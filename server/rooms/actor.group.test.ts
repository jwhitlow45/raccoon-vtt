import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { Member } from "#shared/model.ts";
import { clientMessageSchema, type EphEvent, type EphEventOut, type GroupFrame, type ServerMessage } from "#shared/protocol.ts";
import { scene, token } from "#shared/testutil.ts";
import { MAX_ROOM_HELD_SENDS, MEMBER_HELD_SHARE, RETAIN_MS, RoomActor, type ActorDeps } from "./actor.ts";
import { PreviewPool, SnapshotBudget } from "./budgets.ts";
import { CLOSE, Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { MOST_PREVIEWS_SENT } from "./ephemeral.ts";
import { CANCEL_SENDS, CANCELS_SENDS, heldSends, HONEST_MEMBER_SENDS, MAX_VERSIONS } from "./gestures.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, turnsUntil, until } from "./undoScopeTesting.ts";

/*
 * Group drag frames through the room (design 7.6): bound to their roster as
 * they arrive, held with it while their tick is not covered, and routed by
 * it; the preview pool's share each socket takes at its hello, and the
 * hello that replaces a socket of the same client.
 */

const T0 = Date.parse("2026-11-26T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

class Gate {
  started = 0;
  #shut: { promise: Promise<void>; open: () => void } | null = null;
  shut(): void {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    this.#shut = { promise, open };
  }
  open(): void {
    this.#shut?.open();
    this.#shut = null;
  }
  async pass(): Promise<void> {
    this.started++;
    if (this.#shut) await this.#shut.promise;
  }
}

/** The scope room with five creatures beside the Goblin and a vault no player holds, and a pool of the test's own. */
async function room(t: TestContext, opts: { pool?: PreviewPool; prepare?: (f: ReturnType<typeof scopeFixture>) => void } = {}) {
  const f = scopeFixture();
  f.state.scenes.vault = scene("vault", { order: 9, fogEnabled: false });
  for (let i = 0; i < 5; i++) f.state.tokens[`m${i}`] = token(`m${i}`, { sceneId: f.sceneId, x: 10 + i, y: 10 });
  opts.prepare?.(f);
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const pool = opts.pool ?? new PreviewPool();
  const deps: ActorDeps = {
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget({}, now),
    previews: pool,
    gateway: {} as RoomGateway,
    options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomOpsPerSec: 10_000, now, numberClock: null, standingClock: true, previewSweepMs: null },
  };
  const actor = await RoomActor.load(deps);
  assert.ok(actor);
  const gate = new Gate();
  t.after(() => {
    t.mock.timers.reset();
    gate.open();
    db.beforeCommit = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  const dm = await ScopeClient.open(actor, f.dm, "dm", now);
  const p1 = await ScopeClient.open(actor, f.player, "player", now);
  db.beforeCommit = () => gate.pass();
  return { f, clock, db, actor, dm, p1, now, gate, pool };
}
type Room = Awaited<ReturnType<typeof room>>;

/** A socket of the test's own: its session and client as given, what it was sent, and the code it was closed with. */
function socketOf(r: Room, who: Member, role: "dm" | "player", sessionId = uuidv7(), as: { display?: true; previewOf?: string } = {}) {
  const sent: ServerMessage[] = [];
  let closedWith: number | null = null;
  const socket = {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: (text: string) => sent.push(JSON.parse(text) as ServerMessage),
    close: (code: number) => void (closedWith = code),
    terminate() {},
  };
  const conn = new Connection(socket as never, { sessionId, roomId: "UNDOSCOPE", memberId: who.id, role, ...as }, "203.0.113.9", { now: r.now });
  r.actor.attach(conn);
  return { conn, sent, closed: () => closedWith };
}

/** A hello as the socket layer passes it on, answered once the room has taken it: by its snapshot or its close, or, `queued`, once it is in the queue. */
async function hello(r: Room, s: ReturnType<typeof socketOf>, clientId: string, takes = true, queued = false): Promise<void> {
  s.conn.takesFrames = takes;
  s.conn.helloAllowed = false;
  s.conn.helloPending = true;
  const snapshots = s.sent.filter((m) => m.t === "snapshot").length;
  await r.actor.hello(s.conn, { clientId, resumeFrom: 1 });
  if (queued) return;
  await turnsUntil(() => s.conn.closed || s.sent.filter((m) => m.t === "snapshot").length > snapshots, "snapshot or close");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

function moveTo(t: TestContext, clock: { now: number }, at: number): void {
  const by = at - clock.now;
  assert.ok(by >= 0);
  clock.now = at;
  t.mock.timers.tick(by);
}

/** A batch at T + 20 whose commit waits on the gate, so every frame after it is held until the gate opens. */
async function heldBatch(t: TestContext, r: Room, T: number): Promise<void> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.gate.shut();
  moveTo(t, r.clock, T + 5);
  void r.actor.op(r.p1.conn, ++r.p1.n, { t: "log.chat", text: "held" });
  await flush();
  moveTo(t, r.clock, T + 20);
  await flush();
  assert.equal(r.gate.started, 1, "the batch at T + 20 is committing");
}

/** A frame as the socket layer parses it and hands it to the room. */
function send(r: Room, conn: Connection, e: unknown, sceneId = r.f.sceneId): void {
  const parsed = clientMessageSchema.safeParse({ t: "eph", sceneId, e });
  assert.ok(parsed.success && parsed.data.t === "eph", JSON.stringify(parsed.error?.issues));
  r.actor.ephemeral(conn, { sceneId, e: parsed.data.e as EphEvent | GroupFrame });
}

const ephs = (sent: readonly unknown[]): EphEventOut[] => (sent as ServerMessage[]).flatMap((m) => (m.t === "eph" ? [m.e] : []));
const needs = (sent: readonly ServerMessage[]) => sent.filter((m) => m.t === "need");

describe("group frames held for their tick", () => {
  test("each held frame expands by the roster it bound: drags 200 ms apart, floors A to B to A, and an end while its frames wait", async (t) => {
    const r = await room(t, { prepare: (f) => {
      for (let g = 1; g <= 3; g++) {
        f.state.tokens[`p${g}`] = token(`p${g}`, { sceneId: f.sceneId, x: 10 + g, y: 14 });
        f.state.tokens[`q${g}`] = token(`q${g}`, { sceneId: f.sceneId, x: 20 + g, y: 14 });
      }
    } });
    // Two DM members' devices, each within its member's share of the room's count.
    const dm = socketOf(r, r.f.dm, "dm");
    const other = socketOf(r, r.f.otherDm, "dm");
    await hello(r, dm, uuidv7());
    await hello(r, other, uuidv7());
    const A = r.f.sceneId;
    // Each drag starts before the tick that waits, by a roster of its own.
    for (let g = 1; g <= 3; g++) send(r, dm.conn, { k: "dragStart", tokenId: `p${g}`, g, x: 10 + g, y: 14, with: [{ tokenId: `q${g}`, x: 20 + g, y: 14 }], from: { x: 10 + g, y: 14 } });
    send(r, other.conn, { k: "dragStart", tokenId: r.f.goblin, g: 6, x: 0, y: 0, with: [{ tokenId: "m0", x: 10, y: 10 }], from: { x: 0, y: 0 } });
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    const from = r.p1.sent.length;
    for (let g = 1; g <= 3; g++) {
      moveTo(t, r.clock, T + 21 + (g - 1) * 200);
      send(r, dm.conn, { k: "dragMove", tokenId: `p${g}`, g, x: 11 + g, y: 14 });
      // The end comes while the move before it still waits.
      send(r, dm.conn, { k: "groupEnd", tokenId: `p${g}`, g, at: [null, null] });
    }
    // Floors A to B to A within the one gesture: the old floor's cancel and the new floor's roster, each in one flush.
    send(r, other.conn, { k: "dragMove", tokenId: r.f.goblin, g: 6, x: 1, y: 0 }, A);
    send(r, other.conn, { k: "dragCancel", tokenId: r.f.goblin, g: 6 }, A);
    send(r, other.conn, { k: "dragMove", tokenId: r.f.goblin, g: 6, x: 2, y: 0, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 0, y: 0 } }, "vault");
    send(r, other.conn, { k: "dragCancel", tokenId: r.f.goblin, g: 6 }, "vault");
    send(r, other.conn, { k: "dragMove", tokenId: r.f.goblin, g: 6, x: 3, y: 0, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 0, y: 0 } }, A);
    send(r, other.conn, { k: "dragMove", tokenId: r.f.goblin, g: 6, x: 4, y: 0 }, A);
    send(r, other.conn, { k: "groupEnd", tokenId: r.f.goblin, g: 6, at: [null, null] });
    assert.deepEqual([r.actor.heldOf(dm.conn).frames, r.actor.heldOf(other.conn).frames], [6, 7], "all held");
    r.gate.open();
    await flush();
    const got = ephs(r.p1.sent.slice(from));
    for (let g = 1; g <= 3; g++) {
      assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === `q${g}` && e.x === 21 + g), `drag ${g} moved q${g} by its own roster`);
      assert.ok(got.some((e) => e.k === "dragCancel" && e.tokenId === `q${g}`), `drag ${g} ended with no landing`);
    }
    // On the return to A the return's roster stands: m2 by its offset, never the gesture's first member.
    assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === "m2" && e.x === 15));
    assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === "m2" && e.x === 16), "the frame after the return expands by it too");
    assert.deepEqual([...needs(dm.sent), ...needs(other.sent)], [], "no roster was asked for");
    assert.deepEqual([dm.conn.gestures.retained, other.conn.gestures.retained], [{ versions: 0, bytes: 0 }, { versions: 0, bytes: 0 }], "every ended gesture's rosters went once their frames routed");
  });

  test("frames released at one tick go to each receiver together, once every one of them is routed", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    const order: string[] = [];
    for (const [name, conn] of [["dm", r.dm.conn], ["p1", r.p1.conn]] as const) {
      const real = conn.send.bind(conn);
      conn.send = (msg) => {
        if (msg.t === "eph") order.push(name);
        return real(msg);
      };
    }
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } });
    send(r, dm.conn, { k: "dragStart", tokenId: "m2", g: 2, x: 12, y: 10, with: [{ tokenId: "m3", x: 13, y: 10 }], from: { x: 12, y: 10 } });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2);
    r.gate.open();
    await flush();
    assert.deepEqual(order, ["dm", "dm", "dm", "dm", "p1", "p1", "p1", "p1"]);
  });

  test("rosters past the member's share: retained charges stay within their cap, the frames past it drop, and a gesture whose roster went recovers by `need`", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const start = (g: number) => ({ k: "dragStart", tokenId: r.f.goblin, g, x: 0, y: 0, with: Array.from({ length: 99 }, (_, i) => ({ tokenId: `ghost-${g}-${i}`, x: i, y: 0 })), from: { x: 0, y: 0 } });
    for (let g = 1; g <= 40; g++) {
      send(r, dm.conn, start(g));
      assert.ok(dm.conn.gestures.retained.versions <= MAX_VERSIONS && dm.conn.gestures.retained.bytes <= 448 * 1024);
    }
    const fit = Math.floor(MEMBER_HELD_SHARE / heldSends(start(1) as GroupFrame));
    assert.equal(r.actor.heldOf(dm.conn).frames, fit, "a frame past its member's share is dropped");
    r.gate.open();
    await flush();
    // The first dropped gesture's roster went to make room for later ones: its next frame expands its pressed token alone and asks again.
    const g = fit + 1;
    send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 1, y: 0 });
    assert.deepEqual(needs(dm.sent), [{ t: "need", id: r.f.goblin, g }]);
    send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 2, y: 0, with: [{ tokenId: "m0", x: 10, y: 10 }], from: { x: 0, y: 0 } });
    assert.deepEqual(ephs(r.p1.sent).at(-1), { k: "dragMove", tokenId: "m0", x: 12, y: 10 });
  });

  test("hidden members with plain ids against escaped ones, through an uncovered tick: the same charges and verdicts, and V's next gesture starts", async (t) => {
    const runs: unknown[][] = [];
    for (const id of [(i: number) => `h${i}`, (i: number) => `\u0001"\\ ${i}`.padEnd(64, "一")]) {
      const r = await room(t, { prepare: (f) => {
        for (let i = 0; i < 99; i++) f.state.tokens[id(i)] = token(id(i), { sceneId: f.sceneId, x: i % 20, y: 20, visibility: "dm" });
      } });
      const dm = socketOf(r, r.f.dm, "dm");
      await hello(r, dm, uuidv7());
      const T = T0 + 1_000;
      await heldBatch(t, r, T);
      const marks: unknown[] = [];
      const from = r.p1.sent.length;
      for (let g = 1; g <= 20; g++) {
        moveTo(t, r.clock, T + 21 + g * 33);
        send(r, dm.conn, { k: "dragStart", tokenId: "m0", g, x: 10, y: 10, with: Array.from({ length: 99 }, (_, i) => ({ tokenId: id(i), x: i % 20, y: 20 })), from: { x: 10, y: 10 } });
        send(r, dm.conn, { k: "dragMove", tokenId: "m0", g, x: 11, y: 10, fts: Array.from({ length: 99 }, () => 5) });
        marks.push(r.actor.heldOf(dm.conn), dm.conn.gestures.retained);
      }
      r.gate.open();
      await flush();
      // V's next gesture, after the flood.
      send(r, dm.conn, { k: "dragStart", tokenId: "m1", g: 21, x: 11, y: 10, with: [], from: { x: 11, y: 10 } });
      marks.push(ephs(r.p1.sent.slice(from)));
      runs.push(marks);
      t.mock.timers.reset();
    }
    assert.deepEqual(runs[0], runs[1]);
    assert.deepEqual((runs[0]!.at(-1) as EphEventOut[]).at(-1), { k: "dragStart", tokenId: "m1", x: 11, y: 10 });
  });
});

