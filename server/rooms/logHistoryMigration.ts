import type pg from "pg";
import type { LogEntry } from "#shared/model.ts";
import { cancelRequest, type HistoryMetadata } from "./logHistory.ts";
import { ScanBusyError, ScanCancelledError, type LogScanBudget } from "./logScanBudget.ts";
import { archiveAdmitted, completeLines, incompleteLines, storedKey, type ArchiveGuard } from "./persistence.ts";

/**
 * The log archive's metadata after boot (log history, server stage B): the
 * partial index that finds a room's rows without metadata, and the job that
 * completes those rows for the rooms people read.
 *
 * Boot's schema file adds only empty structures (db/schema.sql), since it
 * runs in one transaction before the server listens, and an index over a
 * large archive would hold both up. This worker runs after the server
 * listens, on a connection of its own, one job at a time:
 *
 * - The index. It is built with `create index concurrently`, so writes go
 *   on while it builds, under an advisory lock that keeps two servers from
 *   building it at once. A build cut short (a shutdown, a crash, a failed
 *   query) leaves an invalid index behind, which `if not exists` would take
 *   as built, so the worker reads pg_index.indisvalid itself: a valid index
 *   is used, an invalid one dropped concurrently and built again, a missing
 *   one built. A failed attempt is tried again later, and a stopped one on
 *   the next start.
 * - The backfill. Once the index is valid, a room a read found incomplete
 *   (LogHistory, ReceiptLines) is queued here, once. Its job holds the
 *   room's advisory lock, then completes its rows in batches: each batch
 *   reads up to `batchRows` rows still without metadata by the index and
 *   completes them in one statement (persistence.ts completeLines). There
 *   is no checkpoint: every batch asks the index again, so rows an older
 *   server writes meanwhile are found too. Each batch is admitted by the
 *   scan budget as background work in the page pool, so it takes a turn
 *   only when no reader of that room waits, and holds no turn or lease
 *   between batches. The free-disk floor is asked before each batch, and a
 *   refusal pauses the room until a read asks for it again. An id the
 *   metadata cannot hold stops the room's backfill for this process, with
 *   an operator error: its reads stay on the complete raw reader.
 *
 * Nothing here decides what a read returns. Readers ask the database whether
 * a room still holds a row without metadata before every indexed read
 * (persistence.ts archiveIncomplete), so a room this worker never reaches
 * is read the raw way, completely.
 *
 * Every step on the worker's connection is bounded and stops at a cancel
 * (shutdown, or the deletion of the room it works on): connecting, waiting
 * for a lock (polled, between cancellable waits), and each query (its
 * query timeout). A cancelled step sends the backend PostgreSQL's cancel
 * request and then closes the connection, with no more SQL on it, which
 * ends the backend and every lock it held. The job's turn and lease are
 * given back only after that, and stop() resolves only after that.
 */

export const UNINDEXED_INDEX = "room_log_unindexed_room";
const CREATE_INDEX = `create index concurrently ${UNINDEXED_INDEX} on room_log (room_id) where seq is null`;
const DROP_INDEX = `drop index concurrently if exists ${UNINDEXED_INDEX}`;

/** Advisory lock keys: the index's DDL, and each room's backfill by the hash of its id. "RVTT" and the next number. */
export const DDL_LOCK = [0x52565454, 1] as const;
export const ROOM_LOCK_CLASS = 0x52565455;

export const BACKFILL_BATCH_ROWS = 500;

