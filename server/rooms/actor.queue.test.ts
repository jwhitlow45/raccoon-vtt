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

/*
 * The queue in arrival order (RoomActor #enqueue, #drain, #armTimer): each
 * command keeps the moment it arrived at, a batch holds one tick's
 * commands and closes once its tick has passed and none of them waits, and
 * the buckets a command spends read its arrival. The clock is a hand moved
 * one and the timers mocked ones. Most tests move both together. Where a
 * test needs a timer to fire late or early, it moves one without the other
 * (`hand`, `mock`), so a timer sees the clock it would on a busy loop.
 */

/** A multiple of every batch window below. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");

type Wire = ServerMessage | HistoryMessage;
type Ev = Extract<ServerMessage, { t: "ev" }>;
type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
type Logged = { msg: string; obj: Record<string, unknown> };

async function room(t: TestContext, opts: { budget?: (now: () => number) => SnapshotBudget; options?: ActorDeps["options"]; dms?: number } = {}) {
  // A room loaded earlier in the test keeps its timers mocked no longer: this one opens on real ones.
  t.mock.timers.reset();
  const f = scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const warned: Logged[] = [];
  const log = { info() {}, debug() {}, error() {}, warn: (obj: Record<string, unknown>, msg?: string) => void warned.push({ msg: msg ?? "", obj }) };
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log,
    budget: opts.budget?.(now) ?? new SnapshotBudget({}, now),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, now, numberClock: now, ...opts.options },
  });
  assert.ok(actor);
  t.after(() => {
    t.mock.timers.reset();
    db.beforeCommit = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // Opened while the clock stands and the timers are real.
  const dm = await ScopeClient.open(actor, f.dm, "dm", now);
  const p1 = await ScopeClient.open(actor, f.player, "player", now);
  const dms = [dm, ...(await Promise.all(Array.from({ length: (opts.dms ?? 1) - 1 }, () => ScopeClient.open(actor, f.dm, "dm", now))))];
  // The mocked timers' own time, which `mock` moves, and the hand clock, which `hand` sets.
  let mocked = clock.now;
  const timers = {
    enable() {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      mocked = clock.now;
    },
    hand(at: number) {
      clock.now = at;
    },
    mock(to: number) {
      assert.ok(to >= mocked, `the timers' time ${to} is before ${mocked}`);
      t.mock.timers.tick(to - mocked);
      mocked = to;
    },
    /** Both clocks to `at`. */
    move(at: number) {
      clock.now = at;
      timers.mock(Math.max(mocked, at));
    },
  };
  return { f, clock, db, actor, dm, dms, p1, now, warned, timers };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function socketOn(actor: RoomActor, grant: { sessionId?: string; memberId: string; role: "dm" | "player" }, now: () => number): { conn: Connection; sent: Wire[] } {
  const sent: Wire[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
  const conn = new Connection(socket as never, { sessionId: grant.sessionId ?? uuidv7(), roomId: "UNDOSCOPE", memberId: grant.memberId, role: grant.role }, "203.0.113.20", { now });
  actor.attach(conn);
  return { conn, sent };
}

function chat(client: ScopeClient, text: string): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, { t: "log.chat", text });
  return n;
}

function frameOf(sent: readonly Wire[], n: number): Ev | undefined {
  return sent.find((m): m is Ev => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n)));
}

function answerOf(client: ScopeClient, n: number): string | undefined {
  const ev = frameOf(client.sent, n);
  const retry = client.sent.find((m) => m.t === "retry" && m.n === n) as { code: string } | undefined;
  if (retry) return `retry ${retry.code}`;
  if (!ev) return undefined;
  const reject = ev.rejects?.find((r) => r.n === n);
  return reject ? `${reject.code}` : "taken";
}

const snapshots = (sent: readonly Wire[]) => sent.filter((m): m is Snapshot => m.t === "snapshot");

/** A deletion step that holds the queue until `release`. */
function heldStep(actor: RoomActor) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const done = actor.deletionStep(async () => {
    await held;
    return { deleted: [], result: 1 };
  });
  return { release, done };
}

