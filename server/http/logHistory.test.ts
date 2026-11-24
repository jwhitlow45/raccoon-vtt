import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectLogEntry } from "#shared/project.ts";
import { member, rng } from "#shared/testutil.ts";
import { captureView, compareIds, LogHistory, ReceiptLines, type HistoryMetadata, type HistoryReader, type HistoryView } from "../rooms/logHistory.ts";
import { LogScanBudget, ScanCancelledError } from "../rooms/logScanBudget.ts";
import { lineAccess, readerStreams, storedKey } from "../rooms/persistence.ts";

/**
 * The indexed reader against the raw one (log history, server stage B),
 * without a database: an archive in memory that answers the statements the
 * two readers send, the access rows filed by the same rule the writes use
 * (persistence.ts lineAccess). The rows that read them and the merge are
 * the reader's own. Every answer the indexed reader gives must be the raw
 * reader's, for random archives, viewers, batch sizes, pages and ranges,
 * and a room with any row lacking metadata must be read raw. The same
 * agreement on a real database, with the backfill half done and restarted,
 * is in server/rooms/logHistoryMigration.itest.ts.
 */

type Stored = { entry: LogEntry; complete: boolean };

/** The archive of one room, and connections that answer the readers' SQL against it. */
class Archive {
  rows: Stored[] = [];
  /** Access rows as the writes file them: a stream and member per complete row. */
  access(): { stream: string; member: string; seq: string; line: number; id: string }[] {
    return this.rows.flatMap(({ entry, complete }) => {
      const key = storedKey(entry.id);
      if (!complete || !key) return [];
      return lineAccess(entry).map((a) => ({ stream: a.stream, member: a.memberId, seq: key.seq, line: key.line, id: entry.id }));
    });
  }
  /** Every statement a reader sent, by its first words, and in full. */
  readonly statements: string[] = [];
  readonly texts: string[] = [];
  /** Runs as a statement's answer is handed back, in the same tick: where a test lands its cancel. */
  answered: ((text: string) => void) | null = null;
  connect = () => Promise.resolve(new FakeClient(this) as never);
}

const KEY = /(\(split_part\(id, ':', 1\)::bigint, split_part\(id, ':', 2\)::int\)|\(seq, line_no\)) (>=|<=|>|<) \(\$(\d+)::bigint, \$(\d+)::int\)/g;

function keyOf(id: string): [bigint, number] {
  const at = id.indexOf(":");
  return [BigInt(id.slice(0, at)), Number(id.slice(at + 1))];
}

function cmp(a: [bigint, number], b: [bigint, number]): number {
  return a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1];
}

/** The bounds a statement's text and parameters name, as a filter on a key. */
function boundsOf(text: string, params: unknown[]): (k: [bigint, number]) => boolean {
  const tests: ((k: [bigint, number]) => boolean)[] = [];
  for (const m of text.matchAll(KEY)) {
    const b: [bigint, number] = [BigInt(String(params[Number(m[3]) - 1])), Number(params[Number(m[4]) - 1])];
    const op = m[2]!;
    tests.push((k) => {
      const c = cmp(k, b);
      return op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
    });
  }
  return (k) => tests.every((t) => t(k));
}

class FakeClient extends EventEmitter {
  processID = 1;
  #archive: Archive;
  #cursor: string[] = [];

  constructor(archive: Archive) {
    super();
    this.#archive = archive;
  }

