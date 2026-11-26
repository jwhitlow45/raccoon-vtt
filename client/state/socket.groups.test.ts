import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FrameBudget } from "#server/rooms/budgets.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { clientMessageSchema, ephCaps, MAX_GROUP_MEMBERS, type ClientMessage, type ClientOp, type EphEvent, type GroupFrame, type PreviewPace, type ServerMessage } from "#shared/protocol.ts";
import { DM, rng, room, scene, token } from "#shared/testutil.ts";
import { TOWER, tower, UPPER } from "../features/floors/testing.ts";
import { createRoomActions } from "./actions.ts";
import { createRoomSocket, EPH_KEEPALIVE_MS, EPH_PER_SECOND, type DragMember, type SocketLike } from "./socket.ts";
import { createRoomStore } from "./store.ts";
import { FakeClock } from "./testing.ts";

/**
 * Drags as group frames (design 7.6): one frame per drag step for every
 * token the drag moves, each drag paced in a slot of its own, and what a
 * server that never says `takes` gets instead.
 */

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: { at: number; msg: ClientMessage; raw: string }[] = [];
  closedWith: number | null = null;
  readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push({ at: this.clock.now(), msg: JSON.parse(data) as ClientMessage, raw: data });
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

type Sent = { at: number; sceneId: string; e: EphEvent | GroupFrame; raw: string };

function setup(opts: { viewer?: Viewer; state?: RoomState; ephPerSecond?: () => number } = {}) {
  const viewer = opts.viewer ?? DM;
  const state = opts.state ?? room({ tokens: { g1: token("g1") } });
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const frames: (() => void)[] = [];
  const store = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => 0.5, clientId: "c1" });
  const socket = createRoomSocket({
    url: "ws://test/ws?room=R1",
    room: store,
    clock,
    random: () => 0.5,
    createSocket: () => {
      const s = new FakeSocket(clock);
      sockets.push(s);
      return s;
    },
    frame: (cb) => frames.push(cb),
    ...(opts.ephPerSecond ? { ephPerSecond: opts.ephPerSecond } : {}),
  });
  const last = () => sockets.at(-1)!;
  /** Opens the newest socket and answers its hello as a server does: `takes` (unless `pace` is null), then the snapshot. */
  const connect = (pace: PreviewPace | null = "full", sceneId = "s1") => {
    last().open();
    if (pace !== null) last().emit({ t: "takes", groups: true, pace });
    last().emit({
      t: "snapshot",
      seq: 0,
      state: projectState(state, viewer, { sceneId }),
      you: { ...viewer, sceneId },
      watermark: 0,
    });
    last().sent = [];
  };
  const runFrames = () => {
    for (const f of frames.splice(0)) f();
  };
  /** One display refresh: time moves on, then the frame's callbacks run. */
  const tick = (ms = 1000 / 60) => {
    clock.advance(ms);
    runFrames();
  };
  /** Every eph message sent on the newest socket since the last call. */
  const eph = (socket = last()): Sent[] => {
    const out = socket.sent.flatMap((s) => (s.msg.t === "eph" ? [{ at: s.at, sceneId: s.msg.sceneId, e: s.msg.e, raw: s.raw }] : []));
    socket.sent = socket.sent.filter((s) => s.msg.t !== "eph");
    return out;
  };
  return { clock, sockets, last, socket, store, connect, runFrames, tick, eph };
}

const members = (n: number, at = 10): DragMember[] => Array.from({ length: n }, (_, i) => ({ tokenId: `m${i}`, x: at + i, y: 5 }));

/** The drag frames among what was sent, as tagged group frames. */
const groupsOf = <T extends Sent>(sent: T[]) => sent.filter((s): s is T & { e: GroupFrame } => "g" in s.e);

function valid(sent: Sent): string | null {
  const parsed = clientMessageSchema.safeParse(JSON.parse(sent.raw));
  if (!parsed.success) return parsed.error.message;
  const bytes = new TextEncoder().encode(JSON.stringify((JSON.parse(sent.raw) as { e: unknown }).e)).length;
  if ("g" in sent.e && bytes > ("with" in sent.e ? ephCaps.roster : ephCaps.bare)) return `${bytes} bytes`;
  return null;
}