describe("a batch closes once its tick's commands are handled", () => {
  test("a drain that lets the loop go mid-tick keeps the batch open until every command of its tick joined it", async (t) => {
    const r = await room(t, { dms: 9, options: { roomOpsPerSec: 100_000 } });
    r.timers.enable();
    const T = T0 + 1_000;
    r.timers.move(T + 1);
    const step = heldStep(r.actor);
    await flush();
    // 500 DM chats arrive at T + 5 behind the step, one tick's worth, across nine sockets within each one's burst.
    r.timers.move(T + 5);
    const sent: Array<[ScopeClient, number]> = [];
    for (let i = 0; i < 500; i++) {
      const client = r.dms[i % 9]!;
      sent.push([client, chat(client, `dm ${i}`)]);
    }
    assert.equal(r.actor.queueLength, 500);
    // The clock reads T + 19 as the step lets go: the batch's timer fires a millisecond after it opens.
    r.timers.hand(T + 19);
    step.release();
    let firedMidway = false;
    for (let i = 0; i < 200 && r.actor.queueLength > 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (r.actor.queueLength > 0 && r.clock.now < T + 21) {
        r.timers.move(r.clock.now + 1);
        firedMidway ||= r.clock.now >= T + 20;
      }
    }
    assert.ok(firedMidway, "the timer fired while commands of the tick still waited");
    r.timers.move(T + 25);
    await flush();
    // Its number ran past the tick with 500 answers in one millisecond: one frame carries them all.
    const frames = new Set(sent.map(([client, n]) => frameOf(client.sent, n)?.seq));
    assert.equal(frames.size, 1, "every chat in the one batch of tick T + 20");
    assert.ok([...frames][0]! >= T + 20);
  });

  test("a command that arrives once the drain has let the loop go waits for the drain's next turn", async (t) => {
    const r = await room(t, { dms: 3, options: { roomOpsPerSec: 100_000 } });
    const step = heldStep(r.actor);
    await flush();
    for (let i = 0; i < 12; i++) chat(r.dms[i % 3]!, `dm ${i}`);
    await flush();
    assert.equal(r.actor.queueLength, 12);
    // Every reading of the loop's clock moves it 3 ms, so a turn takes a few commands and lets the loop go.
    let loopClock = 0;
    const loop = t.mock.method(performance, "now", () => (loopClock += 3));
    step.release();
    // The step's end drains one turn and queues the next. This callback was queued first, so it runs between them.
    await new Promise((resolve) => setImmediate(resolve));
    const left = r.actor.queueLength;
    assert.ok(left > 0 && left < 12, `${left} commands left after one turn`);
    const late = chat(r.dms[0]!, "late");
    assert.equal(r.actor.queueLength, left + 1, "the arrival took no command");
    loop.mock.restore();
    await flush();
    assert.equal(r.actor.queueLength, 0);
    assert.equal(await until(() => answerOf(r.dms[0]!, late), "the late chat's answer"), "taken");
  });

  test("the drains of one turn of the loop share its budget, so arrivals past it wait for the next turn", async (t) => {
    const r = await room(t, { dms: 3, options: { roomOpsPerSec: 100_000 } });
    await flush();
    let loopClock = 0;
    const loop = t.mock.method(performance, "now", () => (loopClock += 3));
    // Twelve chats arrive in one turn of the loop, each drained as it arrives while the turn's budget lasts.
    const sent = Array.from({ length: 12 }, (_, i) => chat(r.dms[i % 3]!, `dm ${i}`));
    const waiting = r.actor.queueLength;
    assert.ok(waiting > 0 && waiting < 12, `${waiting} chats wait for the next turn`);
    loop.mock.restore();
    await flush();
    assert.equal(r.actor.queueLength, 0);
    for (const [i, n] of sent.entries()) assert.equal(await until(() => answerOf(r.dms[i % 3]!, n), `chat ${i}'s answer`), "taken");
  });

  test("a timer that fires late closes the batch at its tick, and one an op arrives after is in the next batch", async (t) => {
    const r = await room(t);
    r.timers.enable();
    const T = T0 + 1_000;
    r.timers.move(T + 5);
    const first = chat(r.p1, "first");
    // The loop is held past the tick: the timer fires 3 ms late, after P1's next chat at T + 21 arrived.
    r.timers.hand(T + 21);
    const next = chat(r.p1, "next");
    r.timers.move(T + 23);
    await flush();
    r.timers.move(T + 40);
    await flush();
    assert.deepEqual([frameOf(r.p1.sent, first)?.seq, frameOf(r.p1.sent, next)?.seq], [T + 20, T + 40]);
  });

  test("a timer that fires early waits once, and a clock set back closes the batch at the second firing with one log line", async (t) => {
    const r = await room(t);
    r.timers.enable();
    const T = T0 + 1_000;
    r.timers.move(T + 5);
    const early = chat(r.p1, "early");
    // The timers run 5 ms ahead of the clock.
    r.timers.hand(T + 15);
    r.timers.mock(T + 20);
    await flush();
    assert.equal(frameOf(r.p1.sent, early), undefined, "not closed at T + 15");
    r.timers.hand(T + 20);
    r.timers.mock(T + 25);
    await flush();
    assert.equal(frameOf(r.p1.sent, early)?.seq, T + 20);
    assert.equal(r.warned.length, 0, "an early firing logs nothing");
    // The clock is set back a second after P1's next chat.
    r.timers.move(T + 45);
    const back = chat(r.p1, "back");
    r.timers.hand(T + 60 - 1_000);
    r.timers.mock(T + 60);
    await flush();
    assert.equal(frameOf(r.p1.sent, back), undefined, "the first firing waits");
    r.timers.hand(T + 61 - 1_000);
    r.timers.mock(T + 80);
    await flush();
    assert.ok(frameOf(r.p1.sent, back), "the second firing closes it");
    assert.deepEqual(r.warned.map((w) => w.msg), ["clock behind the batch tick"]);
  });
});

