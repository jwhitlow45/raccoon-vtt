import { stairMarkAt } from "#shared/heightCodec.ts";
import { LIMITS } from "#shared/limits.ts";
import type { RoomState, StairMark } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { cellKey, chunk, clipRect, parseCellKey, rectBetween, type Bounds, type Point } from "../cells.ts";
import type { HeightState, StairChoice } from "./store.ts";

/**
 * Turning Height mode's gestures into ops (docs/design-v1-maps-vision.md
 * section 4.2): `build.height` and `build.stairs`, at most 2,000 cells each.
 * Cells that already look the way the gesture leaves them are left out, so
 * a stroke back over painted ground sends nothing and adds no undo step.
 */

/** Paints cells to a height in feet, 0 clearing it. */
export function heightOps(sceneId: string, cells: readonly string[], height: number, ground: (x: number, y: number) => number): ClientOp[] {
  const changed = cells.filter((key) => {
    const c = parseCellKey(key);
    return ground(c.x, c.y) !== height;
  });
  return chunk(changed, LIMITS.heightCellsPerOp).map((part) => ({ t: "build.height", sceneId, cells: part, height }));
}

/** Marks cells as stairs pointing by the rule or one way, or takes their marks away. */
export function stairOps(sceneId: string, cells: readonly string[], choice: StairChoice, mark: (x: number, y: number) => StairMark): ClientOp[] {
  const want: StairMark = choice === "remove" ? "." : choice;
  const changed = cells.filter((key) => {
    const c = parseCellKey(key);
    return mark(c.x, c.y) !== want;
  });
  const up = choice === "remove" ? null : choice;
  return chunk(changed, LIMITS.heightCellsPerOp).map((part) => ({ t: "build.stairs", sceneId, cells: part, up }));
}

/** Every cell of the area between two points, both cells included, inside the scene, row by row. */
export function areaCells(a: Point, b: Point, bounds: Bounds): string[] {
  const r = clipRect(rectBetween(a, b), bounds);
  if (!r) return [];
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(cellKey(x, y));
  return out;
}

/** The ops for cells under Height mode's choices, read against the build in a view. */
export function paintCells(view: RoomState | null, sceneId: string, cells: readonly string[], choice: Pick<HeightState, "paint" | "height" | "stairs">): ClientOp[] {
  const chunks = view?.buildChunks ?? {};
  if (choice.paint === "height") return heightOps(sceneId, cells, choice.height, (x, y) => groundAt(chunks, sceneId, x, y));
  return stairOps(sceneId, cells, choice.stairs, (x, y) => stairMarkAt(chunks, sceneId, x, y));
}
