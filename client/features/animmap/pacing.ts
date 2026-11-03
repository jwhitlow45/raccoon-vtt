/**
 * When the board draws a video frame (docs/design/design-v1-animated-maps.md
 * 5.2, D-261102-450), as a gate with no clock of its own: every call carries
 * its times.
 *
 * Two clocks, named apart (AMT-2):
 * - With requestVideoFrameCallback, the gate reads each presented frame's
 *   media time. A frame draws when its media time is at least MIN_GAP_MS
 *   past the last drawn frame's, so 24, 25, 30 and up to about 31.5 fps
 *   draw every frame and 50 to 60 fps every second frame (AMT-1). A loop's
 *   wrap, where media time goes back, starts the gate afresh. Media time
 *   runs at wall speed at normal rate, so this is the pacing.
 * - In the requestAnimationFrame fallback, where frames cannot be counted,
 *   the gate reads wall time and draws when MIN_GAP_MS has passed.
 *
 * On both paths a wall-clock cap backs the gate: it keeps the last
 * CAP_DRAWS draw times and refuses a draw while the oldest is under CAP_MS
 * old. One vsync of slack under a strict second keeps it from skipping a
 * healthy 30 fps frame on a display running slightly fast (AMQ-1).
 */

/** 1/30 s less 2 ms: no two drawn frames closer than this, in the path's own clock. */
export const MIN_GAP_MS = 1000 / 30 - 2;
/** The cap: at most this many draws in any CAP_MS of wall time. */
export const CAP_DRAWS = 30;
export const CAP_MS = 950;

export class DrawGate {
  /** The media time of the last drawn frame, in ms, or null after a wrap or a reset. */
  #lastMedia: number | null = null;
  /** The wall time of the last draw, for the fallback. */
  #lastWall: number | null = null;
  /** The wall times of the last CAP_DRAWS draws, oldest first. */
  readonly #recent: number[] = [];

  /** Whether the cap lets a draw through at wall time `now`. */
  #capAllows(now: number): boolean {
    return this.#recent.length < CAP_DRAWS || now - this.#recent[0]! >= CAP_MS;
  }

  /**
   * A presented frame at media time `mediaMs`, its callback at wall time
   * `now`. True when it should draw. The caller then calls `drew` if it did.
   */
  frame(mediaMs: number, now: number): boolean {
    if (this.#lastMedia !== null && mediaMs < this.#lastMedia) this.#lastMedia = null;
    if (this.#lastMedia !== null && mediaMs - this.#lastMedia < MIN_GAP_MS) return false;
    return this.#capAllows(now);
  }

  /** A fallback frame at wall time `now`. True when it should draw. */
  tick(now: number): boolean {
    if (this.#lastWall !== null && now - this.#lastWall < MIN_GAP_MS) return false;
    return this.#capAllows(now);
  }

  /** A video draw happened at wall time `now`, of the frame at `mediaMs` where the path knows it. */
  drew(now: number, mediaMs: number | null): void {
    this.#lastWall = now;
    if (mediaMs !== null) this.#lastMedia = mediaMs;
    this.#recent.push(now);
    if (this.#recent.length > CAP_DRAWS) this.#recent.shift();
  }

  /** A new source, a seek or a resume: the next frame draws at once, if the cap allows. */
  reset(): void {
    this.#lastMedia = null;
    this.#lastWall = null;
  }
}
