/**
 * Sliding-window counters for the hourly upload and import limits (design
 * section 10.3): 30 per session, 60 per IP and 120 per room, and for scene
 * thumbnails a budget of their own (service.ts).
 *
 * These live in memory rather than in rate_events. A restart forgets them,
 * which costs nothing here: the window is one hour, a deploy is rare, and
 * nobody outside can cause a restart. Each key keeps at most `limit`
 * timestamps, and empty keys are dropped on a sweep, so memory stays bounded
 * by the number of keys active in the last hour.
 */
export class WindowLimiter {
  readonly windowMs: number;
  #events = new Map<string, number[]>();
  #now: () => number;
  #lastSweep = 0;

  constructor(windowMs: number, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Seconds until every key has room for one more event, or 0 when all do.
   * Checking is separate from recording, so a request that is turned away
   * later (no free slot, say) does not spend the caller's budget.
   */
  retryAfter(checks: ReadonlyArray<{ key: string; limit: number }>): number {
    const now = this.#now();
    this.#sweep(now);
    let wait = 0;
    for (const { key, limit } of checks) {
      const times = this.#live(key, now);
      if (times.length >= limit) {
        const oldest = times[times.length - limit]!;
        wait = Math.max(wait, Math.ceil((oldest + this.windowMs - now) / 1000));
      }
    }
    return wait;
  }

  record(checks: ReadonlyArray<{ key: string; limit: number }>): void {
    const now = this.#now();
    for (const { key, limit } of checks) {
      const times = this.#live(key, now);
      times.push(now);
      if (times.length > limit) times.splice(0, times.length - limit);
      this.#events.set(key, times);
    }
  }

  #live(key: string, now: number): number[] {
    const times = this.#events.get(key);
    if (!times) return [];
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < times.length && times[drop]! <= cutoff) drop++;
    if (drop > 0) times.splice(0, drop);
    return times;
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    for (const key of [...this.#events.keys()]) {
      if (this.#live(key, now).length === 0) this.#events.delete(key);
    }
  }
}
