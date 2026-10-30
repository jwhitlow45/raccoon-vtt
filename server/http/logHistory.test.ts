import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectLogEntry } from "#shared/project.ts";
import { member, rng } from "#shared/testutil.ts";
import { captureView, compareIds, LogHistory, type HistoryMetadata, type HistoryReader, type HistoryView } from "../rooms/logHistory.ts";
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
          const view = captureView({ state, seq: maxSeq }, "ROOM", viewer, { previewBy: previewBy ?? null });
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
        const view = captureView({ state, seq: maxSeq }, "ROOM", viewers[1]!.viewer);
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
      const page = await history.page(captureView({ state: roomState(), seq: 1e9 }, "ROOM", { memberId: DM_ID, role: "dm" }), { limit: 10 }, scan);
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
        await assert.rejects(history.page(captureView({ state, seq: 1e9 }, "ROOM", viewer), { limit: 10 }, scan), ScanCancelledError, `${c.reader}, at ${c.what}`);
      } finally {
        scan.close();
        budget.close();
      }
      assert.ok(sentAfter > 0, `${c.reader}: the cancel landed`);
      assert.deepEqual(archive.texts.slice(sentAfter), [], `${c.reader}, at ${c.what}: no statement after the cancel`);
    }
  });
});