describe("drag frames to a server that takes groups", () => {
  test("a drag's first message names its members and its start, tagged with its drag, and a lone drag's names none", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
    s.runFrames();
    const [first] = s.eph();
    assert.deepEqual(first?.e, { k: "dragStart", tokenId: "g1", g: 0, x: 3, y: 3, with: [{ tokenId: "g2", x: 4, y: 3 }], from: { x: 3, y: 3 } });
    assert.equal(valid(first!), null);
    s.clock.advance(100);
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e), [{ k: "dragMove", tokenId: "g1", g: 0, x: 4, y: 3 }]);
    const lone = s.socket.startDrag("g3", { x: 1, y: 1 }, []);
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e), [{ k: "dragStart", tokenId: "g3", g: 1, x: 1, y: 1, with: [], from: { x: 1, y: 1 } }]);
    s.clock.advance(100);
    lone.end([{ x: 2, y: 1 }]);
    drag.cancel();
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e), [
      { k: "dragCancel", tokenId: "g1", g: 0 },
      { k: "groupEnd", tokenId: "g3", g: 1, at: [{ x: 2, y: 1 }] },
    ]);
  });

  test("a start then a move before the flush: the start goes first, naming the members, and the move after it, never replacing it", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(2));
    drag.move({ x: 3.5, y: 3 }, { x: 3, y: 3 }, members(2));
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(2));
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => [m.e.k, "with" in m.e]), [["dragStart", true]]);
    for (let i = 0; i < 4; i++) s.tick();
    assert.deepEqual(s.eph().map((m) => m.e), [{ k: "dragMove", tokenId: "g1", g: 0, x: 4, y: 3 }]);
  });

  test("an end waits for the move before it, and goes at the next due flush", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, []);
    s.runFrames();
    s.eph();
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, []);
    drag.end([{ x: 4, y: 3 }]);
    const kinds: [string, number][] = [];
    for (let i = 0; i < 8; i++) {
      s.tick();
      for (const m of s.eph()) kinds.push([m.e.k, m.at]);
    }
    assert.deepEqual(kinds.map(([k]) => k), ["dragMove", "groupEnd"]);
    assert.ok(kinds[1]![1] - kinds[0]![1] >= ((1000 / EPH_PER_SECOND) * 0.8), "a gap apart");
  });

  test("each drag sends at most 30 messages a second, however fast moves come", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(99));
    const times: number[] = [];
    for (let i = 0; i < 240; i++) {
      drag.move({ x: 3 + i / 100, y: 3, fts: Array.from({ length: 99 }, () => 5) }, { x: 3, y: 3 }, members(99));
      s.tick(1000 / 120);
      for (const m of s.eph()) times.push(m.at);
    }
    assert.ok(times.length >= EPH_PER_SECOND * 2 - 4, `${times.length} in 2 s`);
    for (let i = EPH_PER_SECOND; i < times.length; i++) assert.ok(times[i]! - times[i - EPH_PER_SECOND]! >= 1000, "never more than 30 within one second");
  });

  test("a drag held still repeats its last frame, and stops once ended", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(1));
    s.runFrames();
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(1));
    s.tick(40);
    s.eph();
    s.clock.advance(EPH_KEEPALIVE_MS);
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e), [{ k: "dragMove", tokenId: "g1", g: 0, x: 4, y: 3 }]);
    drag.end([null, null]);
    s.tick(40);
    assert.deepEqual(s.eph().map((m) => m.e.k), ["groupEnd"]);
    s.clock.advance(EPH_KEEPALIVE_MS * 3);
    s.runFrames();
    assert.deepEqual(s.eph(), []);
  });

  test("a step after a token's own spot moved names the members again, from where they stand now", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(1));
    s.runFrames();
    s.tick(40);
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(1));
    s.tick(40);
    drag.move({ x: 5, y: 3 }, { x: 3, y: 4 }, members(1));
    s.tick(40);
    drag.move({ x: 6, y: 3 }, { x: 3, y: 4 }, members(1));
    s.tick(40);
    assert.deepEqual(s.eph().map((m) => [m.e.k, "with" in m.e ? (m.e as { from: unknown }).from : null]), [
      ["dragStart", { x: 3, y: 3 }],
      ["dragMove", null],
      ["dragMove", { x: 3, y: 4 }],
      ["dragMove", null],
    ]);
  });

  test("a need names the drag's members on its next message, once", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(3));
    s.runFrames();
    s.eph();
    s.last().emit({ t: "need", id: "g1", g: 0 });
    // A need for another drag, or naming another token, names nothing.
    s.last().emit({ t: "need", id: "g2", g: 0 });
    s.last().emit({ t: "need", id: "g1", g: 7 });
    for (const x of [4, 5]) {
      s.tick(40);
      drag.move({ x, y: 3 }, { x: 3, y: 3 }, members(3));
      s.tick(40);
    }
    assert.deepEqual(s.eph().map((m) => "with" in m.e), [true, false]);
    s.last().emit({ t: "need", id: "g1", g: 0 });
    // At rest, the keepalive is the next message.
    s.clock.advance(EPH_KEEPALIVE_MS * 2);
    s.runFrames();
    const [kept] = s.eph();
    assert.equal(kept?.e.k, "dragMove");
    assert.ok(kept && "with" in kept.e);
  });

  test("a drag that goes on past a floor switch ends on the old floor in the same flush, then names its members on the new one, and again back on the first", () => {
    const state = tower({ tokens: { g1: token("g1", { sceneId: TOWER }) } });
    const s = setup({ state });
    s.socket.start();
    s.connect("full", TOWER);
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(2));
    s.runFrames();
    s.eph();
    s.store.showFloor(UPPER);
    s.tick(40);
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(2));
    s.runFrames();
    const switched = s.eph();
    assert.deepEqual(switched.map((m) => [m.sceneId, m.e.k, "with" in m.e]), [
      [TOWER, "dragCancel", false],
      [UPPER, "dragMove", true],
    ]);
    assert.equal(switched[0]!.at, switched[1]!.at, "in the same flush");
    assert.deepEqual(switched[0]!.e, { k: "dragCancel", tokenId: "g1", g: 0 });
    s.store.showFloor(TOWER);
    s.tick(40);
    drag.move({ x: 5, y: 3 }, { x: 3, y: 3 }, members(2));
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => [m.sceneId, m.e.k, "with" in m.e]), [
      [UPPER, "dragCancel", false],
      [TOWER, "dragMove", true],
    ]);
    s.tick(40);
    drag.end([null, null, null]);
    s.tick(40);
    assert.deepEqual(s.eph().map((m) => [m.sceneId, m.e.k]), [[TOWER, "groupEnd"]]);
  });

  test("a floor switch before anything went on the old floor ends nothing there", () => {
    const state = tower({ tokens: { g1: token("g1", { sceneId: TOWER }) } });
    const s = setup({ state });
    s.socket.start();
    s.connect("full", TOWER);
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(1));
    s.store.showFloor(UPPER);
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(1));
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => [m.sceneId, m.e.k, "with" in m.e]), [[UPPER, "dragMove", true]]);
  });

  test("a reconnect drops queued ends, and a drag in progress goes on on the new socket, its first message there naming its members", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const ended = s.socket.startDrag("g2", { x: 1, y: 1 }, []);
    const live = s.socket.startDrag("g1", { x: 3, y: 3 }, members(2));
    s.runFrames();
    s.eph();
    ended.end([{ x: 2, y: 1 }]);
    live.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(2));
    s.last().drop(1006);
    s.clock.advance(1_000);
    s.connect();
    s.runFrames();
    // At rest the keepalive is the first message, a move at the drag's point.
    s.clock.advance(EPH_KEEPALIVE_MS);
    s.runFrames();
    const sent = s.eph();
    assert.deepEqual(sent.map((m) => m.e), [{ k: "dragMove", tokenId: "g1", g: 1, x: 4, y: 3, with: members(2), from: { x: 3, y: 3 } }]);
  });

  test("an old drag's end still goes when a new drag of the same token starts before it", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    const first = s.socket.startDrag("g1", { x: 3, y: 3 }, []);
    s.runFrames();
    s.eph();
    first.move({ x: 4, y: 3 }, { x: 3, y: 3 }, []);
    first.end([{ x: 4, y: 3 }]);
    s.socket.startDrag("g1", { x: 4, y: 3 }, []);
    const sent: Sent[] = [];
    for (let i = 0; i < 6; i++) {
      s.tick();
      sent.push(...s.eph());
    }
    assert.deepEqual(sent.map((m) => [(m.e as GroupFrame).g, m.e.k]).sort(), [
      [0, "dragMove"],
      [0, "groupEnd"],
      [1, "dragStart"],
    ]);
  });

  test("at the off pace no drag, ruler or area goes, the camera, laser and pings do, and a raised pace sends a drag from its next frame, naming its members", () => {
    const s = setup();
    s.socket.start();
    s.connect("off");
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(2));
    s.socket.sendEph({ k: "ruler", id: "r1", points: [{ x: 1, y: 1 }] });
    s.socket.sendEph({ k: "aoe", id: "a1", shape: "sphere", origin: { x: 2, y: 2, z: 0 }, yaw: 0, size: 20 });
    s.socket.sendEph({ k: "laser", x: 1, y: 1, on: true });
    s.socket.sendEph({ k: "ping", x: 1, y: 1 });
    s.socket.sendEph({ k: "view", x: 1, y: 1, w: 10, h: 10 });
    s.runFrames();
    drag.move({ x: 4, y: 3 }, { x: 3, y: 3 }, members(2));
    s.tick(40);
    s.clock.advance(EPH_KEEPALIVE_MS * 2);
    s.runFrames();
    assert.deepEqual([...new Set(s.eph().map((m) => m.e.k))].sort(), ["laser", "ping", "view"]);
    s.last().emit({ t: "takes", groups: true, pace: "full" });
    drag.move({ x: 5, y: 3 }, { x: 3, y: 3 }, members(2));
    s.tick(40);
    const raised = s.eph();
    assert.deepEqual(raised.map((m) => [m.e.k, "with" in m.e]), [["dragMove", true]]);
    // The ruler held on screen goes again at its keepalive.
    s.clock.advance(EPH_KEEPALIVE_MS);
    s.runFrames();
    assert.ok(s.eph().some((m) => m.e.k === "ruler"));
  });

  test("a lone token's frame from the page goes nowhere on such a server: a drag goes only as a group", () => {
    const s = setup();
    s.socket.start();
    s.connect();
    s.socket.sendEph({ k: "dragMove", tokenId: "g1", x: 3, y: 3 });
    s.runFrames();
    assert.deepEqual(s.eph(), []);
  });

  test("an op queued at a drag's end goes at the same moment however many members the drag has", () => {
    /** A fog draft of about `kib` KiB, as a band of a Builder room is. */
    const fogDraft = (k: number, kib: number): ClientOp => {
      const cells = Array.from({ length: Math.round((kib * 1024) / 8) }, (_, i) => `${i % 40},${Math.floor(i / 40) % 30}`);
      const add = [];
      for (let at = 0; at < cells.length; at += 2_000) add.push({ id: `f${k}.${at}`, mode: "reveal" as const, shape: { kind: "cells" as const, cells: cells.slice(at, at + 2_000) } });
      return { t: "fog.draft", sceneId: "s1", add };
    };
    const sentAt = (k: number) => {
      const s = setup();
      s.socket.start();
      s.connect();
      // Ops past the outbox's whole budget, as a Builder room sends, so what waits goes as bytes free up.
      for (let i = 0; i < 12; i++) s.store.dispatch(fogDraft(i, 60));
      const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, members(k));
      for (let i = 0; i < 60; i++) {
        drag.move({ x: 3 + i / 10, y: 3, ...(k > 0 ? { fts: Array.from({ length: k }, () => 30) } : {}) }, { x: 3, y: 3 }, members(k));
        // Each step names the members again.
        s.last().emit({ t: "need", id: "g1", g: 0 });
        s.tick();
      }
      drag.end(Array.from({ length: k + 1 }, () => null));
      const n = s.store.dispatch({ t: "log.chat", text: "after" });
      for (let i = 0; i < 240; i++) s.tick();
      return s.last().sent.find((m) => m.msg.t === "op" && m.msg.n === n)?.at;
    };
    const lone = sentAt(0);
    assert.notEqual(lone, undefined);
    assert.ok(lone! > 1000, `the op waited on the outbox budget, sent at ${lone}`);
    assert.equal(sentAt(MAX_GROUP_MEMBERS), lone);
  });
});

