/**
 * The counters behind the socket limits (design sections 7.2, 7.6 and 10.4):
 * token buckets for rates, a sliding window for the snapshot budget, and the
 * "over for 10 s" trackers that turn sustained abuse into a 4008 close.
 *
 * Every class takes a clock, so a unit test can drive time by hand. None of
 * them keeps a timer: time is read when something happens, which is enough
 * because an idle socket costs nothing to leave alone. The maps keyed by
 * session, IP or connection sweep out their dead keys at most once a minute,
 * on the next use, because those keys never come back once a socket or a
 * session is gone.
 */

const SWEEP_EVERY_MS = 60_000;
export type Clock = () => number;

export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  #tokens: number;
  #last: number;
  #now: Clock;

  constructor(ratePerSec: number, burst: number, now: Clock = Date.now) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.#tokens = burst;
    this.#now = now;
    this.#last = now();
  }

  /** Takes `n` tokens when the bucket holds them. */
  take(n = 1): boolean {
    this.#refill();
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }

  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#last);
    this.#last = now;
    this.#tokens = Math.min(this.burst, this.#tokens + (elapsed / 1000) * this.ratePerSec);
  }
}

/**
 * Flags a socket that stays over some threshold for `holdMs`. Each violation
 * extends the streak; a pause of more than `gapMs` without one ends it. An
 * accepted frame in between does not end it, because a socket sending at
 * twice its budget still has every other frame accepted and is exactly the
 * socket this is for.
 */
export class SustainedViolation {
  readonly holdMs: number;
  readonly gapMs: number;
  #since: number | null = null;
  #last = 0;
  #now: Clock;

  constructor(holdMs: number, now: Clock = Date.now, gapMs = 1_000) {
    this.holdMs = holdMs;
    this.gapMs = gapMs;
    this.#now = now;
  }

  /** Records a violation. True when the streak has now lasted the whole hold time. */
  over(): boolean {
    const now = this.#now();
    if (this.#since === null || now - this.#last > this.gapMs) this.#since = now;
    this.#last = now;
    return now - this.#since >= this.holdMs;
  }

  reset(): void {
    this.#since = null;
  }
}

export type FrameVerdict = "ok" | "drop" | "abuse";

/**
 * The per-socket frame budget checked before any parsing (design 7.2): 100
 * frames and 256 KiB per second with a burst of twice that. Frames over
 * budget are dropped unparsed, and a socket over budget for 10 s is abuse.
 */
export class FrameBudget {
  #frames: TokenBucket;
  #bytes: TokenBucket;
  #sustained: SustainedViolation;

  constructor(now: Clock = Date.now, opts: { framesPerSec?: number; bytesPerSec?: number; holdMs?: number } = {}) {
    const frames = opts.framesPerSec ?? 100;
    const bytes = opts.bytesPerSec ?? 256 * 1024;
    this.#frames = new TokenBucket(frames, frames * 2, now);
    this.#bytes = new TokenBucket(bytes, bytes * 2, now);
    this.#sustained = new SustainedViolation(opts.holdMs ?? 10_000, now);
  }

  accept(bytes: number): FrameVerdict {
    // Both buckets are debited even when one refuses, so an over-budget
    // socket cannot keep the other bucket full for later.
    const framesOk = this.#frames.take(1);
    const bytesOk = this.#bytes.take(bytes);
    if (framesOk && bytesOk) return "ok";
    return this.#sustained.over() ? "abuse" : "drop";
  }
}

/**
 * The op rate of one socket (design 10.4): 20 per second with a burst of 60
 * answers `busy` beyond, and a socket that stays over three times its limit
 * for 10 s is closed. The second rule counts every op message, including
 * duplicates and gaps, because those cost the server work too.
 */
export class OpRate {
  #bucket: TokenBucket;
  #perSecond = 0;
  #second: number;
  #sustained: SustainedViolation;
  #abuseAt: number;
  #now: Clock;

  constructor(now: Clock = Date.now, opts: { perSec?: number; burst?: number; holdMs?: number } = {}) {
    const perSec = opts.perSec ?? 20;
    this.#bucket = new TokenBucket(perSec, opts.burst ?? 60, now);
    this.#abuseAt = perSec * 3;
    this.#sustained = new SustainedViolation(opts.holdMs ?? 10_000, now);
    this.#now = now;
    this.#second = Math.floor(now() / 1000);
  }

