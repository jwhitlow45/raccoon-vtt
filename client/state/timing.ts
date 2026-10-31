/**
 * Time for the store and the socket, injected so the tests drive it with a
 * fake clock instead of waiting on real timers.
 */
export type Clock = {
  now(): number;
  /** Time no correction of the device's clock moves, as `performance.now()` is: only the difference between two readings means anything. */
  elapsed(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 5_000;
export const BACKOFF_JITTER = 0.3;

/**
 * The reconnect backoff (design section 7.5): 250 ms doubling per attempt up
 * to the cap, then spread by plus or minus 30% so a table of phones that
 * lost the same Wi-Fi do not all come back in the same millisecond. Op
 * retries (section 7.4) wait the same way.
 */
export function backoffDelay(attempt: number, random: () => number, capMs: number = BACKOFF_CAP_MS): number {
  const base = Math.min(capMs, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 30)));
  const spread = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(base * spread);
}

/** A timer slot that keeps one pending callback and forgets it once it fires. */
export class Timer {
  private handle: unknown = null;
  private readonly clock: Clock;
  /** When the pending callback is due, or null when nothing is pending. */
  due: number | null = null;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  get pending(): boolean {
    return this.handle !== null;
  }

  set(ms: number, fn: () => void): void {
    this.clear();
    this.due = this.clock.now() + ms;
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.due = null;
      fn();
    }, Math.max(0, ms));
  }

  clear(): void {
    if (this.handle !== null) this.clock.clearTimeout(this.handle);
    this.handle = null;
    this.due = null;
  }
}
