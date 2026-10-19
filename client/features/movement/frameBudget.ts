import { SLICE_MS } from "./routeDrag.ts";

/**
 * The search time a frame gives (docs/design-v1-movement.md 5.2), shared by
 * the drag and every walking ruler on the board, so ten kept rulers still
 * searching take 4 ms a frame between them, not 4 ms each. The frame's
 * first asker opens it and the next frame opens a new one. Past it, each
 * search still goes its few states a call, so every ruler gets on.
 */
export function frameBudget(now: () => number, nextFrame: (run: () => void) => void, slice = SLICE_MS): () => number {
  let end: number | null = null;
  return () => {
    if (end === null) {
      end = now() + slice;
      nextFrame(() => {
        end = null;
      });
    }
    return end;
  };
}

/** The board's budget, by `performance.now` and `requestAnimationFrame`. */
export const frameDeadline = frameBudget(() => performance.now(), (run) => requestAnimationFrame(() => run()));
