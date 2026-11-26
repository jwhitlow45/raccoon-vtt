import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION, WALK_TRIM_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { markOffset, RoomActor, SNAPSHOT_EVERY_MS, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import type { RoomGateway } from "./gateway.ts";
import { snapshotJson, snapshotSlices, type Pool } from "./persistence.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, storedActor, type StoredRow } from "./undoScopeTesting.ts";

/*
 * A loaded room builds its snapshot at every mark, every SNAPSHOT_EVERY_MS
 * on the server clock from an offset its id fixes, and writes that build at
 * every third mark when rows were stored since the last write, or at any
 * mark past the backstop's rows (RoomActor #mark). The clock here is a hand
 * moved one and the timers mocked ones, enabled before the room loads, so
 * each mark fires as the clock reaches it.
 */

/** A whole number of mark periods, so the marks fall at this plus the room's offset. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const ROOM = "UNDOSCOPE";
const OFFSET = markOffset(ROOM, SNAPSHOT_EVERY_MS);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Ev = Extract<ServerMessage, { t: "ev" }>;
type Mark = { at: number; third: boolean };

/** The marks after `from` and up to `to`, each with whether it is a third one on the room's grid. */
function marksBetween(from: number, to: number): Mark[] {
  const marks: Mark[] = [];
  for (let k = Math.floor((from - OFFSET) / SNAPSHOT_EVERY_MS) + 1; OFFSET + k * SNAPSHOT_EVERY_MS <= to; k++) marks.push({ at: OFFSET + k * SNAPSHOT_EVERY_MS, third: k % 3 === 0 });
  return marks;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

type Logged = { level: "warn" | "error"; msg: string; obj: Record<string, unknown> };

/**
 * A room loaded with the mocked timers on, its DM and P1 open. Every build
 * records the clock, and every write outside a commit too, through
 * `beforeWrite`, which a test scripts to hold or fail it.
 */
async function markRoom(t: TestContext, opts: { options?: ActorDeps["options"]; pool?: (base: Pool) => Pool; state?: RoomState; version?: number; rows?: StoredRow[]; f?: ReturnType<typeof scopeFixture> } = {}) {
  const f = opts.f ?? scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(opts.state ?? f.state, { version: opts.version, rows: opts.rows });
  const builds: number[] = [];
  const writes: number[] = [];
  const logged: Logged[] = [];
  const room = { beforeWrite: async (): Promise<void> => {} };
  db.beforeSnapshot = async () => {
    writes.push(clock.now);
    await room.beforeWrite();
  };
  const log = {
    info() {},
    debug() {},
    warn: (obj: Record<string, unknown>, msg?: string) => void logged.push({ level: "warn", msg: msg ?? "", obj }),
    error: (obj: Record<string, unknown>, msg?: string) => void logged.push({ level: "error", msg: msg ?? "", obj }),
  };
  // A room loaded earlier in the test keeps no timer: each room here runs alone once the next one loads.
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Every delay a timer is placed with, read through the mocked setTimeout, which the reset puts back.
  const delays: number[] = [];
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return mocked(fn, ms);
  }) as typeof setTimeout;
  const base = db.pool();
  const actor = await RoomActor.load({
    pool: opts.pool?.(base) ?? base,
    info: { roomId: ROOM, pinned: false, createdIp: null, readOnly: false },
    log,
    budget: new SnapshotBudget({}, now),
    gateway: {} as RoomGateway,
    options: {
      batchMs: 20,
      retryBaseMs: 5,
      retryMaxMs: 20,
      grantRecheckMs: 60_000,
      roomOpsPerSec: 10_000,
      now,
      numberClock: null,
      standingClock: true,
      snapshotJson: (state) => {
        builds.push(clock.now);
        return snapshotJson(state);
      },
      snapshotSlices: (state) => {
        builds.push(clock.now);
        return snapshotSlices(state);
      },
      ...opts.options,
    },
  });
  assert.ok(actor);
  t.after(() => {
    t.mock.timers.reset();
    db.beforeCommit = undefined;
    db.beforeSnapshot = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  /** Moves the clock to `at`, and the mocked timers by as much, then lets the queue and the commits run. */
  const to = async (at: number) => {
    const by = at - clock.now;
    assert.ok(by >= 0, `${at} is before ${clock.now}`);
    clock.now = at;
    t.mock.timers.tick(by);
    await flush();
  };
  const open = async (who: Parameters<typeof ScopeClient.open>[1], role: "dm" | "player") => {
    const opening = ScopeClient.open(actor, who, role, now);
    let done = false;
    void opening.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) await to(clock.now + 1);
    return opening;
  };
  const dm = await open(f.dm, "dm");
  const p1 = await open(f.player, "player");
  return { f, clock, db, actor, dm, p1, builds, writes, logged, room, to, delays };
}

function chat(client: ScopeClient, text: string): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, { t: "log.chat", text });
  return n;
}

