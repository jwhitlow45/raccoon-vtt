import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { Member } from "#shared/model.ts";
import { clientMessageSchema, type EphEvent, type EphEventOut, type GroupFrame, type ServerMessage } from "#shared/protocol.ts";
import { scene, token } from "#shared/testutil.ts";
import { RETAIN_MS, RoomActor, type ActorDeps } from "./actor.ts";
import { PreviewPool, SnapshotBudget } from "./budgets.ts";
import { CLOSE, Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { MAX_VERSIONS } from "./gestures.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, until } from "./undoScopeTesting.ts";

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
  // Turns of the event loop alone, so a test's mocked timers never stall it.
  for (let i = 0; i < 200 && !queued; i++) {
    if (s.conn.closed || s.sent.filter((m) => m.t === "snapshot").length > snapshots) return;
    await flush();
  }
  if (!queued) assert.fail("no snapshot or close");
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
  test("each held frame expands by the roster it bound: six drags 200 ms apart, floors A to B to A, and an end while its frames wait", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    const from = r.p1.sent.length;
    const A = r.f.sceneId;
    for (let g = 1; g <= 6; g++) {
      moveTo(t, r.clock, T + 21 + (g - 1) * 200);
      // Each drag's member is a different creature, starting where it stands.
      send(r, dm.conn, { k: "dragStart", tokenId: r.f.goblin, g, x: 0, y: 0, with: [{ tokenId: `m${g % 5}`, x: 10 + (g % 5), y: 10 }], from: { x: 0, y: 0 } });
      send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 1, y: 0 });
      if (g === 6) {
        // Floors A to B to A within the one gesture: the old floor's cancel and the new floor's roster, each in one flush.
        send(r, dm.conn, { k: "dragCancel", tokenId: r.f.goblin, g }, A);
        send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 2, y: 0, with: [{ tokenId: "m1", x: 11, y: 10 }], from: { x: 0, y: 0 } }, "vault");
        send(r, dm.conn, { k: "dragCancel", tokenId: r.f.goblin, g }, "vault");
        send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 3, y: 0, with: [{ tokenId: "m2", x: 12, y: 10 }], from: { x: 0, y: 0 } }, A);
        send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g, x: 4, y: 0 }, A);
      }
      // The end comes while every frame before it still waits.
      send(r, dm.conn, { k: "groupEnd", tokenId: r.f.goblin, g, at: [null, null] });
    }
    assert.ok(r.actor.heldOf(dm.conn).frames > 20, "all held");
    assert.ok(dm.conn.gestures.retained.versions <= MAX_VERSIONS);
    r.gate.open();
    await flush();
    const got = ephs(r.p1.sent.slice(from));
    for (let g = 1; g <= 5; g++) {
      const m = `m${g % 5}`;
      assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === m && e.x === 11 + (g % 5)), `drag ${g} moved ${m} by its own roster`);
    }
    // On the return to A the return's roster stands: m2 by its offset, never m6's first member.
    assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === "m2" && e.x === 15));
    assert.ok(got.some((e) => e.k === "dragMove" && e.tokenId === "m2" && e.x === 16), "the frame after the return expands by it too");
    assert.deepEqual(needs(dm.sent), [], "no roster was asked for");
    assert.deepEqual(dm.conn.gestures.retained, { versions: 0, bytes: 0 }, "every ended gesture's rosters went once their frames routed");
  });

  test("40 rosters while every version is pinned: retained charges stay within their cap, the excess frames drop, and their gestures recover by `need`", async (t) => {
    const r = await room(t);
    const dm = socketOf(r, r.f.dm, "dm");
    await hello(r, dm, uuidv7());
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    for (let g = 1; g <= 40; g++) {
      send(r, dm.conn, { k: "dragStart", tokenId: r.f.goblin, g, x: 0, y: 0, with: Array.from({ length: 99 }, (_, i) => ({ tokenId: `ghost-${g}-${i}`, x: i, y: 0 })), from: { x: 0, y: 0 } });
      assert.ok(dm.conn.gestures.retained.versions <= MAX_VERSIONS && dm.conn.gestures.retained.bytes <= 448 * 1024);
    }
    assert.equal(r.actor.heldOf(dm.conn).frames, MAX_VERSIONS, "a frame whose roster was refused is dropped");
    r.gate.open();
    await flush();
    // The 40th gesture's roster was refused: its next frame expands its pressed token alone and asks again.
    send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g: 40, x: 1, y: 0 });
    assert.deepEqual(needs(dm.sent), [{ t: "need", id: r.f.goblin, g: 40 }]);
    send(r, dm.conn, { k: "dragMove", tokenId: r.f.goblin, g: 40, x: 2, y: 0, with: [{ tokenId: "m0", x: 10, y: 10 }], from: { x: 0, y: 0 } });
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
    assert.equal(r.actor.heldOf(old.conn).frames, 0);
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