describe("a delayed snapshot as its timer fires late", () => {
  /** P1's reconnect inside the budget's window, its snapshot delayed: the time it is due. */
  async function delayed(t: TestContext) {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now) });
    r.timers.enable();
    r.timers.move(T0 + 500);
    const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
    await flush();
    r.timers.move(T0 + 520);
    await flush();
    const wait = again.sent.find((m) => m.t === "wait") as { ms: number } | undefined;
    assert.ok(wait && wait.ms > 100, JSON.stringify(again.sent));
    const due = T0 + 500 + wait.ms;
    // The tick of the batch the snapshot belongs to, and where its due time falls in it.
    const tick = (Math.floor(due / 20) + 1) * 20;
    assert.ok(due % 20 > 1, `due ${due % 20} ms into its tick`);
    return { r, again, due, tick };
  }

  test("behind a hold, it goes before the commands that arrived after its due time", async (t) => {
    const { r, again, due, tick } = await delayed(t);
    r.timers.move(due - 10);
    const step = heldStep(r.actor);
    await flush();
    // Two chats of the DM's arrive behind the step (P1's old socket gave way to the reconnect), at the next tick's start and the one after, before the snapshot's timer runs.
    r.timers.hand(tick);
    const first = chat(r.dm, "first");
    r.timers.hand(tick + 20);
    const second = chat(r.dm, "second");
    r.timers.move(tick + 25);
    await flush();
    assert.deepEqual(snapshots(again.sent), [], "held with the queue");
    step.release();
    await flush();
    r.timers.move(tick + 40);
    await flush();
    assert.deepEqual(
      [snapshots(again.sent).map((m) => m.seq), frameOf(r.dm.sent, first)?.seq, frameOf(r.dm.sent, second)?.seq],
      [[tick], tick + 20, tick + 40],
    );
  });

  test("with a command of a later tick already taken, it joins that command's batch", async (t) => {
    const { r, again, tick } = await delayed(t);
    r.timers.hand(tick + 20);
    const later = chat(r.dm, "later");
    await flush();
    r.timers.move(tick + 25);
    await flush();
    r.timers.move(tick + 40);
    await flush();
    assert.deepEqual([snapshots(again.sent).map((m) => m.seq), frameOf(r.dm.sent, later)?.seq], [[tick + 40], tick + 40]);
  });

  test("after its own tick's batch closed, it is in the next tick's batch", async (t) => {
    const { r, again, due, tick } = await delayed(t);
    assert.equal(tick - due, 10);
    // The timers lag the clock by 15 ms as a chat opens the batch of the snapshot's tick, so the batch's timer, due
    // 5 ms on, fires before the snapshot's, due at its time.
    r.timers.move(tick - 20);
    r.timers.hand(tick - 5);
    const inTick = chat(r.dm, "in its tick");
    await flush();
    r.timers.hand(tick + 1);
    r.timers.mock(tick - 15);
    await flush();
    assert.equal(frameOf(r.dm.sent, inTick)?.seq, tick, "the batch closed at its tick");
    assert.deepEqual(snapshots(again.sent), []);
    r.timers.mock(tick - 10);
    await flush();
    r.timers.hand(tick + 20);
    r.timers.mock(tick + 10);
    await flush();
    assert.deepEqual(snapshots(again.sent).map((m) => m.seq), [tick + 20]);
  });
});

