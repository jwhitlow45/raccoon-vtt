import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { uuidv7 } from "#shared/ids.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { MAX_HELD_BYTES, MAX_HELD_FRAMES, MAX_VIEWS, MAX_WAITING_READERS, READER_DEADLINE_MS, RETAIN_MS, RoomActor, ViewBusyError, type ActorDeps, type RoomView } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, until } from "./undoScopeTesting.ts";

/*
 * Readers and live frames answer as of their arrival tick (RoomActor
 * asOf): a reader waits until every command before its tick is handled and
 * every batch through it has published, then takes that tick's view from
 * the ring, within bounds on how many wait, for how long, how old a view
 * may be and how many views the ring keeps. Commits are held with the
 * stored room's `beforeCommit`, on a hand clock the mocked timers follow.
 */

/** A multiple of every batch window below. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Eph = Extract<ServerMessage, { t: "eph" }>;

/** Holds every commit that starts while it is shut, until it opens. */
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

async function room(t: TestContext, options: ActorDeps["options"] = {}) {
  const f = scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget({}, now),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, roomOpsPerSec: 10_000, now, numberClock: now, ...options },
  });
  assert.ok(actor);
  const gate = new Gate();
  t.after(() => {
    t.mock.timers.reset();
    gate.open();
    db.beforeCommit = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // Opened while the clock stands and the timers are real.
  const dm = await ScopeClient.open(actor, f.dm, "dm", now);
  const p1 = await ScopeClient.open(actor, f.player, "player", now);
  db.beforeCommit = () => gate.pass();
  return { f, clock, db, actor, dm, p1, now, gate };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Moves the hand clock to `at` and the mocked timers by as much. */
function moveTo(t: TestContext, clock: { now: number }, at: number): void {
  const by = at - clock.now;
  assert.ok(by >= 0);
  clock.now = at;
  t.mock.timers.tick(by);
}

function chat(client: ScopeClient, text: string): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, { t: "log.chat", text });
  return n;
}

const texts = (view: RoomView) => view.state.log.map((line) => line.text);

/** Whether `p` has settled, read after the loop has run. */
function settled(p: Promise<unknown>): { done: boolean; value?: unknown; error?: unknown } {
  const out: { done: boolean; value?: unknown; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(out, { done: true, value }),
    (error: unknown) => Object.assign(out, { done: true, error }),
  );
  return out;
}

/** P1's chat at T + 5, its batch closed at T + 20 and its commit held. */
async function heldBatch(t: TestContext, r: Awaited<ReturnType<typeof room>>, T: number): Promise<void> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.gate.shut();
  moveTo(t, r.clock, T + 5);
  chat(r.p1, "held");
  await flush();
  moveTo(t, r.clock, T + 20);
  await flush();
  assert.equal(r.gate.started, 1, "the batch at T + 20 is committing");
}