function answerOf(client: ScopeClient, n: number): string | undefined {
  const ev = client.sent.find((m): m is Ev => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n)));
  if (!ev) return undefined;
  const reject = ev.rejects?.find((r) => r.n === n);
  return reject ? `${reject.code}: ${reject.message}` : "taken";
}

const failing = (logged: Logged[]) => logged.filter((l) => l.msg === "snapshot writes are failing: the replay tail grows");

describe("marks", () => {
  /**
   * A minute of P1's chats, with 400 DM chats in one room only, at the
   * socket's rate. The backstop is lowered to 300 rows, which they pass
   * between the two marks after the third one.
   */
  async function minute(t: TestContext, dmOps: boolean) {
    const r = await markRoom(t, { options: { snapshotBackstopRows: 300 } });
    const end = T0 + 60_000;
    const marks = marksBetween(r.clock.now, end);
    const third = marks.find((m) => m.third);
    assert.ok(third && third.at + 30_000 <= end, "a third mark early in the minute");
    const events: Array<{ at: number; run: () => void }> = [];
    for (let k = 1; T0 + 5_000 * k + 7 < end; k++) events.push({ at: T0 + 5_000 * k + 7, run: () => chat(r.p1, `p1 ${k}`) });
    // Twenty DM chats a second for twenty seconds, from a second after the third mark.
    if (dmOps) for (let i = 0; i < 400; i++) events.push({ at: third.at + 1_000 + 50 * i + 3, run: () => chat(r.dm, `dm ${i}`) });
    // Every mark is stepped onto, so each fires as the clock reads its time.
    for (const m of marks) events.push({ at: m.at, run: () => {} });
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      // A tick before each mark, so a batch closed by then has landed as the mark reads the room.
      await r.to(Math.max(r.clock.now, e.at - 1));
      await r.to(e.at);
      e.run();
    }
    await r.to(end);
    return { r, marks, backstop: third.at + 2 * SNAPSHOT_EVERY_MS };
  }

  test("a build at every mark whatever was stored, writes at the same third marks, and a write past the backstop's rows in the room that stored them", async (t) => {
    const a = await minute(t, true);
    const b = await minute(t, false);
    const marks = a.marks.map((m) => m.at);
    assert.deepEqual(a.r.builds, marks, "a build at every mark");
    assert.deepEqual(b.r.builds, marks, "the same builds without the DM's ops");
    const thirds = a.marks.filter((m) => m.third).map((m) => m.at);
    assert.deepEqual(b.r.writes, thirds, "writes at every third mark, P1's rows stored before each");
    assert.ok(!thirds.includes(a.backstop));
    assert.deepEqual(
      a.r.writes,
      [...thirds, a.backstop].sort((x, y) => x - y),
      "the same writes, and one more at the mark after 300 rows",
    );
    assert.ok(a.r.db.rows.length < 300, "the backstop's write pruned what it covers");
  });

  test("a mark's build of a large room reads its pieces in turns that let the event loop go, and writes the same bytes as one build", async (t) => {
    const f = scopeFixture();
    const state: RoomState = structuredClone(f.state);
    for (let i = 0; i < 400; i++) state.log.push({ id: `${1_000_000 + i}:0`, at: "2026-11-10T19:00:00.000Z", kind: "chat", from: f.dm.id, text: "x".repeat(200) });
    // Every piece read moves the loop's clock 3 ms, so a turn of the build takes three pieces on any machine.
    const turns: number[] = [];
    let turn = 0;
    let ticking = true;
    const tick = () => {
      turn++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    t.after(() => void (ticking = false));
    const r = await markRoom(t, {
      state,
      options: {
        snapshotBackstopRows: 1,
        snapshotSlices: function* (s: RoomState) {
          for (const piece of snapshotSlices(s)) {
            turns.push(turn);
            yield piece;
          }
        },
      },
    });
    const [m1] = marksBetween(r.clock.now, T0 + 100_000) as [Mark];
    await r.to(m1.at - 500);
    chat(r.p1, "a row");
    await r.to(m1.at - 1);
    const expected = snapshotJson(r.actor.committed.state);
    let loop = 0;
    t.mock.method(performance, "now", () => (loop += 3));
    await r.to(m1.at);
    for (let i = 0; i < 400 && r.writes.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    t.mock.restoreAll();
    assert.ok(new Set(turns).size > 10, `the build read in ${new Set(turns).size} turns`);
    assert.deepEqual(r.writes, [m1.at], "the mark's write, once its build is read");
    assert.equal(JSON.stringify(r.db.snapshot.state), JSON.stringify(JSON.parse(expected)), "the same bytes as one build");
    assert.equal(r.db.snapshot.seq, r.actor.committed.seq);
  });

  test("no rows stored since the last write: the third mark builds and writes nothing", async (t) => {
    const r = await markRoom(t);
    const marks = marksBetween(r.clock.now, T0 + 40_000);
    for (const m of marks) await r.to(m.at);
    assert.deepEqual(r.builds, marks.map((m) => m.at));
    assert.deepEqual(r.writes, []);
  });

  test("a period or a test option that is not finite places no timer", async (t) => {
    const r = await markRoom(t, { options: { snapshotEveryMs: Number.POSITIVE_INFINITY } });
    chat(r.dm, "one");
    await r.to(T0 + 60_000);
    assert.deepEqual([r.builds, r.writes], [[], []], "no mark");
    assert.ok(r.delays.every((ms) => Number.isFinite(ms) && ms < 2 ** 31), `no timer past what setTimeout holds: ${r.delays.filter((ms) => !(ms < 2 ** 31)).join(", ")}`);
    const s = await markRoom(t, { options: { snapshotOps: 1_000, snapshotIdleMs: Number.POSITIVE_INFINITY } });
    chat(s.dm, "one");
    for (let at = s.clock.now + 5; at <= T0 + 60_000; at += 5_000) await s.to(at);
    assert.deepEqual([s.builds, s.writes], [[], []], "no write by the count or the wait, and no mark beside them");
    assert.ok(s.delays.every((ms) => Number.isFinite(ms) && ms < 2 ** 31));
  });
});

describe("writes", () => {
  test("a failing run warns once, a write held past its deadline fails before the next mark, which writes, and the rows stored stay until a write lands", async (t) => {
    const r = await markRoom(t, { options: { snapshotBackstopRows: 1 } });
    const marks = marksBetween(r.clock.now, T0 + 100_000).slice(0, 6);
    const script: Array<"fail" | "hold" | "land"> = ["fail", "fail", "hold", "land", "fail"];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    r.room.beforeWrite = async () => {
      const step = script.shift();
      if (step === "fail") throw new Error("scripted snapshot write failure");
      if (step === "hold") await held;
    };
    const tail: number[] = [];
    const chatBefore = async (m: Mark, k: number) => {
      await r.to(m.at - 500);
      chat(r.p1, `before mark ${k}`);
      await r.to(m.at - 400);
    };
    const [m1, m2, m3, m4, m5] = marks as [Mark, Mark, Mark, Mark, Mark];
    await chatBefore(m1, 1);
    await r.to(m1.at);
    tail.push(r.db.rows.length);
    assert.equal(failing(r.logged).length, 1, "the first failure warns");
    assert.ok(Number(failing(r.logged)[0]!.obj.rows) > 0, "with the rows since the last write");
    await chatBefore(m2, 2);
    await r.to(m2.at);
    tail.push(r.db.rows.length);
    assert.equal(failing(r.logged).length, 1, "the second does not");
    assert.equal(r.logged.filter((l) => l.msg === "snapshot write failed").length, 2, "each failure is logged");
    await chatBefore(m3, 3);
    await r.to(m3.at);
    // The write's deadline (SNAPSHOT_WRITE_MS, 5 s) passes before the next mark, 10 s on, so no mark meets a write still running.
    await chatBefore(m4, 4);
    tail.push(r.db.rows.length);
    assert.equal(r.logged.filter((l) => l.msg === "snapshot write failed").length, 3, "the held write fails at its deadline");
    assert.equal(failing(r.logged).length, 1, "within the same failing run");
    assert.ok(tail[0]! < tail[1]! && tail[1]! < tail[2]!, `the rows stored grow while no write lands: ${tail.join(", ")}`);
    await r.to(m4.at);
    assert.deepEqual(r.writes, [m1.at, m2.at, m3.at, m4.at], "the next mark writes");
    assert.ok(r.builds.includes(m4.at), "and builds");
    assert.equal(r.db.snapshot.seq, r.actor.committed.seq, "its write lands");
    assert.ok(r.db.rows.length < tail[2]!, "and prunes what it covers");
    await chatBefore(m5, 5);
    await r.to(m5.at);
    assert.equal(r.logged.filter((l) => l.msg === "snapshot write failed").length, 4);
    assert.equal(failing(r.logged).length, 2, "a new failing run warns again");
  });

  test("a mark while a commit that carries the room's snapshot keeps failing builds and leaves the write to that commit", async (t) => {
    // A room stored at an older version with a row after its snapshot, which a mark would write a snapshot for.
    const f = scopeFixture();
    const tail: StoredRow = { seq: 1, at: new Date(T0 - 60_000).toISOString(), actorMemberId: f.dm.id, actorRole: "dm", op: { t: "log.chat", text: "stored" }, opVersion: OP_VERSION, pub: 1 };
    const r = await markRoom(t, { options: { snapshotBackstopRows: 1, reidAtLoad: false }, f, version: WALK_TRIM_SNAPSHOT_VERSION - 1, rows: [tail] });
    assert.equal(r.db.snapshot.version, WALK_TRIM_SNAPSHOT_VERSION - 1, "no commit stored the snapshot yet");
    assert.equal(r.actor.committed.seq, 1);
    const [m1] = marksBetween(r.clock.now, T0 + 100_000) as [Mark];
    let failed = 0;
    r.db.beforeCommit = async () => {
      failed++;
      throw new Error("database down");
    };
    await r.to(m1.at - 500);
    chat(r.p1, "a row");
    await r.to(m1.at - 400);
    assert.ok(failed > 0, "the commit carrying the snapshot is failing");
    const before = r.db.snapshotWrites;
    await r.to(m1.at);
    assert.ok(r.builds.includes(m1.at), "the mark builds");
    assert.deepEqual(r.writes, [], "and writes nothing of its own");
    assert.equal(r.db.snapshotWrites, before);
    r.db.beforeCommit = undefined;
    await r.to(m1.at + 100);
    assert.equal(r.db.snapshot.version, SNAPSHOT_VERSION, "the commit stores it");
    assert.equal(r.db.snapshot.seq, r.actor.committed.seq);
    assert.deepEqual(r.writes, []);
  });

  test("the quota check after a write runs outside its hold, one at a time, so a slow one never holds the next write", async (t) => {
    let checks = 0;
    let running = 0;
    let most = 0;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    const pool = (base: Pool) =>
      ({
        connect: base.connect.bind(base),
        query: async (text: string, params?: unknown[]) => {
          if (text.includes(" as bytes")) {
            checks++;
            running++;
            most = Math.max(most, running);
            await slow;
            running--;
            return { rows: [{ bytes: "0" }] };
          }
          return base.query(text, params);
        },
      }) as unknown as Pool;
    const r = await markRoom(t, { options: { snapshotBackstopRows: 1, quotaBytes: 1_000_000_000 }, pool });
    const [m1, m2, m3] = marksBetween(r.clock.now, T0 + 100_000) as [Mark, Mark, Mark];
    for (const m of [m1, m2, m3]) {
      await r.to(m.at - 500);
      chat(r.p1, "a row");
      await r.to(m.at - 400);
      await r.to(m.at);
    }
    assert.deepEqual(r.writes, [m1.at, m2.at, m3.at], "each mark wrote while the first check was held");
    assert.equal(r.db.snapshot.seq, r.actor.committed.seq);
    assert.deepEqual([checks, most], [1, 1], "the later checks wait for the running one");
    release();
    await flush();
    await flush();
    assert.deepEqual([checks, most], [2, 1], "and run once more after it");
  });

  test("the quota check after a deletion waits for the one a write started, as a write's own does", async (t) => {
    let checks = 0;
    let running = 0;
    let most = 0;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    const pool = (base: Pool) =>
      ({
        connect: base.connect.bind(base),
        query: async (text: string, params?: unknown[]) => {
          if (text.includes(" as bytes")) {
            checks++;
            running++;
            most = Math.max(most, running);
            await slow;
            running--;
            return { rows: [{ bytes: "0" }] };
          }
          return base.query(text, params);
        },
      }) as unknown as Pool;
    const r = await markRoom(t, { options: { snapshotBackstopRows: 1, quotaBytes: 1_000_000_000 }, pool });
    const [m1] = marksBetween(r.clock.now, T0 + 100_000) as [Mark];
    await r.to(m1.at - 500);
    chat(r.p1, "a row");
    await r.to(m1.at - 400);
    await r.to(m1.at);
    assert.deepEqual(r.writes, [m1.at]);
    assert.deepEqual([checks, most], [1, 1], "the write's check is held");
    assert.equal(await r.actor.deletionStep(async () => ({ deleted: [r.f.goblin], result: 1 })), 1);
    await flush();
    assert.deepEqual([checks, most], [1, 1], "the deletion's check waits for the running one");
    release();
    await flush();
    await flush();
    assert.deepEqual([checks, most], [2, 1], "and runs once after it");
  });
});

describe("the size guard and marks", () => {
  /**
   * The DM's three edits of the goblin: a rename, then notes of 2,000 and of
   * 3,000 characters. The second grows the room less than the first, so a
   * guard that measured the committed state alone would take it unmeasured.
   */
  const edits = (f: ReturnType<typeof scopeFixture>) => [
    { t: "token.update", tokenId: f.goblin, patch: { name: "Goblin 3" } },
    { t: "token.update", tokenId: f.goblin, patch: { notes: "a".repeat(2_000) } },
    { t: "token.update", tokenId: f.goblin, patch: { notes: "a".repeat(3_000) } },
  ];

  /** The answers to the three edits in a room with this byte limit, without marks. */
  async function answersAt(t: TestContext, f: ReturnType<typeof scopeFixture>, stateLimit: number): Promise<string[]> {
    const h = await storedActor(t, new StoredRoomDb(f.state), { sizeLimits: { stateLimit }, snapshotEveryMs: Number.POSITIVE_INFINITY, roomOpsPerSec: 10_000 }, quiet);
    const dm = await h.connect(f.dm);
    const out: string[] = [];
    for (const op of edits(f)) {
      const ev = await dm.send(op);
      const reject = ev.rejects?.[0];
      out.push(reject ? reject.code : "taken");
    }
    await h.actor.shutdown({ code: 1012, snapshot: false });
    return out;
  }

  test("a mark and a landed write while a commit is held change no answer of the guard", async (t) => {
    const f = scopeFixture();
    // The smallest limit, in steps of 250 bytes, that takes the notes of 2,000 and refuses those of 3,000.
    let limit = 0;
    for (let l = 1_000; l < 40_000; l += 250) {
      const answers = await answersAt(t, f, l);
      if (answers.join() === "taken,taken,quota") {
        limit = l;
        break;
      }
    }
    assert.ok(limit > 0, "a limit between the two chats");
    const r = await markRoom(t, { state: f.state, options: { snapshotBackstopRows: 1, sizeLimits: { stateLimit: limit } } });
    const [m1] = marksBetween(r.clock.now, T0 + 100_000) as [Mark];
    const [rename, two, four] = edits(f);
    const send = (op: unknown) => {
      const n = ++r.dm.n;
      void r.actor.op(r.dm.conn, n, op);
      return n;
    };
    await r.to(m1.at - 1_000);
    const zero = send(rename);
    await r.to(m1.at - 980);
    assert.equal(answerOf(r.dm, zero), "taken");
    const committed = r.actor.committed.seq;
    // Every commit from here is held until the end.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    r.db.beforeCommit = () => held;
    await r.to(m1.at - 50);
    const first = send(two);
    await r.to(m1.at - 20);
    await r.to(m1.at);
    assert.deepEqual(r.writes, [m1.at]);
    assert.equal(r.db.snapshot.seq, committed, "the mark wrote the committed state, behind the staged one");
    await r.to(m1.at + 5);
    const second = send(four);
    await r.to(m1.at + 10);
    release();
    await r.to(m1.at + 20);
    await r.to(m1.at + 40);
    assert.equal(answerOf(r.dm, first), "taken");
    assert.match(answerOf(r.dm, second) ?? "", /^quota: /, "refused, as without the mark");
  });
});
