/**
 * Keeping an element on the timeline (docs/design/design-v1-music.md 5.3).
 * Once a second each voice compares where its element is with where it
 * should be: within 25 ms it plays at speed 1, from 25 to 60 ms 1.5% off,
 * from 60 to 150 ms 3% off, and past 150 ms, or after a stall, a resume, a
 * show or an interruption, it seeks with a short fade out and in. Only
 * these five fixed rates, since some browsers glitch on every change of a
 * free-running rate, and the pitch is not kept: a time-stretch clicks at
 * every change (context.ts poolElement). From 150 ms the error falls
 * under 25 ms within 6 seconds: 3 s at 3%, then 2.3 s at 1.5%.
 */

export const RATES = [1, 1.015, 0.985, 1.03, 0.97] as const;
export type Rate = (typeof RATES)[number];

/** Within this the element plays at speed 1. */
export const IN_STEP_MS = 25;
/** Up to this it plays 1.5% off, and past it 3% off. */
export const SLIGHT_MS = 60;
/** Past this it seeks. */
export const SEEK_PAST_MS = 150;
/** Two seeks are never closer than this, so one that has not settled yet is not chased. */
export const SEEK_GAP_MS = 1_000;
/** A seek fades out and back in over this, so it never clicks. */
export const SEEK_FADE_MS = 80;
/** How often the check runs, and a check this much later than its time means the page stalled. */
export const CHECK_MS = 1_000;
export const STALLED_MS = 1_500;

export type DriftAction = { kind: "rate"; rate: Rate } | { kind: "seek" };

/** The rate for an error in ms, the element's place less its aim: positive is ahead, so it slows. */
export function rateFor(errorMs: number): Rate {
  const off = Math.abs(errorMs);
  if (off <= IN_STEP_MS) return 1;
  if (off <= SLIGHT_MS) return errorMs > 0 ? 0.985 : 1.015;
  return errorMs > 0 ? 0.97 : 1.03;
}

/** One voice's drift: its rate, and when it last sought. */
export class Drift {
  #rate: Rate = 1;
  #lastSeek = -Infinity;
  #forced = false;

  get rate(): Rate {
    return this.#rate;
  }

  /** A stall, a resume, a show or an interruption: the next check seeks if the element is out of step at all. */
  force(): void {
    this.#forced = true;
  }

  /** A seek that did not come from a check, such as a voice placed afresh, counts against the gap too. */
  sought(now: number): void {
    this.#lastSeek = now;
    this.#forced = false;
    this.#rate = 1;
  }

  /** The check at `now` (ms, any monotonic clock), for an element at `elementMs` that should be at `aimMs`. */
  check(now: number, elementMs: number, aimMs: number): DriftAction {
    const error = elementMs - aimMs;
    const off = Math.abs(error);
    const wantsSeek = off > SEEK_PAST_MS || (this.#forced && off > IN_STEP_MS);
    if (wantsSeek && now - this.#lastSeek >= SEEK_GAP_MS) {
      this.sought(now);
      return { kind: "seek" };
    }
    // A forced seek that must wait for the gap keeps waiting for the next check, and in step it is done.
    if (off <= IN_STEP_MS) this.#forced = false;
    this.#rate = rateFor(error);
    return { kind: "rate", rate: this.#rate };
  }
}