describe("held frames of one slot while their tick waits (D-261126-208)", () => {
  /** A DM device of the test's own whose frames wait through a batch at T + 20 that commits once the gate opens, after `before` routes at once. */
  async function held(t: TestContext, before?: (r: Room, dm: Connection) => void) {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    before?.(r, dm.conn);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const from = r.p1.sent.length;
    const release = async () => {
      r.gate.open();
      await flush();
      return ephs(r.p1.sent.slice(from));
    };
    return { r, dm, release };
  }
  const start = (g: number, at: number) => ({ k: "dragStart", tokenId: "m0", g, x: at, y: 10, with: [{ tokenId: "m1", x: at + 1, y: 10 }], from: { x: at, y: 10 } });
  const move = (g: number, x: number) => ({ k: "dragMove", tokenId: "m0", g, x, y: 10 });

  test("each newer move takes the older one's place, and starts and ends keep theirs, gesture by gesture", async (t) => {
    // The first gesture's start goes before the tick waits, so its end waits after its moves.
    const { r, dm, release } = await held(t, (r, dm) => send(r, dm, start(1, 10)));
    for (let x = 11; x <= 15; x++) send(r, dm.conn, move(1, x));
    send(r, dm.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 15, y: 10 }, { x: 16, y: 10 }] });
    send(r, dm.conn, start(2, 15));
    for (let x = 16; x <= 18; x++) send(r, dm.conn, move(2, x));
    assert.equal(r.actor.heldOf(dm.conn).frames, 4, "the first gesture's latest move and its end, then a start and its latest move");
    const sends = (e: unknown) => heldSends(e as GroupFrame);
    const counted = 2 * sends(move(1, 0)) + sends({ k: "groupEnd", g: 1 }) + sends(start(2, 0));
    assert.deepEqual([r.actor.heldOf(dm.conn).memberSends, r.actor.heldOf(dm.conn).roomSends], [counted, counted]);
    const got = await release();
    assert.deepEqual([r.actor.heldOf(dm.conn).memberSends, r.actor.heldOf(dm.conn).roomSends], [0, 0], "what routed counts no more");
    assert.deepEqual(got, [
      { k: "dragMove", tokenId: "m0", x: 15, y: 10 },
      { k: "dragMove", tokenId: "m1", x: 16, y: 10 },
      { k: "dragEnd", tokenId: "m0", x: 15, y: 10 },
      { k: "dragEnd", tokenId: "m1", x: 16, y: 10 },
      { k: "dragStart", tokenId: "m0", x: 15, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 16, y: 10 },
      { k: "dragMove", tokenId: "m0", x: 18, y: 10 },
      { k: "dragMove", tokenId: "m1", x: 19, y: 10 },
    ]);
  });

  test("a move that carries a roster takes a plain move's place and stays, and the rosters the replaced moves bound are let go", async (t) => {
    const { r, dm, release } = await held(t);
    send(r, dm.conn, start(1, 10));
    send(r, dm.conn, move(1, 11));
    send(r, dm.conn, move(1, 12));
    // A new roster on the move after them, then plain moves under it.
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 13, y: 10, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 10, y: 10 } });
    send(r, dm.conn, move(1, 14));
    send(r, dm.conn, move(1, 15));
    assert.equal(r.actor.heldOf(dm.conn).frames, 3, "the start, the move with its roster, and the latest move");
    const sends = (e: unknown) => heldSends(e as GroupFrame);
    assert.equal(r.actor.heldOf(dm.conn).memberSends, sends(start(1, 0)) + sends(move(1, 0)) + CANCELS_SENDS + sends(move(1, 0)), "the new roster counts the cancels of the tokens it no longer names");
    assert.equal(dm.conn.gestures.retained.versions, 2);
    assert.deepEqual(await release(), [
      { k: "dragStart", tokenId: "m0", x: 10, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 11, y: 10 },
      { k: "dragCancel", tokenId: "m1" },
      { k: "dragMove", tokenId: "m0", x: 13, y: 10 },
      { k: "dragMove", tokenId: "m2", x: 15, y: 10 },
      { k: "dragMove", tokenId: "m0", x: 15, y: 10 },
      { k: "dragMove", tokenId: "m2", x: 17, y: 10 },
    ]);
    assert.deepEqual(dm.conn.gestures.retained, { versions: 1, bytes: dm.conn.gestures.retained.bytes }, "the first roster went once its start routed, the open one stays");
  });

  test("a ruler's newer frame takes the older one's place, and its end stays after it", async (t) => {
    const { r, dm, release } = await held(t);
    for (let i = 0; i < 5; i++) send(r, dm.conn, { k: "ruler", id: "r1", points: [{ x: 10, y: 10 }, { x: 11 + i, y: 10 }], shared: true });
    send(r, dm.conn, { k: "rulerEnd", id: "r1" });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2);
    const got = await release();
    assert.deepEqual(got.map((e) => (e.k === "ruler" ? `ruler ${e.points[1]!.x}` : e.k)), ["ruler 15", "rulerEnd"]);
  });

  test("a move on another floor, or after a start, waits after the frame before it", async (t) => {
    const { r, dm } = await held(t);
    send(r, dm.conn, start(1, 10));
    send(r, dm.conn, move(1, 11));
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 12, y: 10 }, "vault");
    send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 12, y: 10 });
    send(r, dm.conn, move(1, 13));
    assert.equal(r.actor.heldOf(dm.conn).frames, 5);
  });

  test("past its member's share of the room's count, a frame drops, counted by its kind whatever its roster holds", async (t) => {
    const most = Math.floor(MEMBER_HELD_SHARE / heldSends({ k: "dragStart", tokenId: "m0", g: 1, x: 0, y: 0 } as GroupFrame));
    for (const members of [0, 99]) {
      const { r, dm } = await held(t);
      const roster = Array.from({ length: members }, (_, i) => ({ tokenId: `x${i}`, x: i, y: 0 }));
      send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: roster, from: { x: 10, y: 10 } });
      // Starts neither replace nor go, so each waits until the member's share is spent.
      for (let i = 0; i < most + 20; i++) send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10 + i / 8, y: 10 });
      assert.equal(r.actor.heldOf(dm.conn).frames, most, `${members} members`);
      t.mock.timers.reset();
    }
  });

  test("past what the room's held frames may send one receiver, a frame drops, whichever member sends it", async (t) => {
    const r = await room(t);
    const members = [socketOf(r, r.f.dm, "dm"), socketOf(r, r.f.otherDm, "dm"), socketOf(r, r.f.unrelated, "player")];
    for (const s of members) await hello(r, s, uuidv7());
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    // Each a gesture of its own, so none is charged for what an earlier one showed.
    const start = (g: number) => ({ k: "dragStart", tokenId: "m0", g, x: 10, y: 10, with: [], from: { x: 10, y: 10 } });
    const share = Math.floor(MEMBER_HELD_SHARE / heldSends(start(1) as GroupFrame));
    const most = Math.floor(MAX_ROOM_HELD_SENDS / heldSends(start(1) as GroupFrame));
    assert.ok(2 * share < most && most < 3 * share, "two members' shares leave the room's count unspent");
    for (const { conn } of members) for (let g = 1; g <= share + 5; g++) send(r, conn, start(g));
    assert.deepEqual(members.map((s) => r.actor.heldOf(s.conn).frames), [share, share, most - 2 * share]);
  });

  test("a move of another pressed token counts its gesture's cancels, and so does a newer move that takes its place", async (t) => {
    const { r, dm, release } = await held(t);
    send(r, dm.conn, start(1, 10));
    send(r, dm.conn, { k: "dragMove", tokenId: "m2", g: 1, x: 12, y: 10 });
    send(r, dm.conn, { k: "dragMove", tokenId: "m2", g: 1, x: 13, y: 10 });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2);
    const sends = (e: unknown) => heldSends(e as GroupFrame);
    assert.equal(r.actor.heldOf(dm.conn).memberSends, sends(start(1, 0)) + sends(move(1, 0)) + CANCELS_SENDS);
    assert.deepEqual(await release(), [
      { k: "dragStart", tokenId: "m0", x: 10, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 11, y: 10 },
      { k: "dragCancel", tokenId: "m0" },
      { k: "dragMove", tokenId: "m2", x: 13, y: 10 },
      { k: "dragMove", tokenId: "m1", x: 14, y: 10 },
    ]);
  });

  test("a gesture whose start and end both wait leaves the queue whole, its moves and rosters with it, and another gesture's frames keep their places", async (t) => {
    const { r, dm, release } = await held(t);
    send(r, dm.conn, start(1, 10));
    send(r, dm.conn, start(2, 20));
    send(r, dm.conn, move(1, 11));
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 12, y: 10, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 10, y: 10 } });
    send(r, dm.conn, move(2, 21));
    send(r, dm.conn, move(1, 13));
    assert.equal(r.actor.heldOf(dm.conn).frames, 5);
    const kept = r.actor.heldOf(dm.conn).memberSends - (heldSends(start(1, 0) as GroupFrame) + heldSends(move(1, 0) as GroupFrame) + heldSends(move(1, 0) as GroupFrame) + CANCELS_SENDS);
    send(r, dm.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 13, y: 10 }, { x: 15, y: 10 }] });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2, "the other gesture's start and move");
    assert.deepEqual([r.actor.heldOf(dm.conn).memberSends, r.actor.heldOf(dm.conn).roomSends], [kept, kept]);
    assert.equal(dm.conn.gestures.retained.versions, 1, "the ended gesture's rosters went with its frames");
    assert.deepEqual(await release(), [
      { k: "dragStart", tokenId: "m0", x: 20, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 21, y: 10 },
      { k: "dragMove", tokenId: "m0", x: 21, y: 10 },
      { k: "dragMove", tokenId: "m1", x: 22, y: 10 },
    ]);
  });

  test("a gesture with a frame sent before its start waited keeps its start and end, which are sent", async (t) => {
    const { r, dm, release } = await held(t, (r, dm) => send(r, dm, move(1, 11)));
    send(r, dm.conn, start(1, 10));
    send(r, dm.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 10, y: 10 }, { x: 11, y: 10 }] });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2);
    assert.deepEqual(await release(), [
      { k: "dragStart", tokenId: "m0", x: 10, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 11, y: 10 },
      { k: "dragEnd", tokenId: "m0", x: 10, y: 10 },
      { k: "dragEnd", tokenId: "m1", x: 11, y: 10 },
    ]);
  });

  test("a gesture whose start went before its tick waited still sends its end, after its latest move", async (t) => {
    const { r, dm, release } = await held(t, (r, dm) => send(r, dm, start(1, 10)));
    send(r, dm.conn, move(1, 11));
    send(r, dm.conn, move(1, 12));
    send(r, dm.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 12, y: 10 }, null] });
    assert.equal(r.actor.heldOf(dm.conn).frames, 2);
    assert.deepEqual(await release(), [
      { k: "dragMove", tokenId: "m0", x: 12, y: 10 },
      { k: "dragMove", tokenId: "m1", x: 13, y: 10 },
      { k: "dragEnd", tokenId: "m0", x: 12, y: 10 },
      { k: "dragCancel", tokenId: "m1" },
    ]);
  });
});

