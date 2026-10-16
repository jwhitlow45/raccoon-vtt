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
 * focus went somewhere else meanwhile.
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
  const pressed = doc.activeElement;
  // Nothing had focus to lose.
  if (!scope || pressed === null || pressed === doc.body) return;
  const until = env.now() + HAND_OFF_WAIT_MS;
  const step = () => {
    if (!scope.isConnected) return;
    if (pressed.isConnected) {
      if (doc.activeElement === pressed && env.now() < until) env.schedule(step);
      return;
    }
    const active = doc.activeElement;
    if (active !== null && active !== doc.body) return;
    for (const selector of to) {
      const el = selector === ":scope" ? scope : scope.querySelector(selector);
      if (el) {
        el.focus();
        return;
      }
    }
  };
  env.schedule(step);
}
