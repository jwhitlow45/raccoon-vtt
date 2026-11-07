/**
 * The animated map's draws, counted for the weather's cost measure
 * (store.ts): a video draws on its own beat, up to every other frame all
 * session, so a frame where it drew is judged only against frames where it
 * drew too. A module of its own, so the map's board counts without loading
 * any of the weather.
 */

let draws = 0;

/** The map's board drew a video frame (animmap/board.ts). */
export function mapDrew(): void {
  draws++;
}

/** The map's draws so far on this page. */
export function mapDraws(): number {
  return draws;
}