describe("what a held frame's routing may cancel (D-261126-265)", () => {
  test("a frame that adds a preview past the socket's most counts the cancels of the one that goes: a drag's tokens, or one preview's", async (t) => {
    for (const oldest of ["drag", "ruler"] as const) {
      const r = await room(t);
      const dm = socketOf(r, r.f.dm, "dm");
      await hello(r, dm, uuidv7());
      if (oldest === "drag") send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } });
      const ruler = (i: number) => ({ k: "ruler", id: `r${i}`, points: [{ x: 10, y: 10 }, { x: 11, y: 10 }], shared: true });
      for (let i = dm.conn.previewsSent.size; i < MOST_PREVIEWS_SENT - 1; i++) send(r, dm.conn, ruler(i));
      assert.equal(dm.conn.previewsSent.size, MOST_PREVIEWS_SENT - 1);
      const T = T0 + 1_000;
      await heldBatch(t, r, T);
      moveTo(t, r.clock, T + 21);
      const from = r.p1.sent.length;
      const each = heldSends(ruler(0) as EphEvent);
      const ping = { k: "ping", x: 1, y: 1 };
      send(r, dm.conn, ruler(100));
      assert.equal(r.actor.heldOf(dm.conn).memberSends, each, "the socket's last free entry");
      // A ping keeps no entry, and the ruler's newer frame takes its older one's place: still the last free entry.
      send(r, dm.conn, ping);
      send(r, dm.conn, { ...ruler(100), points: [{ x: 10, y: 10 }, { x: 12, y: 10 }] });
      const pinged = each + heldSends(ping as EphEvent);
      assert.equal(r.actor.heldOf(dm.conn).memberSends, pinged);
      send(r, dm.conn, ruler(101));
      assert.equal(r.actor.heldOf(dm.conn).memberSends, pinged + each + (oldest === "drag" ? CANCELS_SENDS : CANCEL_SENDS), `past the most, with a ${oldest} the oldest`);
      r.gate.open();
      await flush();
      const ended = ephs(r.p1.sent.slice(from)).filter((e) => e.k === "dragCancel" || e.k === "rulerEnd");
      assert.deepEqual(ended, oldest === "drag" ? [{ k: "dragCancel", tokenId: "m0" }, { k: "dragCancel", tokenId: "m1" }] : [{ k: "rulerEnd", id: "r0" }]);
      t.mock.timers.reset();
    }
  });

  test("a held frame counted for no cancels whose step before it did not route goes nowhere, where it would end the tokens that step left", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } });
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    const from = r.p1.sent.length;
    moveTo(t, r.clock, T + 21);
    // A new roster, counted for the cancels it may send, that waits past RETAIN_MS, then a move under it, counted for none.
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 11, y: 10, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 10, y: 10 } });
    moveTo(t, r.clock, T + 1_500);
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 12, y: 10 });
    const sends = heldSends({ k: "dragMove", tokenId: "m0", g: 1, x: 0, y: 0 } as GroupFrame);
    assert.equal(r.actor.heldOf(dm.conn).memberSends, sends + CANCELS_SENDS + sends);
    moveTo(t, r.clock, T + 22 + RETAIN_MS);
    r.gate.open();
    await flush();
    assert.deepEqual(ephs(r.p1.sent.slice(from)), [], "the roster aged out, and the move under it would have ended m1");
    assert.equal(r.actor.heldOf(dm.conn).frames, 0);
    // The gesture's next roster is counted for its cancels, and sends them.
    send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 13, y: 10, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 10, y: 10 } });
    assert.deepEqual(ephs(r.p1.sent.slice(from)), [{ k: "dragCancel", tokenId: "m1" }, { k: "dragMove", tokenId: "m0", x: 13, y: 10 }, { k: "dragMove", tokenId: "m2", x: 15, y: 10 }]);
  });
});