describe("a drag's frames keep their own pace", () => {
  /**
   * V's drag as the page sends it with `extra` driving the rest of the page
   * beside it, at 60 refreshes a second: the time and kind of every V message.
   */
  function vStream(extra: (s: ReturnType<typeof setup>, t: number) => void, opts: { members: number; rate?: number }) {
    const s = setup(opts.rate ? { ephPerSecond: () => opts.rate! } : {});
    s.socket.start();
    s.connect();
    const out: [number, string, number][] = [];
    let drag: ReturnType<typeof s.socket.startDrag> | null = null;
    const roster = members(opts.members);
    for (let t = 0; t < 240; t++) {
      extra(s, t);
      if (t === 20) drag = s.socket.startDrag("v", { x: 3, y: 3 }, roster);
      // Moves for a second and a half, a rest past the keepalive, then the drop.
      if (drag && t > 20 && t < 110) drag.move({ x: 3 + t / 50, y: 3 }, { x: 3, y: 3 }, roster);
      if (drag && t === 220) drag.end([{ x: 5, y: 3 }, ...roster.map(() => null)]);
      s.tick();
      for (const m of s.eph()) if (m.e.k !== "ping" && "tokenId" in m.e && m.e.tokenId === "v") out.push([m.at, m.e.k, "x" in m.e ? m.e.x : 0]);
    }
    return out;
  }

  test("the same flushes for a drag of one token and a drag of a hundred, beside other drags, a held ruler and pings, and in low power", () => {
    for (const rate of [EPH_PER_SECOND, 15]) {
      const lone = vStream(() => {}, { members: 0, rate });
      assert.ok(lone.length > 20);
      const busy = vStream(
        (s, t) => {
          // A drag that ends just before V's starts, then two more that start beside it.
          if (t === 2) (s as unknown as { a: unknown }).a = s.socket.startDrag("a", { x: 1, y: 1 }, members(99, 40));
          const a = (s as unknown as { a?: { move: (...x: unknown[]) => void; end: (x: unknown) => void } }).a;
          if (a && t > 2 && t < 19) a.move({ x: 1 + t / 50, y: 1 }, { x: 1, y: 1 }, members(99, 40));
          if (a && t === 19) a.end(Array.from({ length: 100 }, () => null));
          if (t === 25 || t === 30) {
            const b = s.socket.startDrag(`b${t}`, { x: 2, y: 2 }, members(50, 200));
            for (let i = 1; i < 30; i++) s.clock.setTimeout(() => b.move({ x: 2 + i / 10, y: 2 }, { x: 2, y: 2 }, members(50, 200)), i * 7);
          }
          if (t === 5) s.socket.sendEph({ k: "ruler", id: "r1", points: [{ x: 1, y: 1, tokenId: "a" }, { x: 9, y: 9 }] });
          if (t % 13 === 0) s.socket.sendEph({ k: "ping", x: t, y: 1 });
          if (t % 3 === 0) s.socket.sendEph({ k: "laser", x: t, y: 1, on: true });
        },
        { members: 99, rate },
      );
      assert.deepEqual(busy, lone, `at ${rate} a second`);
    }
  });
});

