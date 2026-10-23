import { WorkBudget } from "#shared/rules/walk.ts";
import { RouteWork, SLICE_MS, type Frames } from "./routeWork.ts";

/** The board's frames: `performance.now` and `requestAnimationFrame`. */
const BROWSER_FRAMES: Frames = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * A frame's budget: SLICE_MS of work, and no more units than the page's
 * `rvttRouteUnitsPerFrame` where a run sets it. The cap is a test hook:
 * e2e/vision.e2e.ts sets it so a walk's search spans frames on any
 * machine, where a time budget alone lets a fast one finish a search in
 * the frame it starts (review LP2L2-E2E-CPU). Nothing in the app sets it.
 */
function frameBudget(): WorkBudget {
  const cap = (globalThis as { rvttRouteUnitsPerFrame?: unknown }).rvttRouteUnitsPerFrame;
  return new WorkBudget({ ms: SLICE_MS, clock: () => performance.now(), ...(typeof cap === "number" && cap > 0 ? { limit: cap } : {}) });
}

/** The board's route work (routeWork.ts), one for every drag, ruler and press on it. */
export const BOARD_WORK = new RouteWork(BROWSER_FRAMES, frameBudget);
