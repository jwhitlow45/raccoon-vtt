import type { BuildChunk, RoomState, Scene } from "#shared/model.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { groundAt } from "#shared/rules/heights.ts";

/**
 * The ground a viewer may read (docs/design-v1-heights-readout.md section
 * 1). Every viewer of a scene holds the same heights in its chunks, under
 * the fog or not, since they are map data. What differs is the screen: the
 * fog hides the ground, and the app never says what the fog hides, even
 * from data the client holds, as a door under the fog cannot be tapped or
 * named (features/doors/doors.ts doorSeen). So the height readout and a
 * ruler stop both read the ground through `seenGround`. Pure, so the rule
 * is tested without a canvas.
 */

export type Cell = { x: number; y: number };

export type GroundSource = {
  chunks: Readonly<Record<string, BuildChunk>>;
  sceneId: string;
  bounds: { w: number; h: number };
  /** The merged fog a player's view holds on a scene with fog on, or null where the viewer sees all the ground: the DM, or a scene without fog. */
  fog: RoomState["fogTiles"] | null;
};

/**
 * A cell's ground in feet as this viewer may read it, or null when it is
 * outside the scene or the viewer's fog fully covers it. A cell with any
 * part revealed counts as seen, as doors count it, and so does ground the
 * party explored, which the merged fog shows.
 */
export function seenGround(src: GroundSource, cell: Cell): number | null {
  // A height left outside a shrunk scene raises nothing (walls.ts reliefOfGrid), so it reads as no ground at all.
  if (cell.x < 0 || cell.y < 0 || cell.x >= src.bounds.w || cell.y >= src.bounds.h) return null;
  if (src.fog && isCellFullyFogged(src.fog, src.sceneId, cell)) return null;
  return groundAt(src.chunks, src.sceneId, cell.x, cell.y);
}

/** What `seenGround` reads from this viewer's own view: a player is held to the fog on a scene with fog on, as a door tap is (features/doors/tap.ts). */
export function groundSource(
  view: Pick<RoomState, "buildChunks" | "fogTiles">,
  scene: Pick<Scene, "id" | "bounds" | "fogEnabled">,
  role: "dm" | "player",
): GroundSource {
  const fogged = role === "player" && scene.fogEnabled !== false;
  return { chunks: view.buildChunks, sceneId: scene.id, bounds: scene.bounds, fog: fogged ? view.fogTiles : null };
}
