import { chunkKey, wallChunk } from "../keys.ts";
import type { FreeWall, GridShape, RoomState, Token, WallFeature } from "../model.ts";
import { room, scene, token } from "../testutil.ts";
import { placedOnHex } from "./footprint.ts";
import { gridOfShape } from "./grid.ts";
import { cornerAt, hexCorners, hexNeighbors, sceneHexes, type Hex, type HexGrid } from "./hex.ts";

/**
 * Hex scenes with free walls along hex sides, for the movement tests on
 * hexes (docs/design-v1-hex-grids.md HX-D8): a wall on the side a hex
 * shares with its neighbor in direction `d`, and walls round a set of
 * solid hexes, so a test lays out rooms and corridors by hexes.
 */

let ids = 0;

/** A free wall of `f` between two corners, by its ends in cells. */
export function freeWall(a: { x: number; y: number }, b: { x: number; y: number }, f: WallFeature = { kind: "wall" }): FreeWall {
  return { id: `h${String(ids++).padStart(11, "0")}`, a: [a.x, a.y], b: [b.x, b.y], f };
}

/** The wall on the side hex `h` shares with its neighbor in direction `d` (hex.ts hexNeighbors' order). */
export function sideWall(g: HexGrid, h: Hex, d: number, f: WallFeature = { kind: "wall" }): FreeWall {
  const corners = hexCorners(g, h);
  // The corners run clockwise from the hex's first point, and the side toward direction d lies between corners d + 1 and d + 2.
  return freeWall(cornerAt(g, corners[(d + 1) % 6]!), cornerAt(g, corners[(d + 2) % 6]!), f);
}

/** Every side between a solid hex and one that is not, as walls: the solid hexes are rock nothing walks into. */
export function wallsRound(g: HexGrid, bounds: { w: number; h: number }, solid: (h: Hex) => boolean): FreeWall[] {
  const out: FreeWall[] = [];
  for (const h of sceneHexes(g, bounds)) {
    if (!solid(h)) continue;
    hexNeighbors(g, h).forEach((n, d) => {
      if (!solid(n)) out.push(sideWall(g, h, d));
    });
  }
  return out;
}

/** A hex scene `s1` of `w` by `h` cells on `shape`, its moves stopped by walls, with these walls in its chunks. */
export function hexWallRoom(shape: GridShape, w: number, h: number, walls: readonly FreeWall[]): RoomState {
  const s = room({ scenes: { s1: scene("s1", { gridShape: shape, bounds: { w, h }, blockMovement: true }) } });
  for (const wall of walls) {
    const { cx, cy } = wallChunk(wall);
    const key = chunkKey("s1", cx, cy);
    const chunk = s.buildChunks[key] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
    s.buildChunks[key] = { ...chunk, walls: [...(chunk.walls ?? []), wall] };
  }
  return s;
}

/** A creature placed so its reference hex is `ref` (footprint.ts placedOnHex). */
export function onHex(g: HexGrid, id: string, size: Token["size"], ref: Hex, extra: Partial<Token> = {}): Token {
  const base = token(id, { sceneId: "s1", size, x: 0, y: 0, ...extra });
  return { ...base, ...placedOnHex(g, base, ref) };
}

export const ROWS = gridOfShape("hexRows") as HexGrid;
export const COLUMNS = gridOfShape("hexColumns") as HexGrid;