describe("readers waiting for their tick", () => {
  test(`the ${MAX_WAITING_READERS + 1}st reader waiting answers busy, and the rest take the batch's view once it publishes`, async (t) => {
    const r = await room(t);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 25);
    const waiting = Array.from({ length: MAX_WAITING_READERS }, () => settled(r.actor.asOf(T + 25)));
    await assert.rejects(r.actor.asOf(T + 25), ViewBusyError, "one more than the bound");
    await flush();
    assert.ok(waiting.every((w) => !w.done), "all wait while the batch commits");
    r.gate.open();
    await flush();
    assert.ok(waiting.every((w) => w.done && (w.value as RoomView).tick === T + 20 && texts(w.value as RoomView).includes("held")));
  });

  test("a reader past its deadline, one whose signal aborts, and every one waiting at shutdown answer busy", async (t) => {
    const r = await room(t);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 25);
    const late = settled(r.actor.asOf(T + 25));
    const abort = new AbortController();
    const gone = settled(r.actor.asOf(T + 25, { signal: abort.signal }));
    abort.abort();
    await flush();
    assert.ok(gone.done && gone.error instanceof ViewBusyError, "the aborted reader answers at once");
    assert.ok(!late.done);
    moveTo(t, r.clock, T + 25 + READER_DEADLINE_MS - 1);
    await flush();
    assert.ok(!late.done, "waits up to its deadline");
    moveTo(t, r.clock, T + 25 + READER_DEADLINE_MS);
    await flush();
    assert.ok(late.done && late.error instanceof ViewBusyError, "and answers busy at it");
    const atStop = settled(r.actor.asOf(T + 25 + READER_DEADLINE_MS));
    const down = r.actor.shutdown({ code: 1012, snapshot: false });
    await flush();
    assert.ok(atStop.done && atStop.error instanceof ViewBusyError, "the shutdown answers it before its commits end");
    r.gate.open();
    await down;
    await assert.rejects(r.actor.asOf(r.clock.now), ViewBusyError, "a closed room answers busy");
  });

  test("a copy read through read() waits as a reader does: bounded, to its deadline, and busy at a stop", async (t) => {
    const r = await room(t);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 25);
    const copies = Array.from({ length: MAX_WAITING_READERS - 1 }, () => settled(r.actor.read((state) => state.log.length, T + 25)));
    const late = settled(r.actor.read((state) => state.log.map((l) => l.text), T + 25));
    await assert.rejects(r.actor.read(() => 0, T + 25), ViewBusyError, "one past the bound");
    // A later chat in the next tick's batch, which none of the copies above may take.
    moveTo(t, r.clock, T + 45);
    chat(r.p1, "later");
    await flush();
    moveTo(t, r.clock, T + 25 + READER_DEADLINE_MS);
    await flush();
    assert.ok(copies.every((c) => c.done && c.error instanceof ViewBusyError), "each answers busy at its deadline");
    assert.ok(late.done && late.error instanceof ViewBusyError);
    // A copy waiting as the room stops answers busy, never the committed room.
    const atStop = settled(r.actor.read((state) => state.log.map((l) => l.text), T + 25 + READER_DEADLINE_MS));
    const down = r.actor.shutdown({ code: 1012, snapshot: false });
    await flush();
    assert.ok(atStop.done && atStop.error instanceof ViewBusyError, JSON.stringify(atStop.value));
    r.gate.open();
    await down;
  });

  test("a reader older than the views kept answers busy, and one within them takes the view of its tick", async (t) => {
    const r = await room(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const T = T0 + 1_000;
    moveTo(t, r.clock, T + 5);
    chat(r.p1, "first");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    moveTo(t, r.clock, T + 45);
    chat(r.p1, "second");
    await flush();
    moveTo(t, r.clock, T + 60);
    await flush();
    const between = await r.actor.asOf(T + 30);
    assert.deepEqual([between.tick, texts(between).includes("first"), texts(between).includes("second")], [T + 20, true, false]);
    // Its age runs from its tick, T + 20.
    moveTo(t, r.clock, T + 20 + RETAIN_MS);
    assert.equal((await r.actor.asOf(T + 30)).tick, T + 20, "at its age bound");
    moveTo(t, r.clock, T + 21 + RETAIN_MS);
    await assert.rejects(r.actor.asOf(T + 30), ViewBusyError, "past it");
  });

  test("a reader that arrived before the room loaded takes the load's view, aged from the load's end", async (t) => {
    const r = await room(t);
    const loaded = r.actor.loadedAt;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    moveTo(t, r.clock, loaded + 5);
    chat(r.p1, "after the load");
    await flush();
    moveTo(t, r.clock, loaded + 40);
    await flush();
    moveTo(t, r.clock, loaded + RETAIN_MS - 100);
    const before = await r.actor.asOf(loaded - 500);
    assert.ok(!texts(before).includes("after the load"), "the room as it loaded");
    moveTo(t, r.clock, loaded + RETAIN_MS + 1);
    await assert.rejects(r.actor.asOf(loaded - 500), ViewBusyError);
  });
});

describe("a room that published nothing since it loaded", () => {
  test("answers a reader 3 s and 60 s after the load from the load's view", async (t) => {
    const f = scopeFixture();
    const clock = { now: T0 };
    const now = () => clock.now;
    const actor = await RoomActor.load({
      pool: new StoredRoomDb(f.state).pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log: quiet,
      budget: new SnapshotBudget({}, now),
      gateway: {} as RoomGateway,
      options: { batchMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, now, numberClock: now },
    });
    assert.ok(actor);
    t.after(() => actor.shutdown({ code: 1012, snapshot: false }));
    for (const after of [3_000, 60_000]) {
      clock.now = actor.loadedAt + after;
      const view = await actor.asOf(clock.now);
      assert.equal(view.seq, actor.committed.seq, `${after} ms after the load`);
    }
  });
});

