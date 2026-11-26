import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_DRAG_TOKENS,
  MAX_EPH_BYTES,
  MAX_GROUP_MEMBERS,
  clientMessageSchema,
  ephCaps,
  expandAt,
  expandGroup,
  groupFrameSchema,
  isGroupFrame,
  loneEphSchema,
  rosterOf,
  serverMessageSchema,
  type EphEvent,
  type GroupFrame,
} from "./protocol.ts";
import { serializedBytes } from "./limits.ts";

type Schema = { safeParse: (v: unknown) => { success: boolean } };
const ok = (schema: Schema, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: Schema, value: unknown) => assert.ok(!schema.safeParse(value).success, JSON.stringify(value));
const eph = (e: unknown) => ({ t: "eph", sceneId: "s1", e });
const okEph = (e: unknown) => ok(clientMessageSchema, eph(e));
const badEph = (e: unknown) => bad(clientMessageSchema, eph(e));

/** server/rooms/ws.ts MAX_FRAME_BYTES, which shared code does not import. */
const MAX_FRAME_BYTES = 64 * 1024;

type Point = { x: number; y: number };
const roster = (n: number, spot: (i: number) => Point = (i) => ({ x: i, y: 0 })) => ({
  with: Array.from({ length: n }, (_, i) => ({ tokenId: `m${i}`, ...spot(i) })),
  from: { x: 0, y: 0 },
});

function parsed(e: unknown): GroupFrame {
  const r = groupFrameSchema.safeParse(e);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  return r.data;
}

/** Expands a frame by the roster it carries, as a device without group frames sends it. */
const expandOwn = (e: unknown) => {
  const frame = parsed(e);
  return expandGroup(frame, rosterOf(frame));
};

