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
 *
 * Stepping on pointerdown has one cost: a scroll that starts on the button
 * has stepped before the browser takes the gesture and cancels the press.
 * So a press cancelled before its first repeat puts the value back (`cancel`).
 */

export const REPEAT_DELAY_MS = 400;
export const REPEAT_EVERY_MS = 80;
/**
 * How long after a press ends its own click may still arrive. A touch's
 * click can come a moment after its lift, so the mark that drops it waits
 * this long. A click after that, which no press began (one from assistive
 * technology, say), steps.
 */
export const CLICK_WINDOW_MS = 1_000;

export type RepeatTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realTimers: RepeatTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** The value the button steps, read and written directly, so a cancelled press can put it back. */
export type RepeatValue = { read(): number; write(value: number): void };

export class HoldRepeat {
  /** Steps once. False when another step the same way would change nothing, at a limit, which ends the hold. */
  readonly #step: () => boolean;
  /**
   * Whether the button stands at its limit, where it is `aria-disabled`
   * rather than disabled, so it keeps the keyboard's focus. There a press
   * and a click do nothing, so a held Enter stops at the limit.
   */
  readonly #atLimit: () => boolean;
  /** A pointer press began or ended, so a stepper can keep its value's live announcement off meanwhile. */
  readonly #onHold: (holding: boolean) => void;
  readonly #value: RepeatValue | null;
  readonly #timers: RepeatTimers;
  #timer: unknown = null;
  /** The press under way: how many repeats it made, and the value before and after its own step. */
  #press: { repeats: number; before: number | null; after: number | null } | null = null;
  /** The last pointer press stepped, so the click that ends it adds none. */
  #pressed = false;
  #pressedTimer: unknown = null;
  #holding = false;

  constructor(options: { step: () => boolean; atLimit?: () => boolean; onHold?: (holding: boolean) => void; value?: RepeatValue; timers?: RepeatTimers }) {
    this.#step = options.step;
    this.#atLimit = options.atLimit ?? (() => false);
    this.#onHold = options.onHold ?? (() => {});
    this.#value = options.value ?? null;
    this.#timers = options.timers ?? realTimers;
  }

  /** A pointer pressed the button. */
  press(): void {
    if (this.#atLimit()) return;
    this.#stopTimer();
    this.#clearPressedTimer();
    this.#pressed = true;
    if (!this.#holding) {
      this.#holding = true;
      this.#onHold(true);
    }
    const before = this.#value?.read() ?? null;
    const more = this.#step();
    this.#press = { repeats: 0, before, after: this.#value?.read() ?? null };
    if (more) this.#arm(REPEAT_DELAY_MS);
    else this.#endHold();
  }

  /**
   * The finger slid off the button: the repeat stops, but the press is not
   * over until the pointer lifts or the browser cancels it, which `cancel`
   * still answers, since a scroll can carry the finger off first.
   */
  stop(): void {
    this.#stopTimer();
    this.#endHold();
  }

  /** The press ended with a lift. */
  release(): void {
    this.stop();
    this.#press = null;
    this.#forgetPressLater();
  }

  /**
   * The browser cancelled the press, which it does when a scroll starts on
   * the button. Before the first repeat the press was no hold, so its step
   * is taken back, unless something else changed the value since. After
   * that the person meant to hold, and the steps stay.
   */
  cancel(): void {
    const press = this.#press;
    // A cancelled press has no click to follow it in a browser, but the mark waits out its window anyway: a click that did
    // come would step the value straight back.
    this.release();
    const value = this.#value;
    if (!press || press.repeats > 0 || !value || press.before === null || press.after === null) return;
    if (press.after !== press.before && value.read() === press.after) value.write(press.before);
  }

  /** The button's click. `fromKeyboard` is a click with `detail` 0, from Enter or Space. */
  click(fromKeyboard: boolean): void {
    if (!fromKeyboard && this.#pressed) {
      this.#pressed = false;
      this.#clearPressedTimer();
      return;
    }
    if (this.#atLimit()) return;
    this.#step();
  }

  get repeating(): boolean {
    return this.#timer !== null;
  }

  get holding(): boolean {
    return this.#holding;
  }

  #arm(ms: number): void {
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      if (this.#press) this.#press.repeats++;
      if (this.#step()) this.#arm(REPEAT_EVERY_MS);
      else this.#endHold();
    }, ms);
  }

  /**
   * The hold is over: the live announcement comes back on. At a limit this
   * comes at once rather than on the lift, since a button that changes
   * state there may never hear its lift (iPhone Safari sends a disabled
   * button no pointer events), and a lost lift must never leave the stepper
   * quiet.
   */
  #endHold(): void {
    if (!this.#holding) return;
    this.#holding = false;
    this.#onHold(false);
  }

  #forgetPressLater(): void {
    this.#clearPressedTimer();
    if (!this.#pressed) return;
    this.#pressedTimer = this.#timers.setTimeout(() => {
      this.#pressedTimer = null;
      this.#pressed = false;
    }, CLICK_WINDOW_MS);
  }

  #clearPressedTimer(): void {
    if (this.#pressedTimer === null) return;
    this.#timers.clearTimeout(this.#pressedTimer);
    this.#pressedTimer = null;
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