export type MigrationLog = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type MigrationOptions = {
  /** A new connection of the worker's own, never one a room or a reader uses. Called once per job. */
  connect: () => Promise<pg.Client>;
  budget: LogScanBudget;
  /** The archive's free-disk floor (persistence.ts ArchiveGuard). */
  guard: ArchiveGuard;
  log: MigrationLog;
  /** How a dropped connection's backend is told to stop. Defaults to PostgreSQL's cancel request. */
  cancel?: (client: pg.Client) => Promise<void>;
  batchRows?: number;
  /** Each backfill query's bound, and the index build's, which reads the whole table. */
  queryMs?: number;
  buildMs?: number;
  /** How long closing a connection may take before its socket is destroyed. */
  closeMs?: number;
  /** The wait after a failed index build, doubling up to `maxRetryMs`, and between polls of a lock or a busy budget. */
  retryMs?: number;
  maxRetryMs?: number;
  pollMs?: number;
  /** Rooms that may wait for a backfill. One asked for past this is asked for again by its next read. */
  maxWanted?: number;
  /** The timers the worker waits on, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** For tests: runs before each step, on the worker's own time, with the job's cancel. */
  onStep?: (step: MigrationStep, signal: AbortSignal) => Promise<void>;
};

export type MigrationStep = { kind: "index"; action: "create" | "drop" } | { kind: "batch"; roomId: string; rows: number } | { kind: "room"; roomId: string; outcome: RoomOutcome };

type RoomOutcome = "complete" | "locked" | "paused" | "malformed" | "cancelled" | "failed";

class MalformedId extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`log row id ${JSON.stringify(id)} is not one the archive's metadata can hold`);
    this.name = "MalformedId";
    this.id = id;
  }
}

const WARN_EVERY_MS = 60_000;

export class LogHistoryMigration implements HistoryMetadata {
  #opts: Required<Omit<MigrationOptions, "onStep" | "cancel">> & Pick<MigrationOptions, "onStep"> & { cancel: (client: pg.Client) => Promise<void> };
  #ready = false;
  #started = false;
  #stopped = false;
  #loop: Promise<void> | null = null;
  #wanted = new Set<string>();
  /** Rooms whose backfill found an id it cannot hold: left raw until the process restarts. */
  #malformed = new Set<string>();
  /** The job running now, and how to stop it. */
  #job: { roomId: string | null; abort: AbortController } | null = null;
  /** Ends the idle wait: a room was asked for, or stop. */
  #wakeIdle: (() => void) | null = null;
  /** Ends the wait before the index build is tried again: stop alone, never a read, so the backoff holds however often rooms are asked for. */
  #wakeRetry: (() => void) | null = null;
  #lastDiskWarning = -Infinity;

