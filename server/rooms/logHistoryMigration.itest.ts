import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { createInitialState } from "#shared/initial.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog } from "#shared/project.ts";
import { member, rng } from "#shared/testutil.ts";
import { TEST_DATABASE_URL } from "../auth/testing.ts";
import { applySchema } from "../db.ts";
import { cancelRequest, captureView, compareIds, LogHistory, ReceiptLines, type HistoryReader, type HistoryView } from "./logHistory.ts";
import { DDL_LOCK, LogHistoryMigration, ROOM_LOCK_CLASS, UNINDEXED_INDEX, type MigrationOptions, type MigrationStep } from "./logHistoryMigration.ts";
import { LogScanBudget } from "./logScanBudget.ts";
import { archiveLines, completeLines, lineAccess, storedKey } from "./persistence.ts";

/**
 * The log archive's metadata on a real database (log history, server stage
 * B): the partial index built after boot and rebuilt when a build was cut
 * short, the backfill that completes rows in atomic batches, the null-row
 * check that sends every read of an incomplete room to the raw reader, and
 * the worker's connection, bounded and gone after every cancel. Indexed
 * reads must give exactly the raw reader's answers, with the backfill half
 * done, restarted, and racing live writes, reads and shutdowns.
 *
 * These tests share the development database with every other, so each
 * builds the index state it needs: dropping it, or leaving one cut short.
 */

const DM_ID = "dm1";
const PLAYERS = ["p1", "p2", "p3"];
const VIEWERS: Viewer[] = [{ memberId: DM_ID, role: "dm" }, ...PLAYERS.map((memberId) => ({ memberId, role: "player" as const }))];

let pool: pg.Pool;
let scanPool: pg.Pool;
const rooms: string[] = [];
const appName = `rvtt-logb-itest-${randomBytes(4).toString("hex")}`;

before(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 6 });
  await applySchema(pool);
  scanPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 500, query_timeout: 15_000 });
});

after(async () => {
  await pool.query("delete from rooms where id = any($1::text[])", [rooms]);
  // Left valid for the tests that come after, as a server's worker would leave it.
  await ensureIndex();
  await scanPool.end();
  await pool.end();
});

function state(): RoomState {
  const s = createInitialState({ roomName: "Metadata", dm: member(DM_ID, "dm") });
  for (const p of PLAYERS) s.members[p] = member(p);
  return s;
}

async function newRoom(): Promise<string> {
  const id = randomBytes(5).toString("hex").slice(0, 8).toUpperCase();
  await pool.query("insert into rooms (id, name, player_pw_hash, dm_key_hash) values ($1, 'Metadata', 'x', '\\x00')", [id]);
  rooms.push(id);
  return id;
}

/** Rows as an older server wrote them, with no metadata at all. */
async function legacyInsert(q: pg.Pool | pg.PoolClient, roomId: string, lines: readonly LogEntry[]): Promise<void> {
  if (lines.length === 0) return;
  await q.query(
    `insert into room_log (room_id, id, at, entry) select $1, i, a::timestamptz, e::jsonb from unnest($2::text[], $3::text[], $4::text[]) as t(i, a, e) on conflict do nothing`,
    [roomId, lines.map((e) => e.id), lines.map((e) => e.at), lines.map((e) => JSON.stringify(e))],
  );
}

/** Random lines of every audience from `seq` on, with the reducer's numbering, `n` of them at least. */
function lines(random: () => number, fromSeq: number, n: number, at0 = Date.parse("2025-04-01T18:00:00.000Z")): { rows: LogEntry[]; seq: number } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const everyone = [DM_ID, ...PLAYERS];
  const rows: LogEntry[] = [];
  let seq = fromSeq;
  let at = at0 + fromSeq * 1_000;
  while (rows.length < n) {
    seq++;
    at += random() < 0.95 ? Math.floor(random() * 30_000) : 5 * 3_600_000;
    const time = new Date(at).toISOString();
    const counts = { shared: 0, party: 100_000, dm: 900_000 };
    for (let i = 1 + Math.floor(random() * 3); i > 0; i--) {
      const r = random();
      const from = pick(everyone);
      if (r < 0.35) rows.push({ id: `${seq}:${counts.shared++}`, at: time, kind: "chat", from, text: "s" });
      else if (r < 0.65) {
        const to = everyone.filter((m) => m !== from && random() < 0.4);
        rows.push({ id: `${seq}:${counts.shared++}`, at: time, kind: "whisper", from, to: to.length > 0 ? to : [pick(everyone.filter((m) => m !== from))], text: "w" });
      } else if (r < 0.85) rows.push({ id: `${seq}:${counts.party++}`, at: time, kind: "chat", from, to: [pick(PLAYERS)], copyOf: `${seq}:900000`, text: "p" });
      else rows.push({ id: `${seq}:${counts.dm++}`, at: time, kind: "chat", from: DM_ID, text: "d" });
    }
  }
  return { rows, seq };
}

