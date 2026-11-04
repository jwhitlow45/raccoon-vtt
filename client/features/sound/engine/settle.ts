/**
 * Starting an element on the timeline (docs/design/design-v1-music.md 5.3).
 * A voice is put at the timeline's place when it starts: a join, a resume,
 * a track, or a background sound's next pass. From then on its element
 * plays on by itself at speed 1, and nothing nudges or seeks it to follow
 * the timeline: on a weak connection every seek waits on the network again
 * and the music stutters, while devices need only start and stop within a
 * second or two of each other (D-261102-940). Each new track or pass starts
 * on the timeline again, so a device that fell behind catches up there.
 *
 * One check stays. A browser may drop a seek made before the file's header
 * has loaded, as iOS Safari has done, which would play a joined track from
 * its start. So the first check that finds a placed element playing seeks it
 * once if it is more than 2 s short of where it was put. One that is only
 * late, having waited on the network, plays on from there.
 */

/** Short of where it was put by more than this, an element's seek was dropped. */
export const DROPPED_SEEK_MS = 2_000;
/** A seek fades out and back in over this, so it never clicks. */
export const SEEK_FADE_MS = 80;
/** How often the check runs. */
export const CHECK_MS = 1_000;

/** One voice's placement, held until the first check that finds its element playing. */
export class Settle {
  #placedMs: number | null = null;

  /** The element was put `ms` into its file. */
  placed(ms: number): void {
    this.#placedMs = ms;
  }

  /** The first check that finds the element playing, at `elementMs`: true once, when its seek was dropped. */
  check(elementMs: number): boolean {
    const placed = this.#placedMs;
    this.#placedMs = null;
    return placed !== null && elementMs < placed - DROPPED_SEEK_MS;
  }
}