describe("group drag frames", () => {
  test("each kind carries the gesture number and the pressed token", () => {
    okEph({ k: "dragStart", tokenId: "p", g: 1, x: 2, y: 3, with: [], from: { x: 2, y: 3 } });
    okEph({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3 });
    okEph({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3, path: [2, 3], ft: 5, squeeze: true, free: true });
    okEph({ k: "dragCancel", tokenId: "p", g: 1 });
    okEph({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 2, y: 3 }] });
    okEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null] });
    okEph({ k: "dragMove", tokenId: "p", g: 0, x: 2, y: 3 });
    okEph({ k: "dragMove", tokenId: "p", g: Number.MAX_SAFE_INTEGER, x: 2, y: 3 });
    for (const g of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) badEph({ k: "dragMove", tokenId: "p", g, x: 2, y: 3 });
    // A gesture ends with `groupEnd`, never a tagged `dragEnd`.
    badEph({ k: "dragEnd", tokenId: "p", g: 1, x: 2, y: 3 });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [] });
    badEph({ k: "groupEnd", tokenId: "p", at: [null] });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 2, y: 3, squeeze: false }] });
    badEph({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3, extra: true });
    badEph({ k: "dragMove", tokenId: "", g: 1, x: 2, y: 3 });
    badEph({ k: "dragStart", tokenId: "p", g: 1, x: 2, y: 3, free: true });
    // A group's fields never ride on an untagged frame, which keeps today's schema.
    badEph({ k: "dragMove", tokenId: "p", x: 2, y: 3, fts: [1] });
    badEph({ k: "dragStart", tokenId: "p", x: 2, y: 3, with: [], from: { x: 2, y: 3 } });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null], free: true });
  });

  test("a frame without a gesture number is a lone frame, as before", () => {
    const lone = { k: "dragMove", tokenId: "p", x: 2, y: 3, ft: 5 };
    const r = clientMessageSchema.safeParse(eph(lone));
    assert.ok(r.success && r.data.t === "eph" && !isGroupFrame(r.data.e));
    const group = clientMessageSchema.safeParse(eph({ ...lone, g: 4 }));
    assert.ok(group.success && group.data.t === "eph" && isGroupFrame(group.data.e));
    ok(loneEphSchema, lone);
    bad(loneEphSchema, { ...lone, g: 4 });
  });

  test("a token's numbers are bounded only as transport: finite", () => {
    const wide = [5_000, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -2.2250738585072014e-308];
    for (const v of wide) {
      okEph({ k: "dragStart", tokenId: "p", g: 1, x: v, y: v, with: [{ tokenId: "m", x: v, y: v }], from: { x: v, y: v } });
      okEph({ k: "dragMove", tokenId: "p", g: 1, x: v, y: v, path: [v, v], ft: v, fts: [v, null], with: [{ tokenId: "m", x: v, y: v }, { tokenId: "n", x: 0, y: 0 }], from: { x: 0, y: 0 } });
      okEph({ k: "dragMove", tokenId: "p", g: 1, x: 0, y: 0, lead: { i: 0, x: v, y: v, path: [v], ft: v } });
      okEph({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: v, y: v }, null] });
      // The same numbers past the map's bounds on a lone frame stay refused.
      if (Math.abs(v) > 1_000) badEph({ k: "dragMove", tokenId: "p", x: v, y: v });
    }
    badEph({ k: "dragMove", tokenId: "p", x: 1, y: 1, ft: -5 });
    okEph({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 1, ft: -5 });
    okEph({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 1, ft: 200_000 });
    // JSON.parse makes Infinity of an overflowing literal, which no group frame takes.
    for (const text of ['{"x":1e400}', '{"x":-1e400}']) {
      const { x } = JSON.parse(text) as { x: number };
      badEph({ k: "dragMove", tokenId: "p", g: 1, x, y: 0 });
      badEph({ k: "dragMove", tokenId: "p", g: 1, x: 0, y: 0, fts: [x] });
      badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x, y: 0 }] });
      badEph({ k: "dragStart", tokenId: "p", g: 1, x: 0, y: 0, with: [{ tokenId: "m", x, y: 0 }], from: { x: 0, y: 0 } });
    }
    badEph({ k: "dragMove", tokenId: "p", g: 1, x: Number.NaN, y: 0 });
    badEph({ k: "dragMove", tokenId: "p", g: 1, x: "1", y: 0 });
    // Every finite double writes in at most 24 characters, inside the counted width.
    for (const v of [-Number.MAX_VALUE, -2.2250738585072014e-308, -1.2345678901234567e-100, -0.000001234567890123456, -Number.MIN_VALUE]) {
      assert.ok(JSON.stringify(v).length <= 24, JSON.stringify(v));
    }
    assert.ok(24 <= ephCaps.numberChars);
  });

  test("a roster carries the pressed token's start with its members, each named once", () => {
    for (const k of ["dragStart", "dragMove", "dragCancel"]) {
      const frame = { k, tokenId: "p", g: 1, ...(k === "dragCancel" ? {} : { x: 0, y: 0 }) };
      okEph({ ...frame, ...roster(0) });
      okEph({ ...frame, ...roster(MAX_GROUP_MEMBERS) });
      badEph({ ...frame, ...roster(MAX_GROUP_MEMBERS + 1) });
      badEph({ ...frame, with: roster(2).with });
      badEph({ ...frame, from: { x: 0, y: 0 } });
      badEph({ ...frame, with: [{ tokenId: "m", x: 0, y: 0 }, { tokenId: "m", x: 1, y: 0 }], from: { x: 0, y: 0 } });
      badEph({ ...frame, with: [{ tokenId: "p", x: 0, y: 0 }], from: { x: 0, y: 0 } });
      badEph({ ...frame, with: [{ tokenId: "m", x: 0 }], from: { x: 0, y: 0 } });
    }
    okEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null, null, null], ...roster(2) });
    assert.equal(MAX_GROUP_MEMBERS, MAX_DRAG_TOKENS - 1);
    assert.equal(MAX_DRAG_TOKENS, 100);
  });

  test("a frame that carries its roster lines up with it", () => {
    const move = { k: "dragMove", tokenId: "p", g: 1, x: 1, y: 0 };
    okEph({ ...move, fts: [1, null, 3], ...roster(3) });
    badEph({ ...move, fts: [1, null], ...roster(3) });
    badEph({ ...move, fts: [1, null, 3, 4], ...roster(3) });
    okEph({ ...move, lead: { i: 2 }, ...roster(3) });
    badEph({ ...move, lead: { i: 3 }, ...roster(3) });
    badEph({ ...move, lead: { i: 0 }, ...roster(0) });
    okEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null, { x: 1, y: 1 }, null, null], ...roster(3) });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null, { x: 1, y: 1 }, null], ...roster(3) });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: [null, null, null, null, null], ...roster(3) });
    // Without its roster in the same message a frame is held only to the largest roster.
    okEph({ ...move, fts: new Array(MAX_GROUP_MEMBERS).fill(1) });
    badEph({ ...move, fts: new Array(MAX_GROUP_MEMBERS + 1).fill(1) });
    okEph({ ...move, lead: { i: MAX_GROUP_MEMBERS - 1 } });
    badEph({ ...move, lead: { i: MAX_GROUP_MEMBERS } });
    badEph({ ...move, lead: { i: -1 } });
    badEph({ ...move, lead: { i: 0.5 } });
    okEph({ k: "groupEnd", tokenId: "p", g: 1, at: new Array(MAX_DRAG_TOKENS).fill(null) });
    badEph({ k: "groupEnd", tokenId: "p", g: 1, at: new Array(MAX_DRAG_TOKENS + 1).fill(null) });
    okEph({ ...move, path: new Array(200).fill(1) });
    badEph({ ...move, path: new Array(201).fill(1) });
    badEph({ ...move, lead: { i: 0, path: new Array(201).fill(1) } });
  });

  test("a frame whose lead is a member carries no route of its own", () => {
    const move = { k: "dragMove", tokenId: "p", g: 1, x: 1, y: 0, lead: { i: 0, path: [1, 0], ft: 5 } };
    okEph(move);
    okEph({ ...move, free: true });
    okEph({ ...move, fts: [null] });
    badEph({ ...move, path: [1, 0] });
    badEph({ ...move, ft: 5 });
    badEph({ ...move, squeeze: true });
  });

  test("the widest frames the grammar takes fit their caps and a socket frame", () => {
    // 64 UTF-16 units that each write as a 6-byte escape, distinct for each token.
    const widestId = (i: number) => String.fromCharCode(1 + (i % 31), 1 + Math.floor(i / 31)) + "\u0001".repeat(62);
    assert.equal(serializedBytes(widestId(0)), ephCaps.idBytes);
    const n = -1.2345678901234567e-100;
    assert.equal(JSON.stringify(n).length, 24);
    const nums = (count: number) => new Array<number>(count).fill(n);
    const g = Number.MAX_SAFE_INTEGER;
    const fullRoster = { with: Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => ({ tokenId: widestId(i + 1), x: n, y: n })), from: { x: n, y: n } };
    const leadMove = { k: "dragMove", tokenId: widestId(0), g, x: n, y: n, free: true, fts: nums(MAX_GROUP_MEMBERS), lead: { i: MAX_GROUP_MEMBERS - 1, x: n, y: n, path: nums(200), ft: n, squeeze: true } };
    const ownMove = { k: "dragMove", tokenId: widestId(0), g, x: n, y: n, path: nums(200), ft: n, squeeze: true, free: true, fts: nums(MAX_GROUP_MEMBERS) };
    const end = { k: "groupEnd", tokenId: widestId(0), g, at: Array.from({ length: MAX_DRAG_TOKENS }, () => ({ x: n, y: n, squeeze: true })) };
    const start = { k: "dragStart", tokenId: widestId(0), g, x: n, y: n };
    /** How many numbers a frame writes, each counted one character wider than its 24. */
    const numbers = (v: unknown): number => (typeof v === "number" ? 1 : Array.isArray(v) ? v.reduce((s: number, x) => s + numbers(x), 0) : v && typeof v === "object" ? Object.values(v).reduce((s: number, x) => s + numbers(x), 0) : 0);
    const counted = (e: unknown) => serializedBytes(e) + numbers(e) * (ephCaps.numberChars - 24);
    for (const e of [leadMove, ownMove, end, start]) {
      ok(groupFrameSchema, e);
      assert.ok(counted(e) <= ephCaps.bare, `${counted(e)} bytes`);
      const carrying = { ...e, ...fullRoster };
      ok(groupFrameSchema, carrying);
      assert.ok(counted(carrying) <= ephCaps.roster, `${counted(carrying)} bytes`);
      const message = { t: "eph", sceneId: widestId(500), e: carrying };
      ok(clientMessageSchema, message);
      assert.ok(serializedBytes(message) < MAX_FRAME_BYTES, `${serializedBytes(message)} bytes`);
    }
    // About 8.4 KB bare and 54 KB with a roster, as the caps were sized.
    assert.ok(counted(leadMove) > 8_300 && counted({ ...leadMove, ...fullRoster }) > 53_500);
    assert.equal(ephCaps.bare, 8_704);
    assert.equal(ephCaps.roster, 54_272);
    assert.equal(ephCaps.other, MAX_EPH_BYTES);
    // A lone frame keeps its 4 KiB: the same widest route refused alone is taken as a group frame.
    const lonePath = { k: "dragMove", tokenId: widestId(0), x: 1, y: 1, path: new Array(200).fill(-999.1234567890123) };
    assert.ok(serializedBytes(lonePath) > MAX_EPH_BYTES);
    badEph(lonePath);
    okEph({ ...lonePath, g: 1 });
  });

  test("the server tells a socket what it takes and asks for a roster", () => {
    ok(serverMessageSchema, { t: "takes", groups: true, pace: "full" });
    ok(serverMessageSchema, { t: "takes", groups: true, pace: "off" });
    bad(serverMessageSchema, { t: "takes", groups: true, pace: "slow" });
    bad(serverMessageSchema, { t: "takes", groups: false, pace: "full" });
    bad(serverMessageSchema, { t: "takes", groups: true });
    bad(serverMessageSchema, { t: "takes", pace: "full" });
    ok(serverMessageSchema, { t: "need", id: "p", g: 3 });
    bad(serverMessageSchema, { t: "need", id: "p" });
    bad(serverMessageSchema, { t: "need", id: "p", g: 1.5 });
    bad(serverMessageSchema, { t: "need", id: "", g: 1 });
    bad(serverMessageSchema, { t: "need", id: "p", g: 1, sceneId: "s1" });
  });
});