async function dropIndex(): Promise<void> {
  await pool.query(`drop index concurrently if exists ${UNINDEXED_INDEX}`);
}

async function indexState(): Promise<"valid" | "invalid" | "absent"> {
  const { rows } = await pool.query<{ valid: boolean }>("select indisvalid as valid from pg_index where indexrelid = to_regclass($1)", [UNINDEXED_INDEX]);
  return rows[0] === undefined ? "absent" : rows[0].valid ? "valid" : "invalid";
}

async function ensureIndex(): Promise<void> {
  const w = worker();
  w.m.start();
  await until(() => w.m.ready, "index ready");
  await w.m.stop();
}

/** The worker's backends and advisory locks still alive, by its application name. */
async function leftovers(): Promise<{ backends: number; locks: number }> {
  const { rows } = await pool.query<{ backends: number; locks: number }>(
    `select (select count(*)::int from pg_stat_activity where application_name = $1 and datname = current_database()) as backends,
            (select count(*)::int from pg_locks l where l.locktype = 'advisory' and l.classid::bigint in ($2, $3)
               and l.database = (select oid from pg_database where datname = current_database())) as locks`,
    [appName, DDL_LOCK[0], ROOM_LOCK_CLASS],
  );
  return rows[0]!;
}

/** Waits until a closed connection's backend has gone, as it does once its socket closes. Bounded. */
async function noLeftovers(what: string): Promise<void> {
  let left = await leftovers();
  for (let i = 0; i < 100 && (left.backends > 0 || left.locks > 0); i++) {
    await new Promise((r) => setTimeout(r, 20));
    left = await leftovers();
  }
  assert.deepEqual(left, { backends: 0, locks: 0 }, `${what}: no backend or lock of the worker left`);
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Worker = { m: LogHistoryMigration; budget: LogScanBudget; steps: MigrationStep[]; logged: { level: string; msg: string }[]; outcome: (roomId: string) => Promise<string>; connects: () => number };

function worker(opts: Partial<MigrationOptions> = {}, budget = new LogScanBudget()): Worker {
  const steps: MigrationStep[] = [];
  let connects = 0;
  const logged: { level: string; msg: string }[] = [];
  const waiters: { roomId: string; resolve: (o: string) => void }[] = [];
  const m = new LogHistoryMigration({
    connect: async () => {
      connects++;
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL, application_name: appName, connectionTimeoutMillis: 2_000 });
      client.on("error", () => undefined);
      await client.connect();
      return client;
    },
    budget,
    guard: () => Promise.resolve(true),
    log: {
      info: (_o, msg) => logged.push({ level: "info", msg }),
      warn: (_o, msg) => logged.push({ level: "warn", msg }),
      error: (_o, msg) => logged.push({ level: "error", msg }),
    },
    retryMs: 50,
    pollMs: 20,
    ...opts,
    onStep: async (step, signal) => {
      steps.push(step);
      if (step.kind === "room") {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.roomId !== step.roomId) continue;
          waiters[i]!.resolve(step.outcome);
          waiters.splice(i, 1);
        }
      }
      await opts.onStep?.(step, signal);
    },
  });
  const outcome = (roomId: string) => new Promise<string>((resolve) => waiters.push({ roomId, resolve }));
  return { m, budget, steps, logged, outcome, connects: () => connects };
}

/** Holds a step until its job is cancelled, as a statement does that the cancel stops. */
function heldUntilCancelled(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("cancelled"));
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
}

async function nulls(roomId: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int as n from room_log where room_id = $1 and seq is null", [roomId])).rows[0]!.n;
}

async function accessCount(roomId: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int as n from room_log_access where room_id = $1", [roomId])).rows[0]!.n;
}

function expectedAccess(rows: readonly LogEntry[]): number {
  return rows.reduce((n, e) => n + (storedKey(e.id) ? lineAccess(e).length : 0), 0);
}

type Answers = { back: string[]; forward: string[]; lines: number; sessions: unknown[]; ends: string[] | null };