describe("a server that never says takes", () => {
  test("gets each token's own frames, under one window for every preview, as before", () => {
    const s = setup();
    s.socket.start();
    s.connect(null);
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e), [
      { k: "dragStart", tokenId: "g1", x: 3, y: 3 },
      { k: "dragStart", tokenId: "g2", x: 4, y: 3 },
    ]);
    const times: number[] = [];
    for (let i = 0; i < 120; i++) {
      drag.move({ x: 3 + i / 100, y: 3, fts: [5] }, { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
      s.socket.sendEph({ k: "laser", x: i, y: 1, on: true });
      s.tick(1000 / 120);
      for (const m of s.eph()) times.push(m.at);
    }
    for (let i = EPH_PER_SECOND; i < times.length; i++) assert.ok(times[i]! - times[i - EPH_PER_SECOND]! >= 1000, "never more than 30 within one second, all previews together");
    s.tick(100);
    s.eph();
    drag.end([{ x: 5, y: 3 }, null]);
    s.tick(100);
    assert.deepEqual(s.eph().map((m) => m.e), [
      { k: "dragEnd", tokenId: "g1", x: 5, y: 3 },
      { k: "dragCancel", tokenId: "g2" },
    ]);
  });

  test("a token whose own frame fails the lone check is left out alone", () => {
    const s = setup();
    s.socket.start();
    s.connect(null);
    const errors: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      s.socket.startDrag("g1", { x: 3, y: 3 }, [{ tokenId: "g2", x: 1e9, y: 3 }, { tokenId: "g3", x: 4, y: 3 }]);
      s.runFrames();
    } finally {
      console.error = error;
    }
    assert.deepEqual(s.eph().map((m) => (m.e as { tokenId: string }).tokenId), ["g1", "g3"]);
    assert.equal(errors.length, 1);
  });

  test("a new server and then an old one on reconnect: nothing it said carries over", () => {
    const s = setup();
    s.socket.start();
    s.connect("off");
    s.last().drop(1012);
    s.clock.advance(1);
    s.connect(null);
    const drag = s.socket.startDrag("g1", { x: 3, y: 3 }, []);
    s.socket.sendEph({ k: "ruler", id: "r1", points: [{ x: 1, y: 1 }] });
    s.runFrames();
    assert.deepEqual(s.eph().map((m) => m.e.k).sort(), ["dragStart", "ruler"]);
    assert.ok(s.eph().every((m) => !("g" in m.e)));
    drag.cancel();
    assert.equal(s.last().closedWith, null);
  });

  test("a carrier without a socket of its own gets each token's own frames through the room's checks", () => {
    const sent: EphEvent[] = [];
    const store = createRoomStore({ roomId: "R1", you: DM, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
    const actions = createRoomActions(store, { sendEph: (e) => void sent.push(e), switchScene: () => {} });
    const drag = actions.startDrag("g1", { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
    drag.move({ x: 4, y: 3, fts: [10] }, { x: 3, y: 3 }, [{ tokenId: "g2", x: 4, y: 3 }]);
    drag.end([{ x: 4, y: 3 }, null]);
    drag.cancel();
    assert.deepEqual(sent, [
      { k: "dragStart", tokenId: "g1", x: 3, y: 3 },
      { k: "dragStart", tokenId: "g2", x: 4, y: 3 },
      { k: "dragMove", tokenId: "g1", x: 4, y: 3 },
      { k: "dragMove", tokenId: "g2", x: 5, y: 3, ft: 10 },
      { k: "dragEnd", tokenId: "g1", x: 4, y: 3 },
      { k: "dragCancel", tokenId: "g2" },
    ]);
  });
});

describe("random drags, ends, floor switches, reconnects and needs", () => {
  test("every end of a socket that stays goes, an old floor's cancel goes first, each drag sends at most 30 a second, and every message is valid", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const state = tower({ tokens: { g1: token("g1", { sceneId: TOWER }) } });
      state.scenes.keep = scene("keep", { name: "Keep" });
      const s = setup({ state, ...(seed % 4 === 0 ? { ephPerSecond: () => 15 } : {}) });
      s.socket.start();
      s.connect("full", TOWER);
      type Live = { drag: ReturnType<typeof s.socket.startDrag>; id: string; members: DragMember[]; ended: boolean; endedOn: number };
      const live: Live[] = [];
      let n = 0;
      let socketIndex = 0;
      const all: (Sent & { socket: number })[] = [];
      const collect = () => {
        for (const m of s.eph()) all.push({ ...m, socket: socketIndex });
      };
      for (let step = 0; step < 300; step++) {
        const roll = r();
        const open = live.filter((d) => !d.ended);
        if (roll < 0.08 || open.length === 0) {
          const k = Math.floor(r() ** 2 * (MAX_GROUP_MEMBERS + 1));
          const ms = members(k, 20 + n);
          const id = `t${n++}`;
          live.push({ drag: s.socket.startDrag(id, { x: 2, y: 2 }, ms), id, members: ms, ended: false, endedOn: -1 });
        } else if (roll < 0.6) {
          const d = open[Math.floor(r() * open.length)]!;
          d.drag.move({ x: 2 + r() * 10, y: 2 + r() * 10, ...(r() < 0.5 && d.members.length > 0 ? { fts: d.members.map(() => (r() < 0.5 ? null : Math.round(r() * 60))) } : {}) }, { x: 2, y: 2 }, d.members);
        } else if (roll < 0.68) {
          const d = open[Math.floor(r() * open.length)]!;
          d.ended = true;
          d.endedOn = socketIndex;
          if (r() < 0.5) d.drag.cancel();
          else d.drag.end([null, ...d.members.map(() => (r() < 0.5 ? null : { x: r() * 10, y: r() * 10 }))]);
        } else if (roll < 0.74) {
          s.store.showFloor(r() < 0.5 ? UPPER : TOWER);
        } else if (roll < 0.77) {
          collect();
          s.last().drop(1006);
          s.clock.advance(300);
          s.connect("full", TOWER);
          socketIndex++;
        } else if (roll < 0.82) {
          const d = open[Math.floor(r() * open.length)];
          if (d) s.last().emit({ t: "need", id: d.id, g: live.indexOf(d) });
        }
        s.tick(r() * 40);
        collect();
      }
      for (let i = 0; i < 200; i++) s.tick();
      collect();
      const where = `seed ${seed}`;
      for (const m of all) assert.equal(valid(m), null, `${where}: ${m.raw.slice(0, 120)}`);
      const groups = groupsOf(all);
      // Every end called on the socket that stayed went, as its drag's last message there.
      for (const d of live) {
        if (!d.ended || d.endedOn !== socketIndex) continue;
        const g = live.indexOf(d);
        const last = groups.filter((m) => m.socket === socketIndex && m.e.g === g).at(-1);
        assert.ok(last && (last.e.k === "groupEnd" || last.e.k === "dragCancel"), `${where}: drag ${g}'s end never went`);
      }
      const bySlot = new Map<string, (Sent & { socket: number; e: GroupFrame })[]>();
      for (const m of groups) {
        const key = `${m.socket}:${m.e.tokenId}#${m.e.g}`;
        bySlot.set(key, [...(bySlot.get(key) ?? []), m]);
      }
      const rate = seed % 4 === 0 ? 15 : EPH_PER_SECOND;
      for (const [key, msgs] of bySlot) {
        for (let i = rate; i < msgs.length; i++) assert.ok(msgs[i]!.at - msgs[i - rate]!.at >= 1000, `${where}: ${key} sent more than ${rate} within a second`);
        // The first message on a socket names the members, and so does the first on each new floor.
        assert.ok("with" in msgs[0]!.e, `${where}: ${key} began without its members`);
        for (let i = 1; i < msgs.length; i++) {
          const [was, now] = [msgs[i - 1]!, msgs[i]!];
          if (now.sceneId !== was.sceneId) {
            assert.ok("with" in now.e, `${where}: ${key} on a new floor without its members`);
            assert.ok(was.e.k === "dragCancel" && was.at === now.at, `${where}: ${key} left a floor without its cancel first`);
          }
          assert.ok(was.e.k !== "groupEnd" && !(was.e.k === "dragCancel" && was.sceneId === now.sceneId), `${where}: ${key} sent after its end`);
        }
      }
    }
  });
});
