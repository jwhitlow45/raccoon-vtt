import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState, Viewer } from "#shared/model.ts";
import { clientMessageSchema, type EphEvent, type EphEventOut, type GroupFrame, type ServerMessage } from "#shared/protocol.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { DM, P1, P2, actor, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { cancelLost, cancelPreviews, MOST_PREVIEWS_SENT, PREVIEW_STALE_MS, rejudgePreviews, routeEphemeral, sweepPreviews } from "./ephemeral.ts";

/*
 * Group drag frames (design 7.6): one frame for every token of a gesture
 * step, expanded by the server into each token's own frame by the roster
 * the frame bound as it arrived, and each judged as a lone frame is. Bree
 * (p2) watches the DM drag V, alone or with other tokens withheld from her,
 * and receives the same frames, cancels and ends either way.
 */

type Seen = { conn: Connection; got: EphEventOut[]; all: ServerMessage[] };

function viewer(who: Viewer, now: () => number): Seen {
  const got: EphEventOut[] = [];
  const all: ServerMessage[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: (text: string) => {
      const msg = JSON.parse(text) as ServerMessage;
      all.push(msg);
      if (msg.t === "eph") got.push(msg.e);
    },
    close: () => undefined,
    terminate: () => undefined,
  };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role }, "203.0.113.1", { now });
  conn.held = new Map();
  conn.sceneId = "s1";
  return { conn, got, all };
}

/** The DM, p1 and Bree on one room, each frame bound and routed as the actor does with a covered tick. */
function stage(state: RoomState) {
  let clock = 1_000_000;
  const now = () => clock;
  const dm = viewer(DM, now);
  const p1 = viewer(P1, now);
  const bree = viewer(P2, now);
  const all = [dm.conn, p1.conn, bree.conn];
  /** A frame as the DM's page sends it, through the client schema, bound to its roster and routed. */
  const send = (e: unknown, sceneId = "s1") => {
    const parsed = clientMessageSchema.safeParse({ t: "eph", sceneId, e });
    assert.ok(parsed.success && parsed.data.t === "eph", JSON.stringify(parsed.error?.issues));
    const frame = parsed.data.e;
    if (!("g" in frame)) {
      routeEphemeral(state, dm.conn, sceneId, frame, all);
      return;
    }
    const version = dm.conn.gestures.arrive(frame as GroupFrame, now());
    assert.notEqual(version, "refused");
    try {
      routeEphemeral(state, dm.conn, sceneId, frame, all, now(), version === "refused" ? null : version);
    } finally {
      if (version !== "refused") dm.conn.gestures.release(version);
    }
  };
  return { state, dm, p1, bree, all, send, tick: (ms: number) => (clock += ms), now };
}

type Point = { x: number; y: number };
const roster = (members: readonly { id: string; at: Point }[], from: Point) => ({ with: members.map((m) => ({ tokenId: m.id, ...m.at })), from });

/** How each kind of withholding keeps the extra tokens from Bree, with V where Bree sees it. */
const WITHHELD: { name: string; build: (k: number) => { state: RoomState; v: Point; hidden: (i: number) => Point; sceneOf?: string } }[] = [
  {
    name: "Hide",
    build: (k) => {
      const state = room();
      for (let i = 0; i < k; i++) state.tokens[`h${i}`] = token(`h${i}`, { x: 2 + (i % 10), y: 2 + Math.floor(i / 10), visibility: "dm" });
      return { state, v: { x: 20, y: 5 }, hidden: (i) => ({ x: 2 + (i % 10), y: 2 + Math.floor(i / 10) }) };
    },
  },
  {
    name: "fog",
    build: (k) => {
      const state = room();
      state.scenes.s1 = scene("s1", { fogEnabled: true });
      reveal(state, "s1", { x: 18, y: 0, w: 12, h: 12 });
      for (let i = 0; i < k; i++) state.tokens[`h${i}`] = token(`h${i}`, { x: 1 + (i % 12), y: 14 + Math.floor(i / 12) });
      return { state, v: { x: 20, y: 5 }, hidden: (i) => ({ x: 1 + (i % 12), y: 14 + Math.floor(i / 12) }) };
    },
  },
  {
    name: "per-player sight",
    build: (k) => {
      clearVisionCache();
      const state = room();
      state.scenes.s1 = scene("s1", { bounds: { w: 48, h: 40 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
      state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
      const dark: { inline: Actor } = { inline: actor({ senses: "darkvision 60 ft" }) };
      state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 8, y: 30, actor: dark });
      state.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 36, y: 8, actor: dark });
      for (let i = 0; i < k; i++) state.tokens[`h${i}`] = token(`h${i}`, { x: 2 + (i % 12), y: 26 + Math.floor(i / 12) });
      return { state, v: { x: 32, y: 8 }, hidden: (i) => ({ x: 2 + (i % 12), y: 26 + Math.floor(i / 12) }) };
    },
  },
  {
    name: "a floor Bree does not hold",
    build: (k) => {
      const state = room();
      for (let i = 0; i < k; i++) state.tokens[`h${i}`] = token(`h${i}`, { sceneId: "s2", x: 2 + (i % 10), y: 2 + Math.floor(i / 10) });
      return { state, v: { x: 20, y: 5 }, hidden: (i) => ({ x: 2 + (i % 10), y: 2 + Math.floor(i / 10) }) };
    },
  },
];

