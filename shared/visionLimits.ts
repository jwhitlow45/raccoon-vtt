import { LIMITS, type LimitCheck } from "./limits.ts";
import type { RoomState, SceneId } from "./model.ts";
import { SIGHT_POTENTIAL } from "./rules/segments.ts";
import { sceneWalls } from "./rules/walls.ts";

/**
 * The cap on a vision scene's potential sight pieces (docs/design-v1-maps-vision.md
 * 2.1 and 2.4): every piece of the split wall set that would block sight
 * if every door were closed and every secret door hidden, and every raised
 * edge whatever its height. Counted whatever the doors' states, so only a
 * build op or turning vision on can raise it, and a player closing a door
 * never gets `quota`. It lives apart from shared/limits.ts because it
 * derives the walls, which import the limits.
 */
type Walls = Pick<RoomState, "scenes" | "buildChunks">;

/** How many pieces of the scene's split wall set could block sight. */
export function sightPieces(state: Walls, sceneId: SceneId): number {
  const scene = state.scenes[sceneId];
  if (!scene) return 0;
  return sceneWalls(scene, state.buildChunks).segmentsWith(SIGHT_POTENTIAL).length / 4;
}

/** The refusal, with the count, so the DM knows how far over the scene is. */
export function tooManySightPieces(count: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `This scene has ${n(count)} wall pieces, more than vision can handle (${n(LIMITS.sightPiecesPerScene)}).`;
}

/**
 * The check on the state an op would produce. A scene without vision has
 * no cap. Over the cap, only an op that turned vision on or raised the
 * count is refused, so a scene already over it, such as one a lowered cap
 * left behind, still takes every other edit. Without `before`, as for a
 * room import, the cap is absolute.
 */
export function sightPiecesCheck(state: Walls, sceneId: SceneId, before?: Walls): LimitCheck {
  if (state.scenes[sceneId]?.vision?.on !== true) return { ok: true };
  const count = sightPieces(state, sceneId);
  if (count <= LIMITS.sightPiecesPerScene) return { ok: true };
  const was = before?.scenes[sceneId];
  if (before && was?.vision?.on === true && sightPieces(before, sceneId) >= count) return { ok: true };
  return { ok: false, code: "quota", message: tooManySightPieces(count) };
}