describe("each member's share of the room's held frames (D-261126-265)", () => {
  test("one member at its share, from two devices, leaves a second member's start and end held and sent", async (t) => {
    const r = await room(t, { prepare: (f) => {
      for (let i = 0; i < 20; i++) f.state.tokens[`h${i}`] = token(`h${i}`, { sceneId: f.sceneId, x: i, y: 30, visibility: "dm" });
    } });
    const devices = [socketOf(r, r.f.dm, "dm"), socketOf(r, r.f.dm, "dm")];
    const second = socketOf(r, r.f.otherDm, "dm");
    for (const s of [...devices, second]) await hello(r, s, uuidv7());
    send(r, second.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [], from: { x: 10, y: 10 } });
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const from = r.p1.sent.length;
    const start = (g: number, i: number) => ({ k: "dragStart", tokenId: `h${i}`, g, x: i, y: 30, with: [], from: { x: i, y: 30 } });
    const share = Math.floor(MEMBER_HELD_SHARE / heldSends(start(1, 0) as GroupFrame));
    // Each device's hidden drags until the member's share is spent, and past it.
    for (let i = 0; i < 20; i++) send(r, devices[i % 2]!.conn, start(i + 1, i));
    assert.equal(r.actor.heldOf(devices[0]!.conn).frames + r.actor.heldOf(devices[1]!.conn).frames, share, "both devices count in one share");
    assert.ok(r.actor.heldOf(devices[0]!.conn).memberSends <= MEMBER_HELD_SHARE);
    // The second member's end of a drag already shown, and its next start.
    send(r, second.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 11, y: 10 }] });
    send(r, second.conn, { k: "dragStart", tokenId: "m1", g: 2, x: 11, y: 10, with: [], from: { x: 11, y: 10 } });
    assert.equal(r.actor.heldOf(second.conn).frames, 2);
    r.gate.open();
    await flush();
    assert.deepEqual(ephs(r.p1.sent.slice(from)), [
      { k: "dragEnd", tokenId: "m0", x: 11, y: 10 },
      { k: "dragStart", tokenId: "m1", x: 11, y: 10 },
    ]);
  });

  test("an honest member's whole stall waits whole: a drag from A to B to A a second apart and its end, the next drag, a ruler, a laser and a camera", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    const A = r.f.sceneId;
    send(r, dm.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } });
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    const from = r.p1.sent.length;
    const moves = (floor: string, x: number) => {
      for (let i = 0; i < 3; i++) send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: x + i / 4, y: 10 }, floor);
    };
    moveTo(t, r.clock, T + 21);
    moves(A, 11);
    // Each floor change a second apart: the cancel on the floor left, then the roster on the floor reached.
    for (const [at, left, reached] of [[T + 100, A, "vault"], [T + 1_100, "vault", A]] as const) {
      moveTo(t, r.clock, at);
      send(r, dm.conn, { k: "dragCancel", tokenId: "m0", g: 1 }, left);
      send(r, dm.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 12, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } }, reached);
      moves(reached, 12);
    }
    moveTo(t, r.clock, T + 1_700);
    send(r, dm.conn, { k: "groupEnd", tokenId: "m0", g: 1, at: [{ x: 13, y: 10 }, { x: 14, y: 10 }] });
    send(r, dm.conn, { k: "dragStart", tokenId: "m2", g: 2, x: 12, y: 10, with: [{ tokenId: "m3", x: 13, y: 10 }], from: { x: 12, y: 10 } });
    send(r, dm.conn, { k: "dragMove", tokenId: "m2", g: 2, x: 12.5, y: 10 });
    send(r, dm.conn, { k: "ruler", id: "r1", points: [{ x: 10, y: 10 }, { x: 15, y: 10 }], shared: true });
    send(r, dm.conn, { k: "rulerEnd", id: "r1" });
    for (let i = 0; i < 60; i++) {
      send(r, dm.conn, { k: "laser", x: 10 + i / 60, y: 12, on: true });
      send(r, dm.conn, { k: "view", x: 10 + i / 60, y: 10, w: 20, h: 12 });
    }
    assert.deepEqual([r.actor.heldOf(dm.conn).frames, r.actor.heldOf(dm.conn).memberSends], [12 + 120, HONEST_MEMBER_SENDS], "every frame waits, counted as the envelope counts it");
    moveTo(t, r.clock, T + 1_820);
    r.gate.open();
    await flush();
    const got = ephs(r.p1.sent.slice(from));
    assert.deepEqual(got.filter((e) => e.k === "dragEnd" || e.k === "dragStart"), [
      { k: "dragEnd", tokenId: "m0", x: 13, y: 10 },
      { k: "dragEnd", tokenId: "m1", x: 14, y: 10 },
      { k: "dragStart", tokenId: "m2", x: 12, y: 10 },
      { k: "dragStart", tokenId: "m3", x: 13, y: 10 },
    ]);
    assert.deepEqual(got.filter((e) => e.k === "dragMove" && e.tokenId === "m2"), [{ k: "dragMove", tokenId: "m2", x: 12.5, y: 10 }]);
  });

  test("a DM's view as a player counts in the DM's share, never the player's", async (t) => {
    const r = await room(t);
    const device = socketOf(r, r.f.dm, "dm");
    const preview = socketOf(r, r.f.dm, "dm", uuidv7(), { previewOf: r.f.player.id });
    for (const s of [device, preview]) await hello(r, s, uuidv7());
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const start = { k: "dragStart", tokenId: r.f.pc, g: 1, x: 8, y: 0, with: [], from: { x: 8, y: 0 } };
    send(r, preview.conn, start);
    assert.equal(r.actor.heldOf(preview.conn).frames, 1);
    assert.deepEqual([r.actor.heldOf(device.conn).memberSends, r.actor.heldOf(r.p1.conn).memberSends], [heldSends(start as GroupFrame), 0]);
  });

  test("3 DM devices' hidden drags 200 ms apart, short or still moving, leave a player's own drag through the stall the same as with none", async (t) => {
    const seen: unknown[] = [];
    for (const hidden of ["none", "short", "moving"] as const) {
      const r = await room(t, { prepare: (f) => {
        for (let i = 0; i < 24; i++) f.state.tokens[`h${i}`] = token(`h${i}`, { sceneId: f.sceneId, x: i, y: 30, visibility: "dm" });
      } });
      const devices = [0, 1, 2].map(() => socketOf(r, r.f.dm, "dm"));
      const player = socketOf(r, r.f.player, "player");
      const watcher = socketOf(r, r.f.unrelated, "player");
      for (const s of [...devices, player, watcher]) await hello(r, s, uuidv7());
      const T = T0 + 1_000;
      await heldBatch(t, r, T);
      const from = watcher.sent.length;
      for (let k = 0; k < 8 && hidden !== "none"; k++) {
        for (const [d, device] of devices.entries()) {
          moveTo(t, r.clock, T + 21 + k * 200 + d);
          const i = 8 * d + k;
          const g = k + 1;
          send(r, device.conn, { k: "dragStart", tokenId: `h${i}`, g, x: i, y: 30, with: [], from: { x: i, y: 30 } });
          send(r, device.conn, { k: "dragMove", tokenId: `h${i}`, g, x: i + 0.5, y: 30 });
          if (hidden === "short") send(r, device.conn, { k: "groupEnd", tokenId: `h${i}`, g, at: [{ x: i + 1, y: 30 }] });
        }
      }
      moveTo(t, r.clock, T + 1_620);
      send(r, player.conn, { k: "dragStart", tokenId: r.f.pc, g: 1, x: 8, y: 0, with: [], from: { x: 8, y: 0 } });
      moveTo(t, r.clock, T + 1_650);
      send(r, player.conn, { k: "dragMove", tokenId: r.f.pc, g: 1, x: 9, y: 0 });
      assert.equal(r.actor.heldOf(player.conn).frames, 2, `${hidden}: the player's frames wait`);
      moveTo(t, r.clock, T + 1_700);
      r.gate.open();
      await flush();
      moveTo(t, r.clock, T + 1_750);
      send(r, player.conn, { k: "groupEnd", tokenId: r.f.pc, g: 1, at: [{ x: 9, y: 0 }] });
      // Each room has a token id of its own for the player's token.
      seen.push(ephs(watcher.sent.slice(from)).map((e) => ("tokenId" in e && e.tokenId === r.f.pc ? { ...e, tokenId: "pc" } : e)));
      t.mock.timers.reset();
    }
    assert.deepEqual(seen[0], [
      { k: "dragStart", tokenId: "pc", x: 8, y: 0 },
      { k: "dragMove", tokenId: "pc", x: 9, y: 0 },
      { k: "dragEnd", tokenId: "pc", x: 9, y: 0 },
    ]);
    assert.deepEqual(seen[1], seen[0]);
    assert.deepEqual(seen[2], seen[0]);
  });
});

