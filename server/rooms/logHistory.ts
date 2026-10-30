import { connect } from "node:net";
import type pg from "pg";
import type { LogNames } from "#shared/logText.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { SessionFold, type LogSession } from "../http/logExport.ts";
import { previewOmits } from "./fanout.ts";
import { ScanBusyError, ScanCancelledError, type Scan } from "./logScanBudget.ts";
import { declareLogScan, fetchLogIds, readLogEntries, type LogBound, type LogScanRange } from "./persistence.ts";

/**
 * The one reader of the log archive (docs/design-v1-dm-tools.md 3.10 and
 * design 10.8), behind Show older pages, the session listing and the
 * Markdown export.
 *
 * Each request captures one committed state and seq (`HistoryView`) and
 * reads only rows at or below that seq, projecting every batch against that
 * same state, so a commit or a change of sight during the request never
 * mixes two states in one answer. Rows are projected before anything is
 * counted, grouped, paged or written, and a reader's answer depends on the
 * lines they may read alone: hidden rows only cost scanning time, and the
 * scan goes on through them however many there are, in bounded batches
 * admitted by the scan budget (logScanBudget.ts), until the answer is full
 * or the archive is done. A scan that cannot finish fails the request,
 * never answers short.
 */

/** Source rows read and projected in one turn. */
export const HISTORY_BATCH_ROWS = 500;
/** Canonical session lists kept, and the bytes they may hold together. */
export const SUMMARIES_KEPT = 8;
export const SUMMARY_BYTES = 1024 * 1024;

const CURSOR = "log_history";
/** How long a scan keeps asking for a connection the pool cannot give, as long as a lease is waited for, and how often. */
const CONNECTION_WAIT_MS = 1_000;
const CONNECTION_RETRY_MS = 50;
/** How long a cancel request may take, connecting and sending, before its socket is destroyed. */
const CANCEL_WAIT_MS = 1_000;

/**
 * PostgreSQL's cancel request for a connection's backend: a new socket to the
 * same server carrying the backend's process id and the secret key the
 * backend gave this connection at startup. Only that backend matches the
 * pair, so a request that arrives late cannot stop another session that has
 * the process id since. It is bounded: connecting and sending get
 * CANCEL_WAIT_MS, and the socket is destroyed after either way. It sends
 * no SQL, so nothing is left queued anywhere.
 */
export function cancelRequest(client: pg.ClientBase, waitMs = CANCEL_WAIT_MS): Promise<void> {
  const c = client as unknown as { processID: unknown; secretKey: unknown; host?: string; port?: number };
  const pid = c.processID;
  const key = c.secretKey;
  if (typeof pid !== "number" || typeof key !== "number" || c.port === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const socket = c.host?.startsWith("/") ? connect(`${c.host}/.s.PGSQL.${c.port}`) : connect(c.port!, c.host ?? "localhost");
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    socket.once("error", done);
    socket.once("close", done);
    socket.once("connect", () => {
      const message = Buffer.alloc(16);
      message.writeInt32BE(16, 0);
      message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
      message.writeInt32BE(pid, 8);
      message.writeInt32BE(key, 12);
      // The server reads the request and closes the socket, which ends the wait.
      socket.end(message);
    });
  });
}

/** The protocol's code for a cancel request (1234 in the high 16 bits, 5678 in the low). */
const CANCEL_REQUEST_CODE = 80_877_102;

/** The pool had no connection to give within its checkout timeout. */
class ConnectionUnavailable extends Error {
  constructor(cause: unknown) {
    super("no log scan connection", { cause });
    this.name = "ConnectionUnavailable";
  }
}

/** What one request reads the archive as. */
export type HistoryView = {
  roomId: string;
  state: RoomState;
  seq: number;
  /** Whose lines: the caller, or the player a DM previews. */
  viewer: Viewer;
  sceneId: string | null;
  /** The DM previewing `viewer`, whose own unreadable whispers are left out as well. */
  previewBy: string | null;
};

