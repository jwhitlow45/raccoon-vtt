/**
 * Waiting out the click that follows a tap.
 *
 * A browser follows a finger's tap with compatibility mouse events and a
 * click, after the pointer events, and sends them to whatever is under the
 * finger by then. Something a tap opens on pointerup, such as the stamp
 * picker's bottom sheet on a phone, is under the finger by then and takes
 * that click: a tile gets picked, or the dim behind the sheet closes it.
 * Opening once the click has gone by leaves nothing there for it to land
 * on. A mouse's click lands on the map, where the press was, so for a
 * mouse the wait costs only a moment.
 */

export type ClickWait = {
  /** Hears the next click anywhere on the page, before anything else does. Returns how to stop listening. */
  onNextClick(listener: () => void): () => void;
  /** Runs `fn` after `ms`. Returns how to call it off. */
  later(fn: () => void, ms: number): () => void;
};

export const browserClickWait: ClickWait = {
  onNextClick(listener) {
    const once = () => {
      stop();
      listener();
    };
    const stop = () => window.removeEventListener("click", once, true);
    window.addEventListener("click", once, true);
    return stop;
  },
  later(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * How long to wait for a click that may never come, as when the finger
 * moved too far for the browser to call it a tap. Longer than the 300 ms or
 * so a browser can hold a tap's click while it waits for a double tap.
 */
export const CLICK_WAIT_MS = 500;

/**
 * Runs `fn` once, just after the next click has been handled, or after
 * `fallbackMs` when no click comes. Returns how to call it off.
 */
export function afterTapClick(fn: () => void, wait: ClickWait = browserClickWait, fallbackMs = CLICK_WAIT_MS): () => void {
  let done = false;
  const stops: (() => void)[] = [];
  const stopAll = () => {
    for (const stop of stops.splice(0)) stop();
  };
  const run = () => {
    if (done) return;
    done = true;
    stopAll();
    fn();
  };
  stops.push(
    // The click's own handlers run first, then `fn` on the next turn, when the click has gone.
    wait.onNextClick(() => {
      stopAll();
      stops.push(wait.later(run, 0));
    }),
    wait.later(run, fallbackMs),
  );
  return () => {
    done = true;
    stopAll();
  };
}