/**
 * One gesture of the DM's, as its page sends it: a start with its roster,
 * moves, and an end or a cancel. V is the pressed token, or a member behind
 * a pressed token Bree does not see. Bree's messages are marked after each.
 */
function gesture(t: ReturnType<typeof stage>, v: Point, members: readonly { id: string; at: Point }[], vLeads: boolean, end: "groupEnd" | "dragCancel"): unknown[][] {
  t.state.tokens.v = token("v", { x: v.x, y: v.y });
  const all = vLeads ? [{ id: "v", at: v }, ...members] : [...members.slice(0, 1), { id: "v", at: v }, ...members.slice(1)];
  const [pressed, ...rest] = all;
  const from = pressed!.at;
  const marks: unknown[][] = [];
  const mark = () => marks.push([...t.bree.all]);
  t.send({ k: "dragStart", tokenId: pressed!.id, g: 1, ...from, ...roster(rest, from) });
  mark();
  for (const step of [1, 2, 3]) {
    t.tick(33);
    t.send({ k: "dragMove", tokenId: pressed!.id, g: 1, x: from.x + step, y: from.y, ...(rest.length > 0 ? { fts: rest.map((_, i) => (i % 2 === 0 ? 5 * step : null)) } : {}) });
    mark();
  }
  t.tick(33);
  if (end === "groupEnd") t.send({ k: "groupEnd", tokenId: pressed!.id, g: 1, at: all.map((m) => ({ x: m.at.x + 3, y: m.at.y })) });
  else t.send({ k: "dragCancel", tokenId: pressed!.id, g: 1 });
  mark();
  return marks;
}

describe("a group drag gives a watcher the same frames as V alone", () => {
  for (const kind of WITHHELD) {
    for (const k of [1, 5, 99]) {
      for (const vLeads of [true, false]) {
        for (const end of ["groupEnd", "dragCancel"] as const) {
          test(`withheld by ${kind.name}, k = ${k}, V ${vLeads ? "pressed" : "a member"}, ending with ${end}`, () => {
            const lone = kind.build(k);
            const alone = stage(lone.state);
            const loneMarks = gesture(alone, lone.v, vLeads ? [] : [{ id: "h0", at: lone.hidden(0) }], vLeads, end);
            // The lone twin's own hidden pressed token, when V is a member, keeps the twins' rosters apart only in their extra members.
            const twin = kind.build(k);
            const group = stage(twin.state);
            const members = Array.from({ length: k }, (_, i) => ({ id: `h${i}`, at: twin.hidden(i) }));
            const groupMarks = gesture(group, twin.v, members, vLeads, end);
            if (vLeads) assert.deepEqual(groupMarks, loneMarks);
            else assert.deepEqual(groupMarks.map((m) => m.filter((e) => JSON.stringify(e).includes('"v"'))), loneMarks.map((m) => m.filter((e) => JSON.stringify(e).includes('"v"'))));
            // V's whole stream: a start, three moves and its end or cancel, and nothing about any other token.
            const last = groupMarks.at(-1)!;
            assert.equal(last.length, 5, JSON.stringify(last));
            assert.ok(last.every((m) => JSON.stringify(m).includes('"tokenId":"v"')), JSON.stringify(last));
            if (kind.name === "per-player sight") {
              // p1 sees the members Bree does not, so the frames did go out for them.
              assert.ok(group.p1.got.some((e) => "tokenId" in e && e.tokenId === "h0"));
            }
          });
        }
      }
    }
  }

  test("the whole stream is the lone one's for V alone and for V with every member withheld at once, frame by frame", () => {
    const lone = stage(room());
    const loneMarks = gesture(lone, { x: 20, y: 5 }, [], true, "groupEnd");
    const state = room();
    for (let i = 0; i < 99; i++) state.tokens[`h${i}`] = token(`h${i}`, { x: 2 + (i % 10), y: 2 + Math.floor(i / 10), visibility: "dm" });
    const group = stage(state);
    const groupMarks = gesture(group, { x: 20, y: 5 }, Array.from({ length: 99 }, (_, i) => ({ id: `h${i}`, at: { x: 2 + (i % 10), y: 2 + Math.floor(i / 10) } })), true, "groupEnd");
    assert.deepEqual(groupMarks, loneMarks);
    assert.deepEqual(groupMarks.at(-1), [
      { t: "eph", from: "dm1", sceneId: "s1", e: { k: "dragStart", tokenId: "v", x: 20, y: 5 } },
      { t: "eph", from: "dm1", sceneId: "s1", e: { k: "dragMove", tokenId: "v", x: 21, y: 5 } },
      { t: "eph", from: "dm1", sceneId: "s1", e: { k: "dragMove", tokenId: "v", x: 22, y: 5 } },
      { t: "eph", from: "dm1", sceneId: "s1", e: { k: "dragMove", tokenId: "v", x: 23, y: 5 } },
      { t: "eph", from: "dm1", sceneId: "s1", e: { k: "dragEnd", tokenId: "v", x: 23, y: 5 } },
    ]);
  });
});

