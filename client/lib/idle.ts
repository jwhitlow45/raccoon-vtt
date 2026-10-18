/**
 * Runs `cb` once the main thread is idle, and within `maxMs` whatever
 * happens. Safari and iOS Safari have no requestIdleCallback, so there it
 * is a short timer, which still lets the frame in progress paint first.
 * Returns a function that cancels the call if it has not run.
 */
export type IdleHost = {
  requestIdleCallback?: (cb: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/** The longest the fallback waits: long enough for the frame being drawn, short enough to be ready for a tap. */
const FALLBACK_MS = 50;

export function idle(cb: () => void, maxMs: number, host: IdleHost = globalThis as unknown as IdleHost): () => void {
  if (typeof host.requestIdleCallback === "function") {
    const id = host.requestIdleCallback(() => cb(), { timeout: maxMs });
    return () => host.cancelIdleCallback?.(id);
  }
  const id = host.setTimeout(cb, Math.min(FALLBACK_MS, maxMs));
  return () => host.clearTimeout(id);
}