/** free.ts moveFrame: the point, then the frame's fields over it, then `free`. */
const todayMove = (tokenId: string, at: Point, free: boolean, fields: object) => ({ k: "dragMove", tokenId, x: at.x, y: at.y, ...fields, ...(free ? { free: true } : {}) });

/**
 * Stage.tsx dragMove's frames one token at a time: the pressed node's own
 * frame, then each follower at its drawn start plus the pressed node's
 * offset from where it is drawn, in that order.
 */
function stageMove(o: { pressed: string; node: Point; drawnFrom: Point; free: boolean; followers: readonly { id: string; was: Point }[]; fields: (id: string) => object }): unknown[] {
  const dx = o.node.x - o.drawnFrom.x;
  const dy = o.node.y - o.drawnFrom.y;
  return [todayMove(o.pressed, o.node, o.free, o.fields(o.pressed)), ...o.followers.map((f) => todayMove(f.id, { x: f.was.x + dx, y: f.was.y + dy }, false, o.fields(f.id)))];
}

/** Two frame lists as the wire carries them, key order and left-out fields included. */
const sameWire = (a: readonly unknown[], b: readonly unknown[]) => assert.equal(JSON.stringify(a), JSON.stringify(b));

describe("expandGroup", () => {
  test("a member moves by the pressed token's offset from its start", () => {
    const frames = expandOwn({ k: "dragMove", tokenId: "p", g: 1, x: 12, y: 5, with: [{ tokenId: "m", x: 20, y: 7 }], from: { x: 10, y: 5 } });
    assert.deepEqual(frames, [
      { k: "dragMove", tokenId: "p", x: 12, y: 5 },
      { k: "dragMove", tokenId: "m", x: 22, y: 7 },
    ]);
    // Added as Stage adds it, start plus offset: 0.7 + (0.1 - 0.3) is 0.5, where (0.7 + 0.1) - 0.3 is not.
    const [, m] = expandOwn({ k: "dragMove", tokenId: "p", g: 1, x: 0.1, y: 0.1, with: [{ tokenId: "m", x: 0.7, y: 0.7 }], from: { x: 0.3, y: 0.3 } });
    assert.deepEqual(m, { k: "dragMove", tokenId: "m", x: 0.5, y: 0.5 });
  });

  test("a group drag comes out as each token's own frames, costs and no `free` on members", () => {
    const followers = [
      { id: "a", was: { x: 0.7, y: 3.25 } },
      { id: "b", was: { x: 4.125, y: -2 } },
      { id: "c", was: { x: 9, y: 9 } },
    ];
    const node = { x: 0.1, y: 6.6 };
    const drawnFrom = { x: 0.3, y: 1.1 };
    const cost: Record<string, number | undefined> = { p: 15, a: 0, c: 35 };
    const today = stageMove({ pressed: "p", node, drawnFrom, free: false, followers, fields: (id) => (cost[id] !== undefined ? { ft: cost[id] } : {}) });
    const group = { k: "dragMove", tokenId: "p", g: 7, ...node, ft: 15, fts: [0, null, 35], with: followers.map((f) => ({ tokenId: f.id, ...f.was })), from: drawnFrom };
    sameWire(expandOwn(group), today);
    // Its next frames carry no roster and expand by the one the server holds.
    const held = rosterOf(parsed(group));
    const next = { k: "dragMove", tokenId: "p", g: 7, x: 2.2, y: 3.3, ft: 20, fts: [5, null, null] };
    const cost2: Record<string, number | undefined> = { p: 20, a: 5 };
    sameWire(expandGroup(parsed(next), held), stageMove({ pressed: "p", node: { x: 2.2, y: 3.3 }, drawnFrom, free: false, followers, fields: (id) => (cost2[id] !== undefined ? { ft: cost2[id] } : {}) }));
  });

  test("an Alt-held press on a rider moves its mount by the lead's route, with `free` on no frame", () => {
    // The rider is pressed, its mount leads as a follower and takes the route, cut short at a wall, and a second rider follows.
    const followers = [
      { id: "mount", was: { x: 3, y: 4 } },
      { id: "rider2", was: { x: 3.5, y: 4.5 } },
    ];
    const node = { x: 7.3, y: 4.1 };
    const drawnFrom = { x: 3.25, y: 4 };
    const route = { x: 5, y: 4, path: [3, 4, 5, 4], ft: 10 };
    const today = stageMove({ pressed: "rider", node, drawnFrom, free: false, followers, fields: (id) => (id === "mount" ? route : {}) });
    const group = { k: "dragMove", tokenId: "rider", g: 2, ...node, lead: { i: 0, ...route }, with: followers.map((f) => ({ tokenId: f.id, ...f.was })), from: drawnFrom };
    sameWire(expandOwn(group), today);
    // A walk that is not cut gives the lead no point of its own: it moves by the offset as every member does.
    const straight = { path: [3, 4, 7, 4], ft: 20 };
    const todayStraight = stageMove({ pressed: "rider", node, drawnFrom, free: false, followers, fields: (id) => (id === "mount" ? straight : {}) });
    sameWire(expandOwn({ ...group, lead: { i: 0, ...straight } }), todayStraight);
    for (const f of expandOwn(group)) assert.ok(!("free" in f));
  });

  test("an Alt-held press on a mount sends `free` on the mount's own frame only", () => {
    const followers = [{ id: "rider", was: { x: 2.25, y: 2 } }];
    const node = { x: 6.6, y: 2.2 };
    const drawnFrom = { x: 2, y: 2 };
    const route = { path: [2, 2, 6, 2], ft: 20 };
    const today = stageMove({ pressed: "mount", node, drawnFrom, free: true, followers, fields: (id) => (id === "mount" ? route : {}) });
    const group = { k: "dragMove", tokenId: "mount", g: 3, ...node, ...route, free: true, with: followers.map((f) => ({ tokenId: f.id, ...f.was })), from: drawnFrom };
    sameWire(expandOwn(group), today);
    const [mount, rider] = expandOwn(group);
    assert.ok(mount && "free" in mount && rider && !("free" in rider));
  });

  test("expandAt gives each token's frame exactly as expandGroup does, the Alt-held rider's and mount's included", () => {
    const followers = [
      { tokenId: "mount", x: 3, y: 4 },
      { tokenId: "rider2", x: 3.5, y: 4.5 },
    ];
    const frames = [
      { k: "dragMove", tokenId: "rider", g: 2, x: 7.3, y: 4.1, lead: { i: 0, x: 5, y: 4, path: [3, 4, 5, 4], ft: 10 }, with: followers, from: { x: 3.25, y: 4 } },
      { k: "dragMove", tokenId: "rider", g: 2, x: 7.3, y: 4.1, lead: { i: 0, path: [3, 4, 7, 4], ft: 20 }, with: followers, from: { x: 3.25, y: 4 } },
      { k: "dragMove", tokenId: "mount", g: 3, x: 6.6, y: 2.2, path: [2, 2, 6, 2], ft: 20, free: true, with: [{ tokenId: "rider", x: 2.25, y: 2 }], from: { x: 2, y: 2 } },
      { k: "dragMove", tokenId: "p", g: 1, x: 2.2, y: 3.3, fts: [null, 7], squeeze: true, ...roster(2, (i) => ({ x: 0.1 * i, y: 1.7 })) },
      { k: "dragStart", tokenId: "p", g: 1, x: 0.7, y: -0.25, ...roster(3, (i) => ({ x: 12.125 + i, y: 3 })) },
      { k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 4, y: 5 }, null, { x: 1, y: 1, squeeze: true }], ...roster(2) },
      { k: "dragCancel", tokenId: "p", g: 1, ...roster(2) },
    ];
    for (const e of frames) {
      const frame = parsed(e);
      for (const r of [rosterOf(frame), null]) {
        const all = expandGroup(frame, r);
        assert.equal(all.length, 1 + (r?.ids.length ?? 0));
        for (const [j, one] of all.entries()) assert.equal(JSON.stringify(expandAt(frame, r, j)), JSON.stringify(one), `${frame.k} ${j}`);
      }
    }
  });

  test("a start puts every member where it stands", () => {
    const with_ = [
      { tokenId: "a", x: 0.7, y: -0.25 },
      { tokenId: "b", x: 12.125, y: 3 },
    ];
    sameWire(expandOwn({ k: "dragStart", tokenId: "p", g: 1, x: 0.3, y: 1, with: with_, from: { x: 0.3, y: 1 } }), [
      { k: "dragStart", tokenId: "p", x: 0.3, y: 1 },
      ...with_.map((m) => ({ k: "dragStart", tokenId: m.tokenId, x: m.x, y: m.y })),
    ]);
  });

  test("a group end lands each token on its own landing or ends it as a cancel", () => {
    const held = rosterOf(parsed({ k: "dragStart", tokenId: "p", g: 1, x: 0, y: 0, ...roster(3) }));
    const end = parsed({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 4, y: 5, squeeze: true }, null, { x: -3, y: 2.5 }, null] });
    sameWire(expandGroup(end, held), [
      { k: "dragEnd", tokenId: "p", x: 4, y: 5, squeeze: true },
      { k: "dragCancel", tokenId: "m0" },
      { k: "dragEnd", tokenId: "m1", x: -3, y: 2.5 },
      { k: "dragCancel", tokenId: "m2" },
    ]);
    // A landing list shorter than the roster held ends the rest as cancels.
    sameWire(expandGroup(parsed({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 4, y: 5 }] }), held), [
      { k: "dragEnd", tokenId: "p", x: 4, y: 5 },
      { k: "dragCancel", tokenId: "m0" },
      { k: "dragCancel", tokenId: "m1" },
      { k: "dragCancel", tokenId: "m2" },
    ]);
  });

  test("a tagged cancel ends every token of its gesture", () => {
    const held = rosterOf(parsed({ k: "dragStart", tokenId: "p", g: 1, x: 0, y: 0, ...roster(2) }));
    sameWire(expandGroup(parsed({ k: "dragCancel", tokenId: "p", g: 1 }), held), [
      { k: "dragCancel", tokenId: "p" },
      { k: "dragCancel", tokenId: "m0" },
      { k: "dragCancel", tokenId: "m1" },
    ]);
  });

  test("with no roster only the pressed token's frame comes out", () => {
    sameWire(expandGroup(parsed({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3, ft: 5, free: true, fts: [1, 2] }), null), [{ k: "dragMove", tokenId: "p", x: 2, y: 3, ft: 5, free: true }]);
    sameWire(expandGroup(parsed({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3, lead: { i: 0, ft: 5 } }), null), [{ k: "dragMove", tokenId: "p", x: 2, y: 3 }]);
    sameWire(expandGroup(parsed({ k: "dragStart", tokenId: "p", g: 1, x: 2, y: 3 }), null), [{ k: "dragStart", tokenId: "p", x: 2, y: 3 }]);
    sameWire(expandGroup(parsed({ k: "groupEnd", tokenId: "p", g: 1, at: [null, { x: 1, y: 1 }] }), null), [{ k: "dragCancel", tokenId: "p" }]);
    sameWire(expandGroup(parsed({ k: "dragCancel", tokenId: "p", g: 1 }), null), [{ k: "dragCancel", tokenId: "p" }]);
    assert.equal(rosterOf(parsed({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 3 })), null);
  });

  test("a token whose frame falls outside a lone frame's bounds fails the lone check alone", () => {
    // The pressed token starts at the map's edge and moves one cell past it, its member stays inside.
    const frames = expandOwn({ k: "dragMove", tokenId: "p", g: 1, x: 1_001, y: 0, with: [{ tokenId: "v", x: 0, y: 0 }], from: { x: 1_000, y: 0 } });
    assert.deepEqual(frames.map((f) => loneEphSchema.safeParse(f).success), [false, true]);
    assert.deepEqual(frames[1], { k: "dragMove", tokenId: "v", x: 1, y: 0 });
    // A member's cost past a lone frame's bound fails its frame alone.
    const costs = expandOwn({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 0, fts: [100_001, 30], with: [{ tokenId: "a", x: 0, y: 0 }, { tokenId: "b", x: 2, y: 0 }], from: { x: 0, y: 0 } });
    assert.deepEqual(costs.map((f) => loneEphSchema.safeParse(f).success), [true, false, true]);
    // A landing outside the bounds ends nothing else.
    const ends = expandOwn({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 1, y: 1 }, { x: 5_000, y: 1 }], with: [{ tokenId: "a", x: 0, y: 0 }], from: { x: 0, y: 0 } });
    assert.deepEqual(ends.map((f) => loneEphSchema.safeParse(f).success), [true, false]);
  });

  test("a stored roster keeps each start exactly, in roster order", () => {
    const frame = parsed({ k: "dragStart", tokenId: "p", g: 1, x: 0.1, y: 0.2, with: [{ tokenId: "a", x: 0.7, y: -1e-300 }, { tokenId: "b", x: 5e300, y: 3 }], from: { x: 0.1, y: 0.2 } });
    const held = rosterOf(frame);
    assert.ok(held);
    assert.deepEqual(held.ids, ["a", "b"]);
    assert.deepEqual(Array.from(held.starts), [0.7, -1e-300, 5e300, 3]);
    assert.deepEqual(held.from, { x: 0.1, y: 0.2 });
    // A roster missing a member's start gives that member no point a lone frame takes.
    const short = expandGroup(parsed({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 1 }), { from: { x: 0, y: 0 }, ids: ["a", "b"], starts: [1, 1] });
    assert.deepEqual(short.map((f: EphEvent) => loneEphSchema.safeParse(f).success), [true, true, false]);
  });
});
