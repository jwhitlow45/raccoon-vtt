import { TokenBucket } from "./budgets.ts";

/**
 * Admission for archive reads (docs/design-v1-dm-tools.md 3.10): Show
 * older pages, session listings and Markdown exports all scan `room_log`,
 * and how long a scan runs depends on rows its reader may not see. So the
 * cost a reader pays never depends on that work: each `GET /log` takes one
 * fixed token, and every scan, however long, runs in bounded turns that the
 * server shares out fairly.
 *
 * A turn is one batch: at most a few hundred source rows read and
 * projected. Each pool ("page" for pages, listings and background work,
 * "export" for exports) has its own few turns, and a room has at most one
 * turn running across both, so one room cannot hold every turn. Waiting
 * scans are served by room, the room served longest ago first, then by
 * member within the room, and a scan that wants another batch waits at the
 * back like anyone else.
 *
 * A scan reads through a database cursor, which holds a connection from
 * one batch to the next, even while the reader is slow to take a body. That
 * connection is a lease: each pool has a few, and a room holds at most one
 * of each pool's. A lease is taken only together with a turn, never waited
 * for while holding one, so a scan blocked on a lease holds nothing.
 *
 * Waits are bounded: a scan not admitted within its wait fails as busy,
 * and how many scans may wait at all is capped, globally and per room.
 * Cancelling (a disconnect, a deadline, the room's deletion, shutdown)
 * takes a scan out of the queue at once.
 */
export type ScanPool = "page" | "export";

export type ScanBudgetOptions = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** `GET /log`'s bucket per room and member. */
  pageBurst: number;
  pagePerSec: number;
  turns: Record<ScanPool, number>;
  leases: Record<ScanPool, number>;
  /** Scans not yet admitted that may wait, server-wide and per room. A scan already holding its lease is bounded by the leases instead. */
  maxWaiting: number;
  maxWaitingPerRoom: number;
  maxBackgroundPerRoom: number;
  /** How long a scan waits for a turn (and, for its first batch, its lease) before it fails as busy. */
  waitMs: number;
};

export const DEFAULT_SCAN_BUDGET: ScanBudgetOptions = {
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  pageBurst: 10,
  pagePerSec: 1,
  turns: { page: 2, export: 2 },
  leases: { page: 2, export: 2 },
  maxWaiting: 16,
  maxWaitingPerRoom: 2,
  maxBackgroundPerRoom: 1,
  waitMs: 1_000,
};

/** Answered 429 busy with Retry-After 1: the scan could not be admitted in time, or too many wait. */
export class ScanBusyError extends Error {
  readonly retryAfter = 1;
  constructor() {
    super("archive scan busy");
    this.name = "ScanBusyError";
  }
}

/** The scan was cancelled: its request went, its deadline passed, its room was deleted, or the server is stopping. */
export class ScanCancelledError extends Error {
  constructor(reason?: unknown) {
    super("archive scan cancelled", { cause: reason });
    this.name = "ScanCancelledError";
  }
}

type Waiter = {
  scan: Scan;
  /** Whether this scan is new and so counts against the waiting caps. */
  counted: boolean;
  order: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: unknown;
};

/** How many served-at marks are kept. A forgotten mark reads as served longest ago, which is what it was. */
const SERVED_KEPT = 4_096;
const BUCKETS_KEPT = 4_096;

export class LogScanBudget {
  readonly options: ScanBudgetOptions;
  #buckets = new Map<string, TokenBucket>();
  #outstanding = new Set<string>();
  #turns: Record<ScanPool, number> = { page: 0, export: 0 };
  #turnRooms = new Set<string>();
  #leases: Record<ScanPool, Set<string>> = { page: new Set(), export: new Set() };
  #waiting: Waiter[] = [];
  #served = new Map<string, number>();
  #tick = 0;
  #order = 0;
  #scans = new Set<Scan>();
  #closed = false;

  constructor(options: Partial<ScanBudgetOptions> = {}) {
    this.options = { ...DEFAULT_SCAN_BUDGET, ...options };
  }

