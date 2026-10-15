/**
 * Which map image the map layer draws while the map changes under a scene
 * (docs/design-v1-maps-vision.md section 3.4). A phase switch, or a new
 * image for the scene on screen, keeps the old image up until the new one
 * has decoded and then swaps, so the map never flashes to the bare
 * background. A different scene never inherits the last scene's image, and
 * an image that fails to load drops the old one too, so nobody keeps
 * looking at a map that is no longer the scene's.
 *
 * A plain function over the image hook's answer, so the rules run under
 * node's test runner. `I` is whatever the canvas draws from.
 */

export type MapRect = { x: number; y: number; width: number; height: number };

/** An image on screen, with the world rectangle it was placed at. */
export type ShownMap<I> = { sceneId: string; assetId: string; image: I; rect: MapRect };

export type MapSwapInput<I> = {
  sceneId: string;
  assetId: string;
  /** Where the current map goes, or null when its calibration cannot place it. */
  rect: MapRect | null;
  status: "loading" | "ready" | "failed";
  /** The current map's image once it is ready. */
  image: I | null;
};

export type MapSwap<I> = {
  /** What to draw now, if anything. */
  draw: ShownMap<I> | null;
  /** What to remember as the last image drawn, for the next change. */
  keep: ShownMap<I> | null;
  /** True while an older image of the same scene stands in for one still loading. */
  swapping: boolean;
};

export function mapSwap<I>(input: MapSwapInput<I>, kept: ShownMap<I> | null): MapSwap<I> {
  if (!input.rect || input.status === "failed") return { draw: null, keep: null, swapping: false };
  if (input.status === "ready" && input.image !== null) {
    const now: ShownMap<I> = { sceneId: input.sceneId, assetId: input.assetId, image: input.image, rect: input.rect };
    // The same image at the same place is the same value, so a caller that stores it settles.
    const same = kept !== null && sameShown(kept, now);
    return { draw: same ? kept : now, keep: same ? kept : now, swapping: false };
  }
  // Still loading. The old image keeps its own rectangle: it was calibrated
  // for its own pixels, and a phase's grid lands on the same cells.
  if (kept && kept.sceneId === input.sceneId) return { draw: kept, keep: kept, swapping: true };
  return { draw: null, keep: null, swapping: false };
}

export function sameShown<I>(a: ShownMap<I> | null, b: ShownMap<I> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sceneId === b.sceneId &&
    a.assetId === b.assetId &&
    a.image === b.image &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}
