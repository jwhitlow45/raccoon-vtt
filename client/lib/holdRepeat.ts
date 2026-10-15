/**
 * A button that repeats while held, such as a stepper's − and +
 * (docs/design-v1-heights-readout.md section 5). The press steps at once,
 * then once 400 ms into the hold and every 80 ms after, so a 1.68 s hold
 * takes the height stepper from 10 ft to 100 ft. Every tap still steps
 * once, so nothing needs the hold. A plain state machine over injected
 * timers, so it is tested without a DOM.
 *
 * The press steps on pointerdown rather than on click, so the hold's first
 * step lands at once and the timer counts from the press. The click that
 * ends the press then steps no more, so each press is exactly one step
 * plus its repeats, whichever event drives it. A keyboard's click (Enter
 * or Space, whose `detail` is 0) always steps: Enter's key repeat repeats
 * it, and Space clicks once on its keyup.
 */

export const REPEAT_DELAY_MS = 400;
export const REPEAT_EVERY_MS = 80;

export type RepeatTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realTimers: RepeatTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export class HoldRepeat {
  /** Steps once. False when another step the same way would change nothing, at a limit, which ends the repeat. */
  readonly #step: () => boolean;
  /** A pointer press began or ended, so a stepper can keep its value's live announcement off meanwhile. */
  readonly #onHold: (holding: boolean) => void;
  readonly #timers: RepeatTimers;
  #timer: unknown = null;
  /** The last pointer press stepped, so the click that ends it adds none. */
  #pressed = false;
  #holding = false;

  constructor(options: { step: () => boolean; onHold?: (holding: boolean) => void; timers?: RepeatTimers }) {
    this.#step = options.step;
    this.#onHold = options.onHold ?? (() => {});
    this.#timers = options.timers ?? realTimers;
  }

  /** A pointer pressed the button. */
  press(): void {
    this.#stopTimer();
    this.#pressed = true;
    if (!this.#holding) {
      this.#holding = true;
      this.#onHold(true);
    }
    if (this.#step()) this.#arm(REPEAT_DELAY_MS);
  }

  /**
   * The press ended: lifted, cancelled, or slid off the button. The click
   * that may follow a lift on the button is still the press's own, and
   * `click` drops it. One that never comes (a press that slid off, or a
   * button disabled at its limit) leaves the mark until the next press.
   */
  release(): void {
    this.#stopTimer();
    if (!this.#holding) return;
    this.#holding = false;
    this.#onHold(false);
  }

  /** The button's click. `fromKeyboard` is a click with `detail` 0, from Enter or Space. */
  click(fromKeyboard: boolean): void {
    if (!fromKeyboard && this.#pressed) {
      this.#pressed = false;
      return;
    }
    this.#step();
  }

  get repeating(): boolean {
    return this.#timer !== null;
  }

  #arm(ms: number): void {
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      if (this.#step()) this.#arm(REPEAT_EVERY_MS);
    }, ms);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