export function captureView(committed: { state: RoomState; seq: number }, roomId: string, viewer: Viewer, opts: { sceneId?: string | null; previewBy?: string | null } = {}): HistoryView {
  return { roomId, state: committed.state, seq: committed.seq, viewer, sceneId: opts.sceneId ?? null, previewBy: opts.previewBy ?? null };
}

/**
 * The names a file reads with: a DM's from the whole room's state, every
 * scene's tokens included, since the DM's scene-scoped view would read a
 * creature on another scene as "A creature", and a player's from their own
 * view, as their Log panel's are.
 */
export function viewNames(view: HistoryView): LogNames {
  const { state, viewer } = view;
  const seen = viewer.role === "dm" ? state : projectState(state, viewer, { sceneId: null });
  return { members: seen.members, tokens: seen.tokens, characters: seen.characters, handouts: seen.handouts, encounter: seen.encounter } as LogNames;
}

// Entry ids -----------------------------------------------------------------

const ENTRY_ID = /^(\d{1,18}):(\d{1,6})$/;

/** An entry id written the way stored ids are, or null. Leading zeros go, so ids compare as numbers. */
export function canonicalId(raw: string): string | null {
  const m = ENTRY_ID.exec(raw);
  if (!m) return null;
  return `${m[1]!.replace(/^0+(?=\d)/, "")}:${Number(m[2])}`;
}

/** Numeric order of two canonical ids: op seq, then line index. */
export function compareIds(a: string, b: string): number {
  const ia = a.indexOf(":");
  const ib = b.indexOf(":");
  if (ia !== ib) return ia - ib;
  const sa = a.slice(0, ia);
  const sb = b.slice(0, ib);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return Number(a.slice(ia + 1)) - Number(b.slice(ib + 1));
}

function bound(id: string, inclusive: boolean): LogBound {
  const at = id.indexOf(":");
  return { seq: id.slice(0, at), index: Number(id.slice(at + 1)), inclusive };
}

// Admission -----------------------------------------------------------------

/** Who a request was admitted as, fixed when it starts. The token's hash never leaves the server. */
export type HistoryAdmission = { sessionId: string; tokenHash: Buffer; roomId: string; memberId: string; role: "dm" | "player" };

/**
 * Whether the request's admission still holds, read fresh from the tables
 * every time: the same token on a live room session, and a grant in the
 * room for the same member and role at the room's current epoch. An export
 * asks before its headers and before each batch it writes, so signing out,
 * expiry, a rotated token, a removed grant, a new epoch or a deleted room
 * stops it there. The token matters on its own: rotation keeps the session
 * id and its grants. Run on its own, outside any scan's transaction, so
 * `now()` is now.
 */