describe("a group frame's tokens are each checked as a lone frame", () => {
  /** Bree's frames of V in a gesture that also carries `extra`, against V's alone. */
  function againstLone(extra: (state: RoomState) => void, frames: (send: (e: unknown) => void) => void, loneFrames: (send: (e: unknown) => void) => void) {
    const a = stage(room());
    a.state.tokens.v = token("v", { x: 0, y: 5 });
    loneFrames(a.send);
    const state = room();
    state.tokens.v = token("v", { x: 0, y: 5 });
    extra(state);
    const b = stage(state);
    frames(b.send);
    assert.deepEqual(b.bree.all, a.bree.all);
    assert.ok(b.bree.got.length > 0);
    return b;
  }

  test("a pressed token at the map's edge moved past it drops alone, and V behind it at 0 still moves", () => {
    againstLone(
      (s) => void (s.tokens.h = token("h", { x: 1_000, y: 5, visibility: "dm" })),
      (send) => {
        send({ k: "dragStart", tokenId: "h", g: 1, x: 1_000, y: 5, with: [{ tokenId: "v", x: 0, y: 5 }], from: { x: 1_000, y: 5 } });
        send({ k: "dragMove", tokenId: "h", g: 1, x: 1_001, y: 5 });
      },
      (send) => {
        send({ k: "dragStart", tokenId: "v", g: 1, x: 0, y: 5, with: [], from: { x: 0, y: 5 } });
        send({ k: "dragMove", tokenId: "v", g: 1, x: 1, y: 5 });
      },
    );
  });

  test("a member nudged past the edge, a landing outside the map and a cost over 100,000 each drop alone", () => {
    const frames = (send: (e: unknown) => void) => {
      send({ k: "dragStart", tokenId: "v", g: 1, x: 0, y: 5, with: [{ tokenId: "edge", x: 999.75, y: 5 }, { tokenId: "far", x: 4, y: 5 }], from: { x: 0, y: 5 } });
      send({ k: "dragMove", tokenId: "v", g: 1, x: 0.5, y: 5, fts: [null, 100_001] });
      send({ k: "groupEnd", tokenId: "v", g: 1, at: [{ x: 1, y: 5 }, { x: 1_000, y: 5 }, { x: 5_000, y: 5 }] });
    };
    againstLone(
      (s) => {
        s.tokens.edge = token("edge", { x: 999.75, y: 5, visibility: "dm" });
        s.tokens.far = token("far", { x: 4, y: 5, visibility: "dm" });
      },
      frames,
      (send) => {
        send({ k: "dragStart", tokenId: "v", g: 1, x: 0, y: 5, with: [], from: { x: 0, y: 5 } });
        send({ k: "dragMove", tokenId: "v", g: 1, x: 0.5, y: 5 });
        send({ k: "groupEnd", tokenId: "v", g: 1, at: [{ x: 1, y: 5 }] });
      },
    );
    // With the members on Bree's screen, each member's frames that a lone frame's bounds take go to her, and no others.
    const state = room();
    state.tokens.v = token("v", { x: 0, y: 5 });
    state.tokens.edge = token("edge", { x: 999.75, y: 5 });
    state.tokens.far = token("far", { x: 4, y: 5 });
    const t = stage(state);
    frames(t.send);
    const of = (id: string) => t.bree.got.filter((e) => "tokenId" in e && e.tokenId === id).map((e) => e.k);
    assert.deepEqual(of("v"), ["dragStart", "dragMove", "dragEnd"]);
    assert.deepEqual(of("edge"), ["dragStart", "dragEnd"]);
    assert.deepEqual(of("far"), ["dragStart", "dragCancel"]);
  });
});