  /** Counts one op message. True when the socket has been abusive for the hold time. */
  count(): boolean {
    const second = Math.floor(this.#now() / 1000);
    if (second !== this.#second) {
      this.#second = second;
      this.#perSecond = 0;
    }
    this.#perSecond++;
    if (this.#perSecond > this.#abuseAt) return this.#sustained.over();
    return false;
  }

  /** Whether this op may be processed now. */
  allow(): boolean {
    return this.#bucket.take(1);
  }

  /** Whether `allow()` would say yes now, without spending anything. */
  wouldAllow(): boolean {
    return this.#bucket.tokens >= 1;
  }
}

/** At most `max` events per `windowMs`, per key. */
export class SlidingWindow {
  readonly windowMs: number;
  readonly max: number;
  #events = new Map<string, number[]>();
  #now: Clock;
  #lastSweep: number;

  constructor(windowMs: number, max: number, now: Clock = Date.now) {
    this.windowMs = windowMs;
    this.max = max;
    this.#now = now;
    this.#lastSweep = now();
  }

  /** Keys still held, for tests. */
  get size(): number {
    return this.#events.size;
  }

  tryAdd(key: string): boolean {
    const now = this.#now();
    this.#sweep(now);
    const live = (this.#events.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (live.length >= this.max) {
      if (live.length === 0) this.#events.delete(key);
      else this.#events.set(key, live);
      return false;
    }
    live.push(now);
    this.#events.set(key, live);
    return true;
  }

  forget(key: string): void {
    this.#events.delete(key);
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_EVERY_MS) return;
    this.#lastSweep = now;
    for (const [key, times] of this.#events) {
      if (!times.some((t) => t > now - this.windowMs)) this.#events.delete(key);
    }
  }
}

export type BudgetKey = { key: string; maxCount: number; maxBytes: number };

export type SnapshotBudgetLimits = {
  windowMs: number;
  sessionCount: number;
  sessionBytes: number;
  ipCount: number;
  ipBytes: number;
  /** How long a session may keep making new requests while over budget before its sockets close. */
  abuseMs: number;
};

/*
 * The byte budgets hold ten of the largest DM snapshot a minute per session
 * and twenty per address: 6 MiB since companion stat blocks ride on top of
 * the 3 MiB for everything else (docs/design-v1-companion-stat-blocks.md 3.4).
 */
export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudgetLimits = {
  windowMs: 60_000,
  sessionCount: 20,
  sessionBytes: 60 * 1024 * 1024,
  ipCount: 40,
  ipBytes: 120 * 1024 * 1024,
  abuseMs: 30_000,
};

type Spent = { at: number; bytes: number };

/**
 * The snapshot budget (design 10.4): every snapshot the server builds counts
 * against its session and its IP. A request over budget is delayed, never
 * refused, until the oldest entries leave the window. For a pinned room the
 * IP part is counted per session, because its whole table shares one IP.
 *
 * The 30 s abuse rule is tracked per session: a request that is delayed
 * starts the clock, a request that goes through stops it, and a delayed
 * request that is simply waiting never touches it.
 */
export class SnapshotBudget {
  readonly limits: SnapshotBudgetLimits;
  #spent = new Map<string, Spent[]>();
  /** Sessions whose requests are being delayed: since when, and their latest request. */
  #overSince = new Map<string, { since: number; last: number }>();
  #now: Clock;
  #lastSweep: number;

  constructor(limits: Partial<SnapshotBudgetLimits> = {}, now: Clock = Date.now) {
    this.limits = { ...DEFAULT_SNAPSHOT_BUDGET, ...limits };
    this.#now = now;
    this.#lastSweep = now();
  }

  /** Keys still held, for tests. */
  get size(): number {
    return this.#spent.size + this.#overSince.size;
  }

  keys(sessionId: string, ip: string, pinned: boolean): BudgetKey[] {
    const l = this.limits;
    return [
      { key: `s:${sessionId}`, maxCount: l.sessionCount, maxBytes: l.sessionBytes },
      pinned
        ? { key: `ps:${sessionId}`, maxCount: l.ipCount, maxBytes: l.ipBytes }
        : { key: `ip:${ip}`, maxCount: l.ipCount, maxBytes: l.ipBytes },
    ];
  }