describe("a clock set back", () => {
  test("a later batch at a lower tick shows no earlier batch to a reader before that batch's tick", async (t) => {
    const r = await room(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const T = T0 + 1_000;
    moveTo(t, r.clock, T + 5);
    chat(r.p1, "at 5");
    await flush();
    moveTo(t, r.clock, T + 45);
    await flush();
    const said = (view: RoomView) => texts(view).includes("at 5");
    assert.equal(said(await r.actor.asOf(T + 3)), false, "a reader before its tick");
    // The clock steps back a second, and a chat forms a batch of a lower tick, closed at its timer's second firing.
    r.clock.now = T - 1_000 + 45;
    chat(r.p1, "after the set back");
    await flush();
    for (let i = 0; i < 60; i++) {
      r.clock.now += 1;
      t.mock.timers.tick(1);
      await flush();
    }
    assert.ok(texts(await r.actor.asOf(r.clock.now + 1_000)).includes("after the set back"), "the later batch published");
    assert.equal(said(await r.actor.asOf(T + 3)), false, "still none of it before its tick");
  });

  test("a reader waits for every committing batch through its tick, a later one at a lower tick included", async (t) => {
    const r = await room(t);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    // The clock steps back a second, and a chat forms a batch of a lower tick behind the one committing.
    r.clock.now = T - 1_000 + 5;
    chat(r.p1, "after the set back");
    await flush();
    for (let i = 0; i < 60; i++) {
      r.clock.now += 1;
      t.mock.timers.tick(1);
      await flush();
    }
    const reader = settled(r.actor.asOf(T - 1_000 + 60));
    await flush();
    assert.equal(reader.done, false, "its tick's batch still commits behind the first");
    r.gate.open();
    await flush();
    await flush();
    assert.ok(reader.done && !reader.error, String(reader.error));
  });
});

describe("the ring of views", () => {
  test(`200 publications in 800 ms keep at most ${MAX_VIEWS} views`, async (t) => {
    const r = await room(t, { batchMs: 4 });
    // Four sockets of the DM's, so each socket's op rate takes its share of one chat a tick.
    const sockets = [r.dm, ...(await Promise.all([1, 2, 3].map(() => ScopeClient.open(r.actor, r.f.dm, "dm", r.now))))];
    r.db.beforeCommit = undefined;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const T = T0 + 1_000;
    let most = 0;
    for (let k = 0; k < 200; k++) {
      moveTo(t, r.clock, T + 4 * k + 1);
      chat(sockets[k % 4]!, `tick ${k}`);
      await flush();
      moveTo(t, r.clock, T + 4 * k + 4);
      await flush();
      most = Math.max(most, r.actor.viewCount);
    }
    assert.ok(texts(await r.actor.asOf(r.clock.now)).includes("tick 199"), "every batch published");
    assert.equal(most, MAX_VIEWS);
  });

  test("batches that publish after their ticks passed the views' age keep only the newest of them", async (t) => {
    const r = await room(t);
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    for (let k = 1; k < 10; k++) {
      moveTo(t, r.clock, T + 20 * k + 5);
      chat(r.p1, `tick ${k}`);
      await flush();
      moveTo(t, r.clock, T + 20 * (k + 1));
      await flush();
    }
    moveTo(t, r.clock, T + 3_000);
    r.gate.open();
    await flush();
    assert.ok(r.actor.viewCount <= 2, `${r.actor.viewCount} views kept`);
    assert.equal((await r.actor.asOf(T + 3_000)).tick, T + 200);
  });

  test("a published state goes once later batches publish, and its tick still reads the same room", async (t) => {
    const r = await room(t);
    r.db.beforeCommit = undefined;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const T = T0 + 1_000;
    let published: { ref: WeakRef<object>; read: string } | null = null;
    for (let k = 0; k < 4; k++) {
      moveTo(t, r.clock, T + 20 * k + 5);
      chat(r.p1, `tick ${k}`);
      await flush();
      moveTo(t, r.clock, T + 20 * (k + 1));
      await flush();
      published ??= await newestView(r.actor, T + 30);
    }
    assert.ok(await collected(published!.ref), "nothing holds the state the room published at T + 20");
    const later = await r.actor.asOf(T + 30);
    assert.equal(later.tick, T + 20);
    assert.equal(JSON.stringify(later.state), published!.read);
  });
});

/**
 * The newest view, read as its batch publishes: the state the room published then, held weakly. Read in a
 * function of its own, since a suspended test function keeps its locals.
 */
async function newestView(actor: RoomActor, at: number): Promise<{ ref: WeakRef<object>; read: string }> {
  const view = await actor.asOf(at);
  assert.equal(view.state, actor.committed.state);
  return { ref: new WeakRef(view.state), read: JSON.stringify(view.state) };
}

/** Whether `ref`'s object is collected, with the loop let go before each collection: a WeakRef read in a turn holds its object until the turn ends. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  for (let i = 0; i < 5 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  return ref.deref() === undefined;
}

describe("live frames held for their tick", () => {
  /** A socket of P1's with a burst large enough to send past the held bound in one go. */
  async function sender(r: Awaited<ReturnType<typeof room>>) {
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send() {}, close() {}, terminate() {} };
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: r.f.player.id, role: "player" }, "203.0.113.9", { now: r.now, ephBurst: 1_000 });
    r.actor.attach(conn);
    await r.actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
    await until(() => (conn.held !== null ? true : undefined), "the sender's snapshot");
    return conn;
  }

  const rulers = (sent: readonly unknown[]) => (sent as ServerMessage[]).filter((m): m is Eph => m.t === "eph" && m.e.k === "ruler").map((m) => (m.e as { id: string }).id);

  test(`frames behind a committing batch route in order once it publishes, and the ${MAX_HELD_FRAMES + 1}st is dropped`, async (t) => {
    const r = await room(t);
    const conn = await sender(r);
    const sceneId = r.actor.committed.state.meta.playerSceneId!;
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const from = r.dm.sent.length;
    for (let i = 0; i <= MAX_HELD_FRAMES; i++) r.actor.ephemeral(conn, { sceneId, e: { k: "ruler", id: `r${i}`, points: [{ x: 1.5, y: 1.5 }] } });
    await flush();
    assert.deepEqual(rulers(r.dm.sent.slice(from)), [], "held while the batch commits");
    r.gate.open();
    await flush();
    assert.deepEqual(
      rulers(r.dm.sent.slice(from)),
      Array.from({ length: MAX_HELD_FRAMES }, (_, i) => `r${i}`),
      "each frame in order, the one past the bound dropped",
    );
    // Covered again, a frame routes at once.
    r.actor.ephemeral(conn, { sceneId, e: { k: "ruler", id: "after", points: [{ x: 1.5, y: 1.5 }] } });
    assert.equal(rulers(r.dm.sent).at(-1), "after");
  });

  test("held frames stop at their byte bound, and frames older than the views kept are dropped as they would route", async (t) => {
    const r = await room(t);
    const conn = await sender(r);
    const sceneId = r.actor.committed.state.meta.playerSceneId!;
    const T = T0 + 1_000;
    await heldBatch(t, r, T);
    moveTo(t, r.clock, T + 21);
    const points = Array.from({ length: 500 }, (_, i) => ({ x: 1.5 + i, y: 1.5 }));
    const bytes = Buffer.byteLength(JSON.stringify({ sceneId, e: { k: "ruler", id: "r00", points } }));
    const fit = Math.floor(MAX_HELD_BYTES / bytes);
    assert.ok(fit < MAX_HELD_FRAMES, "the byte bound comes first");
    const from = r.dm.sent.length;
    for (let i = 0; i < fit + 3; i++) r.actor.ephemeral(conn, { sceneId, e: { k: "ruler", id: `r${String(i).padStart(2, "0")}`, points } });
    r.gate.open();
    await flush();
    assert.equal(rulers(r.dm.sent.slice(from)).length, fit);
    // Held again behind the next batch, then let go past the age bound.
    r.gate.shut();
    moveTo(t, r.clock, T + 25);
    chat(r.p1, "again");
    await flush();
    moveTo(t, r.clock, T + 40);
    await flush();
    moveTo(t, r.clock, T + 41);
    const later = r.dm.sent.length;
    r.actor.ephemeral(conn, { sceneId, e: { k: "ruler", id: "old", points: [{ x: 1.5, y: 1.5 }] } });
    moveTo(t, r.clock, T + 42 + RETAIN_MS);
    r.gate.open();
    await flush();
    assert.deepEqual(rulers(r.dm.sent.slice(later)), [], "past RETAIN_MS it is dropped");
  });
});