describe("a group drag's members on the screens that show them", () => {
  function shown() {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.a = token("a", { x: 21, y: 5 });
    state.tokens.b = token("b", { x: 22, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, ...roster([{ id: "a", at: { x: 21, y: 5 } }, { id: "b", at: { x: 22, y: 5 } }], { x: 20, y: 5 }) });
    t.send({ k: "dragMove", tokenId: "v", g: 1, x: 21, y: 5 });
    assert.deepEqual(
      [...t.bree.conn.previewsHeld.keys()].sort(),
      ["dm1|drag:a", "dm1|drag:b", "dm1|drag:v"],
    );
    assert.deepEqual([...t.dm.conn.previewsSent.keys()], ["drag#1"], "the gesture keeps one entry for all its tokens");
    t.bree.got.length = 0;
    return t;
  }
  const cancels = (got: EphEventOut[]) => got.filter((e) => e.k === "dragCancel").map((e) => (e as { tokenId: string }).tokenId);

  for (const [what, change] of [
    ["hidden", (s: RoomState) => void (s.tokens.b = { ...s.tokens.b!, visibility: "dm" })],
    ["locked", (s: RoomState) => void (s.tokens.b = { ...s.tokens.b!, locked: true, ownerIds: [] })],
    ["fogged", (s: RoomState) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      // V at 21 and a at 22 stay revealed, b at 23 goes under the fog.
      reveal(s, "s1", { x: 18, y: 0, w: 5, h: 10 });
    }],
  ] as const) {
    test(`a member ${what} at rest is cancelled in that batch's judgment, the rest stay`, () => {
      const t = shown();
      change(t.state);
      rejudgePreviews(t.state, t.all);
      if (what === "locked") {
        // A lock stops only a player's drag: the DM's goes on.
        assert.deepEqual(cancels(t.bree.got), []);
        return;
      }
      assert.deepEqual(cancels(t.bree.got), ["b"]);
      assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:v") && t.bree.conn.previewsHeld.has("dm1|drag:a"));
    });
  }

  test("the DM's socket closing mid-drag cancels every member Bree held", () => {
    const t = shown();
    cancelPreviews(t.dm.conn, t.all);
    assert.deepEqual(cancels(t.bree.got).sort(), ["a", "b", "v"]);
    assert.equal(t.bree.conn.previewsHeld.size, 0);
    assert.equal(t.dm.conn.dragOwners.size, 0);
    assert.deepEqual(t.dm.conn.gestures.retained, { versions: 0, bytes: 0 });
  });

  test("a batch that takes a member from Bree's copy cancels it there", () => {
    const t = shown();
    cancelLost(t.bree.conn, ["token:a"], t.all);
    assert.deepEqual(cancels(t.bree.got), ["a"]);
    assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:b"));
  });

  test("a member is judged by its own last point: a move into fog cancels it where the pressed token's would not", () => {
    const t = shown();
    t.state.scenes.s1 = { ...t.state.scenes.s1!, fogEnabled: true };
    reveal(t.state, "s1", { x: 0, y: 0, w: 24, h: 10 });
    rejudgePreviews(t.state, t.all);
    assert.deepEqual(cancels(t.bree.got), [], "every member's last point is revealed");
    t.send({ k: "dragMove", tokenId: "v", g: 1, x: 22, y: 5 });
    assert.deepEqual(cancels(t.bree.got), ["b"], "b's point, 24, is in the fog, where V's, 22, is not");
    rejudgePreviews(t.state, t.all);
    assert.deepEqual(cancels(t.bree.got), ["b"]);
  });

  test("a member whose frame drops under a new roster keeps its own last point, wherever the roster now lists it", () => {
    const t = shown();
    // a at 22 and b at 23. The new roster lists b first, from a start whose frame the map's edge drops.
    t.send({ k: "dragMove", tokenId: "v", g: 1, x: 21, y: 5, with: [{ tokenId: "b", x: 999.9, y: 5 }, { tokenId: "a", x: 21, y: 5 }], from: { x: 20, y: 5 } });
    assert.deepEqual(t.bree.got.map((e) => "tokenId" in e && e.tokenId), ["v", "a"]);
    t.state.scenes.s1 = { ...t.state.scenes.s1!, fogEnabled: true };
    // V at 21 and a at 22 stay revealed, b at 23 goes under the fog.
    reveal(t.state, "s1", { x: 18, y: 0, w: 5, h: 10 });
    rejudgePreviews(t.state, t.all);
    assert.deepEqual(cancels(t.bree.got), ["b"]);
  });

  test("a step's ends and a blocked pressed token: a cancel and an end for each token, as a lone drop sends them", () => {
    const t = shown();
    t.send({ k: "groupEnd", tokenId: "v", g: 1, at: [null, { x: 25, y: 5 }, null] });
    assert.deepEqual(t.bree.got, [
      { k: "dragCancel", tokenId: "v" },
      { k: "dragEnd", tokenId: "a", x: 25, y: 5 },
      { k: "dragCancel", tokenId: "b" },
    ]);
    assert.equal(t.dm.conn.previewsSent.size, 0);
    assert.equal(t.dm.conn.dragOwners.size, 0);
  });

  test("an end whose roster the server lost still ends every member the gesture shows", () => {
    const t = shown();
    // Its roster gone, as the sweep or an eviction would leave it, the end names only the pressed token.
    t.dm.conn.gestures.clear();
    t.send({ k: "groupEnd", tokenId: "v", g: 1, at: [{ x: 22, y: 5 }] });
    assert.deepEqual(t.bree.got, [
      { k: "dragEnd", tokenId: "v", x: 22, y: 5 },
      { k: "dragCancel", tokenId: "a" },
      { k: "dragCancel", tokenId: "b" },
    ]);
  });

  test("a 100-token gesture is one of the socket's entries", () => {
    const state = room();
    const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
    for (const [i, id] of ids.entries()) state.tokens[id] = token(id, { x: i % 30, y: Math.floor(i / 30) });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "t0", g: 1, x: 0, y: 0, ...roster(ids.slice(1).map((id, i) => ({ id, at: { x: (i + 1) % 30, y: Math.floor((i + 1) / 30) } })), { x: 0, y: 0 }) });
    for (let i = 0; i < MOST_PREVIEWS_SENT - 1; i++) t.send({ k: "ruler", id: `r${i}`, points: [{ x: 1.5, y: 1.5 }], shared: true });
    assert.equal(t.dm.conn.previewsSent.size, MOST_PREVIEWS_SENT);
    assert.equal(t.bree.conn.previewsHeld.size, 100 + MOST_PREVIEWS_SENT - 1);
    assert.deepEqual(t.bree.got.filter((e) => e.k === "dragCancel"), []);
  });
});