  constructor(opts: MigrationOptions) {
    this.#opts = {
      batchRows: BACKFILL_BATCH_ROWS,
      queryMs: 15_000,
      buildMs: 30 * 60_000,
      closeMs: 1_000,
      retryMs: 1_000,
      maxRetryMs: 60_000,
      pollMs: 100,
      maxWanted: 1_024,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      ...opts,
      cancel: opts.cancel ?? ((client) => cancelRequest(client)),
    };
  }

  /** Whether the partial index is valid, so a read may check a room's completeness quickly. */
  get ready(): boolean {
    return this.#ready;
  }

  /** What the worker holds, for tests. */
  get detail(): { wanted: string[]; running: string | null; started: boolean; stopped: boolean } {
    return { wanted: [...this.#wanted], running: this.#job ? (this.#job.roomId ?? "index") : null, started: this.#started, stopped: this.#stopped };
  }

  /** Starts the worker, after the server listens. It never throws: a failed step is logged and tried again. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#loop = this.#run().catch((err: unknown) => this.#opts.log.error({ err }, "log metadata worker stopped"));
  }

  want(roomId: string): void {
    if (this.#stopped || this.#malformed.has(roomId) || this.#job?.roomId === roomId) return;
    if (!this.#wanted.has(roomId) && this.#wanted.size >= this.#opts.maxWanted) return;
    this.#wanted.add(roomId);
    this.#wakeIdle?.();
  }

  /** A deleted room: dropped from the queue, and its running job cancelled. */
  cancelRoom(roomId: string): void {
    this.#wanted.delete(roomId);
    this.#malformed.delete(roomId);
    if (this.#job?.roomId === roomId) this.#job.abort.abort(new Error("room deleted"));
  }

  /** Stops the worker: the running job is cancelled and its connection gone before this resolves. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wanted.clear();
    this.#job?.abort.abort(new Error("shutting down"));
    this.#wakeIdle?.();
    this.#wakeRetry?.();
    await this.#loop;
  }

  async #run(): Promise<void> {
    let delay = this.#opts.retryMs;
    while (!this.#stopped) {
      if (!this.#ready) {
        const built = await this.#withJob(null, (conn, signal) => this.#ensureIndex(conn, signal)).catch((err: unknown) => {
          if (!this.#stopped) this.#opts.log.warn({ err }, "log history index not built yet, trying again later");
          return false;
        });
        if (built) {
          this.#ready = true;
          delay = this.#opts.retryMs;
          this.#opts.log.info({ index: UNINDEXED_INDEX }, "log history index ready");
          continue;
        }
        await this.#sleep(delay);
        delay = Math.min(delay * 2, this.#opts.maxRetryMs);
        continue;
      }
      const roomId = this.#wanted.values().next().value;
      if (roomId === undefined) {
        await this.#idle();
        continue;
      }
      this.#wanted.delete(roomId);
      // Asked first without a connection, so a room read often while the disk is short opens none.
      if (!(await archiveAdmitted(this.#opts.guard))) {
        this.#warnDisk({ roomId }, "log history backfill paused: the disk is under its free-space floor");
        await this.#opts.onStep?.({ kind: "room", roomId, outcome: "paused" }, AbortSignal.abort());
        continue;
      }
      const outcome = await this.#withJob(roomId, (conn, signal) => this.#backfill(conn, roomId, signal)).catch((err: unknown): RoomOutcome => {
        if (err instanceof ScanCancelledError || this.#stopped) return "cancelled";
        if (err instanceof MalformedId) {
          this.#malformed.add(roomId);
          this.#opts.log.error({ roomId, id: err.id }, "log history backfill stopped: a row's id cannot be indexed, so the room keeps the raw reader");
          return "malformed";
        }
        this.#opts.log.warn({ err, roomId }, "log history backfill failed, the room is tried again on its next read");
        return "failed";
      });
      await this.#opts.onStep?.({ kind: "room", roomId, outcome }, AbortSignal.abort());
    }
  }

  /**
   * One job on a connection of its own, which is closed before this
   * returns, whatever happens. A cancel during the job (stop, or the
   * room's deletion) drops the connection at once.
   */
  async #withJob<T>(roomId: string | null, fn: (conn: Dedicated, signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    this.#job = { roomId, abort };
    if (this.#stopped) abort.abort(new Error("shutting down"));
    let conn: Dedicated | null = null;
    try {
      conn = await Dedicated.open(this.#opts, abort.signal);
      return await fn(conn, abort.signal);
    } finally {
      // The connection is gone, or back to idle and closed, before the job lets go of anything.
      if (conn) await conn.close(abort.signal.aborted);
      this.#job = null;
    }
  }

  /** Builds the index unless a valid one exists. True once it is valid, false when the disk floor refused the build. */
  async #ensureIndex(conn: Dedicated, signal: AbortSignal): Promise<boolean> {
    await this.#lock(conn, signal, () => conn.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [...DDL_LOCK]));
    try {
      const valid = await indexValid(conn);
      if (valid === true) return true;
      if (!(await archiveAdmitted(this.#opts.guard))) {
        this.#warnDisk({}, "log history index not built: the disk is under its free-space floor");
        return false;
      }
      if (valid === false) {
        await this.#opts.onStep?.({ kind: "index", action: "drop" }, signal);
        await conn.query(DROP_INDEX, [], this.#opts.buildMs);
      }
      await this.#opts.onStep?.({ kind: "index", action: "create" }, signal);
      await conn.query(CREATE_INDEX, [], this.#opts.buildMs);
      if ((await indexValid(conn)) !== true) throw new Error(`${UNINDEXED_INDEX} is not valid after its build`);
      return true;
    } finally {
      if (!signal.aborted && conn.usable) await conn.query("select pg_advisory_unlock($1, $2)", [...DDL_LOCK]);
    }
  }

  async #backfill(conn: Dedicated, roomId: string, signal: AbortSignal): Promise<RoomOutcome> {
    const { budget, batchRows } = this.#opts;
    const got = await conn.query<{ locked: boolean }>("select pg_try_advisory_lock($1, hashtext($2)) as locked", [ROOM_LOCK_CLASS, roomId]);
    // Another server is completing this room: its reads stay raw until that server is done.
    if (got.rows[0]?.locked !== true) return "locked";
    try {
      for (;;) {
        if (signal.aborted) throw new ScanCancelledError(signal.reason);
        if (!(await archiveAdmitted(this.#opts.guard))) {
          this.#warnDisk({ roomId }, "log history backfill paused: the disk is under its free-space floor");
          return "paused";
        }
        const scan = budget.open({ pool: "page", roomId, memberId: "", background: true, signal });
        // A cancel from the budget itself (the room's deletion, shutdown) ends the job and drops its connection too.
        const onCancel = () => this.#job?.abort.abort(scan.signal.reason);
        scan.signal.addEventListener("abort", onCancel, { once: true });
        // The lease is held until the connection is idle again or gone, even when the scan is cancelled mid-batch.
        const letGo = scan.retain();
        let done: number;
        try {
          done = await scan.batch(async () => {
            const rows = await incompleteLines(conn, roomId, batchRows);
            const bad = rows.find((r) => storedKey(r.id) === null);
            if (bad) throw new MalformedId(bad.id);
            await this.#opts.onStep?.({ kind: "batch", roomId, rows: rows.length }, signal);
            await completeLines(conn, roomId, rows as { id: string; entry: LogEntry }[]);
            return rows.length;
          });
        } catch (err) {
          if (err instanceof ScanBusyError && !signal.aborted) {
            await this.#sleep(this.#opts.pollMs, signal);
            continue;
          }
          throw signal.aborted ? new ScanCancelledError(signal.reason) : err;
        } finally {
          scan.signal.removeEventListener("abort", onCancel);
          if (signal.aborted || !conn.usable) await conn.close(true);
          letGo();
          scan.close();
        }
        if (done < batchRows) return "complete";
      }
    } finally {
      if (!signal.aborted && conn.usable) await conn.query("select pg_advisory_unlock($1, hashtext($2))", [ROOM_LOCK_CLASS, roomId]);
    }
  }

  /** Polls `attempt` until it takes its lock, waiting between tries, until the job is cancelled. */
  async #lock(conn: Dedicated, signal: AbortSignal, attempt: () => Promise<pg.QueryResult<{ locked: boolean }>>): Promise<void> {
    for (;;) {
      if ((await attempt()).rows[0]?.locked === true) return;
      if (conn.usable === false) throw new Error("connection lost");
      await this.#sleep(this.#opts.pollMs, signal);
    }
  }

  #warnDisk(obj: object, msg: string): void {
    const now = Date.now();
    if (now - this.#lastDiskWarning < WARN_EVERY_MS) return;
    this.#lastDiskWarning = now;
    this.#opts.log.warn(obj, msg);
  }

  /** Waits `ms`, or until stop. With a signal, a cancel rejects the wait. */
  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const { setTimer, clearTimer } = this.#opts;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new ScanCancelledError(signal.reason));
      if (!signal && this.#stopped) return resolve();
      const finish = () => {
        clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.#wakeRetry === finish) this.#wakeRetry = null;
        resolve();
      };
      const onAbort = () => {
        clearTimer(timer);
        reject(new ScanCancelledError(signal!.reason));
      };
      const timer = setTimer(finish, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!signal) this.#wakeRetry = finish;
    });
  }

  /** Waits for a room to be asked for, or for stop. */
  #idle(): Promise<void> {
    if (this.#stopped || this.#wanted.size > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#wakeIdle = () => {
        this.#wakeIdle = null;
        resolve();
      };
    });
  }
}

/** Whether the partial index exists and is valid: null when it does not exist. */
async function indexValid(conn: Dedicated): Promise<boolean | null> {
  const { rows } = await conn.query<{ valid: boolean }>("select i.indisvalid as valid from pg_index i where i.indexrelid = to_regclass($1)", [UNINDEXED_INDEX]);
  return rows[0] === undefined ? null : rows[0].valid;
}

/**
 * The worker's connection for one job. Every query is bounded by its own
 * timeout, and the first failure, timeout or cancel drops the connection:
 * a cancel request to its backend, then the socket closed, so a statement
 * still running on the server stops and the backend's locks go with it.
 * After that no more SQL is sent on it.
 */
class Dedicated {
  readonly #client: pg.Client;
  readonly #opts: { cancel: (client: pg.Client) => Promise<void>; queryMs: number; closeMs: number };
  #ended = false;
  #dropping: Promise<void> | null = null;
  #onAbort: () => void;
  #signal: AbortSignal;

  constructor(client: pg.Client, opts: { cancel: (client: pg.Client) => Promise<void>; queryMs: number; closeMs: number }, signal: AbortSignal) {
    this.#client = client;
    this.#opts = opts;
    this.#signal = signal;
    client.once("end", () => {
      this.#ended = true;
    });
    // An error on an idle connection must never go unheard: it would end the process.
    client.on("error", () => {
      this.#ended = true;
    });
    this.#onAbort = () => void this.close(true);
    signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  /** Connects, giving up at the cancel: a connection made after that is closed at once. */
  static async open(opts: { connect: () => Promise<pg.Client>; cancel: (client: pg.Client) => Promise<void>; queryMs: number; closeMs: number }, signal: AbortSignal): Promise<Dedicated> {
    if (signal.aborted) throw new ScanCancelledError(signal.reason);
    const client = await new Promise<pg.Client>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new ScanCancelledError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      opts.connect().then(
        (c) => {
          signal.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            resolve(c);
          } else void endBounded(c, opts.closeMs);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
    return new Dedicated(client, opts, signal);
  }

  /** Whether more SQL may go on this connection. */
  get usable(): boolean {
    return !this.#ended && this.#dropping === null;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = [], ms = this.#opts.queryMs): Promise<pg.QueryResult<R>> {
    if (this.#signal.aborted) throw new ScanCancelledError(this.#signal.reason);
    if (!this.usable) throw new Error("log metadata connection is gone");
    try {
      return await this.#client.query<R>({ text, values, query_timeout: ms } as pg.QueryConfig);
    } catch (err) {
      await this.close(true);
      if (this.#signal.aborted) throw new ScanCancelledError(this.#signal.reason);
      throw err;
    }
  }

  /**
   * Ends the connection. Dropped (`drop`, or once anything failed): the
   * backend is sent a cancel request first, bounded, so a statement still
   * running stops. Either way the close is bounded, and a socket that does
   * not close in time is destroyed. Idempotent: every caller waits for the
   * one close.
   */
  close(drop: boolean): Promise<void> {
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#dropping ??= (async () => {
      if (drop && !this.#ended) await this.#opts.cancel(this.#client).catch(() => undefined);
      await endBounded(this.#client, this.#opts.closeMs);
      this.#ended = true;
    })();
    return this.#dropping;
  }
}

/** `client.end()`, or the socket destroyed if it has not closed within `ms`. Resolves once the socket is closed. */
async function endBounded(client: pg.Client, ms: number): Promise<void> {
  const stream = (client as unknown as { connection?: { stream?: { destroy(): void; destroyed?: boolean; once(e: string, f: () => void): void } } }).connection?.stream;
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve) => {
    if (!stream || stream.destroyed) return resolve();
    stream.once("close", resolve);
  });
  await Promise.race([
    client.end().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        stream?.destroy();
        resolve();
      }, ms);
    }),
  ]);
  clearTimeout(timer);
  // A destroyed socket closes on the next tick. Bounded too, by the same wait once more.
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
}