describe("admission at arrival", () => {
  test("an op that arrives while the queue is held spends its member's bucket as of its arrival", async (t) => {
    const r = await room(t);
    const second = await ScopeClient.open(r.actor, r.f.player, "player", r.now);
    r.timers.enable();
    const T = T0 + 1_000;
    r.timers.move(T + 1);
    // Sixty chats across P1's two sockets empty its member bucket, each socket inside its own burst.
    const spent: number[] = [];
    for (let i = 0; i < 60; i++) spent.push(chat(i % 2 === 0 ? r.p1 : second, `spend ${i}`));
    await flush();
    r.timers.move(T + 30);
    await flush();
    assert.ok(spent.every((n, i) => answerOf(i % 2 === 0 ? r.p1 : second, n) === "taken"));
    r.timers.move(T + 31);
    const step = heldStep(r.actor);
    await flush();
    // Arrives at T + 40, 39 ms after the bucket emptied: under one token. Handled 50 ms later, it would have two.
    r.timers.move(T + 40);
    const late = chat(r.p1, "over");
    r.timers.move(T + 90);
    await flush();
    step.release();
    await flush();
    r.timers.move(T + 120);
    await flush();
    assert.notEqual(answerOf(r.p1, late), "taken");
    assert.notEqual(answerOf(r.p1, late), undefined);
  });

  test("an asset op's lookup reads the socket's lookup bucket alone, an empty op bucket aside", async (t) => {
    const r = await room(t);
    const image = { assetId: "0192f0aa-0000-4000-8000-000000000001", crop: { cx: 0, cy: 0, zoom: 1 } };
    // The DM's socket spends its op bucket's burst: the asset op still reaches its lookup.
    while (r.dm.conn.opRate.allow(1, r.now())) {
      // spent
    }
    const lookups = r.db.assetLookups;
    const n = ++r.dm.n;
    await r.actor.op(r.dm.conn, n, { t: "token.update", tokenId: r.f.goblin, patch: { image } });
    assert.equal(r.db.assetLookups, lookups + 1, "looked up");
  });
});

describe("a snapshot's wait read from the hello's arrival", () => {
  test("the wait frames and the snapshot's tick are the same with the queue held across the hello", async (t) => {
    const run = async (hold: boolean) => {
      const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now) });
      r.timers.enable();
      r.timers.move(T0 + 490);
      const step = hold ? heldStep(r.actor) : null;
      await flush();
      r.timers.move(T0 + 500);
      const again = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
      void r.actor.hello(again.conn, { clientId: r.p1.clientId, resumeFrom: r.p1.n + 1 });
      await flush();
      r.timers.move(T0 + 560);
      step?.release();
      await flush();
      for (let at = T0 + 580; at <= T0 + 4_000; at += 20) {
        r.timers.move(at);
        await flush();
      }
      return again.sent.filter((m) => m.t === "wait" || m.t === "snapshot").map((m) => (m.t === "wait" ? `wait ${(m as { ms: number }).ms}` : `snapshot ${(m as Snapshot).seq}`));
    };
    const held = await run(true);
    const free = await run(false);
    assert.ok(held.some((m) => m.startsWith("snapshot")));
    assert.deepEqual(held, free);
  });
});