describe("each token belongs to the newest gesture that framed it", () => {
  function two() {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.p = token("p", { x: 10, y: 5 });
    state.tokens.q = token("q", { x: 30, y: 5 });
    return stage(state);
  }

  test("a late end of an old gesture leaves V to the newer gesture that framed it", () => {
    const t = two();
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    t.send({ k: "dragStart", tokenId: "q", g: 2, x: 30, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 30, y: 5 }) });
    t.send({ k: "dragMove", tokenId: "q", g: 2, x: 31, y: 5 });
    t.bree.got.length = 0;
    t.send({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 11, y: 5 }, { x: 21, y: 5 }] });
    assert.deepEqual(t.bree.got, [{ k: "dragEnd", tokenId: "p", x: 11, y: 5 }], "V is the newer gesture's");
    assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:v"));
    t.send({ k: "dragMove", tokenId: "q", g: 2, x: 32, y: 5 });
    assert.deepEqual(t.bree.got.at(-1), { k: "dragMove", tokenId: "v", x: 22, y: 5 });
  });

  test("an old end while the newer gesture's frames of V never arrived still ends V", () => {
    const t = two();
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    t.bree.got.length = 0;
    t.send({ k: "groupEnd", tokenId: "p", g: 1, at: [{ x: 11, y: 5 }, { x: 21, y: 5 }] });
    assert.deepEqual(t.bree.got, [
      { k: "dragEnd", tokenId: "p", x: 11, y: 5 },
      { k: "dragEnd", tokenId: "v", x: 21, y: 5 },
    ]);
  });

  test("a lost end, then a new drag of the same token live past the old entry's age: the sweep leaves the new preview alone", () => {
    const t = two();
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    t.tick(PREVIEW_STALE_MS - 1_000);
    t.send({ k: "dragStart", tokenId: "v", g: 2, x: 20, y: 5, with: [], from: { x: 20, y: 5 } });
    t.tick(1_000);
    t.bree.got.length = 0;
    sweepPreviews(t.all);
    assert.deepEqual(t.bree.got, [{ k: "dragCancel", tokenId: "p" }], "only the old gesture's own token");
    assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:v"));
    t.tick(PREVIEW_STALE_MS);
    sweepPreviews(t.all);
    assert.deepEqual(t.bree.got.at(-1), { k: "dragCancel", tokenId: "v" });
  });

  test("a stale entry then frames of other tokens Bree does not see: nothing until the entry's own sweep", () => {
    const t = two();
    t.state.tokens.h = token("h", { x: 2, y: 2, visibility: "dm" });
    t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, with: [], from: { x: 20, y: 5 } });
    t.tick(PREVIEW_STALE_MS);
    t.bree.got.length = 0;
    for (let i = 0; i < 30; i++) {
      t.send({ k: "dragMove", tokenId: "h", g: 2, x: 2 + i / 10, y: 2 });
      t.tick(33);
    }
    assert.deepEqual(t.bree.got, []);
    sweepPreviews(t.all);
    assert.deepEqual(t.bree.got, [{ k: "dragCancel", tokenId: "v" }]);
  });
});