/** Every page backward and forward, the session list and an export's ends, for one viewer, and which readers answered. */
async function read(history: LogHistory, view: HistoryView, budget: LogScanBudget, limit = 37): Promise<Answers> {
  const scan = budget.open({ pool: "page", roomId: view.roomId, memberId: view.viewer.memberId });
  try {
    const back: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await history.page(view, { before, limit }, scan);
      back.unshift(...page.entries.map((e) => e.id));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    const forward: string[] = [];
    let after = "0:0";
    for (;;) {
      const page = await history.page(view, { after, limit: limit + 13 }, scan);
      forward.push(...page.entries.map((e) => e.id));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    const sessions = await history.sessions(view, { limit: 50 }, scan);
    const ends = await history.bounds(view, {}, scan);
    return { back, forward, lines: sessions.lines, sessions: sessions.sessions, ends: ends ? [ends.first.id, ends.last.id] : null };
  } finally {
    scan.close();
  }
}

/** What a viewer may read of `rows` at or below `seq`, by the projector alone, in id order: the oracle. */
function oracle(s: RoomState, rows: readonly LogEntry[], viewer: Viewer, seq: number): string[] {
  const within = rows.filter((e) => Number(e.id.slice(0, e.id.indexOf(":"))) <= seq).sort((a, b) => compareIds(a.id, b.id));
  return projectArchivedLog(s, within, viewer, { sceneId: null }).map((e) => e.id);
}

function reader(metadata: LogHistoryMigration | undefined, used?: Set<HistoryReader>, batchRows?: number): LogHistory {
  return new LogHistory({ pool: scanPool, metadata, batchRows, summaryBytes: 0, onBatch: async ({ reader: r }) => void used?.add(r) });
}

describe("the partial index", () => {
  test("boot's schema adds only empty structures, and the worker builds the index after, reuses a valid one and rebuilds one cut short while writes go on", async () => {
    const roomId = await newRoom();
    const other = await newRoom();
    const old = lines(rng(1), 0, 300).rows;
    await legacyInsert(pool, roomId, old);
    await dropIndex();
    // The schema file again, as a boot runs it on a database with history: it fills nothing and builds no index.
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    assert.equal(await indexState(), "absent");
    assert.equal(await nulls(roomId), old.length);

    const w1 = worker();
    w1.m.start();
    await until(() => w1.m.ready, "built");
    assert.equal(await indexState(), "valid");
    assert.deepEqual(w1.steps, [{ kind: "index", action: "create" }]);
    await w1.m.stop();
    await noLeftovers("after a build");

    const w2 = worker();
    w2.m.start();
    await until(() => w2.m.ready, "reused");
    assert.deepEqual(w2.steps, [], "a valid index is used as it is");
    await w2.m.stop();

    // A build cut short: a writer's open transaction holds the concurrent build at its first wait, with the
    // index already in the catalog and not valid, and the worker is stopped there.
    await dropIndex();
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await legacyInsert(writer, roomId, [{ id: "999:0", at: new Date().toISOString(), kind: "chat", from: DM_ID, text: "open" }]);
      const w3 = worker();
      w3.m.start();
      await until(async () => (await indexState()) === "invalid", "the build waiting");
      // Writes in another room go on while it waits.
      const started = Date.now();
      await archiveLines(pool, other, lines(rng(2), 0, 50).rows);
      assert.ok(Date.now() - started < 2_000, "a write is not held by the build");
      const stopping = Date.now();
      await w3.m.stop();
      assert.ok(Date.now() - stopping < 3_000, "the stop is bounded");
      assert.equal(w3.m.ready, false);
      await noLeftovers("after a stopped build");
      assert.equal(await indexState(), "invalid", "a stopped build leaves its index invalid");
    } finally {
      await writer.query("rollback");
      writer.release();
    }
    const w4 = worker();
    w4.m.start();
    await until(() => w4.m.ready, "rebuilt");
    assert.deepEqual(w4.steps, [
      { kind: "index", action: "drop" },
      { kind: "index", action: "create" },
    ]);
    assert.equal(await indexState(), "valid");
    await w4.m.stop();
    await noLeftovers("after a rebuild");
  });

  test("running workers revalidate a dropped index before later backfills and preserve complete raw reads", async () => {
    const roomId = await newRoom();
    const nextRoom = await newRoom();
    const old = lines(rng(4103), 0, 80);
    const next = lines(rng(4104), 0, 80);
    const first = worker();
    const second = worker();
    first.m.start();
    second.m.start();
    try {
      await until(() => first.m.ready && second.m.ready, "both workers ready");
      await legacyInsert(pool, roomId, old.rows);
      const initial = first.outcome(roomId);
      first.m.want(roomId);
      assert.equal(await initial, "complete");
      first.steps.length = 0;
      second.steps.length = 0;
      await dropIndex();
      await legacyInsert(pool, nextRoom, next.rows);
      const view = captureView({ state: state(), seq: next.seq }, nextRoom, VIEWERS[1]!);
      assert.deepEqual((await read(reader(undefined), view, new LogScanBudget())).back, oracle(view.state, next.rows, view.viewer, next.seq));
      const a = first.outcome(nextRoom);
      const b = second.outcome(nextRoom);
      first.m.want(nextRoom);
      second.m.want(nextRoom);
      const results = await Promise.all([a, b]);
      assert.ok(results.includes("complete"));
      assert.ok(results.every((r) => r === "complete" || r === "locked"));
      assert.equal(await indexState(), "valid", "the dropped index was reconstructed without restarting either worker");
      assert.equal(await nulls(nextRoom), 0);
      assert.equal([...first.steps, ...second.steps].filter((s) => s.kind === "index" && s.action === "create").length, 1, "competing workers rebuild only once");
      assert.deepEqual((await read(reader(first.m), view, new LogScanBudget())).back, oracle(view.state, next.rows, view.viewer, next.seq));
    } finally {
      await first.m.stop();
      await second.m.stop();
    }
    await noLeftovers("after live index reconstruction");
  });

  test("a disk under its floor holds the build back, and the worker builds once there is room", async () => {
    await dropIndex();
    let room = false;
    const w = worker({ guard: () => Promise.resolve(room) });
    w.m.start();
    await until(() => w.logged.some((l) => l.level === "warn" && /free-space floor/.test(l.msg)), "the warning");
    assert.equal(await indexState(), "absent");
    room = true;
    await until(() => w.m.ready, "built");
    await w.m.stop();
    await noLeftovers("after a held build");
  });
});

