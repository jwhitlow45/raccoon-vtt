import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type DoorCover, type Scene, type SceneId, type TerrainId } from "../model.ts";
import { markIn } from "./heights.ts";

/**
 * Automatic walls (docs/design/design-v1-maps-vision.md section 2.1): the one
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

/** How far along its line a new secret door looks for the wall it stands in (coverOfLine). */
export const COVER_REACH = 16;

/**
 * The cover a hidden secret door takes from its line when `build.edge` makes
 * it (docs/design/design-v1-maps-vision.md 2.1), read from the real build:
 * "auto" where the real cells already give the edge an automatic wall, else
 * "drawn" where the nearest wall along its line on either side is a drawn
 * one, past doors, windows and openings, within COVER_REACH edges, else
 * "auto". So a door in a drawn line looks drawn and one in an automatic line
 * looks automatic, whichever tool or page made it.
 */
export function coverOfLine(chunks: Readonly<Record<string, BuildChunk>>, sceneId: SceneId, rule: AutoWalls, key: string): DoorCover {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  const north = side === "n";
  const automatic = (ex: number, ey: number) =>
    autoWallBetween(rule, paintedAt(chunks, sceneId, ex, ey), north ? paintedAt(chunks, sceneId, ex, ey - 1) : paintedAt(chunks, sceneId, ex - 1, ey));
  if (automatic(x, y)) return "auto";
  for (const step of [-1, 1]) {
    for (let i = 1; i <= COVER_REACH; i++) {
      const ex = north ? x + step * i : x;
      const ey = north ? y : y + step * i;
      if (ex < 0 || ey < 0) break;
      const drawn = chunks[`${sceneId}:${Math.floor(ex / CHUNK_CELLS)},${Math.floor(ey / CHUNK_CELLS)}`]?.edges[`${ex},${ey},${side}`];
      if (drawn?.kind === "wall") return "drawn";
      if (drawn === undefined && automatic(ex, ey)) break;
    }
  }
  return "auto";
}