describe("what a gesture's entry owns when its tokens change", () => {
  const unknown = (round: number) => Array.from({ length: 99 }, (_, i) => ({ tokenId: `u${round}-${i}`, x: 1 + (i % 10), y: 1 + Math.floor(i / 10) }));
  /** V and 99 ids no token has, a new 99 in each of 300 rosters 11 ms apart. */
  function rotating() {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    const t = stage(state);
    for (let round = 0; round < 300; round++) {
      t.send({ k: "dragMove", tokenId: "v", g: 1, x: 20 + (round % 2) / 2, y: 5, with: unknown(round), from: { x: 20, y: 5 } });
      assert.ok(t.dm.conn.dragOwners.size <= 100, `${t.dm.conn.dragOwners.size} after ${round + 1} rosters`);
      t.tick(11);
    }
    return t;
  }

  test("300 rosters of 99 new ids each: the entry owns V and the last roster's members alone", () => {
    const t = rotating();
    assert.equal(t.dm.conn.dragOwners.size, 100);
    assert.deepEqual([...new Set(t.dm.conn.dragOwners.values())], ["drag#1"]);
    assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:v"));
  });

  test("after them, the gesture's cancel leaves no owner and no entry", () => {
    const t = rotating();
    t.send({ k: "dragCancel", tokenId: "v", g: 1 });
    assert.equal(t.dm.conn.dragOwners.size, 0);
    assert.equal(t.dm.conn.previewsSent.size, 0);
  });

  test("after them, the sweep leaves no owner and no entry", () => {
    const t = rotating();
    t.tick(PREVIEW_STALE_MS);
    sweepPreviews(t.all);
    assert.equal(t.dm.conn.dragOwners.size, 0);
    assert.equal(t.dm.conn.previewsSent.size, 0);
  });

  test("a new roster that leaves out a member Bree shows ends it there, and the members it keeps go on", () => {
    const state = room();
    for (const [id, x] of [["v", 20], ["a", 21], ["b", 22], ["c", 23]] as const) state.tokens[id] = token(id, { x, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, ...roster([{ id: "a", at: { x: 21, y: 5 } }, { id: "b", at: { x: 22, y: 5 } }], { x: 20, y: 5 }) });
    t.bree.got.length = 0;
    t.send({ k: "dragMove", tokenId: "v", g: 1, x: 21, y: 5, ...roster([{ id: "b", at: { x: 22, y: 5 } }, { id: "c", at: { x: 23, y: 5 } }], { x: 20, y: 5 }) });
    assert.deepEqual(t.bree.got, [
      { k: "dragCancel", tokenId: "a" },
      { k: "dragMove", tokenId: "v", x: 21, y: 5 },
      { k: "dragMove", tokenId: "b", x: 23, y: 5 },
      { k: "dragMove", tokenId: "c", x: 24, y: 5 },
    ]);
    assert.deepEqual([...t.dm.conn.dragOwners.keys()].sort(), ["b", "c", "v"]);
    assert.ok(!t.bree.conn.previewsHeld.has("dm1|drag:a"));
  });

  test("a member a newer gesture took stays the newer one's when the older gesture's new roster leaves it out", () => {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.p = token("p", { x: 10, y: 5 });
    state.tokens.q = token("q", { x: 30, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    t.send({ k: "dragStart", tokenId: "v", g: 2, x: 20, y: 5, with: [], from: { x: 20, y: 5 } });
    t.bree.got.length = 0;
    t.send({ k: "dragMove", tokenId: "p", g: 1, x: 11, y: 5, ...roster([{ id: "q", at: { x: 30, y: 5 } }], { x: 10, y: 5 }) });
    assert.deepEqual(t.bree.got, [
      { k: "dragMove", tokenId: "p", x: 11, y: 5 },
      { k: "dragMove", tokenId: "q", x: 31, y: 5 },
    ]);
    assert.equal(t.dm.conn.dragOwners.get("v"), "drag#2");
    assert.ok(t.bree.conn.previewsHeld.has("dm1|drag:v"));
  });

  test("a gesture's frames under another pressed token end the one before, however many it names in turn", () => {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.w = token("w", { x: 24, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, with: [], from: { x: 20, y: 5 } });
    t.bree.got.length = 0;
    t.send({ k: "dragMove", tokenId: "w", g: 1, x: 25, y: 5 });
    assert.deepEqual(t.bree.got, [
      { k: "dragCancel", tokenId: "v" },
      { k: "dragMove", tokenId: "w", x: 25, y: 5 },
    ]);
    for (let i = 0; i < 300; i++) t.send({ k: "dragMove", tokenId: `u${i}`, g: 1, x: 1, y: 1 });
    assert.ok(t.dm.conn.dragOwners.size <= 1, `${t.dm.conn.dragOwners.size}`);
  });
});

describe("each receiver's messages of one pass go together", () => {
  /**
   * V, a and b on Bree's screen, with 30 members under Hide between a and b
   * in the roster. `work` counts the reads routing and judging make (the
   * room's tokens, p1's held previews, what the DM's socket owns), and each
   * message to Bree is marked with the count as it goes.
   */
  function probed() {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.a = token("a", { x: 21, y: 5 });
    state.tokens.b = token("b", { x: 22, y: 5 });
    const hidden = Array.from({ length: 30 }, (_, i) => `h${i}`);
    for (const [i, id] of hidden.entries()) state.tokens[id] = token(id, { x: 2 + (i % 10), y: 2 + Math.floor(i / 10), visibility: "dm" });
    const t = stage(state);
    let work = 0;
    const tokens = state.tokens;
    state.tokens = new Proxy(tokens, {
      get(target, prop, receiver) {
        work++;
        return Reflect.get(target, prop, receiver);
      },
    });
    for (const map of [t.p1.conn.previewsHeld, t.dm.conn.dragOwners] as Map<string, unknown>[]) {
      for (const name of ["get", "has", "delete", "set"] as const) {
        const real = map[name].bind(map) as (...args: unknown[]) => unknown;
        (map as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
          work++;
          return real(...args);
        };
      }
    }
    const marks: number[] = [];
    const real = t.bree.conn.send.bind(t.bree.conn);
    t.bree.conn.send = (msg) => {
      marks.push(work);
      return real(msg);
    };
    const members = [{ id: "a", at: { x: 21, y: 5 } }, ...hidden.map((id, i) => ({ id, at: { x: 2 + (i % 10), y: 2 + Math.floor(i / 10) } })), { id: "b", at: { x: 22, y: 5 } }];
    /** Bree's marks for one pass: how many messages, and how many counts they went at. */
    const during = (run: () => void) => {
      marks.length = 0;
      run();
      return { sent: marks.length, counts: new Set(marks).size };
    };
    return { t, members, during };
  }

  test("a group frame's members to Bree, with members she does not show judged between them", () => {
    const { t, members, during } = probed();
    assert.deepEqual(
      during(() => t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, ...roster(members, { x: 20, y: 5 }) })),
      { sent: 3, counts: 1 },
    );
    assert.deepEqual(during(() => t.send({ k: "dragMove", tokenId: "v", g: 1, x: 21, y: 5 })), { sent: 3, counts: 1 });
  });

  test("the batch's judgment, a batch that takes tokens from Bree's copy, the sweep and a roster that leaves members out", () => {
    for (const end of ["rejudge", "lost", "sweep", "roster"] as const) {
      const { t, members, during } = probed();
      t.send({ k: "dragStart", tokenId: "v", g: 1, x: 20, y: 5, ...roster(members, { x: 20, y: 5 }) });
      const pass =
        end === "rejudge"
          ? during(() => {
              t.state.tokens.a = { ...t.state.tokens.a!, visibility: "dm" };
              t.state.tokens.b = { ...t.state.tokens.b!, visibility: "dm" };
              rejudgePreviews(t.state, t.all);
            })
          : end === "lost"
            ? during(() => cancelLost(t.bree.conn, ["token:a", "token:b"], t.all))
            : end === "sweep"
            ? during(() => {
                t.tick(PREVIEW_STALE_MS);
                sweepPreviews(t.all);
              })
            : during(() => t.send({ k: "dragMove", tokenId: "v", g: 1, x: 21, y: 5, with: [], from: { x: 20, y: 5 } }));
      assert.deepEqual(pass, { sent: end === "rejudge" || end === "lost" ? 2 : 3, counts: 1 }, end);
    }
  });
});