export async function admissionHolds(pool: Pick<pg.Pool, "query">, a: HistoryAdmission): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from sessions s
       join grants g on g.session_id = s.id
       join rooms r on r.id = g.room_id
     where s.id = $1 and s.token_hash = $2 and s.expires_at > now() and s.purpose = 'room'
       and g.room_id = $3 and g.member_id = $4 and g.role = $5
       and g.epoch = case g.role when 'dm' then r.dm_epoch else r.player_epoch end`,
    [a.sessionId, a.tokenHash, a.roomId, a.memberId, a.role],
  );
  return rows.length === 1;
}

// The reader ----------------------------------------------------------------

export type HistoryPage = { entries: LogEntry[]; nextBefore: string | null; nextAfter: string | null };
export type SessionPage = { sessions: LogSession[]; lines: number; nextSessionsBefore: string | null };
/** What an export covers: an id range (inclusive), or the older time filter, or everything. */
export type ExportRange = { fromId?: string; toId?: string; fromMs?: number; toMs?: number };

type Canonical = { sessions: LogSession[]; lines: number; bytes: number };

export type LogHistoryOptions = {
  /** The pool scans take their cursors' connections from, apart from the rooms' own. */
  pool: Pick<pg.Pool, "connect">;
  /** How a dropped connection's backend is told to stop. Defaults to PostgreSQL's cancel request (cancelRequest). Tests replace it. */
  cancel?: (client: pg.PoolClient) => Promise<void>;
  batchRows?: number;
  summaryBytes?: number;
  /** For tests: runs in each batch's turn, after its rows are read. */
  onBatch?: (what: { roomId: string; pass: "page" | "sessions" | "bounds" | "lines" }) => Promise<void>;
};

export class LogHistory {
  #pool: Pick<pg.Pool, "connect">;
  #cancel: (client: pg.PoolClient) => Promise<void>;
  #batchRows: number;
  #summaryBytes: number;
  #onBatch: LogHistoryOptions["onBatch"];
  /** Canonical session lists, least recently used first. */
  #summaries = new Map<string, Canonical>();
  #summaryTotal = 0;
  /** Lists being found now, by key. */
  #folding = new Map<string, Promise<Canonical | null>>();

  constructor(opts: LogHistoryOptions) {
    this.#pool = opts.pool;
    this.#cancel = opts.cancel ?? cancelRequest;
    this.#batchRows = opts.batchRows ?? HISTORY_BATCH_ROWS;
    this.#summaryBytes = opts.summaryBytes ?? SUMMARY_BYTES;
    this.#onBatch = opts.onBatch;
  }

  /**
   * The view's readable lines over a range, a batch at a time, each batch
   * projected in its own turn. Batches with nothing readable are passed
   * over, never answered.
   *
   * The cursor's connection is taken in the first turn and held to the end,
   * and the scan keeps its lease until the connection is physically back in
   * the pool or destroyed (Scan.retain). Every step on it is bounded and
   * stops when the scan is cancelled:
   * - taking it: the pool's checkout timeout, or the cancel, which disposes
   *   of a connection handed over too late, including one handed over in the
   *   moment before it was cancelled, before any query runs on it;
   * - each query: the pool's query timeout;
   * - the end: a rollback and a return to the pool, but only for a scan that
   *   was neither cancelled nor failed. A cancelled scan, or one whose query
   *   failed or timed out, sends its backend a cancel request keyed by the
   *   backend's secret (cancelBackend) and destroys the connection, sending
   *   no more SQL on it.
   * A connection the pool cannot give now frees the turn and is asked for
   * again, until the lease wait runs out.
   */
  async *batches(view: HistoryView, range: Pick<LogScanRange, "order" | "lower" | "upper">, scan: Scan, pass: "page" | "sessions" | "bounds" | "lines"): AsyncGenerator<LogEntry[]> {
    let client: pg.PoolClient | null = null;
    let letGo: (() => void) | null = null;
    let dropping: Promise<void> | null = null;
    let failed = false;
    let ended = false;
    const onEnd = () => {
      ended = true;
    };
    const drop = (): Promise<void> => {
      const held = client;
      if (!held) return Promise.resolve();
      dropping ??= (async () => {
        if (!ended) await this.#cancelBackend(held);
        held.release(true);
        letGo?.();
      })();
      return dropping;
    };
    const onAbort = () => void drop();
    // Kept until the connection is let go, so a cancel during the closing rollback still drops it.
    scan.signal.addEventListener("abort", onAbort);
    let unavailableSince: number | null = null;
    try {
      for (;;) {
        let batch: { entries: LogEntry[]; done: boolean };
        try {
          batch = await scan.batch(async () => {
            if (!client) {
              const taken = await this.#connect(scan);
              client = taken;
              letGo = scan.retain();
              taken.once("end", onEnd);
              // Cancelled in the moment between the pool's answer and here: the abort found no connection to drop.
              if (scan.signal.aborted) {
                await drop();
                throw new ScanCancelledError(scan.signal.reason);
              }
              // One snapshot for the cursor and every entry read beside it.
              await taken.query("begin isolation level repeatable read read only");
              await declareLogScan(taken, CURSOR, { ...range, roomId: view.roomId, maxSeq: view.seq });
            }
            const held = client as pg.PoolClient;
            const ids = await fetchLogIds(held, CURSOR, this.#batchRows);
            const rows = await readLogEntries(held, view.roomId, ids);
            await this.#onBatch?.({ roomId: view.roomId, pass });
            return { entries: projectRows(view, rows), done: ids.length < this.#batchRows };
          });
        } catch (err) {
          if (!(err instanceof ConnectionUnavailable) || scan.signal.aborted) throw err;
          unavailableSince ??= scan.now();
          if (scan.now() - unavailableSince >= CONNECTION_WAIT_MS) throw new ScanBusyError();
          await scan.wait(CONNECTION_RETRY_MS);
          continue;
        }
        if (batch.entries.length > 0) yield batch.entries;
        if (batch.done) return;
      }
    } catch (err) {
      failed = true;
      if (scan.signal.aborted) throw new ScanCancelledError(scan.signal.reason);
      throw err;
    } finally {
      const held = client as pg.PoolClient | null;
      if (held && !dropping) {
        if (failed || ended || scan.signal.aborted) await drop();
        else {
          try {
            await held.query("rollback");
          } catch {
            await drop();
          }
          // Set inside the scan's callbacks, so read through casts the compiler cannot narrow away.
          if (!(dropping as Promise<void> | null)) {
            held.release();
            (letGo as (() => void) | null)?.();
          }
        }
      }
      // A drop started by the abort finishes before the scan can give up its lease: bounded, since the cancel is.
      if (dropping as Promise<void> | null) await dropping;
      scan.signal.removeEventListener("abort", onAbort);
      held?.removeListener("end", onEnd);
    }
  }

  /** A connection for the scan, or ConnectionUnavailable. Cancelling stops the wait, and a connection handed over after that is disposed of. */
  #connect(scan: Scan): Promise<pg.PoolClient> {
    if (scan.signal.aborted) return Promise.reject(new ScanCancelledError(scan.signal.reason));
    return new Promise<pg.PoolClient>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new ScanCancelledError(scan.signal.reason));
      };
      scan.signal.addEventListener("abort", onAbort, { once: true });
      this.#pool.connect().then(
        (client) => {
          scan.signal.removeEventListener("abort", onAbort);
          if (settled) client.release(true);
          else {
            settled = true;
            resolve(client);
          }
        },
        (err: unknown) => {
          scan.signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          reject(new ConnectionUnavailable(err));
        },
      );
    });
  }

  /** Cancels what the scan's backend is running, so a long sort does not run on after the scan lets go of it. */
  #cancelBackend(client: pg.PoolClient): Promise<void> {
    return this.#cancel(client).catch(() => undefined);
  }

  /**
   * A page of `limit` readable lines before or after an id (exclusive), the
   * newest when neither is given, oldest first. Its cursors name only lines
   * it returns, and a page that came back short says its direction ended:
   * nothing beyond the page's own lines decides either.
   */
  async page(view: HistoryView, q: { before?: string; after?: string; limit: number }, scan: Scan): Promise<HistoryPage> {
    const forward = q.after !== undefined;
    const range: Pick<LogScanRange, "order" | "lower" | "upper"> = forward
      ? { order: "asc", lower: bound(q.after!, false) }
      : { order: "desc", ...(q.before !== undefined ? { upper: bound(q.before, false) } : {}) };
    const got: LogEntry[] = [];
    reading: for await (const batch of this.batches(view, range, scan, "page")) {
      for (const entry of batch) {
        got.push(entry);
        if (got.length === q.limit) break reading;
      }
    }
    if (got.length === 0) return { entries: [], nextBefore: null, nextAfter: null };
    const entries = forward ? got : got.reverse();
    const full = entries.length === q.limit;
    const lo = entries[0]!.id;
    const hi = entries[entries.length - 1]!.id;
    return forward ? { entries, nextBefore: lo, nextAfter: full ? hi : null } : { entries, nextBefore: full ? lo : null, nextAfter: hi };
  }

  /**
   * A page of sessions, newest first, from the canonical list of every
   * readable line's sessions: the same sessions whatever the page, and
   * `lines` always the whole readable archive's count. The list is found
   * once per view and kept, small, in a bounded cache. One too large to
   * keep is found again by each request, which keeps only its own page.
   */
  async sessions(view: HistoryView, q: { before?: string; limit: number }, scan: Scan): Promise<SessionPage> {
    const key = `${view.roomId}|${view.seq}|${stateSerial(view.state)}|${view.viewer.memberId}|${view.viewer.role}|${view.sceneId ?? ""}|${view.previewBy ?? ""}`;
    const hit = this.#hit(key);
    if (hit) return { ...sliceSessions(hit.sessions, q.before, q.limit), lines: hit.lines };
    // A second request for a list being found waits for that one, holding nothing, rather than finding it again. It
    // waits on its own terms: its cancel ends its wait, and the one finding the list goes on regardless.
    const pending = this.#folding.get(key);
    if (pending) {
      const found = await untilCancelled(pending, scan);
      if (scan.signal.aborted) throw new ScanCancelledError(scan.signal.reason);
      if (found) {
        this.#hit(key);
        return { ...sliceSessions(found.sessions, q.before, q.limit), lines: found.lines };
      }
    }
    let share!: (list: Canonical | null) => void;
    const shared = new Promise<Canonical | null>((resolve) => (share = resolve));
    this.#folding.set(key, shared);
    try {
      const { list, page } = await this.#foldSessions(view, q, scan);
      if (list) this.#remember(key, list);
      share(list);
      return page;
    } catch (err) {
      share(null);
      throw err;
    } finally {
      if (this.#folding.get(key) === shared) this.#folding.delete(key);
    }
  }

  /** What the session cache holds, for tests. */
  get cached(): { lists: number; bytes: number } {
    let bytes = 0;
    for (const list of this.#summaries.values()) bytes += list.bytes;
    if (bytes !== this.#summaryTotal) throw new Error(`session cache total ${this.#summaryTotal} is not its lists' ${bytes}`);
    return { lists: this.#summaries.size, bytes };
  }

  /** The cached list for a key, marked most recently used. */
  #hit(key: string): Canonical | undefined {
    const hit = this.#summaries.get(key);
    if (hit) {
      this.#summaries.delete(key);
      this.#summaries.set(key, hit);
    }
    return hit;
  }

  /** One pass over the view's lines: the page asked for, and the whole list when it is small enough to keep. */
  async #foldSessions(view: HistoryView, q: { before?: string; limit: number }, scan: Scan): Promise<{ list: Canonical | null; page: SessionPage }> {
    let list: LogSession[] | null = [];
    let bytes = 0;
    // Once the list outgrows the budget only the sessions this page can need are kept: the newest `limit + 1` before `before`.
    const ring: LogSession[] = [];
    const keep = (s: LogSession) => {
      if (q.before !== undefined && compareIds(s.firstId, q.before) >= 0) return;
      ring.push(s);
      if (ring.length > q.limit + 1) ring.shift();
    };
    const fold = new SessionFold((s) => {
      if (list === null) return keep(s);
      list.push(s);
      bytes += sessionBytes(s);
      if (bytes > this.#summaryBytes) {
        for (const kept of list) keep(kept);
        list = null;
      }
    });
    let lines = 0;
    for await (const batch of this.batches(view, { order: "asc" }, scan, "sessions")) {
      lines += batch.length;
      for (const entry of batch) fold.add(entry);
    }
    fold.end();
    const all = list as LogSession[] | null;
    if (all !== null) return { list: { sessions: all, lines, bytes }, page: { ...sliceSessions(all, q.before, q.limit), lines } };
    const more = ring.length > q.limit;
    const page = ring.slice(-q.limit).reverse();
    return { list: null, page: { sessions: page, lines, nextSessionsBefore: more ? page[page.length - 1]!.firstId : null } };
  }

  /** The first and last readable lines an export covers, read without keeping any line between. */
  async bounds(view: HistoryView, range: ExportRange, scan: Scan): Promise<{ first: LogEntry; last: LogEntry } | null> {
    let first: LogEntry | null = null;
    let last: LogEntry | null = null;
    for await (const batch of this.exportBatches(view, range, scan, "bounds")) {
      first ??= batch[0]!;
      last = batch[batch.length - 1]!;
    }
    return first && last ? { first, last } : null;
  }

  /** An export's readable lines, oldest first, a batch at a time. */
  async *exportBatches(view: HistoryView, range: ExportRange, scan: Scan, pass: "bounds" | "lines" = "lines"): AsyncGenerator<LogEntry[]> {
    const ids: Pick<LogScanRange, "order" | "lower" | "upper"> = {
      order: "asc",
      ...(range.fromId !== undefined ? { lower: bound(range.fromId, true) } : {}),
      ...(range.toId !== undefined ? { upper: bound(range.toId, true) } : {}),
    };
    const lo = range.fromMs ?? -Infinity;
    const hi = range.toMs ?? Infinity;
    const timed = range.fromMs !== undefined || range.toMs !== undefined;
    for await (const batch of this.batches(view, ids, scan, pass)) {
      const kept = timed
        ? batch.filter((e) => {
            const at = Date.parse(e.at);
            return at >= lo && at <= hi;
          })
        : batch;
      if (kept.length > 0) yield kept;
    }
  }

  #remember(key: string, list: Canonical): void {
    const old = this.#summaries.get(key);
    if (old) {
      this.#summaries.delete(key);
      this.#summaryTotal -= old.bytes;
    }
    this.#summaries.set(key, list);
    this.#summaryTotal += list.bytes;
    for (const [old, kept] of this.#summaries) {
      if (this.#summaries.size <= SUMMARIES_KEPT && this.#summaryTotal <= this.#summaryBytes) break;
      this.#summaries.delete(old);
      this.#summaryTotal -= kept.bytes;
    }
  }
}

