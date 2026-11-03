/**
 * The step-down (docs/design/design-v1-animated-maps.md 5.4, D-261102-450):
 * when a device falls behind a video, it shows the still until the page
 * reloads. A state machine with no clock of its own: every call carries its
 * wall time, as performance.now and requestVideoFrameCallback give it.
 *
 * After a warm-up from each start, resume, scene load and remount, it reads
 * windows of WINDOW_MS. The 500 ms around a loop's wrap is left out, and a
 * window holding a pause or a remount is dropped (`restart`). Two counts can
 * step it down, and neither reads the file's rate:
 *
 * - Decoder drops: the window's change in dropped frames over its change in
 *   total frames (getVideoPlaybackQuality), over a quarter. In a window
 *   shaped like a 30 Hz render cap (Chrome's Energy Saver: callbacks at 25
 *   to 35 a second, each rising by one), the frames the compositor skips
 *   show as drops, so only drops beyond (fps - 30) / fps count, fps being
 *   the decoder's own count. It is read one second at a time, so a
 *   variable-rate file's fast stretch is judged apart from its slow one.
 * - Late callbacks: a callback whose presentedFrames rose by LATE_STEP or
 *   more since the one before, so frames the compositor showed never
 *   reached the page. Over a quarter of a window's callbacks late steps
 *   down. The requestAnimationFrame fallback has no presentedFrames, so
 *   only the drops count there.
 */

export const WARMUP_MS = 2000;
export const WINDOW_MS = 10_000;
/** Half of the 500 ms left out around a wrap. */
export const WRAP_GUARD_MS = 250;
/** More than this share dropped, or late, steps down. */
export const SHARE = 0.25;
export const LATE_STEP = 3;
/** A window with fewer frames than this says too little to judge. */
export const MIN_FRAMES = 20;
/** Callbacks a second in a window shaped like a 30 Hz render cap. */
export const CAPPED_MIN = 25;
export const CAPPED_MAX = 35;
/** The render cap's rate. */
const CAPPED_RATE = 30;

/** One frame callback, or in the fallback one animation frame: its wall time and the element's counters then. */
export type FrameSample = {
  now: number;
  /** requestVideoFrameCallback's presentedFrames, or null in the fallback. */
  presentedFrames: number | null;
  /** getVideoPlaybackQuality's totalVideoFrames and droppedVideoFrames. */
  totalFrames: number;
  droppedFrames: number;
};

export type StepResult = "slowing" | "slowingOrSaving";

/** A sample in the open window, as its changes from the sample before. */
type Entry = { now: number; gap: number; late: boolean; total: number; dropped: number; presentedStep: number | null; excluded: boolean };

export class StepDown {
  #result: StepResult | null = null;
  #warmUntil: number;
  #windowAt: number | null = null;
  #entries: Entry[] = [];
  #prev: FrameSample | null = null;
  #excludeUntil = -Infinity;
  /** Windows judged, for tests. */
  judged = 0;

  constructor(now: number) {
    this.#warmUntil = now + WARMUP_MS;
  }

  /** Null while the video may play, else why it stepped down. It never goes back. */
  get result(): StepResult | null {
    return this.#result;
  }

  /** A start, a resume, a scene load or a remount: the warm-up begins again and the window so far is dropped. */
  restart(now: number): void {
    this.#warmUntil = now + WARMUP_MS;
    this.#windowAt = null;
    this.#entries = [];
    this.#prev = null;
  }

  /** A loop's wrap at `now`: the frames around it are left out. */
  wrap(now: number): void {
    for (const e of this.#entries) if (e.now >= now - WRAP_GUARD_MS) e.excluded = true;
    this.#excludeUntil = now + WRAP_GUARD_MS;
  }

  /** A frame callback, or a fallback frame. */
  sample(s: FrameSample): void {
    if (this.#result) return;
    const prev = this.#prev;
    this.#prev = s;
    if (s.now < this.#warmUntil || !prev) return;
    if (this.#windowAt === null) {
      this.#windowAt = prev.now;
      this.#entries = [];
    }
    const presentedStep = s.presentedFrames !== null && prev.presentedFrames !== null ? s.presentedFrames - prev.presentedFrames : null;
    this.#entries.push({
      now: s.now,
      gap: s.now - prev.now,
      late: presentedStep !== null && presentedStep >= LATE_STEP,
      // Counters that went back belong to a new source or a reload of it: nothing changed that the window can read.
      total: Math.max(0, s.totalFrames - prev.totalFrames),
      dropped: Math.max(0, s.droppedFrames - prev.droppedFrames),
      presentedStep,
      excluded: s.now < this.#excludeUntil,
    });
    if (s.now - this.#windowAt >= WINDOW_MS) {
      this.#judge();
      this.#windowAt = s.now;
      this.#entries = [];
    }
  }

  /**
   * Judges the window in one-second slices, so a variable-rate file whose
   * fast stretch plays under the render cap and whose slow one does not is
   * read slice by slice. A slice shaped like the cap expects the drops the
   * compositor makes there: the frames past 30 a second, which is
   * (fps - 30) / fps of them at the decoder's own rate.
   */
  #judge(): void {
    this.judged++;
    const kept = this.#entries.filter((e) => !e.excluded);
    if (kept.length < MIN_FRAMES) return;
    const fallback = kept.some((e) => e.presentedStep === null);
    const start = this.#windowAt ?? kept[0]!.now;
    const slices = new Map<number, Entry[]>();
    for (const e of kept) {
      const at = Math.floor((e.now - start) / 1000);
      const slice = slices.get(at);
      if (slice) slice.push(e);
      else slices.set(at, [e]);
    }
    let total = 0;
    let dropped = 0;
    let expected = 0;
    let capped = false;
    for (const slice of slices.values()) {
      const seconds = slice.reduce((sum, e) => sum + e.gap, 0) / 1000;
      const frames = slice.reduce((sum, e) => sum + e.total, 0);
      total += frames;
      dropped += slice.reduce((sum, e) => sum + e.dropped, 0);
      const rate = seconds > 0 ? slice.length / seconds : 0;
      if (rate >= CAPPED_MIN && rate <= CAPPED_MAX && (fallback || slice.every((e) => e.presentedStep === 1))) {
        capped = true;
        expected += Math.max(0, frames - CAPPED_RATE * seconds);
      }
    }
    if (total >= MIN_FRAMES && (dropped - expected) / total > SHARE) {
      this.#result = capped ? "slowingOrSaving" : "slowing";
      return;
    }
    if (!fallback && kept.filter((e) => e.late).length / kept.length > SHARE) this.#result = "slowing";
  }
}