describe("a frame whose gesture has no roster", () => {
  test("expands to its pressed token alone and asks for the roster at most once a second", () => {
    const state = room();
    state.tokens.p = token("p", { x: 10, y: 5 });
    state.tokens.m = token("m", { x: 20, y: 5 });
    const t = stage(state);
    const needs = () => t.dm.all.filter((m) => m.t === "need");
    // The gesture's first message was lost: its next frames carry no roster.
    t.send({ k: "dragMove", tokenId: "p", g: 4, x: 11, y: 5 });
    assert.deepEqual(t.bree.got, [{ k: "dragMove", tokenId: "p", x: 11, y: 5 }]);
    assert.deepEqual(needs(), [{ t: "need", id: "p", g: 4 }]);
    t.tick(500);
    t.send({ k: "dragMove", tokenId: "p", g: 4, x: 11.5, y: 5 });
    assert.equal(needs().length, 1, "once a second");
    t.tick(500);
    t.send({ k: "dragMove", tokenId: "p", g: 4, x: 12, y: 5 });
    assert.equal(needs().length, 2);
    // The answer carries the roster with the pressed token's start, so the member lands by the offset since then.
    t.send({ k: "dragMove", tokenId: "p", g: 4, x: 12, y: 5, ...roster([{ id: "m", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    assert.deepEqual(t.bree.got.slice(-2), [
      { k: "dragMove", tokenId: "p", x: 12, y: 5 },
      { k: "dragMove", tokenId: "m", x: 22, y: 5 },
    ]);
    t.tick(2_000);
    t.send({ k: "dragMove", tokenId: "p", g: 4, x: 13, y: 5 });
    assert.equal(needs().length, 2, "no ask once the roster is held");
    // An end without its roster asks nothing.
    t.send({ k: "groupEnd", tokenId: "p", g: 5, at: [null] });
    assert.equal(needs().length, 2);
  });

  test("a start then a move before the device's flush, and a lone drag: members from the first frame, never a `need`", () => {
    const state = room();
    state.tokens.p = token("p", { x: 10, y: 5 });
    state.tokens.m = token("m", { x: 20, y: 5 });
    const t = stage(state);
    t.send({ k: "dragMove", tokenId: "p", g: 1, x: 11, y: 5, ...roster([{ id: "m", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    t.send({ k: "dragStart", tokenId: "m", g: 2, x: 20, y: 5, with: [], from: { x: 20, y: 5 } });
    assert.deepEqual(t.bree.got.slice(0, 2), [
      { k: "dragMove", tokenId: "p", x: 11, y: 5 },
      { k: "dragMove", tokenId: "m", x: 21, y: 5 },
    ]);
    assert.deepEqual(t.dm.all.filter((m) => m.t === "need"), []);
  });

  test("a member made by an op just before the drag shows once it exists", () => {
    const state = room();
    state.tokens.p = token("p", { x: 10, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "new", at: { x: 12, y: 5 } }], { x: 10, y: 5 }) });
    assert.deepEqual(t.bree.got, [{ k: "dragStart", tokenId: "p", x: 10, y: 5 }], "the member is not in the room yet");
    state.tokens.new = token("new", { x: 12, y: 5 });
    t.send({ k: "dragMove", tokenId: "p", g: 1, x: 11, y: 5 });
    assert.deepEqual(t.bree.got.slice(1), [
      { k: "dragMove", tokenId: "p", x: 11, y: 5 },
      { k: "dragMove", tokenId: "new", x: 13, y: 5 },
    ]);
  });
});

describe("lone frames, as an older page sends them", () => {
  test("go as before, each its own entry, and a lone end ends its token whatever gesture framed it", () => {
    const state = room();
    state.tokens.v = token("v", { x: 20, y: 5 });
    state.tokens.p = token("p", { x: 10, y: 5 });
    const t = stage(state);
    t.send({ k: "dragStart", tokenId: "v", x: 20, y: 5 } satisfies EphEvent);
    assert.deepEqual([...t.dm.conn.previewsSent.keys()], ["drag:v"]);
    t.send({ k: "dragStart", tokenId: "p", g: 1, x: 10, y: 5, ...roster([{ id: "v", at: { x: 20, y: 5 } }], { x: 10, y: 5 }) });
    assert.deepEqual([...t.dm.conn.previewsSent.keys()], ["drag#1"], "the gesture took V, and the lone entry had nothing left");
    t.send({ k: "dragCancel", tokenId: "v" } satisfies EphEvent);
    assert.deepEqual(t.bree.got.at(-1), { k: "dragCancel", tokenId: "v" });
    assert.ok(!t.bree.conn.previewsHeld.has("dm1|drag:v"));
  });
});
