import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import type { HistoryMessage } from "#shared/undoContract.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, until } from "./undoScopeTesting.ts";

/**
 * Batches close on the number clock's grid, and every snapshot and resent
 * ack a device asks for joins a batch and is answered at its close, with
 * the number of that close (docs/design/design-v1-room-count.md). The clock
 * here is a hand-moved one, and the batch timer a mocked one, so each test
 * says when the clock reads what.
 */

/** A multiple of every batch window below, so the first tick after it is a whole window on. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Wire = ServerMessage | HistoryMessage;
type Ev = Extract<ServerMessage, { t: "ev" }>;
type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;

async function gridRoom(t: TestContext, opts: { budget?: (now: () => number) => SnapshotBudget; options?: ActorDeps["options"] } = {}) {
  const f = scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: opts.budget?.(now) ?? new SnapshotBudget({}, now),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, now, numberClock: now, ...opts.options },
  });
  assert.ok(actor);
  t.after(() => {
    // The real clearTimeout, so the shutdown clears the snapshot timer a real commit placed.
    t.mock.timers.reset();
    db.beforeCommit = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // Opened while the clock stands at T0 and the timer is real: each hello's batch closes a window on.
  const dm = await ScopeClient.open(actor, f.dm, "dm", now);
  const p1 = await ScopeClient.open(actor, f.player, "player", now);
  return { f, clock, db, actor, dm, p1, now };
}

/** A socket of its own on the room, as a device's reconnect or another screen opens one. */
function socketOn(actor: RoomActor, grant: { sessionId?: string; memberId: string; role: "dm" | "player"; display?: boolean; previewOf?: string }, now: () => number): { conn: Connection; sent: Wire[] } {
  const sent: Wire[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
  const conn = new Connection(socket as never, { sessionId: grant.sessionId ?? uuidv7(), roomId: "UNDOSCOPE", memberId: grant.memberId, role: grant.role, ...(grant.display ? { display: true } : {}), ...(grant.previewOf ? { previewOf: grant.previewOf } : {}) }, "203.0.113.20", { now });
  actor.attach(conn);
  return { conn, sent };
}

/** Lets the queue, the stored room's commit and the fan-out run, with the batch timer mocked. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function evs(sent: readonly Wire[], from = 0): Ev[] {
  return sent.slice(from).filter((m): m is Ev => m.t === "ev");
}

function snapshots(sent: readonly Wire[], from = 0): Snapshot[] {
  return sent.slice(from).filter((m): m is Snapshot => m.t === "snapshot");
}

function chat(client: ScopeClient, text: string): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, { t: "log.chat", text });
  return n;
}

/** Moves the hand clock to `at` and the mocked timers by as much. */
function moveTo(t: TestContext, clock: { now: number }, at: number): void {
  const by = at - clock.now;
  assert.ok(by >= 0);
  clock.now = at;
  t.mock.timers.tick(by);
}

describe("batches close on the number clock's grid", () => {
  test("a batch closes at the next tick whoever opened it, and an answer joining a batch a read opened does not start it again", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.clock.now = T0 + 3;
    const first = r.p1.sent.length;
    chat(r.p1, "at 3");
    await flush();
    moveTo(t, r.clock, T0 + 19);
    await flush();
    assert.deepEqual(evs(r.p1.sent, first), [], "nothing before the tick at 20");
    moveTo(t, r.clock, T0 + 20);
    await flush();
    assert.deepEqual(evs(r.p1.sent, first).map((m) => [m.seq, m.acks]), [[T0 + 20, [r.p1.n]]], "acked at the tick, numbered by the clock then");
    // A reconnect's read opens the next batch at 45, and P1's chat at 55 joins it: it still closes at 60.
    moveTo(t, r.clock, T0 + 45);
    const again = socketOn(r.actor, { memberId: r.f.dm.id, role: "dm" }, r.now);
    void r.actor.hello(again.conn, { clientId: uuidv7(), resumeFrom: 1 });
    await flush();
    moveTo(t, r.clock, T0 + 55);
    const second = r.p1.sent.length;
    chat(r.p1, "at 55");
    await flush();
    moveTo(t, r.clock, T0 + 59);
    await flush();
    assert.deepEqual(evs(r.p1.sent, second), []);
    assert.deepEqual(snapshots(again.sent), []);
    moveTo(t, r.clock, T0 + 60);
    await flush();
    assert.deepEqual(evs(r.p1.sent, second).map((m) => [m.seq, m.acks]), [[T0 + 60, [r.p1.n]]]);
    assert.deepEqual(snapshots(again.sent).map((m) => m.seq), [T0 + 60]);
  });

  test("an op that comes after the tick its batch was due at, before the late timer fires, has a number at or below its frame's, which is the clock at the close", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.clock.now = T0 + 5;
    const from = r.p1.sent.length;
    chat(r.p1, "early");
    await flush();
    // The tick at 20 passes on the clock, and the timer has not fired yet when the second chat comes at 22.
    r.clock.now = T0 + 22;
    chat(r.p1, "late");
    await flush();
    r.clock.now = T0 + 25;
    t.mock.timers.tick(15);
    await flush();
    const [ev] = evs(r.p1.sent, from);
    assert.ok(ev);
    assert.deepEqual(ev.acks, [r.p1.n - 1, r.p1.n]);
    assert.equal(ev.seq, T0 + 25, "the frame carries the clock as the batch closed, not the tick it was due at");
    const late = r.actor.committed.state.log.find((line) => line.text === "late");
    assert.equal(late?.id, `${T0 + 22}:0`);
    assert.ok(Number(late.id.split(":")[0]) <= ev.seq);
  });

  test("the cap closes a batch at once, off the grid, and its frame carries the highest number its answers took", async (t) => {
    const r = await gridRoom(t, { options: { maxBatchOps: 3 } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.clock.now = T0 + 5;
    const from = r.p1.sent.length;
    for (const text of ["a", "b", "c"]) chat(r.p1, text);
    await flush();
    const [ev] = evs(r.p1.sent, from);
    assert.ok(ev, "closed before any tick");
    assert.deepEqual(ev.acks, [r.p1.n - 2, r.p1.n - 1, r.p1.n]);
    // Three answers in one millisecond run ahead of it by one each.
    assert.deepEqual(r.actor.committed.state.log.slice(-3).map((line) => line.id), [`${T0 + 5}:0`, `${T0 + 6}:0`, `${T0 + 7}:0`]);
    assert.equal(ev.seq, T0 + 7);
  });
});

describe("a device's reads are answered at a batch's close", () => {
  /** A room whose last commit was at T0 + 20, with the clock moved on to T0 + 5000 and the timer mocked. */
  async function quietRoom(t: TestContext, opts: Parameters<typeof gridRoom>[1] = {}) {
    const r = await gridRoom(t, opts);
    await r.dm.apply({ t: "log.chat", text: "done before" });
    const committed = r.actor.committed.pub;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.clock.now = T0 + 5_003;
    return { ...r, committed };
  }

  test("a reconnect's snapshot and history come at the next tick, numbered by the clock then, not at once with the last commit's number", async (t) => {
    const r = await quietRoom(t);
    const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await flush();
    assert.deepEqual(snapshots(again.sent), [], "nothing before the tick");
    moveTo(t, r.clock, T0 + 5_020);
    await flush();
    assert.deepEqual(snapshots(again.sent).map((m) => m.seq), [T0 + 5_020]);
    assert.ok(T0 + 5_020 > r.committed);
    assert.equal(again.sent.findLast((m) => m.t === "history")?.seq, T0 + 5_020);
  });

  test("a resent op's ack and the history after it come at the next tick", async (t) => {
    const r = await quietRoom(t);
    await flush();
    const from = r.dm.sent.length;
    void r.actor.op(r.dm.conn, r.dm.n, { t: "log.chat", text: "done before" });
    await flush();
    assert.deepEqual(r.dm.sent.slice(from), [], "nothing before the tick");
    moveTo(t, r.clock, T0 + 5_020);
    await flush();
    const sent = r.dm.sent.slice(from);
    assert.deepEqual(sent[0], { t: "ev", seq: T0 + 5_020, changes: [], acks: [r.dm.n] });
    assert.equal(sent[1]?.t, "history");
    assert.equal(sent[1]?.seq, T0 + 5_020);
  });

  test("a delayed snapshot whose wait ends comes at the next tick after it", async (t) => {
    const r = await quietRoom(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_000 }, now) });
    // P1's own reconnect inside the window: its session spent its one snapshot when it opened.
    r.clock.now = T0 + 500;
    const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await flush();
    moveTo(t, r.clock, T0 + 520);
    await flush();
    const wait = again.sent.find((m) => m.t === "wait");
    assert.ok(wait && wait.t === "wait" && wait.ms > 0, JSON.stringify(again.sent));
    assert.deepEqual(snapshots(again.sent), []);
    // The wait ends between two ticks: the snapshot waits for the next.
    const ends = T0 + 520 + wait.ms;
    moveTo(t, r.clock, ends);
    await flush();
    assert.deepEqual(snapshots(again.sent), [], "not at once when the wait ends");
    const tick = Math.ceil((ends + 1) / 20) * 20;
    moveTo(t, r.clock, tick);
    await flush();
    assert.deepEqual(snapshots(again.sent).map((m) => m.seq), [tick]);
  });

  test("a View as preview's snapshot and a table display's come at the next tick", async (t) => {
    const r = await quietRoom(t);
    const preview = socketOn(r.actor, { memberId: r.f.dm.id, role: "dm", previewOf: r.f.player.id }, r.now);
    const display = socketOn(r.actor, { memberId: r.f.dm.id, role: "dm", display: true }, r.now);
    void r.actor.hello(preview.conn, { clientId: uuidv7(), resumeFrom: 1 });
    void r.actor.hello(display.conn, { clientId: uuidv7(), resumeFrom: 1 });
    await flush();
    assert.deepEqual([snapshots(preview.sent), snapshots(display.sent)], [[], []]);
    moveTo(t, r.clock, T0 + 5_020);
    await flush();
    assert.deepEqual(snapshots(preview.sent).map((m) => m.seq), [T0 + 5_020]);
    assert.deepEqual(snapshots(display.sent).map((m) => m.seq), [T0 + 5_020]);
  });

  test("the hello after a resync comes at the next tick", async (t) => {
    const r = await quietRoom(t);
    const from = r.dm.sent.length;
    r.actor.scene(r.dm.conn);
    assert.equal(r.dm.sent.at(-1)?.t, "resync");
    void r.actor.hello(r.dm.conn, { clientId: r.dm.clientId, resumeFrom: r.dm.n + 1 });
    await flush();
    assert.deepEqual(snapshots(r.dm.sent, from), []);
    moveTo(t, r.clock, T0 + 5_020);
    await flush();
    assert.deepEqual(snapshots(r.dm.sent, from).map((m) => m.seq), [T0 + 5_020]);
  });

  test("a batch of reads alone stores nothing and moves no stored number", async (t) => {
    const r = await quietRoom(t);
    let commits = 0;
    r.db.beforeCommit = async () => {
      commits++;
    };
    const rows = r.db.rows.length;
    const stored = r.db.pub;
    const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await flush();
    moveTo(t, r.clock, T0 + 5_020);
    await flush();
    assert.deepEqual(snapshots(again.sent).map((m) => m.seq), [T0 + 5_020]);
    assert.equal(commits, 0, "no transaction for a batch of reads");
    assert.equal(r.db.rows.length, rows);
    assert.equal(r.db.pub, stored);
    // The next answer is above the number the read was handed.
    r.clock.now = T0 + 5_020;
    chat(r.p1, "after the read");
    await flush();
    moveTo(t, r.clock, T0 + 5_040);
    await flush();
    assert.ok(r.actor.committed.state.log.some((line) => line.id === `${T0 + 5_021}:0`), "one past the number handed at the same millisecond");
  });
});

describe("a read behind a commit that is retried", () => {
  test("a reload while the database is out gets no frame until the commit lands, then its snapshot at the close after", async (t) => {
    const r = await gridRoom(t);
    let out = true;
    let tries = 0;
    r.db.beforeCommit = async () => {
      tries++;
      if (out) throw new Error("connection refused");
    };
    void r.actor.op(r.p1.conn, ++r.p1.n, { t: "log.chat", text: "while out" });
    await until(() => (tries > 0 ? true : undefined), "a failed commit");
    assert.equal(r.actor.retrying, true);
    const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await until(() => (tries > 3 ? true : undefined), "the commit retried");
    assert.deepEqual(again.sent, [], "nothing while the commit retries");
    r.clock.now = T0 + 1_000;
    out = false;
    const snapshot = await until(() => snapshots(again.sent)[0], "the snapshot after the commit");
    assert.equal(snapshot.seq, T0 + 1_000, "numbered by the close after the commit landed");
    assert.equal(snapshot.watermark, r.p1.n, "it holds the op the commit stored");
  });
});