  query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const t = text.replace(/\s+/g, " ").trim();
    this.#archive.statements.push(t.split(" ").slice(0, 2).join(" "));
    this.#archive.texts.push(t);
    const answer = this.#answer(t, params);
    this.#archive.answered?.(t);
    return answer;
  }

  #answer(t: string, params: unknown[]): Promise<{ rows: unknown[] }> {
    if (t.startsWith("begin") || t === "rollback") return Promise.resolve({ rows: [] });
    if (t.startsWith("select exists")) return Promise.resolve({ rows: [{ incomplete: this.#archive.rows.some((r) => !r.complete) }] });
    if (t.startsWith("declare")) {
      const maxSeq = BigInt(Number(params[1]));
      const within = boundsOf(t, params);
      const desc = / desc$/.test(t);
      this.#cursor = this.#archive.rows
        .map((r) => r.entry.id)
        .filter((id) => keyOf(id)[0] <= maxSeq && within(keyOf(id)))
        .sort((a, b) => cmp(keyOf(a), keyOf(b)) * (desc ? -1 : 1));
      return Promise.resolve({ rows: [] });
    }
    if (t.startsWith("fetch")) {
      const n = Number(/^fetch (\d+)/.exec(t)![1]);
      return Promise.resolve({ rows: this.#cursor.splice(0, n).map((id) => ({ id })) });
    }
    if (t.startsWith("select id, entry from room_log")) {
      const ids = new Set(params[1] as string[]);
      return Promise.resolve({ rows: this.#archive.rows.filter((r) => ids.has(r.entry.id)).map((r) => ({ id: r.entry.id, entry: r.entry })) });
    }
    if (t.startsWith("select id, seq::text as seq_text, line_no from room_log_access")) {
      const [, stream, memberId, maxSeq] = params as [string, string, string, number];
      const within = boundsOf(t, params);
      const desc = / desc limit \$\d+$/.test(t);
      const limit = Number(params[params.length - 1]);
      const rows = this.#archive
        .access()
        // The captured seq bounds the read only where the statement says so.
        .filter((a) => a.stream === stream && a.member === memberId && (!t.includes("seq <= $4") || BigInt(a.seq) <= BigInt(maxSeq)) && within([BigInt(a.seq), a.line]))
        .sort((a, b) => cmp([BigInt(a.seq), a.line], [BigInt(b.seq), b.line]) * (desc ? -1 : 1))
        .slice(0, limit)
        .map((a) => ({ id: a.id, seq_text: a.seq, line_no: a.line }));
      return Promise.resolve({ rows });
    }
    return Promise.reject(new Error(`the fake archive does not know: ${t.slice(0, 80)}`));
  }

  release(): void {}
}

const DM_ID = "dm1";
const PLAYERS = ["p1", "p2", "p3"];

function roomState(): RoomState {
  const state = createInitialState({ roomName: "Agreement", dm: member(DM_ID, "dm") });
  for (const p of PLAYERS) state.members[p] = member(p);
  return state;
}

/** A random archive of `n` rows of every audience, with the ids and clocks the reducer writes, and some old-style ids. */
function randomRows(random: () => number, n: number): LogEntry[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const everyone = [DM_ID, ...PLAYERS];
  const rows: LogEntry[] = [];
  let seq = 1;
  let at = Date.parse("2025-03-01T18:00:00.000Z");
  while (rows.length < n) {
    seq += 1 + Math.floor(random() * 3);
    const step = random();
    at += step < 0.9 ? Math.floor(random() * 60_000) : step < 0.96 ? 5 * 3_600_000 : -2 * 3_600_000;
    const counts = { shared: 0, party: 100_000, dm: 900_000 };
    const time = new Date(at).toISOString();
    for (let i = 1 + Math.floor(random() * 4); i > 0; i--) {
      const r = random();
      const from = pick(everyone);
      if (r < 0.3) rows.push({ id: `${seq}:${counts.shared++}`, at: time, kind: "chat", from, text: "s" });
      else if (r < 0.55) {
        const to = everyone.filter((m) => m !== from && random() < 0.4);
        rows.push({ id: `${seq}:${counts.shared++}`, at: time, kind: "whisper", from, to: to.length > 0 ? to : [pick(everyone.filter((m) => m !== from))], text: "w" });
      } else if (r < 0.75) rows.push({ id: `${seq}:${counts.party++}`, at: time, kind: "chat", from, to: [pick(PLAYERS)], copyOf: `${seq}:900000`, text: "p" });
      else if (r < 0.9) rows.push({ id: `${seq}:${counts.dm++}`, at: time, kind: "chat", from: DM_ID, text: "d" });
      // An event line from before op version 19 that only its kind makes a DM line: shared in the access rows, kept from players by the projector.
      else rows.push({ id: `${seq}:${counts.shared++}`, at: time, kind: "event", data: { type: "teleport", tokenId: "t1", sceneId: "s1" } as never });
    }
  }
  return rows.sort((a, b) => compareIds(a.id, b.id));
}

type Answers = { back: string[]; forward: string[]; lines: number; sessions: unknown[]; ends: string[] | null; range: string[] };

async function answers(history: LogHistory, view: HistoryView, budget: LogScanBudget, random: () => number, ids: readonly string[]): Promise<Answers> {
  const scan = budget.open({ pool: "page", roomId: view.roomId, memberId: view.viewer.memberId });
  try {
    const back: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await history.page(view, { before, limit: 1 + Math.floor(random() * 100) }, scan);
      back.unshift(...page.entries.map((e) => e.id));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    const forward: string[] = [];
    let after = "0:0";
    for (;;) {
      const page = await history.page(view, { after, limit: 1 + Math.floor(random() * 100) }, scan);
      forward.push(...page.entries.map((e) => e.id));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    const sessions = await history.sessions(view, { limit: 50 }, scan);
    const ends = await history.bounds(view, {}, scan);
    // An inclusive id range, its ends picked among stored ids whoever may read them.
    const a = ids[Math.floor(random() * ids.length)]!;
    const b = ids[Math.floor(random() * ids.length)]!;
    const [fromId, toId] = compareIds(a, b) <= 0 ? [a, b] : [b, a];
    const range: string[] = [];
    for await (const batch of history.exportBatches(view, { fromId, toId }, scan)) range.push(...batch.map((e) => e.id));
    return { back, forward, lines: sessions.lines, sessions: sessions.sessions, ends: ends ? [ends.first.id, ends.last.id] : null, range };
  } finally {
    scan.close();
  }
}

describe("the indexed reader against the raw reader", () => {
  test("a line's access rows include a stream of every reader the projector lets read it", () => {
    const state = roomState();
    const random = rng(7);
    const viewers: Viewer[] = [{ memberId: DM_ID, role: "dm" }, ...PLAYERS.map((memberId) => ({ memberId, role: "player" as const })), { memberId: "stranger", role: "player" }];
    let readable = 0;
    for (const entry of randomRows(random, 3_000)) {
      const filed = lineAccess(entry).map((a) => `${a.stream}|${a.memberId}`);
      for (const viewer of viewers) {
        if (!projectLogEntry(state, entry, viewer, { sceneId: null })) continue;
        readable++;
        const mine = readerStreams(viewer).map((a) => `${a.stream}|${a.memberId}`);
        assert.ok(
          filed.some((f) => mine.includes(f)),
          `${entry.id} (${entry.kind}) readable by ${viewer.role} ${viewer.memberId} but filed only in ${filed.join(", ")}`,
        );
      }
    }
    assert.ok(readable > 3_000);
  });

  test("ids the metadata can hold are the reducer's own: decimal, no leading zero, within bigint and six digits", () => {
    assert.deepEqual(storedKey("0:0"), { seq: "0", line: 0 });
    assert.deepEqual(storedKey("123:900001"), { seq: "123", line: 900_001 });
    assert.deepEqual(storedKey("999999999999999999:999999"), { seq: "999999999999999999", line: 999_999 });
    for (const bad of ["05:1", "5:01", "-1:0", "1:1234567", "1234567890123456789:0", "a:b", "1:", ":1", "1:2:3", " 1:2", "1:2 "]) assert.equal(storedKey(bad), null, bad);
  });

  test("pages, sessions, export ranges and ends agree for random archives, and any row without metadata keeps the room raw", async () => {
    const state = roomState();
    const viewers: { viewer: Viewer; previewBy?: string }[] = [
      { viewer: { memberId: DM_ID, role: "dm" } },
      ...PLAYERS.map((memberId) => ({ viewer: { memberId, role: "player" as const } })),
      { viewer: { memberId: "p2", role: "player" }, previewBy: DM_ID },
    ];
    const budget = new LogScanBudget({ waitMs: 10_000 });
    try {
      for (let seed = 1; seed <= 12; seed++) {
        const random = rng(seed);
        const archive = new Archive();
        const rows = randomRows(random, 400 + Math.floor(random() * 800));
        archive.rows = rows.map((entry) => ({ entry, complete: true }));
        const ids = rows.map((r) => r.id);
        const maxSeq = Number(ids[ids.length - 1]!.split(":")[0]) - Math.floor(random() * 3);
        const wanted: string[] = [];
        const used = new Set<HistoryReader>();
        const metadata: HistoryMetadata = { ready: true, want: (roomId) => void wanted.push(roomId) };
        const batchRows = 1 + Math.floor(random() * 600);
        const indexed = new LogHistory({ pool: archive, metadata, batchRows, onBatch: async ({ reader }) => void used.add(reader) });
        const raw = new LogHistory({ pool: archive, batchRows: 1 + Math.floor(random() * 600) });
        for (const { viewer, previewBy } of viewers) {
          const view = captureView({ state, through: maxSeq }, "ROOM", viewer, { previewBy: previewBy ?? null });
          const pickSeed = Math.floor(random() * 1e9);
          const want = await answers(raw, view, budget, rng(pickSeed), ids);
          used.clear();
          const got = await answers(indexed, view, budget, rng(pickSeed), ids);
          assert.deepEqual([...used], ["indexed"], `seed ${seed}: a complete room is read indexed`);
          assert.deepEqual(got, want, `seed ${seed} ${viewer.role} ${viewer.memberId}${previewBy ? " preview" : ""} batch ${batchRows}`);
          assert.ok(want.back.length > 0 || viewer.memberId === "stranger");
        }
        assert.deepEqual(wanted, [], "a complete room asks for no backfill");
        // One row without metadata, anywhere: every read is raw again, and the room is queued.
        archive.rows[Math.floor(random() * archive.rows.length)]!.complete = false;
        const fresh = new LogHistory({ pool: archive, metadata, batchRows, onBatch: async ({ reader }) => void used.add(reader) });
        const view = captureView({ state, through: maxSeq }, "ROOM", viewers[1]!.viewer);
        const pickSeed = Math.floor(random() * 1e9);
        used.clear();
        const half = await answers(fresh, view, budget, rng(pickSeed), ids);
        assert.deepEqual([...used], ["raw"], `seed ${seed}: an incomplete room is read raw`);
        assert.deepEqual(half, await answers(raw, view, budget, rng(pickSeed), ids));
        assert.ok(wanted.length > 0 && wanted.every((r) => r === "ROOM"));
      }
    } finally {
      budget.close();
    }
  });

  test("before its index is valid every read is raw, and asks for its room once the worker can", async () => {
    const archive = new Archive();
    archive.rows = randomRows(rng(3), 50).map((entry) => ({ entry, complete: true }));
    const wanted: string[] = [];
    const used = new Set<HistoryReader>();
    const history = new LogHistory({ pool: archive, metadata: { ready: false, want: (r) => void wanted.push(r) }, onBatch: async ({ reader }) => void used.add(reader) });
    const budget = new LogScanBudget();
    const scan = budget.open({ pool: "page", roomId: "ROOM", memberId: DM_ID });
    try {
      const page = await history.page(captureView({ state: roomState(), through: 1e9 }, "ROOM", { memberId: DM_ID, role: "dm" }), { limit: 10 }, scan);
      assert.equal(page.entries.length, 10);
    } finally {
      scan.close();
      budget.close();
    }
    assert.deepEqual([...used], ["raw"]);
    assert.deepEqual(wanted, ["ROOM"]);
    assert.ok(!archive.statements.includes("select exists"), "no completeness check runs without the index");
  });

  test("a cancel that lands as a statement answers sends no more SQL and fails the read, on the indexed and the raw reader alike", async () => {
    const state = roomState();
    const viewer: Viewer = { memberId: DM_ID, role: "dm" };
    const cases: { reader: HistoryReader; at: RegExp; what: string }[] = [
      { reader: "indexed", at: /^select id, seq::text as seq_text/, what: "a stream's candidates" },
      { reader: "indexed", at: /^select id, entry from room_log/, what: "the quantum's last statement" },
      { reader: "raw", at: /^fetch /, what: "the cursor's fetch" },
      { reader: "raw", at: /^select id, entry from room_log/, what: "the batch's last statement" },
    ];
    for (const c of cases) {
      const archive = new Archive();
      archive.rows = randomRows(rng(5), 300).map((entry) => ({ entry, complete: true }));
      const abort = new AbortController();
      let sentAfter = -1;
      archive.answered = (text) => {
        if (sentAfter >= 0 || !c.at.test(text)) return;
        sentAfter = archive.texts.length;
        abort.abort(new Error("client went away"));
      };
      const history = new LogHistory({
        pool: archive,
        metadata: c.reader === "indexed" ? { ready: true, want: () => undefined } : undefined,
        batchRows: 50,
        cancel: () => Promise.resolve(),
      });
      const budget = new LogScanBudget();
      const scan = budget.open({ pool: "page", roomId: "ROOM", memberId: DM_ID, signal: abort.signal });
      try {
        await assert.rejects(history.page(captureView({ state, through: 1e9 }, "ROOM", viewer), { limit: 10 }, scan), ScanCancelledError, `${c.reader}, at ${c.what}`);
      } finally {
        scan.close();
        budget.close();
      }
      assert.ok(sentAfter > 0, `${c.reader}: the cancel landed`);
      assert.deepEqual(archive.texts.slice(sentAfter), [], `${c.reader}, at ${c.what}: no statement after the cancel`);
    }
  });
});

/** Which step of a guarded connection a stop lands on: the timeout's setting, the statement, or the reset. */
type Step = "set" | "statement" | "reset";

/**
 * How a sequence's connections behave. `stopped` is the server's own timer:
 * the first step of kind `at` that runs under a timeout fails with SQLSTATE
 * 57014 once that timeout has passed since the step began. `external` is
 * someone else's cancel, such as an operator's pg_cancel_backend: the
 * first step of kind `at` fails with 57014 at once. `hang` holds every
 * statement until its connection is destroyed.
 */
type Fate = { kind: "answer" | "hang" } | { kind: "stopped" | "external"; at: Step };

/**
 * A connection whose session keeps a statement timeout as PostgreSQL's does:
 * set_config sets it and a reset puts back the session's own (null here),
 * a step that fails changing neither. Every step lands a few turns later,
 * so a cancel can come between any two of them. Broken invariants are kept
 * in `broken`, since the code under test would swallow a throw.
 */
class TimedConnection extends EventEmitter {
  readonly steps: string[] = [];
  readonly broken: string[] = [];
  timeout: number | null = null;
  let: "release" | "destroy" | null = null;
  /** Runs as the nth step answers, in the same turn, before its caller hears the answer. */
  onAnswer: ((n: number) => void) | null = null;
  readonly random: () => number;
  readonly fate: Fate;
  /** Shared by a sequence's connections: answers so far, and the step the fate's stop landed on. */
  readonly shared: { answers: number; fired: Step | null };
  #pending = new Set<(err: Error) => void>();
  constructor(random: () => number, fate: Fate, shared: { answers: number; fired: Step | null }) {
    super();
    this.random = random;
    this.fate = fate;
    this.shared = shared;
  }
  query(config: string | { text: string; values?: unknown[] }, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = typeof config === "string" ? config : config.text;
    const values = typeof config === "string" ? params : config.values;
    if (this.let !== null) this.broken.push(`SQL after the connection was let go: ${text}`);
    if (this.steps.includes("cancel")) this.broken.push(`SQL after its backend was told to stop: ${text}`);
    const step: Step | "rollback" = text.startsWith("select set_config('statement_timeout'") ? "set" : text === "reset statement_timeout" ? "reset" : text === "rollback" ? "rollback" : "statement";
    this.steps.push(step);
    const started = performance.now();
    const fate = this.fate;
    if (step !== "rollback" && this.shared.fired === null && (fate.kind === "stopped" || fate.kind === "external") && fate.at === step && (fate.kind === "external" || this.timeout !== null)) {
      this.shared.fired = step;
      if (fate.kind === "external") return this.#after(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
      const ends = started + this.timeout!;
      return this.#after(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }), 0, ends);
    }
    if (step === "set") {
      this.timeout = Number(values?.[0]);
      if (!(this.timeout >= 1)) this.broken.push(`a timeout of ${this.timeout}: 0 would turn it off`);
    }
    if (step === "reset") this.timeout = null;
    if (step === "statement" && fate.kind === "hang") return this.#after(null, Infinity);
    return this.#after(null);
  }
  release(destroy?: boolean): void {
    if (this.let !== null) this.broken.push("let go twice");
    this.let = destroy ? "destroy" : "release";
    if (!destroy && this.timeout !== null) this.broken.push("back to the pool with a statement timeout of its own");
    for (const reject of this.#pending) reject(new Error("Connection terminated"));
    this.#pending.clear();
  }
  /** Lands a few turns later, and not before `notBefore` on performance.now()'s clock, which a server timer never beats. */
  #after(err: Error | null, turns = Math.floor(this.random() * 3), notBefore = 0): Promise<{ rows: unknown[] }> {
    return new Promise((resolve, reject) => {
      this.#pending.add(reject);
      if (turns === Infinity) return;
      const land = (left: number) => {
        if (!this.#pending.has(reject)) return;
        const wait = notBefore - performance.now();
        if (wait > 0) return void setTimeout(() => land(left), Math.ceil(wait));
        if (left > 0) return void setImmediate(() => land(left - 1));
        this.#pending.delete(reject);
        if (err) return reject(err);
        resolve({ rows: [] });
        this.onAnswer?.(this.shared.answers++);
      };
      land(turns);
    });
  }
}

/** A receipt read of `statements` statements on one TimedConnection, as withQueries runs it, and what became of it. */
async function timedRead(fate: Fate, stopIn: number, statements: number): Promise<{ result: unknown; conn: TimedConnection }> {
  const conn = new TimedConnection(rng(1), fate, { answers: 0, fired: null });
  const lines = new ReceiptLines({ pool: { connect: async () => conn } as never, cancel: async () => void conn.steps.push("cancel") });
  const result = await lines
    .withQueries(new AbortController().signal, async (q) => {
      for (let k = 0; k < statements; k++) await q.query(`select ${k}`);
    }, performance.now() + stopIn)
    .then(() => "answered", (err: unknown) => err);
  return { result, conn };
}

test("the server's own stop during the timeout's setting or its reset fails as cancelled, which answers busy, and destroys the connection", async () => {
  for (const at of ["set", "statement", "reset"] as const) {
    // Two statements, so the second setting runs under the first one's timeout.
    const { result, conn } = await timedRead({ kind: "stopped", at }, 3, 2);
    assert.equal(conn.shared.fired, at, `${at}: the stop landed`);
    assert.ok(result instanceof ScanCancelledError, `${at}: ${String(result)}`);
    assert.equal(conn.let, "destroy", at);
    assert.deepEqual(conn.broken, [], at);
  }
});

test("a cancel before the deadline with no abort is someone else's and stays the error it is, while one at or after the deadline is the request's own", async () => {
  for (const at of ["set", "statement", "reset"] as const) {
    const early = await timedRead({ kind: "external", at }, 60_000, 1);
    assert.ok(!(early.result instanceof ScanCancelledError) && (early.result as { code?: unknown }).code === "57014", `${at}, early: ${String(early.result)}`);
    assert.equal(early.conn.let, "destroy", at);
    const late = await timedRead({ kind: "external", at }, -5, 1);
    assert.ok(late.result instanceof ScanCancelledError, `${at}, late: ${String(late.result)}`);
    assert.equal(late.conn.let, "destroy", at);
  }
});

test("random deadlines, cancels and stops, the server's own and others', for a receipt read and both scan readers: each statement goes out with its own timeout, nothing after the cancel, no timeout back to the pool, and only this request's stops answer busy", async () => {
  const random = rng(4103);
  const outcomes = new Map<string, number>();
  const turn = () => new Promise((r) => setImmediate(r));
  const view = captureView({ state: createInitialState({ roomName: "Timed", dm: member("dm1", "dm") }), through: 10 }, "ROOM", { memberId: "dm1", role: "dm" });
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  for (let i = 0; i < 900; i++) {
    const driver = (["receipt", "indexed", "raw"] as const)[i % 3]!;
    const kind = pick(["answer", "stopped", "external", "hang"] as const);
    const fate: Fate = kind === "stopped" || kind === "external" ? { kind, at: pick(["set", "statement", "reset"] as const) } : { kind };
    // Someone else's cancel comes with no abort, so which side of the deadline it lands on alone decides its answer.
    // A statement that hangs ends only at its cancel, so the cancel comes then: after some turns, or as a step answers.
    const cancel = kind === "external" ? "none" : kind === "hang" || random() < 0.6 ? pick(["turns", "answer"] as const) : "none";
    const abortAfter = Math.floor(random() * 12);
    const answerAt = Math.floor(random() * 6);
    const cancelTurns = Math.floor(random() * 3);
    const shared = { answers: 0, fired: null as Step | null };
    const abort = new AbortController();
    const conns: TimedConnection[] = [];
    const pool = {
      connect: async () => {
        const conn = new TimedConnection(random, fate, shared);
        if (cancel === "answer") conn.onAnswer = (n) => void (n === answerAt && abort.abort(new Error("client went away")));
        conns.push(conn);
        return conn;
      },
    };
    // A cancel request takes a few turns, as a real one's connection does, and a step can answer meanwhile.
    const cancelRequest = async (client: unknown) => {
      (client as TimedConnection).steps.push("cancel");
      for (let t = 0; t < cancelTurns; t++) await turn();
    };
    // The server's own stops wait out their timeout in real time, so theirs are short.
    const stopIn = pick(kind === "stopped" ? [-5, 2, 6] : kind === "external" ? [-5, 60_000] : [-5, 5, 60_000]);
    const stopAt = performance.now() + stopIn;
    const statements = 1 + Math.floor(random() * 3);
    const budget = new LogScanBudget();
    const scan = budget.open({ pool: "page", roomId: "ROOM", memberId: "dm1", signal: abort.signal, stopAt });
    const work: Promise<unknown> =
      driver === "receipt"
        ? new ReceiptLines({ pool: pool as never, cancel: cancelRequest as never }).withQueries(abort.signal, async (q) => {
            for (let k = 0; k < statements; k++) await q.query(`select ${k}`);
          }, stopAt)
        : new LogHistory({ pool: pool as never, cancel: cancelRequest as never, ...(driver === "indexed" ? { metadata: { ready: true, want: () => undefined } } : {}) }).page(view, { limit: 50 }, scan);
    const outcome = work.then(
      () => "answered",
      (err: unknown) => (err instanceof ScanCancelledError ? "cancelled" : (err as { code?: unknown }).code === "57014" ? "raw 57014" : `failed: ${String(err)}`),
    );
    if (cancel === "turns" || kind === "hang") {
      // A hung statement whose cancel was to come at an answer that never comes ends at the deadline.
      for (let t = 0; t < (cancel === "turns" ? abortAfter : 12); t++) await turn();
      abort.abort(new Error("deadline"));
    }
    const result = await outcome;
    for (let t = 0; t < 6; t++) await turn();
    scan.close();
    const where = `sequence ${i} (${driver}, ${JSON.stringify(fate)}, in ${stopIn} ms, cancel ${cancel}, fired ${shared.fired}): ${result}: ${conns.map((c) => `${c.steps.join(",")} ${c.let}`).join(" | ")}`;
    outcomes.set(`${driver} ${kind}${shared.fired ? ` at ${shared.fired}` : ""} ${result}`, (outcomes.get(`${driver} ${kind}${shared.fired ? ` at ${shared.fired}` : ""} ${result}`) ?? 0) + 1);
    // Invariants, for every connection: each statement goes out right after its own timeout is set, nothing goes out
    // after the cancel request or the let-go, the let-go comes once, a destroy after SQL follows a cancel request, and
    // one back in the pool has the session's own timeout, reset last. An answer with no cancel or stop let every connection go back.
    for (const c of conns) {
      assert.deepEqual(c.broken, [], where);
      c.steps.forEach((step, n) => {
        if (step === "statement") assert.equal(c.steps[n - 1], "set", `${where}: a statement without its timeout`);
      });
      assert.notEqual(c.let, null, `${where}: a connection never let go`);
      if (c.let === "destroy" && c.steps.some((s) => s !== "cancel")) assert.ok(c.steps.includes("cancel"), `${where}: destroyed after SQL without a cancel request`);
      if (c.let === "release" && c.steps.includes("set")) assert.equal(c.steps.at(-1), "reset", where);
      if (result === "answered" && !abort.signal.aborted && shared.fired === null) assert.equal(c.let, "release", where);
    }
    // Invariants on the answer: a stop on the raw reader's closing reset comes after its page was whole, so it answers;
    // any other stop of the server's own, or someone else's past the deadline, is cancelled, and someone else's before
    // the deadline stays its own error.
    if (shared.fired === "reset" && driver === "raw") assert.equal(result, "answered", where);
    else if (kind === "stopped" && shared.fired) assert.equal(result, "cancelled", where);
    else if (kind === "external") assert.equal(result, stopIn > 0 ? "raw 57014" : "cancelled", where);
    else assert.ok(result === "answered" || result === "cancelled", where);
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 }, where);
  }
  const seen = (key: string) => (outcomes.get(key) ?? 0) > 0;
  for (const driver of ["receipt", "indexed", "raw"]) {
    for (const key of ["answer answered", "answer cancelled", "hang cancelled", "stopped at set cancelled", "stopped at statement cancelled", "external at set raw 57014", "external at set cancelled", "external at statement raw 57014", "external at statement cancelled"]) {
      assert.ok(seen(`${driver} ${key}`), `${driver} ${key}: ${JSON.stringify([...outcomes])}`);
    }
    const reset = driver === "raw" ? ["answered", "answered", "answered"] : ["cancelled", "raw 57014", "cancelled"];
    assert.ok(seen(`${driver} stopped at reset ${reset[0]}`) && seen(`${driver} external at reset ${reset[1]}`) && seen(`${driver} external at reset ${reset[2]}`), `${driver} reset: ${JSON.stringify([...outcomes])}`);
  }
});
