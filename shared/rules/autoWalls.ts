import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type Scene, type SceneId, type TerrainId } from "../model.ts";
import { markIn } from "./heights.ts";

/**
 * Automatic walls (docs/design-v1-maps-vision.md section 2.1): the one
 * predicate that decides whether an edge between two cells gets a wall
 * nobody drew. Wall derivation (rules/walls.ts) and the secret door
 * projection (project.ts) both ask it, so a hidden door never shows players
 * a gap that the walls do not have.
 *
 * A cell holds one terrain, so the overlay terrains replace the floor in
 * their cell rather than sitting on it. Wave 4 adds stair marks, which count
 * as a Stairs cell, an overlay, under every rule.
 */

export const FLOOR_TERRAINS: ReadonlySet<TerrainId> = new Set<TerrainId>(["stone", "wood", "grass", "dirt", "cave"]);

/** A cell as automatic walls see it. */
export type Painted = "empty" | "floor" | "overlay";

export function paintedOf(terrain: TerrainId | undefined): Painted {
  if (terrain === undefined) return "empty";
  return FLOOR_TERRAINS.has(terrain) ? "floor" : "overlay";
}

/**
 * What a cell counts as for automatic walls: a Stairs cell when it carries a
 * stair mark (any mark but "."), whatever its terrain, else its terrain.
 */
export function paintedCell(terrain: TerrainId | undefined, mark: string): Painted {
  return mark !== "." ? "overlay" : paintedOf(terrain);
}

/**
 * The one predicate for a cell of a scene's stored build, reading whichever
 * chunk holds it, so a caller looking across a chunk border reads the
 * neighbor's cells and marks. Wall derivation (walls.ts) gives the same
 * answer from its own parse of the chunks, and the secret-door projection
 * (project.ts) asks this.
 */
export function paintedAt(chunks: Readonly<Record<string, BuildChunk>>, sceneId: SceneId, x: number, y: number): Painted {
  if (x < 0 || y < 0) return "empty";
  const chunk = chunks[`${sceneId}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`];
  return chunk ? paintedCell(chunk.cells[`${x},${y}`], markIn(chunk, x, y)) : "empty";
}

/** A scene's rule. Absent reads as "all", the rule every scene from before wave 3 was built under. */
export function autoWallsOf(scene: Pick<Scene, "autoWalls"> | undefined): AutoWalls {
  return scene?.autoWalls ?? "all";
}

/**
 * Whether the edge between two cells carries an automatic wall. Under
 * "floor" only an edge between floor and an unpainted cell does, so the
 * edges that differ from "all" are exactly those between an overlay and an
 * unpainted cell.
 */
export function autoWallBetween(rule: AutoWalls, a: Painted, b: Painted): boolean {
  switch (rule) {
    case "all":
      return (a === "empty") !== (b === "empty");
    case "floor":
      return (a === "floor" && b === "empty") || (a === "empty" && b === "floor");
    case "off":
      return false;
  }
}