describe("the backfill", () => {
  before(ensureIndex);

  test("an incomplete room is read raw and queued, completed in batches, then read indexed with the same answers, through rollback writes and a new boot", async () => {
    const roomId = await newRoom();
    const s = state();
    const first = lines(rng(11), 0, 1_200);
    await legacyInsert(pool, roomId, first.rows);
    const budget = new LogScanBudget({ waitMs: 5_000 });
    const w = worker({ batchRows: 100 }, budget);
    w.m.start();
    await until(() => w.m.ready, "ready");
    const used = new Set<HistoryReader>();
    const view = (viewer: Viewer, seq: number) => captureView({ state: s, seq }, roomId, viewer);
    const done = w.outcome(roomId);
    const raw = await read(reader(w.m, used), view(VIEWERS[1]!, first.seq), budget);
    assert.deepEqual([...used], ["raw"]);
    assert.deepEqual(raw.back, oracle(s, first.rows, VIEWERS[1]!, first.seq));
    assert.equal(await done, "complete");
    assert.equal(w.steps.filter((x) => x.kind === "batch").length, Math.ceil(first.rows.length / 100) + (first.rows.length % 100 === 0 ? 1 : 0));
    assert.equal(await nulls(roomId), 0);
    assert.equal(await accessCount(roomId), expectedAccess(first.rows));
    for (const viewer of VIEWERS) {
      used.clear();
      const got = await read(reader(w.m, used, 1 + Math.floor(Math.random() * 300)), view(viewer, first.seq), budget);
      assert.deepEqual([...used], ["indexed"], viewer.memberId);
      assert.deepEqual(got, await read(reader(undefined), view(viewer, first.seq), budget), `indexed equals raw for ${viewer.memberId}`);
      assert.deepEqual(got.back, oracle(s, first.rows, viewer, first.seq));
    }
    await w.m.stop();

    // A rollback to the stage-A server writes rows with no metadata. A new boot finds the index valid at once, and the
    // null-row check sends reads raw until the new rows are completed, though every older row is complete.
    const second = lines(rng(12), first.seq, 400);
    await legacyInsert(pool, roomId, second.rows);
    const all = [...first.rows, ...second.rows];
    const again = worker({ batchRows: 100 }, budget);
    again.m.start();
    await until(() => again.m.ready, "ready again");
    assert.deepEqual(again.steps, []);
    used.clear();
    const settled = again.outcome(roomId);
    const mid = await read(reader(again.m, used), view(VIEWERS[0]!, second.seq), budget);
    assert.deepEqual([...used], ["raw"]);
    assert.deepEqual(mid.back, oracle(s, all, VIEWERS[0]!, second.seq));
    assert.equal(await settled, "complete");
    used.clear();
    const after = await read(reader(again.m, used), view(VIEWERS[0]!, second.seq), budget);
    assert.deepEqual([...used], ["indexed"]);
    assert.deepEqual(after, mid);
    await again.m.stop();
    await noLeftovers("after the backfills");
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("a batch whose access rows fail keeps every row in it without metadata, and a repeat or a write of a stored line completes it once", async () => {
    const roomId = await newRoom();
    const { rows } = lines(rng(21), 0, 60);
    await legacyInsert(pool, roomId, rows);
    const fn = `rvtt_fail_access_${randomBytes(3).toString("hex")}`;
    const victim = rows.find((r) => r.kind === "whisper")!;
    await pool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if new.id = '${victim.id}' and new.room_id = '${roomId}' then raise exception 'access fault'; end if; return new; end $$`);
    await pool.query(`create trigger ${fn} before insert on room_log_access for each row execute function ${fn}()`);
    try {
      const stored = (await pool.query<{ id: string; entry: LogEntry }>("select id, entry from room_log where room_id = $1", [roomId])).rows;
      await assert.rejects(completeLines(pool, roomId, stored), /access fault/);
      assert.equal(await nulls(roomId), rows.length, "no seq set");
      assert.equal(await accessCount(roomId), 0, "no access row kept");
      // A new write that names the faulted line fails whole: the line and every other line in it are not stored.
      const fresh = lines(rng(22), 500, 20).rows;
      await assert.rejects(archiveLines(pool, roomId, [...fresh, { ...victim }]), /access fault/);
      assert.equal((await pool.query("select 1 from room_log where room_id = $1 and id = any($2::text[])", [roomId, fresh.map((r) => r.id)])).rowCount, 0);
    } finally {
      await pool.query(`drop trigger ${fn} on room_log_access`);
      await pool.query(`drop function ${fn}()`);
    }
    // The same write again, as a retry: the stored legacy line is completed only because its entry is the same.
    const other = rows.find((r) => r !== victim)!;
    await archiveLines(pool, roomId, [victim, { ...other, text: "not what is stored" }]);
    const states = (await pool.query<{ id: string; seq: string | null }>("select id, seq::text from room_log where room_id = $1 and id = any($2::text[])", [roomId, [victim.id, other.id]])).rows;
    assert.deepEqual(Object.fromEntries(states.map((r) => [r.id, r.seq !== null])), { [victim.id]: true, [other.id]: false });
    assert.equal(await accessCount(roomId), lineAccess(victim).length);
    const stored = (await pool.query<{ id: string; entry: LogEntry }>("select id, entry from room_log where room_id = $1", [roomId])).rows;
    assert.equal(await completeLines(pool, roomId, stored), rows.length - 1);
    assert.equal(await completeLines(pool, roomId, stored), 0, "a second run changes nothing");
    await archiveLines(pool, roomId, rows);
    assert.equal(await accessCount(roomId), expectedAccess(rows), "each access row once");
    assert.equal(await nulls(roomId), 0);
  });

  test("a disk refusal pauses the room, a stop mid-batch leaves the batch incomplete and frees everything, and a new worker finishes", async () => {
    const roomId = await newRoom();
    const { rows } = lines(rng(31), 0, 500);
    await legacyInsert(pool, roomId, rows);
    let disk = false;
    const paused = worker({ batchRows: 100, guard: () => Promise.resolve(disk) });
    paused.m.start();
    await until(() => paused.m.ready, "ready");
    const connected = paused.connects();
    const outcome = paused.outcome(roomId);
    paused.m.want(roomId);
    assert.equal(await outcome, "paused");
    assert.equal(paused.connects(), connected, "a refused room opens no connection");
    assert.equal(await nulls(roomId), rows.length);
    assert.ok(paused.logged.some((l) => l.level === "warn" && /backfill paused/.test(l.msg)));
    await paused.m.stop();

    // The disk fills during the backfill: the next batch is refused, and what is done stays done.
    disk = true;
    let done = 0;
    const filling = worker({
      batchRows: 100,
      guard: () => Promise.resolve(disk),
      onStep: async (step) => {
        if (step.kind === "batch" && ++done === 2) disk = false;
      },
    });
    filling.m.start();
    const midway = filling.outcome(roomId);
    filling.m.want(roomId);
    assert.equal(await midway, "paused");
    assert.equal(await nulls(roomId), rows.length - 200, "two batches done before the floor");
    await filling.m.stop();
    await noLeftovers("after a pause midway");

    let reached!: () => void;
    const atBatch = new Promise<void>((r) => (reached = r));
    let batches = 0;
    disk = true;
    const budget = new LogScanBudget();
    const cut = worker(
      {
        batchRows: 100,
        guard: () => Promise.resolve(disk),
        onStep: async (step, signal) => {
          // The third batch waits here, its rows read and not yet completed, until the worker is stopped.
          if (step.kind === "batch" && ++batches === 3) {
            reached();
            await heldUntilCancelled(signal);
          }
        },
      },
      budget,
    );
    cut.m.start();
    cut.m.want(roomId);
    await atBatch;
    assert.equal(budget.usage.turns.page, 1, "the batch holds its turn");
    const stopping = Date.now();
    await cut.m.stop();
    assert.ok(Date.now() - stopping < 3_000, "bounded");
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 }, "turn and lease given back");
    await noLeftovers("after a stop mid-batch");
    assert.equal(await nulls(roomId), rows.length - 400, "two batches done before the floor, two more now, the fifth not");

    const last = worker({ batchRows: 100 });
    last.m.start();
    const finished = last.outcome(roomId);
    last.m.want(roomId);
    assert.equal(await finished, "complete");
    assert.equal(await nulls(roomId), 0);
    assert.equal(await accessCount(roomId), expectedAccess(rows));
    await last.m.stop();
  });

  test("an id the metadata cannot hold stops the room's backfill with an operator error, and its reads stay raw and whole", async () => {
    const roomId = await newRoom();
    const s = state();
    const { rows, seq } = lines(rng(41), 0, 40);
    const odd: LogEntry = { id: "05:7", at: rows[0]!.at, kind: "chat", from: DM_ID, text: "old id" };
    await legacyInsert(pool, roomId, [...rows, odd]);
    const w = worker();
    w.m.start();
    await until(() => w.m.ready, "ready");
    const outcome = w.outcome(roomId);
    w.m.want(roomId);
    assert.equal(await outcome, "malformed");
    assert.ok(w.logged.some((l) => l.level === "error" && /cannot be indexed/.test(l.msg)));
    assert.equal(await nulls(roomId), rows.length + 1, "nothing completed");
    w.m.want(roomId);
    assert.deepEqual(w.m.detail.wanted, [], "not asked for again");
    const used = new Set<HistoryReader>();
    const got = await read(reader(w.m, used), captureView({ state: s, seq }, roomId, VIEWERS[0]!), new LogScanBudget());
    assert.deepEqual([...used], ["raw"]);
    assert.ok(got.back.includes("05:7"), "the raw reader reads the odd id as its number");
    // The raw reader orders it by its number, 5, where the oracle's string order cannot, so the two are compared as sets.
    assert.deepEqual([...got.back].sort(), [...oracle(s, [...rows, odd], VIEWERS[0]!, seq)].sort());
    await w.m.stop();
  });

  test("deleting a room cancels its backfill mid-statement: the backend is told to stop, the connection closed, then the lock and lease let go", async () => {
    const roomId = await newRoom();
    await legacyInsert(pool, roomId, lines(rng(51), 0, 300).rows);
    const budget = new LogScanBudget();
    const order: string[] = [];
    const w = worker(
      {
        batchRows: 100,
        cancel: async (client) => {
          order.push(`cancel, leases ${budget.usage.leases.page}`);
          await cancelRequest(client);
        },
      },
      budget,
    );
    w.m.start();
    await until(() => w.m.ready, "ready");
    // A writer holds every row of the room, so the batch's update waits on the server, in its statement.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from room_log where room_id = $1 for update", [roomId]);
      const outcome = w.outcome(roomId);
      w.m.want(roomId);
      await until(async () => (await pool.query("select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [appName])).rowCount === 1, "the batch waiting on the row locks");
      assert.equal((await leftovers()).locks, 1, "the room's advisory lock is held");
      // The budget's cancel alone stops the statement. The app's deletion wiring calls the worker's cancelRoom too (its unit test).
      budget.cancelRoom(roomId);
      assert.equal(await outcome, "cancelled");
      assert.deepEqual(order, ["cancel, leases 1"], "the cancel request goes out while the lease is still held");
      assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
      await noLeftovers("after the room's deletion");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    assert.equal(await nulls(roomId) > 0, true, "the cut batch completed nothing it held");
    await w.m.stop();
  });
});

describe("the access table's plans", () => {
  test("a stream read takes the access key even for a room the planner has no statistics on, and no other index leads with the room", async () => {
    const { rows: indexes } = await pool.query<{ name: string; first: string; primary: boolean }>(
      `select c.relname as name, a.attname as first, i.indisprimary as primary
       from pg_index i join pg_class c on c.oid = i.indexrelid
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = 'room_log_access'::regclass`,
    );
    assert.deepEqual(
      indexes.filter((x) => !x.primary && x.first === "room_id").map((x) => x.name),
      [],
      "an index led by room_id is one a planner can take for a stream read and then sort the room",
    );
    // A new room's rows, written after the table's last statistics.
    const roomId = await newRoom();
    await archiveLines(pool, roomId, lines(rng(81), 0, 3_000).rows);
    for (const [order, bound] of [
      ["desc", ""],
      ["asc", " and (seq, line_no) > ($5::bigint, $6::int)"],
    ] as const) {
      const { rows } = await pool.query<{ "QUERY PLAN": unknown }>(
        `explain (format json) select id, seq::text as seq_text, line_no from room_log_access
         where room_id = $1 and stream = $2 and member_id = $3 and seq <= $4${bound} order by seq ${order}, line_no ${order} limit 500`,
        bound ? [roomId, "shared", "", 10_000, "5", 0] : [roomId, "shared", "", 10_000],
      );
      const plan = JSON.stringify(rows[0]!["QUERY PLAN"]);
      assert.match(plan, /room_log_access_pkey/, `${order}: ${plan}`);
      assert.doesNotMatch(plan, /"Sort"/, `${order}: no sort of the room's rows`);
    }
  });
});

describe("indexed and raw reads agree", () => {
  before(ensureIndex);

  test("with the backfill half done, after a restart mid-backfill, and once complete", async () => {
    const s = state();
    for (const seed of [61, 62, 63]) {
      const roomId = await newRoom();
      const random = rng(seed);
      const { rows, seq } = lines(random, 0, 700 + Math.floor(random() * 500));
      // Half the rows written by this server, half by an older one.
      const ours = rows.filter(() => random() < 0.5);
      const theirs = rows.filter((r) => !ours.includes(r));
      await archiveLines(pool, roomId, ours);
      await legacyInsert(pool, roomId, theirs);
      const budget = new LogScanBudget({ waitMs: 5_000 });
      const truth = new Map<string, Answers>();
      for (const viewer of VIEWERS) truth.set(viewer.memberId, await read(reader(undefined), captureView({ state: s, seq }, roomId, viewer), budget));
      for (const viewer of VIEWERS) assert.deepEqual(truth.get(viewer.memberId)!.back, oracle(s, rows, viewer, seq));
      // The first worker stops after two batches.
      let batches = 0;
      let reached!: () => void;
      const two = new Promise<void>((r) => (reached = r));
      const first = worker(
        {
          batchRows: 50 + Math.floor(random() * 100),
          onStep: async (step, signal) => {
            if (step.kind === "batch" && ++batches === 3) {
              reached();
              await heldUntilCancelled(signal);
            }
          },
        },
        budget,
      );
      first.m.start();
      await until(() => first.m.ready, "ready");
      first.m.want(roomId);
      await two;
      await first.m.stop();
      await noLeftovers("after a restart");
      const used = new Set<HistoryReader>();
      for (const viewer of VIEWERS) assert.deepEqual(await read(reader(first.m, used), captureView({ state: s, seq }, roomId, viewer), budget, 1 + Math.floor(random() * 90)), truth.get(viewer.memberId), `seed ${seed} half done`);
      assert.deepEqual([...used], ["raw"]);
      assert.ok((await nulls(roomId)) > 0 && (await nulls(roomId)) < theirs.length, "half done");
      // The restart reads its rows again from the index: no checkpoint to skip any.
      const second = worker({ batchRows: 50 + Math.floor(random() * 100) }, budget);
      second.m.start();
      await until(() => second.m.ready, "ready");
      const done = second.outcome(roomId);
      second.m.want(roomId);
      assert.equal(await done, "complete");
      used.clear();
      for (const viewer of VIEWERS) assert.deepEqual(await read(reader(second.m, used, 1 + Math.floor(random() * 600)), captureView({ state: s, seq }, roomId, viewer), budget, 1 + Math.floor(random() * 90)), truth.get(viewer.memberId), `seed ${seed} complete`);
      assert.deepEqual([...used], ["indexed"]);
      await second.m.stop();
    }
  });

  test("receipts read by the access key give the raw lookup's lines, projected, and none of another member's", async () => {
    const roomId = await newRoom();
    const s = state();
    const { rows, seq } = lines(rng(71), 0, 400);
    await archiveLines(pool, roomId, rows);
    const ready = { ready: true, want: () => undefined };
    const indexed = new ReceiptLines({ pool, metadata: ready });
    const raw = new ReceiptLines({ pool });
    const seqs = Array.from({ length: seq }, (_, i) => i + 1);
    for (const viewer of VIEWERS) {
      const a = await indexed.read(roomId, seqs, viewer, AbortSignal.timeout(10_000));
      const b = await raw.read(roomId, seqs, viewer, AbortSignal.timeout(10_000));
      for (const n of seqs) {
        const mine = projectArchivedLog(s, a.get(n)!, viewer, { sceneId: null });
        assert.deepEqual(mine, projectArchivedLog(s, b.get(n)!, viewer, { sceneId: null }), `seq ${n} for ${viewer.memberId}`);
        // The access read holds only rows of the viewer's own streams.
        for (const e of a.get(n)!) assert.ok(e.kind !== "whisper" || e.from === viewer.memberId || e.to?.includes(viewer.memberId));
      }
    }
    // A row without metadata sends the lookup raw, and asks for the room.
    await legacyInsert(pool, roomId, lines(rng(72), seq, 5).rows);
    const wanted: string[] = [];
    const halfway = new ReceiptLines({ pool, metadata: { ready: true, want: (r) => void wanted.push(r) } });
    const got = await halfway.read(roomId, [seq + 1], VIEWERS[0]!, AbortSignal.timeout(10_000));
    assert.ok(got.get(seq + 1)!.length > 0);
    assert.deepEqual(wanted, [roomId]);
  });
});

describe("backfill, index builds, live writes, reads and shutdowns in random order", () => {
  test("no indexed read misses or repeats a row, and no lock, connection, turn or lease outlives a cancel", async () => {
    const s = state();
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(1_000 + seed);
      const roomA = await newRoom();
      const roomB = await newRoom();
      const stored = new Map<string, LogEntry[]>([
        [roomA, []],
        [roomB, []],
      ]);
      const seqs = new Map<string, number>([
        [roomA, 0],
        [roomB, 0],
      ]);
      const budget = new LogScanBudget({ waitMs: 5_000 });
      let w: Worker | null = null;
      const used = new Set<HistoryReader>();
      const events: string[] = [];
      const write = async (roomId: string, legacy: boolean) => {
        const next = lines(random, seqs.get(roomId)!, 1 + Math.floor(random() * 120));
        seqs.set(roomId, next.seq);
        stored.get(roomId)!.push(...next.rows);
        if (legacy) await legacyInsert(pool, roomId, next.rows);
        else await archiveLines(pool, roomId, next.rows);
      };
      if (random() < 0.5) await dropIndex();
      for (let step = 0; step < 40; step++) {
        const roomId = random() < 0.5 ? roomA : roomB;
        const r = random();
        if (r < 0.25) {
          events.push("write");
          await write(roomId, false);
        } else if (r < 0.4) {
          events.push("legacy write");
          await write(roomId, true);
        } else if (r < 0.7) {
          events.push("read");
          const viewer = VIEWERS[Math.floor(random() * VIEWERS.length)]!;
          // Sometimes a view captured before the newest rows, which it must not read.
          const seq = random() < 0.5 ? seqs.get(roomId)! : Math.floor(random() * seqs.get(roomId)!);
          const got = await read(reader(w?.m, used, 1 + Math.floor(random() * 200)), captureView({ state: s, seq }, roomId, viewer), budget, 1 + Math.floor(random() * 80));
          const want = oracle(s, stored.get(roomId)!, viewer, seq);
          assert.deepEqual(got.back, want, `seed ${seed} step ${step} (${events.join(", ")}): backward`);
          assert.deepEqual(got.forward, want, `seed ${seed} step ${step}: forward`);
          assert.equal(got.lines, want.length);
        } else if (r < 0.8) {
          events.push("start");
          if (!w) {
            w = worker({ batchRows: 1 + Math.floor(random() * 150) }, budget);
            w.m.start();
          }
          w.m.want(roomA);
          w.m.want(roomB);
        } else if (r < 0.9) {
          events.push("stop");
          if (w) {
            // A stop at a random moment: before, during or after a build or a batch.
            await new Promise((res) => setTimeout(res, Math.floor(random() * 30)));
            await w.m.stop();
            w = null;
            await noLeftovers(`seed ${seed} step ${step}`);
            assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 }, `seed ${seed} step ${step}: budget`);
          }
        } else {
          events.push("drop index");
          if (w) {
            await w.m.stop();
            w = null;
          }
          await dropIndex();
        }
      }
      if (w) await w.m.stop();
      // Settle: a last worker completes both rooms, and every read is indexed and right.
      const last = worker({}, budget);
      last.m.start();
      await until(() => last.m.ready, "ready");
      for (const roomId of [roomA, roomB]) {
        const done = last.outcome(roomId);
        last.m.want(roomId);
        await done;
        assert.equal(await nulls(roomId), 0);
        assert.equal(await accessCount(roomId), expectedAccess(stored.get(roomId)!));
        for (const viewer of VIEWERS) {
          used.clear();
          const seq = seqs.get(roomId)!;
          const got = await read(reader(last.m, used), captureView({ state: s, seq }, roomId, viewer), budget);
          assert.deepEqual(got.back, oracle(s, stored.get(roomId)!, viewer, seq), `seed ${seed} settled`);
          if (stored.get(roomId)!.length > 0) assert.deepEqual([...used], ["indexed"]);
        }
      }
      await last.m.stop();
      await noLeftovers(`seed ${seed} end`);
    }
  });
});