describe("the preview pool at a socket's hello", () => {
  test("a hello that carries its op version is told its pace after `build` and before its snapshot, and a resync's hello keeps the share", async (t) => {
    const r = await room(t);
    const before = r.pool.counts;
    const s = socketOf(r, r.f.player, "player");
    await hello(r, s, uuidv7());
    const kinds = s.sent.map((m) => m.t);
    assert.ok(kinds.indexOf("takes") >= 0 && kinds.indexOf("takes") < kinds.indexOf("snapshot"), kinds.join());
    assert.deepEqual(s.sent.find((m) => m.t === "takes"), { t: "takes", groups: true, pace: "full" });
    assert.equal(r.pool.counts.general, before.general + 1);
    // A resync sends the hello again on the same socket: it keeps its share and is told its pace again.
    s.sent.length = 0;
    r.actor.scene(s.conn);
    await hello(r, s, s.conn.clientId!);
    assert.equal(r.pool.counts.general, before.general + 1);
    assert.deepEqual(s.sent.filter((m) => m.t === "takes"), [{ t: "takes", groups: true, pace: "full" }]);
    // An older page's hello takes a share and is told nothing.
    const old = socketOf(r, r.f.player, "player");
    await hello(r, old, uuidv7(), false);
    assert.deepEqual(old.sent.filter((m) => m.t === "takes"), []);
    assert.equal(old.conn.pace, "full");
  });

  test("a table display's socket and a DM's view as a player take no share and are told no pace", async (t) => {
    const r = await room(t);
    const before = r.pool.counts;
    const display = socketOf(r, r.f.player, "player", uuidv7(), { display: true });
    await hello(r, display, uuidv7());
    const preview = socketOf(r, r.f.dm, "dm", uuidv7(), { previewOf: r.f.player.id });
    await hello(r, preview, uuidv7());
    assert.deepEqual(r.pool.counts, before);
    for (const s of [display, preview]) {
      assert.equal(s.conn.pace, null);
      assert.deepEqual(s.sent.filter((m) => m.t === "takes"), []);
    }
  });

  test("an off socket's camera, laser and pings at their most through an uncovered tick all go, and an older page's drags from it go nowhere", async (t) => {
    // No full share at all: every socket is off.
    const r = await room(t, { pool: new PreviewPool(0) });
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    assert.equal(dm.conn.pace, "off");
    assert.deepEqual(dm.sent.find((m) => m.t === "takes"), { t: "takes", groups: true, pace: "off" });
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    const from = r.p1.sent.length;
    // 60 laser, 34 camera and 20 ping frames in 2 s.
    for (let i = 0; i < 114; i++) {
      moveTo(t, r.clock, T + 21 + Math.floor((i * (RETAIN_MS - 100)) / 114));
      if (i < 60) send(r, dm.conn, { k: "laser", x: 1 + i / 100, y: 1, on: true });
      else if (i < 94) send(r, dm.conn, { k: "focus", x: 1 + i / 100, y: 1, zoom: 1 });
      else send(r, dm.conn, { k: "ping", x: 1 + i / 100, y: 1 });
    }
    send(r, dm.conn, { k: "dragStart", tokenId: "m0", x: 10, y: 10 });
    send(r, dm.conn, { k: "ruler", id: "r", points: [{ x: 1.5, y: 1.5 }], shared: true });
    r.gate.open();
    await flush();
    const got = ephs(r.p1.sent.slice(from));
    assert.equal(got.filter((e) => e.k === "laser" || e.k === "focus" || e.k === "ping").length, 114, "no held frame dropped");
    assert.deepEqual(got.filter((e) => e.k === "dragStart" || e.k === "ruler"), []);
  });
});

