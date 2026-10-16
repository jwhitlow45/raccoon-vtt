/**
 * Focus hand-off for a control a press takes away, such as Revive, which
 * goes once the creature is alive. A focused element removed from the page
 * leaves focus on the page itself, where a keyboard or screen reader user
 * loses their place, so once the control is gone, focus moves to the first
 * of `to` found in `scope`, a part of the page the press leaves in place.
 * `:scope` names the scope itself, such as the token bar's frame.
 *
 * The control may go at once, from a change the device predicts, or only
 * when the server answers, so the hand-off waits for it, a frame at a time,
 * up to `HAND_OFF_WAIT_MS`. It moves nothing when the control stays (a
 * refusal kept it), when it never had focus (a tap on a phone), or when
 * focus went somewhere else meanwhile. A caller that knows when the
 * control may have gone, such as when the op behind the press settles,
 * takes the same step itself with `handFocusNow`, with no limit.
 */

/** How long a hand-off waits for the pressed control to go: a slow server's answer. */
export const HAND_OFF_WAIT_MS = 10_000;

type Focusable = { focus(): void };
type El = Focusable & { isConnected: boolean; querySelector(selector: string): Focusable | null };
type Doc = { activeElement: { isConnected: boolean } | null; body: unknown };
export type HandOffEnv = { doc: Doc; schedule(run: () => void): void; now(): number };

const browser = (): HandOffEnv => ({
  doc: document as unknown as Doc,
  schedule: (run) => requestAnimationFrame(run),
  now: () => performance.now(),
});

export function handFocusOn(scope: El | null | undefined, to: readonly string[], env: HandOffEnv = browser()): void {
  const { doc } = env;
  const pressed = pressedControl(doc);
  if (!scope || pressed === null) return;
  const until = env.now() + HAND_OFF_WAIT_MS;
  const step = () => {
    if (pressed.isConnected) {
      if (scope.isConnected && doc.activeElement === pressed && env.now() < until) env.schedule(step);
      return;
    }
    handFocusNow(scope, pressed, to, doc);
  };
  env.schedule(step);
}

/** What has focus as a control is pressed, or null when nothing does and so nothing can be lost. */
export function pressedControl(doc: Doc = document as unknown as Doc): Doc["activeElement"] {
  const active = doc.activeElement;
  return active === null || active === doc.body ? null : active;
}

/**
 * The hand-off's one step, for a caller that knows when the control may
 * have gone, such as when the op behind the press settles, rather than
 * watching a frame at a time up to a limit: an offline op may wait far
 * longer. Once `pressed` is gone and focus fell to the page, focus moves
 * to the first of `to` found in `scope`, which it returns. Anything else
 * moves nothing and returns null.
 */
export function handFocusNow(scope: El | null | undefined, pressed: { isConnected: boolean } | null, to: readonly string[], doc: Doc = document as unknown as Doc): Focusable | null {
  if (!scope?.isConnected || pressed === null || pressed.isConnected) return null;
  const active = doc.activeElement;
  if (active !== null && active !== doc.body) return null;
  for (const selector of to) {
    const el = selector === ":scope" ? scope : scope.querySelector(selector);
    if (el) {
      el.focus();
      return el;
    }
  }
  return null;
}
