import assert from "node:assert/strict";
import { after, before, describe, mock, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import type { HistoryMessage } from "#shared/undoContract.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { CLOSE, Connection } from "./connection.ts";
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

// The loop's clock, which the drain spends its turns on (actor.ts DRAIN_TURN_MS), stands still in this file, so a fixed
// flush is enough on any machine. A test of the drain's turns moves it on purpose, over this one.
before(() => mock.method(performance, "now", () => 0));
after(() => mock.restoreAll());

type Wire = ServerMessage | HistoryMessage;
type Ev = Extract<ServerMessage, { t: "ev" }>;
type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
type Logged = { msg: string; obj: Record<string, unknown> };

async function room(t: TestContext, opts: { budget?: (now: () => number) => SnapshotBudget; options?: ActorDeps["options"]; dms?: number; pool?: (pool: ActorDeps["pool"]) => ActorDeps["pool"] } = {}) {
  // A room loaded earlier in the test keeps its timers mocked no longer: this one opens on real ones.
  t.mock.timers.reset();
  const f = scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const warned: Logged[] = [];
  const log = { info() {}, debug() {}, error() {}, warn: (obj: Record<string, unknown>, msg?: string) => void warned.push({ msg: msg ?? "", obj }) };
  const budget = opts.budget?.(now) ?? new SnapshotBudget({}, now);
  /** The room loaded, as the server loads it again after it unloaded, on the same budget. */
  const load = async () => {
    const loaded = await RoomActor.load({
      pool: opts.pool?.(db.pool()) ?? db.pool(),
      info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
      log,
      budget,
      gateway: {} as RoomGateway,
      options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, now, numberClock: null, standingClock: true, ...opts.options },
    });
    assert.ok(loaded);
    t.after(() => {
      t.mock.timers.reset();
      db.beforeCommit = undefined;
      return loaded.shutdown({ code: 1012, snapshot: false });
    });
    return loaded;
  };
  const actor = await load();
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
  return { f, clock, db, actor, dm, dms, p1, now, warned, timers, budget, load };
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
    // Every reading of the loop's clock moves it 1 ms, so a turn takes a few of the 500 and lets the loop go.
    let loopClock = 0;
    t.mock.method(performance, "now", () => (loopClock += 1));
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

  test("reads across many ticks whose batches land without I/O run no further than one turn before an immediate queued first", async (t) => {
    const r = await room(t, { options: { roomOpsPerSec: 100_000 } });
    const step = heldStep(r.actor);
    await flush();
    // A hundred ids asks behind the step, each in its own tick, so each closes a batch of reads that lands in microtasks.
    for (let k = 1; k <= 100; k++) {
      r.clock.now += 20;
      r.actor.ids(r.dm.conn, { k, ids: [uuidv7()] });
    }
    await flush();
    assert.equal(r.actor.queueLength, 100);
    // Every reading of the loop's clock moves it 2 ms, so a command costs about 2 ms of the turn.
    let loopClock = 0;
    const loop = t.mock.method(performance, "now", () => (loopClock += 2));
    let takenFirst = -1;
    const first = new Promise<void>((resolve) =>
      setImmediate(() => {
        takenFirst = 100 - r.actor.queueLength;
        resolve();
      }),
    );
    step.release();
    await first;
    loop.mock.restore();
    assert.ok(takenFirst >= 1 && takenFirst <= 8, `${takenFirst} asks taken before the immediate`);
    await flush();
    assert.equal(r.actor.queueLength, 0);
    const answered = new Set(r.dm.sent.filter((m) => m.t === "ids").map((m) => (m as { k: number }).k));
    assert.equal(answered.size, 100);
  });

  test("a reader a landing batch covers is answered as it lands, while the drain waits for its next turn", async (t) => {
    const r = await room(t, { options: { roomOpsPerSec: 100_000 } });
    const step = heldStep(r.actor);
    await flush();
    // The first ask's tick: a reader then waits for its batch to land.
    const asked = r.clock.now + 40;
    for (let k = 1; k <= 40; k++) {
      r.clock.now += 20;
      r.actor.ids(r.dm.conn, { k, ids: [uuidv7()] });
    }
    let read = false;
    void r.actor.asOf(asked).then(() => (read = true));
    await flush();
    assert.equal(read, false, "the first ask's batch has not landed");
    let loopClock = 0;
    const loop = t.mock.method(performance, "now", () => (loopClock += 2));
    let readFirst: boolean | null = null;
    let leftFirst = -1;
    const first = new Promise<void>((resolve) =>
      setImmediate(() => {
        readFirst = read;
        leftFirst = r.actor.queueLength;
        resolve();
      }),
    );
    step.release();
    await first;
    loop.mock.restore();
    assert.ok(leftFirst > 0, "the drain waits for its next turn");
    assert.equal(readFirst, true, "the reader was answered as the first ask's batch landed");
    await flush();
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

  test("a room given a clock of the test's own but not the standing clock option closes a batch on a still clock by the rule above", async (t) => {
    // The DM's and P1's hellos as the rooms open, on a hand clock that stands at T0 while the real timers run.
    const still = await room(t, { options: { standingClock: false } });
    assert.deepEqual(still.warned.map((w) => w.msg), ["clock behind the batch tick"], "the batch closed at its timer's second firing");
    const standing = await room(t);
    assert.deepEqual(standing.warned, [], "with the option, at its first");
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

  /** The frames that answered a socket's snapshot requests: each `wait` with its value, and each `snapshot`. */
  const answers = (sent: readonly Wire[]) => sent.flatMap((m) => (m.t === "wait" ? [`wait ${m.ms}`] : m.t === "snapshot" ? ["snapshot"] : []));

  /** A new socket of P1's session at `at`, P1's page's own unless `clientId` names another page, with its hello sent then. */
  function reconnect(r: Awaited<ReturnType<typeof room>>, at: number, clientId = r.p1.clientId) {
    r.timers.move(at);
    const socket = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
    void r.actor.hello(socket.conn, { clientId, resumeFrom: clientId === r.p1.clientId ? r.p1.n + 1 : 1 });
    return socket;
  }

  test("a hello takes the place of its client's delayed request as it arrives, so the request it replaced spends nothing", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now) });
    r.timers.enable();
    // Two reconnects of P1's page inside the window its first snapshot spent, before the server hears its older sockets close.
    const second = reconnect(r, T0 + 500);
    await flush();
    r.timers.move(T0 + 520);
    await flush();
    const third = reconnect(r, T0 + 600);
    await flush();
    for (let at = T0 + 620; at <= T0 + 3_000; at += 20) {
      r.timers.move(at);
      await flush();
    }
    assert.deepEqual([answers(second.sent), answers(third.sent)], [["wait 510"], ["wait 410", "snapshot"]]);
  });

  /** The client's close of `socket`, as the server's socket reports it (ws.ts). */
  function clientCloses(r: Awaited<ReturnType<typeof room>>, socket: { conn: Connection }) {
    socket.conn.closed = true;
    socket.conn.clearTimers();
    r.actor.detach(socket.conn);
  }

  test("a delayed request of a socket its client closes spends nothing, and another client's still comes due", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now) });
    r.timers.enable();
    // P1's page and another page of P1's session both wait for the place P1's first snapshot holds until 1,010 ms.
    const gone = reconnect(r, T0 + 500);
    await flush();
    const stays = reconnect(r, T0 + 510, uuidv7());
    await flush();
    r.timers.move(T0 + 540);
    await flush();
    r.timers.move(T0 + 600);
    clientCloses(r, gone);
    for (let at = T0 + 1_000; at <= T0 + 1_100; at += 20) {
      r.timers.move(at);
      await flush();
    }
    assert.deepEqual([answers(gone.sent), answers(stays.sent)], [["wait 510"], ["wait 500", "snapshot"]]);
  });

  test("requests of sockets the room closed count against their session's bound on requests waiting at once until each is answered", async (t) => {
    let budget!: SnapshotBudget;
    const r = await room(t, { budget: (now) => (budget = new SnapshotBudget({ sessionCount: 1, windowMs: 10_000 }, now)) });
    r.timers.enable();
    // Twenty pages of P1's session ask while it is over budget, and the room closes each socket as its second hello
    // would close it (ws.ts), once its wait is sent.
    const pages: Array<ReturnType<typeof reconnect>> = [];
    for (let i = 0; i < 20; i++) {
      const page = reconnect(r, T0 + 500 + 40 * i, uuidv7());
      pages.push(page);
      await flush();
      r.timers.move(T0 + 530 + 40 * i);
      await flush();
      page.conn.close(CLOSE.authFailure, "unexpected hello");
      r.actor.detach(page.conn);
    }
    assert.deepEqual([budget.waiting, r.actor.delayedRequests], [16, 0], "sixteen wait in the budget, and the room follows none");
    assert.deepEqual(
      pages.map((p) => [answers(p.sent).length, p.conn.closedWith]),
      [...Array.from({ length: 16 }, () => [1, CLOSE.authFailure]), ...Array.from({ length: 4 }, () => [0, CLOSE.abuse])],
      "the first sixteen waited, and the rest closed as they arrived",
    );
    // At 10 s the first fits and the rest wait again, still counted, so the session has room for one more.
    r.timers.move(T0 + 10_100);
    await flush();
    assert.deepEqual([budget.waiting, r.actor.delayedRequests], [15, 0], "the room follows none of them as they wait again");
    const more = reconnect(r, T0 + 10_100, uuidv7());
    await flush();
    const past = reconnect(r, T0 + 10_120, uuidv7());
    await flush();
    r.timers.move(T0 + 10_140);
    await flush();
    assert.deepEqual([answers(more.sent).length, more.conn.closed, past.conn.closedWith], [1, false, CLOSE.abuse]);
  });

  test("requests due before a hello is read are settled first, so one that waits again keeps its place against the bound", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 10_000, sessionWaiting: 2 }, now) });
    r.timers.enable();
    // Two pages of P1's session wait for the place P1's first snapshot holds until 10 s, and the room closes both.
    for (const at of [T0 + 500, T0 + 540]) {
      const page = reconnect(r, at, uuidv7());
      await flush();
      r.timers.move(at + 30);
      await flush();
      page.conn.close(CLOSE.authFailure, "unexpected hello");
      r.actor.detach(page.conn);
    }
    // The loop is busy past their due time: two more pages ask at 10,001 and 10,002 ms, before the budget's timer fires.
    const late: Array<ReturnType<typeof socketOn>> = [];
    for (const at of [T0 + 10_001, T0 + 10_002]) {
      r.timers.hand(at);
      const page = socketOn(r.actor, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
      void r.actor.hello(page.conn, { clientId: uuidv7(), resumeFrom: 1 });
      late.push(page);
      await flush();
    }
    r.timers.move(T0 + 10_100);
    await flush();
    // At 10 s one of the two fit and the other waits again, so only one of the later pages has room.
    assert.deepEqual(late.map((p) => p.conn.closedWith), [null, CLOSE.abuse]);
    assert.equal(r.budget.waiting, 2);
  });

  test("a hello after the room unloaded and loaded again takes the place of its client's request", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 10_000, sessionWaiting: 2 }, now) });
    r.timers.enable();
    const clients = [uuidv7(), uuidv7()];
    for (const [i, clientId] of clients.entries()) {
      reconnect(r, T0 + 500 + 40 * i, clientId);
      await flush();
    }
    r.timers.move(T0 + 600);
    await flush();
    await r.actor.shutdown({ code: CLOSE.evicted, snapshot: false });
    const again = await r.load();
    r.timers.move(T0 + 700);
    const pages = clients.map((clientId) => {
      const page = socketOn(again, { sessionId: r.p1.conn.sessionId, memberId: r.f.player.id, role: "player" }, r.now);
      void again.hello(page.conn, { clientId, resumeFrom: 1 });
      return page;
    });
    await flush();
    r.timers.move(T0 + 720);
    await flush();
    assert.deepEqual(
      pages.map((p) => [p.conn.closedWith, answers(p.sent)]),
      [
        [null, ["wait 9300"]],
        [null, ["wait 9300"]],
      ],
    );
    assert.equal(r.budget.waiting, 2);
  });

  test("a hello past the abuse rule leaves no request waiting", async (t) => {
    let budget!: SnapshotBudget;
    const r = await room(t, { budget: (now) => (budget = new SnapshotBudget({ sessionCount: 1, windowMs: 120_000, abuseMs: 30_000 }, now)) });
    r.timers.enable();
    // The session asked over budget in another room at 1 s, which starts its time over budget, and a new socket of its
    // asks here 30 s later.
    budget.request(r.p1.conn.sessionId, true, T0 + 1_000);
    const page = reconnect(r, T0 + 31_000, uuidv7());
    await flush();
    assert.deepEqual([page.conn.closedWith, r.actor.delayedRequests], [CLOSE.abuse, 0]);
  });

  test("sockets their clients close before their hellos are handled keep no delayed request and spend nothing", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now) });
    r.timers.enable();
    r.timers.move(T0 + 490);
    const step = heldStep(r.actor);
    await flush();
    // More than the session's bound on requests waiting at once, which a closed one no longer counts against.
    const closed: Array<ReturnType<typeof reconnect>> = [];
    for (let i = 0; i < 10; i++) {
      const page = reconnect(r, T0 + 500 + 10 * i, uuidv7());
      await flush();
      clientCloses(r, page);
      closed.push(page);
    }
    const kept = r.actor.delayedRequests;
    r.timers.move(T0 + 1_100);
    step.release();
    await flush();
    assert.deepEqual([kept, r.budget.waiting], [0, 0]);
    assert.deepEqual(closed.map((p) => p.conn.closedWith), Array.from({ length: 10 }, () => null), "every one was let in");
    const page = reconnect(r, T0 + 1_100, uuidv7());
    await flush();
    r.timers.move(T0 + 1_120);
    await flush();
    assert.deepEqual(answers(page.sent), ["snapshot"]);
    assert.equal(r.actor.delayedRequests, 0);
  });

  test("a role resync while a hello reads its watermark leaves that hello's requests unanswered until the client's next hello", async (t) => {
    // The room checks each socket's grant every 20 ms of the loop's own time. A session the test has not named yet has no
    // answer, which leaves its sockets as they are, and P1's session turns DM once `promoted` is set.
    const roles = new Map<string, { member_id: string; role: "dm" | "player" }>();
    let promoted = false;
    let shut: { promise: Promise<void>; open: () => void } | null = null;
    const pool = (stored: ActorDeps["pool"]) =>
      ({
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("where g.session_id = $1")) {
            const grant = roles.get(params[0] as string);
            if (!grant) throw new Error("a session the test has not named");
            return { rows: [{ ...grant, role: promoted && grant.role === "player" ? "dm" : grant.role, epoch: 1, player_epoch: 1, dm_epoch: 1 }] };
          }
          if (sql.includes("from client_watermarks where")) await shut?.promise;
          return stored.query(sql, params as never);
        },
        connect: () => stored.connect(),
      }) as unknown as ActorDeps["pool"];
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 1_010 }, now), options: { grantRecheckMs: 20 }, pool });
    for (const client of r.dms) roles.set(client.conn.sessionId, { member_id: r.f.dm.id, role: "dm" });
    roles.set(r.p1.conn.sessionId, { member_id: r.f.player.id, role: "player" });
    r.timers.enable();
    let open!: () => void;
    shut = { promise: new Promise<void>((resolve) => (open = resolve)), open };
    // A page of P1's session asks at 500 ms and waits for P1's first snapshot's place until 1,010, its watermark read held.
    const clientId = uuidv7();
    const page = reconnect(r, T0 + 500, clientId);
    await flush();
    promoted = true;
    const deadline = Date.now() + 10_000;
    while (!page.sent.some((m) => m.t === "resync") && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    const resynced = page.sent.length;
    assert.ok(resynced > 0, "the role resync came");
    shut.open();
    shut = null;
    await flush();
    for (let at = T0 + 520; at <= T0 + 1_200; at += 20) {
      r.timers.move(at);
      await flush();
    }
    // The client's next hello over the same socket. Its request waits for the place its old one took at 1,010 ms.
    void r.actor.hello(page.conn, { clientId, resumeFrom: 1 });
    await flush();
    for (let at = T0 + 1_220; at <= T0 + 2_100; at += 20) {
      r.timers.move(at);
      await flush();
    }
    assert.deepEqual(answers(page.sent.slice(resynced)), ["wait 820", "snapshot"]);
  });

  test("a resync stops the waits of a request from before it, and it never sends that request's snapshot", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 10_000 }, now) });
    r.timers.enable();
    // A device of the DM's session asks at 500 ms and waits 9.5 s, then switches scene at 3 s.
    r.timers.move(T0 + 500);
    const device = socketOn(r.actor, { sessionId: r.dm.conn.sessionId, memberId: r.f.dm.id, role: "dm" }, r.now);
    void r.actor.hello(device.conn, { clientId: uuidv7(), resumeFrom: 1 });
    await flush();
    for (let at = T0 + 520; at <= T0 + 3_000; at += 20) {
      r.timers.move(at);
      await flush();
    }
    r.actor.scene(device.conn);
    for (let at = T0 + 3_500; at <= T0 + 11_000; at += 500) {
      r.timers.move(at);
      await flush();
    }
    assert.deepEqual(
      device.sent.filter((m) => m.t === "wait" || m.t === "snapshot" || m.t === "resync").map((m) => (m.t === "wait" ? `wait ${m.ms}` : m.t)),
      ["wait 9500", "wait 7500", "resync"],
    );
  });

  test("a snapshot's bytes count against its session once it is sent", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionBytes: 1 }, now) });
    r.timers.enable();
    const again = reconnect(r, T0 + 500);
    await flush();
    r.timers.move(T0 + 520);
    await flush();
    assert.deepEqual(answers(again.sent), ["wait 59500"], "P1's first snapshot, sent at T0, holds the session's bytes for a minute");
  });

  test("a request a newer hello took the place of sends its waits only up to then, though its batch publishes after", async (t) => {
    const r = await room(t, { budget: (now) => new SnapshotBudget({ sessionCount: 1, windowMs: 10_000 }, now) });
    r.timers.enable();
    let land!: () => void;
    const held = new Promise<void>((resolve) => (land = resolve));
    r.db.beforeCommit = () => held;
    // P1's reconnect waits 9.5 s, and a chat of the DM's in its tick holds its batch at the commit until 5 s.
    const first = reconnect(r, T0 + 500);
    chat(r.dm, "held");
    await flush();
    // A deletion step behind that batch holds the queue before any later tick, so the next reconnect is handled after
    // the first's batch publishes, while the first is still its client's socket.
    r.timers.move(T0 + 510);
    const step = heldStep(r.actor);
    await flush();
    reconnect(r, T0 + 3_000);
    await flush();
    r.timers.move(T0 + 5_000);
    land();
    await flush();
    for (let at = T0 + 5_500; at <= T0 + 9_500; at += 500) {
      r.timers.move(at);
      await flush();
    }
    step.release();
    await step.done;
    assert.deepEqual(answers(first.sent), ["wait 9500", "wait 7500"], "its wait, and the one each 2 s after it up to 3 s");
  });

  test("a delayed request that comes due and waits again counts nothing toward the abuse rule", async (t) => {
    let budget!: SnapshotBudget;
    const r = await room(t, { budget: (now) => (budget = new SnapshotBudget({ ipCount: 2, windowMs: 40_000, abuseMs: 30_000 }, now)) });
    r.timers.enable();
    // Another session at the same address spends both of the address's places by 1 s. A page of P1's session asks at
    // 5 s and waits for the oldest place, which starts the session's time over budget.
    const other = budget.keys("0199f0a0-0000-7000-8000-00000000b002", "203.0.113.20", false);
    budget.record(other, 1_000, T0);
    budget.record(other, 1_000, T0 + 1_000);
    const page = reconnect(r, T0 + 5_000, uuidv7());
    await flush();
    for (let at = T0 + 5_500; at < T0 + 40_000; at += 500) {
      r.timers.move(at);
      await flush();
    }
    // The other session takes that place just before it frees, as its snapshot in another room would, so the page's
    // request comes due at 40 s, 35 s after the session's time over budget started, and waits again, for the next
    // place at 41 s.
    budget.record(other, 1_000, T0 + 39_999);
    for (let at = T0 + 40_000; at <= T0 + 42_000; at += 20) {
      r.timers.move(at);
      await flush();
    }
    assert.equal(page.conn.closed, false);
    assert.deepEqual(answers(page.sent).slice(-3), ["wait 1000", "wait 1000", "snapshot"], "its last wait, then the one it waits again, then its snapshot");
  });

  test("only a socket's first hello counts toward the abuse rule, never another hello over the same socket", async (t) => {
    let budget!: SnapshotBudget;
    const r = await room(t, { budget: (now) => (budget = new SnapshotBudget({ ipCount: 2, abuseMs: 30_000 }, now)) });
    r.timers.enable();
    // Another session at the same address spends both of the address's places by 1 s. A page of P1's session asks at
    // 5 s, which starts the session's time over budget, and asks again over the same socket 31 s later.
    const other = budget.keys("0199f0a0-0000-7000-8000-00000000b002", "203.0.113.20", false);
    budget.record(other, 1_000, T0);
    budget.record(other, 1_000, T0 + 1_000);
    const clientId = uuidv7();
    const page = reconnect(r, T0 + 5_000, clientId);
    await flush();
    r.timers.move(T0 + 36_000);
    void r.actor.hello(page.conn, { clientId, resumeFrom: 1 });
    await flush();
    r.timers.move(T0 + 36_020);
    await flush();
    assert.equal(page.conn.closed, false);
    assert.equal(answers(page.sent).at(-1), "wait 24000", "the second hello's own wait");
  });
});
