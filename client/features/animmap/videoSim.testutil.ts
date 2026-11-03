/**
 * A browser's compositor playing a looping video, for the step-down's and
 * the board's random tests: the frames a file holds, the display's
 * rendering frames, and what requestVideoFrameCallback and
 * getVideoPlaybackQuality report at each. Media time runs at wall speed,
 * as it does at normal rate.
 *
 * - Each rendering frame shows the latest frame whose time has come. A
 *   frame passed over between two rendering frames counts as dropped, as
 *   Chrome counts what the compositor skips under a 30 Hz render cap.
 * - presentedFrames rises by one for each frame shown.
 * - A struggling device drops frames in the decoder, and misses callbacks
 *   while its main thread is blocked, so the next one sees presentedFrames
 *   jump.
 */

/** A file's frame rate over stretches of its loop, such as 12 s at 60 fps then 18 s at 10 fps. */
export type Content = readonly { fps: number; ms: number }[];

/** Each frame's media time in ms over one loop, and the loop's length. */
export function framesOf(content: Content): { pts: number[]; durationMs: number } {
  const pts: number[] = [];
  let at = 0;
  for (const stretch of content) {
    const step = 1000 / stretch.fps;
    for (let t = 0; t < stretch.ms - 1e-9; t += step) pts.push(at + t);
    at += stretch.ms;
  }
  return { pts, durationMs: at };
}

export type Display = {
  hz: number;
  /** Chrome's Energy Saver renders at 30 whatever the display. */
  capped?: boolean;
};

/** The wall times of a display's rendering frames from `from` to `to`. */
export function renderTimes(display: Display, from: number, to: number): number[] {
  const vsync = 1000 / display.hz;
  const every = display.capped ? Math.max(1, Math.round(display.hz / 30)) : 1;
  const out: number[] = [];
  const first = Math.ceil(from / vsync);
  for (let k = first; k * vsync < to; k++) if (k % every === 0) out.push(k * vsync);
  return out;
}

export type Struggle = {
  /** The share of frames the decoder drops. */
  dropShare: number;
  /** The chance, at each shown frame, that the main thread blocks for the next 2 to 4 callbacks. */
  blockChance: number;
};

export const HEALTHY: Struggle = { dropShare: 0, blockChance: 0 };

export type Callback = {
  now: number;
  /** The shown frame's media time, in ms, within the loop. */
  mediaMs: number;
  presentedFrames: number;
  totalFrames: number;
  droppedFrames: number;
  /** The loop wrapped since the last callback. */
  wrapped: boolean;
};

/** A video playing from media time 0 at wall time `start`, rendered on `display`. */
export class Compositor {
  readonly pts: number[];
  readonly durationMs: number;
  readonly display: Display;
  /** How the device copes now: a test may change it mid-run. */
  struggle: Struggle;
  readonly #r: () => number;
  #start: number;
  /** The index of the shown frame in the endless sequence of loops, or -1 before the first. */
  #shown = -1;
  presentedFrames = 0;
  totalFrames = 0;
  droppedFrames = 0;
  #blocked = 0;
  #wrapped = false;

  constructor(content: Content, display: Display, r: () => number, struggle: Struggle = HEALTHY, start = 0) {
    const { pts, durationMs } = framesOf(content);
    this.pts = pts;
    this.durationMs = durationMs;
    this.display = display;
    this.struggle = struggle;
    this.#r = r;
    this.#start = start;
  }

  /** The media time, in ms within the loop, at wall time `now`. */
  mediaAt(now: number): number {
    return (now - this.#start) % this.durationMs;
  }

  /** The time played since the start, in ms, loops included, at wall time `now`. */
  playedAt(now: number): number {
    return now - this.#start;
  }

  /** Plays on from `playedMs` at `now`, as a resume after a pause does from where it stood. */
  resumeAt(now: number, playedMs: number): void {
    this.#start = now - playedMs;
  }

  /** The frame index in the endless sequence at wall time `now`. */
  #indexAt(now: number): number {
    const elapsed = now - this.#start;
    const loop = Math.floor(elapsed / this.durationMs);
    const within = elapsed - loop * this.durationMs;
    let lo = 0;
    let hi = this.pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pts[mid]! <= within + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return loop * this.pts.length + lo;
  }

  /**
   * A rendering frame at `now`: the callback the page gets, or null when no
   * new frame showed or the main thread missed it. Each frame whose time
   * came since the last shown one may be dropped by a struggling decoder,
   * and the compositor shows the latest one it has.
   */
  render(now: number): Callback | null {
    const index = this.#indexAt(now);
    if (index <= this.#shown) return null;
    const from = this.#shown < 0 ? index : this.#shown + 1;
    let show = -1;
    for (let i = index; i >= from; i--) {
      if (this.struggle.dropShare > 0 && this.#r() < this.struggle.dropShare) continue;
      show = i;
      break;
    }
    const arrived = index - from + 1;
    this.totalFrames += arrived;
    if (this.#shown >= 0 && Math.floor(index / this.pts.length) > Math.floor(this.#shown / this.pts.length)) this.#wrapped = true;
    if (show < 0) {
      // Every frame since the last shown one was dropped: nothing new shows.
      this.droppedFrames += arrived;
      this.#shown = index;
      return null;
    }
    this.droppedFrames += arrived - 1;
    this.#shown = index;
    this.presentedFrames++;
    if (this.#blocked > 0) {
      this.#blocked--;
      return null;
    }
    if (this.struggle.blockChance > 0 && this.#r() < this.struggle.blockChance) this.#blocked = 2 + Math.floor(this.#r() * 3);
    const wrapped = this.#wrapped;
    this.#wrapped = false;
    return { now, mediaMs: this.pts[show % this.pts.length]!, presentedFrames: this.presentedFrames, totalFrames: this.totalFrames, droppedFrames: this.droppedFrames, wrapped };
  }
}

/** The most draws in any window of `windowMs`, over sorted times. */
export function mostInWindow(times: readonly number[], windowMs = 1000): number {
  let most = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi]! - times[lo]! >= windowMs) lo++;
    most = Math.max(most, hi - lo + 1);
  }
  return most;
}
