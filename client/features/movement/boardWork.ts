import { RouteWork, type Frames } from "./routeWork.ts";

/** The board's frames: `performance.now` and `requestAnimationFrame`. */
const BROWSER_FRAMES: Frames = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** The board's route work (routeWork.ts), one for every drag, ruler and press on it. */
export const BOARD_WORK = new RouteWork(BROWSER_FRAMES);