/**
 * A number for each committed state the reader has seen. A room keeps one
 * state object from one commit to the next, and a load makes a new one, so
 * this tells apart two loads of a room at the same seq: an old import's lines
 * can reach the archive as a room loads (persistence.ts loadRoom) without any
 * op, and a list kept from before must not answer for after.
 */
const stateSerials = new WeakMap<RoomState, number>();
let lastSerial = 0;
function stateSerial(state: RoomState): number {
  let serial = stateSerials.get(state);
  if (serial === undefined) {
    serial = ++lastSerial;
    stateSerials.set(state, serial);
  }
  return serial;
}

/** `work`'s answer, or ScanCancelledError as soon as the scan is cancelled, whichever comes first. `work` runs on. */
function untilCancelled<T>(work: Promise<T>, scan: Scan): Promise<T> {
  if (scan.signal.aborted) return Promise.reject(new ScanCancelledError(scan.signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ScanCancelledError(scan.signal.reason));
    scan.signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        scan.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        scan.signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** A view's readable lines among `rows`, against its one captured state. */
function projectRows(view: HistoryView, rows: readonly LogEntry[]): LogEntry[] {
  const projected = projectArchivedLog(view.state, rows, view.viewer, { sceneId: view.sceneId });
  const by = view.previewBy;
  return by === null ? projected : projected.filter((line) => !previewOmits(line, by));
}

/** Roughly what a session costs held in memory, for the cache's byte budget. */
function sessionBytes(s: LogSession): number {
  return 2 * (s.firstId.length + s.lastId.length + s.from.length + s.to.length) + 64;
}

/** The newest `limit` sessions of an oldest-first list that start before `before`, newest first, and the next page's cursor. */
export function sliceSessions(sessions: readonly LogSession[], before: string | undefined, limit: number): Omit<SessionPage, "lines"> {
  let end = sessions.length;
  if (before !== undefined) {
    let lo = 0;
    let hi = sessions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareIds(sessions[mid]!.firstId, before) < 0) lo = mid + 1;
      else hi = mid;
    }
    end = lo;
  }
  const start = Math.max(0, end - limit);
  const page = sessions.slice(start, end).reverse();
  return { sessions: page, nextSessionsBefore: start > 0 ? page[page.length - 1]!.firstId : null };
}
