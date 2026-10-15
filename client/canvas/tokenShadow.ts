import type { BuildChunk, SceneId } from "#shared/model.ts";
import type { PlacedToken } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { landedElevation } from "../features/movement/drop.ts";

/**
 * The depth cue under a token off the ground (docs/design-v1-maps-vision.md
 * section 4.4): a soft shadow that drifts down and to the right as the
 * token rises, and shrinks and fades. Only a token above the ground under it
 * casts one. A token standing on raised ground stands on it, so a platform
 * never looks like flight, and a token inside the ground casts none.
 */

/**
 * Where the shadow sits down and to the right of the token, in cells: from
 * SHADOW_MIN_OFFSET just off the ground to SHADOW_MAX_OFFSET at
 * SHADOW_FULL_LIFT_FT and above. The shadow is nearly the token's size, so
 * at a smaller offset it hid under the token's own disc, and a creature 5 or
 * 10 ft up showed no cue at all. The minimum leaves a thin dark rim past the
 * token's lower right, kept faint so a low flier does not look like a
 * high one.
 */
export const SHADOW_MIN_OFFSET = 0.2;
export const SHADOW_MAX_OFFSET = 0.6;
export const SHADOW_FULL_LIFT_FT = 30;
/** The share of the shadow's radius drawn at full darkness. It fades to nothing beyond. */
export const SHADOW_CORE = 0.6;

export type ShadowShape = {
  /** Down and to the right, in cells, already scaled to the footprint. */
  offset: number;
  /** The shadow's size against the footprint. */
  scale: number;
  /** Its darkness at the middle. */
  alpha: number;
};

/**
 * The shadow for a lift in feet, or null for a token that is not above the
 * ground. The offsets above are for a one-cell token. The shadow itself
 * scales with the footprint, so the offset scales with its shorter side
 * too, else a Large or bigger flier's rim shrank to a faint fringe under
 * its own disc. A footprint smaller than a cell keeps the one-cell offset,
 * so a Tiny flier's shadow still clears it.
 */
export function shadowShape(lift: number, footprint: { w: number; h: number } = { w: 1, h: 1 }): ShadowShape | null {
  if (!(lift > 0)) return null;
  const rise = Math.min(1, lift / SHADOW_FULL_LIFT_FT);
  const size = Math.max(1, Math.min(footprint.w, footprint.h));
  const offset = (SHADOW_MIN_OFFSET + (SHADOW_MAX_OFFSET - SHADOW_MIN_OFFSET) * rise) * size;
  return { offset, scale: 1 - 0.3 * rise, alpha: 0.75 - 0.3 * rise };
}

type Chunks = Readonly<Record<string, BuildChunk>>;
type Lifted = PlacedToken & { sceneId: SceneId; elevation: number };

/**
 * How far a token is above the ground under its footprint, in feet, 0 when
 * it is on or inside the ground. With `at`, where a drag would drop it,
 * the lift it would land with there, by the drop's own landing rule
 * (features/movement/drop.ts `landedElevation`, section 4.2), so the shadow
 * during a drag never disagrees with where the token lands.
 */
export function tokenLift(chunks: Chunks, token: Lifted, at?: { x: number; y: number }): number {
  if (!at || (at.x === token.x && at.y === token.y)) return Math.max(0, token.elevation - footprintGround(chunks, token));
  // A move without the squeeze flag clears it, so the landing is judged at full size, as the drop judges it.
  const there = footprintGround(chunks, { ...token, x: at.x, y: at.y, squeeze: undefined });
  return Math.max(0, landedElevation(chunks, token, at) - there);
}