  /** Milliseconds until one more snapshot fits under every key, 0 when it fits now. */
  delay(keys: readonly BudgetKey[]): number {
    const now = this.#now();
    let delay = 0;
    for (const k of keys) {
      const live = this.#live(k.key, now);
      let count = live.length;
      let bytes = live.reduce((sum, s) => sum + s.bytes, 0);
      if (count < k.maxCount && bytes < k.maxBytes) continue;
      let i = 0;
      while (i < live.length && (count >= k.maxCount || bytes >= k.maxBytes)) {
        count--;
        bytes -= live[i]!.bytes;
        i++;
      }
      const last = live[i - 1];
      if (last) delay = Math.max(delay, last.at + this.limits.windowMs - now);
    }
    return Math.ceil(delay);
  }

  record(keys: readonly BudgetKey[], bytes: number): void {
    const now = this.#now();
    this.#sweep(now);
    for (const k of keys) {
      const live = this.#live(k.key, now);
      live.push({ at: now, bytes });
      this.#spent.set(k.key, live);
    }
  }

  /**
   * Notes a new request (a `hello` on a new socket or a `scene` message) and
   * whether the budget delayed it. True when the session has now been making
   * requests over budget for the whole abuse window.
   */
  request(sessionId: string, delayed: boolean): boolean {
    if (!delayed) {
      this.#overSince.delete(sessionId);
      return false;
    }
    const now = this.#now();
    this.#sweep(now);
    const over = this.#overSince.get(sessionId);
    if (over === undefined) {
      this.#overSince.set(sessionId, { since: now, last: now });
      return false;
    }
    over.last = now;
    if (now - over.since >= this.limits.abuseMs) {
      this.#overSince.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Drops spent entries past the window, and abuse clocks of sessions that
   * stopped asking for a whole abuse window. Such a session was not keeping
   * up requests, which is all the abuse rule is for.
   */
  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_EVERY_MS) return;
    this.#lastSweep = now;
    for (const key of [...this.#spent.keys()]) this.#live(key, now);
    for (const [sessionId, over] of this.#overSince) {
      if (now - over.last > this.limits.abuseMs) this.#overSince.delete(sessionId);
    }
  }

  #live(key: string, now: number): Spent[] {
    const list = this.#spent.get(key);
    if (!list) return [];
    const cutoff = now - this.limits.windowMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.at <= cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) this.#spent.delete(key);
    return list;
  }
}

/**
 * Socket caps (design 10.4): 8 per session, 64 per room, 16 per IP and 400
 * on the whole server, checked before the upgrade completes.
 */
export type SocketCaps = { perSession: number; perRoom: number; perIp: number; total: number };

export const DEFAULT_SOCKET_CAPS: SocketCaps = { perSession: 8, perRoom: 64, perIp: 16, total: 400 };

export class SocketRegistry {
  readonly caps: SocketCaps;
  #total = 0;
  #bySession = new Map<string, number>();
  #byRoom = new Map<string, number>();
  #byIp = new Map<string, number>();

  constructor(caps: Partial<SocketCaps> = {}) {
    this.caps = { ...DEFAULT_SOCKET_CAPS, ...caps };
  }

  get total(): number {
    return this.#total;
  }

  canOpen(sessionId: string, roomId: string, ip: string): boolean {
    const c = this.caps;
    return (
      this.#total < c.total &&
      (this.#bySession.get(sessionId) ?? 0) < c.perSession &&
      (this.#byRoom.get(roomId) ?? 0) < c.perRoom &&
      (this.#byIp.get(ip) ?? 0) < c.perIp
    );
  }

  /** Counts a socket and returns the function that uncounts it, safe to call twice. */
  open(sessionId: string, roomId: string, ip: string): () => void {
    this.#total++;
    bump(this.#bySession, sessionId, 1);
    bump(this.#byRoom, roomId, 1);
    bump(this.#byIp, ip, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      bump(this.#bySession, sessionId, -1);
      bump(this.#byRoom, roomId, -1);
      bump(this.#byIp, ip, -1);
    };
  }
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