  /** `GET /log`'s fixed charge, taken before anything is read: null when it is admitted, or the seconds to wait. */
  chargePage(roomId: string, memberId: string): number | null {
    const key = `${roomId}|${memberId}`;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= BUCKETS_KEPT) {
        // A full bucket is the same as a new one, so dropping it changes no answer.
        for (const [k, b] of this.#buckets) if (b.tokens >= b.burst) this.#buckets.delete(k);
      }
      bucket = new TokenBucket(this.options.pagePerSec, this.options.pageBurst, this.options.now);
      this.#buckets.set(key, bucket);
    }
    if (bucket.take()) return null;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.options.pagePerSec));
  }

  /** One `GET /log` at a time per member, whatever the device: the release, or null when one is still running. */
  beginPage(roomId: string, memberId: string): (() => void) | null {
    const key = `${roomId}|${memberId}`;
    if (this.#outstanding.has(key)) return null;
    this.#outstanding.add(key);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#outstanding.delete(key);
    };
  }

  /** A scan, admitted batch by batch through `Scan.batch`. Close it in a finally. */
  open(job: { pool: ScanPool; roomId: string; memberId: string; background?: boolean; signal?: AbortSignal }): Scan {
    const scan = new Scan(this, job.pool, job.roomId, job.memberId, job.background === true, job.signal);
    if (this.#closed) scan.cancel(new Error("closed"));
    else this.#scans.add(scan);
    return scan;
  }

  /** Cancels every scan of a room being deleted, queued or running. */
  cancelRoom(roomId: string): void {
    for (const scan of this.#scans) if (scan.roomId === roomId) scan.cancel(new Error("room deleted"));
  }

  /** Shutdown: every scan is cancelled and no new one starts. */
  close(): void {
    this.#closed = true;
    for (const scan of this.#scans) scan.cancel(new Error("shutting down"));
  }

  /** What is in use, for tests. */
  get usage(): { turns: Record<ScanPool, number>; leases: Record<ScanPool, number>; waiting: number; scans: number } {
    return { turns: { ...this.#turns }, leases: { page: this.#leases.page.size, export: this.#leases.export.size }, waiting: this.#waiting.length, scans: this.#scans.size };
  }

  /** @internal Waits for the scan's next turn, and its lease with its first. */
  admit(scan: Scan): Promise<void> {
    if (scan.signal.aborted) return Promise.reject(new ScanCancelledError(scan.signal.reason));
    const counted = !scan.leased;
    if (counted) {
      let all = 0;
      let room = 0;
      let background = 0;
      for (const w of this.#waiting) {
        if (!w.counted) continue;
        all++;
        if (w.scan.roomId !== scan.roomId) continue;
        if (w.scan.background) background++;
        else room++;
      }
      if (all >= this.options.maxWaiting) return Promise.reject(new ScanBusyError());
      if (scan.background ? background >= this.options.maxBackgroundPerRoom : room >= this.options.maxWaitingPerRoom) return Promise.reject(new ScanBusyError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { scan, counted, order: this.#order++, resolve, reject, timer: null };
      waiter.timer = this.options.setTimer(() => this.#drop(waiter, new ScanBusyError()), this.options.waitMs);
      scan.waiter = waiter;
      this.#waiting.push(waiter);
      this.#dispatch();
    });
  }

  /** @internal The scan's turn is over. */
  endTurn(scan: Scan): void {
    if (!scan.turn) return;
    scan.turn = false;
    this.#turns[scan.pool]--;
    this.#turnRooms.delete(scan.roomId);
    this.#dispatch();
  }

  /** @internal The scan is done with its lease, and with the budget. */
  release(scan: Scan): void {
    if (scan.waiter) this.#drop(scan.waiter, new ScanCancelledError());
    this.endTurn(scan);
    if (scan.leased) {
      scan.leased = false;
      this.#leases[scan.pool].delete(scan.roomId);
    }
    this.#scans.delete(scan);
    this.#dispatch();
  }

  /** @internal A cancelled scan leaves the queue at once. */
  cancelled(scan: Scan): void {
    if (scan.waiter) this.#drop(scan.waiter, new ScanCancelledError(scan.signal.reason));
  }

  #drop(waiter: Waiter, err: Error): void {
    const at = this.#waiting.indexOf(waiter);
    if (at < 0) return;
    this.#waiting.splice(at, 1);
    this.options.clearTimer(waiter.timer);
    if (waiter.scan.waiter === waiter) waiter.scan.waiter = null;
    waiter.reject(err);
    this.#dispatch();
  }

  #dispatch(): void {
    for (;;) {
      let best: Waiter | undefined;
      for (const w of this.#waiting) if (this.#eligible(w) && (!best || this.#before(w, best))) best = w;
      if (!best) return;
      const { scan } = best;
      this.#waiting.splice(this.#waiting.indexOf(best), 1);
      this.options.clearTimer(best.timer);
      scan.waiter = null;
      this.#turns[scan.pool]++;
      this.#turnRooms.add(scan.roomId);
      scan.turn = true;
      if (!scan.leased) {
        scan.leased = true;
        this.#leases[scan.pool].add(scan.roomId);
      }
      const tick = ++this.#tick;
      this.#mark(scan.roomId, tick);
      this.#mark(`${scan.roomId}|${scan.memberId}`, tick);
      best.resolve();
    }
  }

  #eligible(w: Waiter): boolean {
    const { pool, roomId } = w.scan;
    if (this.#turns[pool] >= this.options.turns[pool] || this.#turnRooms.has(roomId)) return false;
    if (w.scan.leased) return true;
    const leases = this.#leases[pool];
    return leases.size < this.options.leases[pool] && !leases.has(roomId);
  }

  /** Whether `a` goes before `b`: the room served longest ago, then in a room its own work before background work, then the member served longest ago. */
  #before(a: Waiter, b: Waiter): boolean {
    if (a.scan.roomId !== b.scan.roomId) {
      const ra = this.#served.get(a.scan.roomId) ?? -1;
      const rb = this.#served.get(b.scan.roomId) ?? -1;
      return ra !== rb ? ra < rb : a.order < b.order;
    }
    if (a.scan.background !== b.scan.background) return !a.scan.background;
    const ma = this.#served.get(`${a.scan.roomId}|${a.scan.memberId}`) ?? -1;
    const mb = this.#served.get(`${b.scan.roomId}|${b.scan.memberId}`) ?? -1;
    return ma !== mb ? ma < mb : a.order < b.order;
  }

  #mark(key: string, tick: number): void {
    this.#served.delete(key);
    this.#served.set(key, tick);
    if (this.#served.size > SERVED_KEPT) this.#served.delete(this.#served.keys().next().value!);
  }
}

/**
 * One scan: a pass over the archive for one request, in turns. The caller
 * runs each batch inside `batch`, which holds a turn only while its
 * function runs, so waiting on the reader between batches holds none.
 */
export class Scan {
  readonly pool: ScanPool;
  readonly roomId: string;
  readonly memberId: string;
  readonly background: boolean;
  readonly signal: AbortSignal;
  /** @internal */ leased = false;
  /** @internal */ turn = false;
  /** @internal */ waiter: Waiter | null = null;
  #budget: LogScanBudget;
  #abort = new AbortController();
  #closed = false;

  constructor(budget: LogScanBudget, pool: ScanPool, roomId: string, memberId: string, background: boolean, signal: AbortSignal | undefined) {
    this.#budget = budget;
    this.pool = pool;
    this.roomId = roomId;
    this.memberId = memberId;
    this.background = background;
    this.signal = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;
    this.signal.addEventListener("abort", () => budget.cancelled(this), { once: true });
  }

  /** Runs `fn` in a turn of its own, waiting for one (and the lease, the first time). */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new ScanCancelledError();
    await this.#budget.admit(this);
    try {
      if (this.signal.aborted) throw new ScanCancelledError(this.signal.reason);
      return await fn();
    } finally {
      this.#budget.endTurn(this);
    }
  }

  cancel(reason: unknown): void {
    this.#abort.abort(reason);
  }

  /** Releases the lease and leaves the budget. Idempotent. Close the scan's cursor first. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#budget.release(this);
  }
}