describe("a hello of a client whose socket is already open", () => {
  test("a delayed hello from the older socket after the newer one's snapshot is refused and closed, and the newer stays current with one share", async (t) => {
    const r = await room(t);
    const session = uuidv7();
    const clientId = uuidv7();
    const a = socketOf(r, r.f.player, "player", session);
    const b = socketOf(r, r.f.player, "player", session);
    assert.ok(a.conn.id < b.conn.id);
    const before = r.pool.counts.general;
    await hello(r, b, clientId);
    // A's hello waited on its watermark read and comes now.
    await hello(r, a, clientId);
    assert.equal(a.closed(), CLOSE.replaced);
    assert.notEqual(CLOSE.replaced, CLOSE.authFailure, "a page reconnects from it");
    assert.equal(b.closed(), null);
    assert.equal(r.pool.counts.general, before + 1, "one share for the client");
    assert.equal(a.conn.pace, null);
    // B is the client's current socket: its op's answer comes to it.
    const n = 1;
    await r.actor.op(b.conn, n, { t: "log.chat", text: "still here" });
    await until(() => (b.sent.some((m) => m.t === "ev" && m.acks?.includes(n)) ? true : undefined), "B's ack");
    assert.ok(!a.sent.some((m) => m.t === "ev" && m.acks?.includes(n)));
  });

  test("a table display's two sockets of one client both stay open, whichever hello comes first", async (t) => {
    for (const newerFirst of [false, true]) {
      const r = await room(t);
      const session = uuidv7();
      const clientId = uuidv7();
      const older = socketOf(r, r.f.player, "player", session, { display: true });
      const newer = socketOf(r, r.f.player, "player", session, { display: true });
      for (const s of newerFirst ? [newer, older] : [older, newer]) await hello(r, s, clientId);
      for (const s of [older, newer]) {
        assert.equal(s.closed(), null, `newer first: ${newerFirst}`);
        assert.ok(s.sent.some((m) => m.t === "snapshot"));
      }
    }
  });

  test("a newer socket's hello closes the older one first, its previews ended and its held frames gone, and takes its share", async (t) => {
    const r = await room(t);
    const session = uuidv7();
    const clientId = uuidv7();
    const old = socketOf(r, r.f.dm, "dm", session);
    await hello(r, old, clientId);
    send(r, old.conn, { k: "dragStart", tokenId: "m0", g: 1, x: 10, y: 10, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 10, y: 10 } });
    assert.ok(r.p1.conn.previewsHeld.size === 2);
    const counts = r.pool.counts;
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    send(r, old.conn, { k: "dragMove", tokenId: "m0", g: 1, x: 12, y: 10 });
    assert.equal(r.actor.heldOf(old.conn).frames, 1);
    const from = r.p1.sent.length;
    const next = socketOf(r, r.f.dm, "dm", session);
    await hello(r, next, clientId, true, true);
    await flush();
    // Closed in the hello's own turn, while its frame still waited for the tick.
    assert.equal(old.closed(), CLOSE.replaced);
    assert.deepEqual(r.actor.heldOf(old.conn), { frames: 0, bytes: 0, memberSends: 0, roomSends: 0 }, "its frames count no more");
    r.gate.open();
    await flush();
    moveTo(t, r.clock, T + 80);
    await flush();
    assert.ok(next.sent.some((m) => m.t === "snapshot"));
    assert.deepEqual(ephs(r.p1.sent.slice(from)).filter((e) => e.k !== "dragCancel"), [], "no frame of the old socket's reappears");
    assert.deepEqual(ephs(r.p1.sent.slice(from)).filter((e) => e.k === "dragCancel").length, 2);
    assert.deepEqual(r.pool.counts, counts, "the newer socket holds the older one's share");
    assert.equal(next.conn.pace, "full");
    assert.deepEqual(old.conn.gestures.retained, { versions: 0, bytes: 0 });
  });

  test("a replacement whose role changed takes no share its role may not hold", async (t) => {
    const pool = new PreviewPool();
    const r = await room(t, { pool });
    // The room's DM holds its kept share already (the harness's DM socket).
    assert.equal(pool.counts.reserve, 1);
    const session = uuidv7();
    const clientId = uuidv7();
    const other = socketOf(r, r.f.otherDm, "dm", session);
    await hello(r, other, clientId);
    const general = pool.counts.general;
    // The co-DM's grant became a player's between the two sockets.
    const demoted = socketOf(r, r.f.otherDm, "player", session);
    await hello(r, demoted, clientId);
    assert.equal(other.closed(), CLOSE.replaced);
    assert.equal(pool.counts.general, general, "a general share passes to any role");
    assert.equal(demoted.conn.pace, "full");
  });
});
