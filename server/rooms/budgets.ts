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

  /** Takes `n` tokens when the bucket holds them at `at`, the bucket's own clock when absent. */
  take(n = 1, at = this.#now()): boolean {
    this.#refill(at);
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }

  get tokens(): number {
    return this.available();
  }

  /** The tokens the bucket holds at `at`, the bucket's own clock when absent. */
  available(at = this.#now()): number {
    this.#refill(at);
    return this.#tokens;
  }

  /** A time before the last one read refills nothing and leaves the last one as it was, so the bucket's time never moves back. */
  #refill(now: number): void {
    if (now <= this.#last) return;
    this.#tokens = Math.min(this.burst, this.#tokens + ((now - this.#last) / 1000) * this.ratePerSec);
    this.#last = now;
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

  /** Records a violation at `now`, its own clock when absent. True when the streak has now lasted the whole hold time. Its last time never moves back. */
  over(now = this.#now()): boolean {
    if (this.#since === null || now - this.#last > this.gapMs) this.#since = now;
    this.#last = Math.max(this.#last, now);
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

/** One socket's op rate, and a player member's across their sockets (actor.ts #rateOf). */
export const OP_RATE = { perSec: 20, burst: 60 } as const;

/**
 * The op rate of one socket (design 10.4): 20 per second with a burst of 60
 * answers `busy` beyond, and a socket that stays over three times its limit
 * for 10 s is closed. The second rule counts every op message, including
 * duplicates and gaps, because those cost the server work too. Each method
 * reads the time it is given, the moment a queued op arrived at, and its own
 * clock when none is: a time before the last one read counts in the window
 * already open, never one gone.
 */
export class OpRate {
  #bucket: TokenBucket;
  #perSecond = 0;
  #second: number;
  #sustained: SustainedViolation;
  #abuseAt: number;
  #now: Clock;

  constructor(now: Clock = Date.now, opts: { perSec?: number; burst?: number; holdMs?: number } = {}) {
    const perSec = opts.perSec ?? OP_RATE.perSec;
    this.#bucket = new TokenBucket(perSec, opts.burst ?? OP_RATE.burst, now);
    this.#abuseAt = perSec * 3;
    this.#sustained = new SustainedViolation(opts.holdMs ?? 10_000, now);
    this.#now = now;
    this.#second = Math.floor(now() / 1000);
  }

  /** Counts one op message at `at`. True when the socket has been abusive for the hold time. */
  count(at = this.#now()): boolean {
    const second = Math.floor(at / 1000);
    if (second > this.#second) {
      this.#second = second;
      this.#perSecond = 0;
    }
    this.#perSecond++;
    if (this.#perSecond > this.#abuseAt) return this.#sustained.over(at);
    return false;
  }

  /** Whether this op may be processed at `at`, at `n` ops' cost: a builder's ask costs one for each op it reads. */
  allow(n = 1, at = this.#now()): boolean {
    return this.#bucket.take(n, at);
  }

  /** Whether `allow(n, at)` would say yes, without spending anything. */
  wouldAllow(n = 1, at = this.#now()): boolean {
    return this.#bucket.available(at) >= n;
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

/**
 * Socket caps (design 10.4): 8 per session, 64 per room, 16 per IP and 400
 * on the whole server, checked before the upgrade completes.
 */
export type SocketCaps = { perSession: number; perRoom: number; perIp: number; total: number };

export const DEFAULT_SOCKET_CAPS: SocketCaps = { perSession: 8, perRoom: 64, perIp: 16, total: 400 };

export type BudgetKey = { key: string; maxCount: number; maxBytes: number; maxWaiting: number };

export type SnapshotBudgetLimits = {
  windowMs: number;
  sessionCount: number;
  sessionBytes: number;
  ipCount: number;
  ipBytes: number;
  /** How long a session may keep making new requests while over budget before its sockets close. */
  abuseMs: number;
  /** How many delayed requests a session, and an address, may have waiting at once (SnapshotBudget.mayWait). */
  sessionWaiting: number;
  ipWaiting: number;
};

/** What a waiting request's due time decided (SnapshotBudget): it fits and spends then, or it waits again `delay` ms. */
export type DueOutcome = { at: number; kind: "fits"; sent: (bytes: number) => void } | { at: number; kind: "waits"; delay: number };

/**
 * A delayed snapshot request, which the budget holds from its arrival until
 * it fits at a due time or is dropped (SnapshotBudget.wait). `id` is its
 * room and the key its client goes by there, so a hello in that room finds
 * it whichever actor holds the room by then. `onDue` is told each due
 * time's outcome, and is null once nothing is owed to its socket.
 */
export type WaitingRequest = { readonly id: string; readonly keys: readonly BudgetKey[]; due: number; onDue: ((outcome: DueOutcome) => void) | null };

/** Where the budget reports a room that failed to take its request's due time (SnapshotBudget). */
export type BudgetLog = { warn(obj: object, msg: string): void };

/*
 * The byte budgets hold ten of the largest DM snapshot under the DM's own
 * limits a minute per session and twenty per session of a pinned room: 6
 * MiB since companion stat blocks ride on top of the 3 MiB for everything
 * else (docs/design/design-v1-companion-stat-blocks.md 3.4). Players' own
 * things sit outside those limits, so a room at the far line sends its DM
 * about 12.6 MiB (docs/design/design-v1-player-limits.md 8), so a DM
 * switching between scenes at their size line meets the session's budget
 * after about four snapshots a minute. An address counts requests alone.
 */
export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudgetLimits = {
  windowMs: 60_000,
  sessionCount: 20,
  sessionBytes: 60 * 1024 * 1024,
  ipCount: 40,
  ipBytes: 120 * 1024 * 1024,
  abuseMs: 30_000,
  sessionWaiting: 2 * DEFAULT_SOCKET_CAPS.perSession,
  ipWaiting: 2 * DEFAULT_SOCKET_CAPS.perIp,
};

type Spent = { at: number; bytes: number };

/**
 * A waiting request's place in the due heap: its due time and arrival order.
 * A request that was dropped or replaced since then leaves its place behind,
 * and the heap skips it when it comes to the top. A request that waits again
 * is placed again under its first arrival, so it keeps its turn among equal
 * due times.
 */
type DuePlace = { due: number; order: number; request: WaitingRequest };

/** Whether `a` comes due before `b`: the earlier due time, then the earlier arrival, as one scan of the requests in arrival order picks. */
function before(a: DuePlace, b: DuePlace): boolean {
  return a.due < b.due || (a.due === b.due && a.order < b.order);
}

function heapPush(heap: DuePlace[], place: DuePlace): void {
  let i = heap.push(place) - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!before(heap[i]!, heap[parent]!)) break;
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

function heapPop(heap: DuePlace[]): void {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let top = i;
    if (l < heap.length && before(heap[l]!, heap[top]!)) top = l;
    if (r < heap.length && before(heap[r]!, heap[top]!)) top = r;
    if (top === i) return;
    [heap[i], heap[top]] = [heap[top]!, heap[i]!];
    i = top;
  }
}

/**
 * The snapshot budget (design 10.4): every snapshot the server builds counts
 * against its session and its IP, the IP by count alone (keys). A request
 * over budget is delayed, never refused, until the oldest entries leave the
 * window. For a pinned room the IP part is counted per session, because its
 * whole table shares one IP.
 *
 * The 30 s abuse rule is tracked per session: a request that is delayed
 * starts the clock, a request that goes through stops it, and a delayed
 * request that is simply waiting never touches it.
 *
 * A session may have twice as many delayed requests waiting at once as it
 * may hold sockets, and an address likewise (DEFAULT_SOCKET_CAPS). Each
 * socket waits on at most one, from its own hello, and a client's new
 * hello in the same room takes the place of its old request, so only
 * requests left by sockets that are gone count past the sockets a session
 * holds: a new preview's, or one in another room. The budget holds each
 * request (WaitingRequest) from its arrival until it fits at a due time, or
 * until its client closes its socket or sends a newer hello in its room. A
 * socket the room closed and a room that unloaded leave it waiting as it
 * was. Its due timer is the budget's own, and every call that reads or
 * spends the budget first settles each request whose due time has passed,
 * in due order, so a timer that fires late changes nothing.
 */
export class SnapshotBudget {
  readonly limits: SnapshotBudgetLimits;
  #spent = new Map<string, Spent[]>();
  /** Sessions whose requests are being delayed: since when, and their latest request. */
  #overSince = new Map<string, { since: number; last: number }>();
  /** The delayed requests waiting, by id, and how many count against each key's bound. */
  #requests = new Map<string, WaitingRequest>();
  #waiting = new Map<string, number>();
  /**
   * The waiting requests by due time, so a call settles the k requests due by
   * then in O(k log n), not a scan of every request for each one. With many
   * sessions in a pinned room, n grows with the sessions.
   */
  #due: DuePlace[] = [];
  #arrivals = 0;
  #settling = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerAt = Number.POSITIVE_INFINITY;
  #now: Clock;
  #log: BudgetLog;
  #lastSweep: number;

  constructor(limits: Partial<SnapshotBudgetLimits> = {}, now: Clock = Date.now, log: BudgetLog = { warn: (obj, msg) => console.warn(msg, obj) }) {
    this.limits = { ...DEFAULT_SNAPSHOT_BUDGET, ...limits };
    this.#now = now;
    this.#log = log;
    this.#lastSweep = now();
  }

  /** Keys still held, for tests. */
  get size(): number {
    return this.#spent.size + this.#overSince.size + this.#waiting.size;
  }

  /** Delayed requests waiting, for tests. */
  get waiting(): number {
    return this.#requests.size;
  }

  /** Places in the due heap, those left behind included, for tests. */
  get places(): number {
    return this.#due.length;
  }

  /**
   * The keys a session's snapshot counts against. An address shared by
   * several sessions counts their requests and never their bytes, which
   * each session's own key counts. A pinned room's second key, one for
   * each session, counts both.
   */
  keys(sessionId: string, ip: string, pinned: boolean): BudgetKey[] {
    const l = this.limits;
    return [
      { key: `s:${sessionId}`, maxCount: l.sessionCount, maxBytes: l.sessionBytes, maxWaiting: l.sessionWaiting },
      pinned
        ? { key: `ps:${sessionId}`, maxCount: l.ipCount, maxBytes: l.ipBytes, maxWaiting: l.ipWaiting }
        : { key: `ip:${ip}`, maxCount: l.ipCount, maxBytes: Infinity, maxWaiting: l.ipWaiting },
    ];
  }

  /** Milliseconds from `now` until one more snapshot fits under every key, 0 when it fits then. */
  delay(keys: readonly BudgetKey[], now = this.#now()): number {
    this.#settle(now);
    return this.#delayAt(keys, now);
  }

  #delayAt(keys: readonly BudgetKey[], now: number): number {
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

  /** Spends one snapshot of `bytes` at `now`, kept in time order whatever order the rooms record in. */
  record(keys: readonly BudgetKey[], bytes: number, now = this.#now()): void {
    this.reserve(keys, now)(bytes);
  }

  /**
   * Spends one snapshot at `now` whose size is not known yet, kept in time
   * order as `record` keeps it: it counts from `now` at once, and its bytes
   * count once the function returned is called with them, as it is sent.
   */
  reserve(keys: readonly BudgetKey[], now = this.#now()): (bytes: number) => void {
    this.#settle(now);
    return this.#reserveAt(keys, now);
  }

  #reserveAt(keys: readonly BudgetKey[], now: number): (bytes: number) => void {
    this.#sweep(now);
    const spends: Spent[] = [];
    for (const k of keys) {
      this.#live(k.key, now);
      const list = this.#spent.get(k.key) ?? [];
      let at = list.length;
      while (at > 0 && list[at - 1]!.at > now) at--;
      const spent = { at: now, bytes: 0 };
      list.splice(at, 0, spent);
      this.#spent.set(k.key, list);
      spends.push(spent);
    }
    return (bytes) => {
      for (const spent of spends) spent.bytes = bytes;
    };
  }

  /** Whether one more delayed request may wait under every key at `now`, once those due by then are settled. */
  mayWait(keys: readonly BudgetKey[], now = this.#now()): boolean {
    this.#settle(now);
    return keys.every((k) => (this.#waiting.get(k.key) ?? 0) < k.maxWaiting);
  }

  /**
   * Holds a delayed request that arrived at `now` and comes due at `due`,
   * in place of any request with its id, and counts it against every key.
   */
  wait(id: string, keys: readonly BudgetKey[], due: number, now: number, onDue: WaitingRequest["onDue"] = null): WaitingRequest {
    this.drop(id, now);
    const request: WaitingRequest = { id, keys, due, onDue };
    this.#requests.set(id, request);
    heapPush(this.#due, { due, order: this.#arrivals++, request });
    for (const k of keys) bump(this.#waiting, k.key, 1);
    this.#arm(now);
    return request;
  }

  /**
   * Drops the request with this id at `now`, once those due by then are
   * settled: its client closed its socket or sent a newer hello. It never
   * comes due, and it counts no more.
   */
  drop(id: string, now: number): void {
    this.#settle(now);
    const held = this.#requests.get(id);
    if (!held) return;
    this.#forget(held);
  }

  #forget(request: WaitingRequest): void {
    this.#requests.delete(request.id);
    for (const k of request.keys) bump(this.#waiting, k.key, -1);
    // Places left behind are skipped at the top, and rebuilt away once they outnumber the requests, so the heap stays near n.
    if (this.#due.length > 2 * this.#requests.size + 16) {
      const live = this.#due.filter((place) => this.#holds(place));
      this.#due = [];
      for (const place of live) heapPush(this.#due, place);
    }
  }

  /** Whether `place` is still its request's place: the request still waits. Settling takes a place out before it places the request again. */
  #holds(place: DuePlace): boolean {
    return this.#requests.get(place.request.id) === place.request;
  }

  /** The earliest request still waiting, its places left behind dropped on the way. */
  #earliest(): DuePlace | null {
    while (this.#due.length > 0 && !this.#holds(this.#due[0]!)) heapPop(this.#due);
    return this.#due[0] ?? null;
  }

  /**
   * Each request due by `now`, earliest first, asks again as a request that
   * arrives at its due time. One that fits spends then and leaves, and one
   * that does not waits again, still counted. Its `onDue` hears which.
   */
  #settle(now: number): void {
    if (this.#settling) return;
    this.#settling = true;
    try {
      for (;;) {
        const place = this.#earliest();
        if (place === null || place.due > now) break;
        heapPop(this.#due);
        const next = place.request;
        const at = next.due;
        const delay = this.#delayAt(next.keys, at);
        let outcome: DueOutcome;
        if (delay > 0) {
          next.due = at + delay;
          heapPush(this.#due, { due: next.due, order: place.order, request: next });
          outcome = { at, kind: "waits", delay };
        } else {
          this.#forget(next);
          outcome = { at, kind: "fits", sent: this.#reserveAt(next.keys, at) };
        }
        try {
          next.onDue?.(outcome);
        } catch (err) {
          // One room that fails to take its request's due time stops neither the other requests nor the call that
          // settled them, which may be another room's.
          this.#log.warn({ err, roomId: next.id.slice(0, next.id.indexOf("|")) }, "a room failed to take a delayed snapshot's due time");
        }
      }
    } finally {
      this.#settling = false;
      this.#arm(now);
    }
  }

  /**
   * One timer for the earliest due time, set from `now`, and holding no
   * process open. A timer that fires late settles every request due by the
   * time it fires, each at its own due time, and sets the next from then.
   */
  #arm(now: number): void {
    const earliest = this.#earliest()?.due ?? Number.POSITIVE_INFINITY;
    if (earliest === this.#timerAt) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = earliest;
    if (earliest === Number.POSITIVE_INFINITY) return;
    const timer = setTimeout(() => {
      if (this.#timer === timer) {
        this.#timer = null;
        this.#timerAt = Number.POSITIVE_INFINITY;
      }
      this.#settle(Math.max(this.#now(), earliest));
    }, Math.max(0, earliest - now));
    timer.unref?.();
    this.#timer = timer;
  }

  /**
   * Notes a new request (a `hello` on a new socket or a `scene` message) and
   * whether the budget delayed it. True when the session has now been making
   * requests over budget for the whole abuse window.
   */
  request(sessionId: string, delayed: boolean, now = this.#now()): boolean {
    if (!delayed) {
      this.#overSince.delete(sessionId);
      return false;
    }
    this.#sweep(now);
    const over = this.#overSince.get(sessionId);
    if (over === undefined) {
      this.#overSince.set(sessionId, { since: now, last: now });
      return false;
    }
    over.last = Math.max(over.last, now);
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

  /**
   * The spends that count at `now`: those in the window before it, none
   * after it. Only spends a further window older are dropped, so a call
   * that reads a time a little earlier than another's still finds them.
   */
  #live(key: string, now: number): Spent[] {
    const list = this.#spent.get(key);
    if (!list) return [];
    const cutoff = now - this.limits.windowMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.at <= cutoff - this.limits.windowMs) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) {
      this.#spent.delete(key);
      return [];
    }
    return list.filter((s) => s.at > cutoff && s.at <= now);
  }
}

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

  /**
   * The number of distinct addresses holding a socket that `isThisComputer`
   * rejects: the other devices the desktop app's window counts, so the DM's
   * own tabs on that computer never count, whichever address they opened
   * (docs/design/design-v1-local-app.md 4, D-261113-095).
   */
  remoteDevices(isThisComputer: (ip: string) => boolean): number {
    let count = 0;
    for (const ip of this.#byIp.keys()) if (!isThisComputer(ip)) count++;
    return count;
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
