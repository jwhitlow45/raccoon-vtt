import { cellOf, chunkKey, wallMidpoint } from "#shared/keys.ts";
import { CHUNK_CELLS, type EdgeFeature, type Label, type RoomState, type TerrainId } from "#shared/model.ts";
import { chunkHeights, chunkMarks } from "#shared/rules/heights.ts";
import { boxTouchesCell, labelBox, type MeasureText } from "#shared/rules/labels.ts";
import type { Point } from "./cells.ts";

/**
 * Reading the build in a view, for the builder's gestures. Plain functions
 * over the room state, so they are tested without a canvas.
 */

function parseCell(key: string): Point {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

function chunkOf(view: RoomState | null, sceneId: string, key: string) {
  const c = parseCell(key);
  return view?.buildChunks[chunkKey(sceneId, Math.floor(c.x / CHUNK_CELLS), Math.floor(c.y / CHUNK_CELLS))];
}

export function terrainAt(view: RoomState | null, sceneId: string, key: string): TerrainId | undefined {
  return chunkOf(view, sceneId, key)?.cells[key];
}

export function edgeAt(view: RoomState | null, sceneId: string, key: string): EdgeFeature | undefined {
  return chunkOf(view, sceneId, key)?.edges[key];
}

/**
 * The label drawn under a point, or null. Only the label's own box counts,
 * widened by `slop` cells for a finger, so a tap beside a label places a new
 * one instead of picking the old. The label drawn last wins, as it is on top.
 */
export function labelAt(view: RoomState | null, sceneId: string, p: Point, opts: { measure?: MeasureText; slop?: number } = {}): Label | null {
  const slop = opts.slop ?? 0;
  let hit: Label | null = null;
  for (const label of Object.values(view?.labels ?? {})) {
    if (!label || label.sceneId !== sceneId) continue;
    const b = labelBox(label, opts.measure);
    if (p.x >= b.x0 - slop && p.x <= b.x1 + slop && p.y >= b.y0 - slop && p.y <= b.y1 + slop) hit = label;
  }
  return hit;
}

/**
 * Whether erasing a cell would take something besides its floor, as the
 * reducer erases it: an edge feature on any of its sides, a label whose
 * text covers part of it, a free wall whose midpoint lies in it, a stamp
 * or light whose center does, or a height or stair mark painted on it
 * (docs/design-v1-maps-vision.md sections 2.2, 3.5, 3.6 and 4.2). An edge on
 * the scene's east or south border stays when the cell beside it is erased,
 * so it does not count.
 */
export function erasable(view: RoomState | null, sceneId: string): (key: string) => boolean {
  // The reducer's estimate, not the canvas measure, so the preview takes exactly what the erase will.
  const boxes = Object.values(view?.labels ?? {}).flatMap((label) => (label && label.sceneId === sceneId ? [labelBox(label)] : []));
  const bounds = view?.scenes[sceneId]?.bounds;
  const centers = new Set<string>();
  for (const chunk of Object.values(view?.buildChunks ?? {})) {
    if (chunk?.sceneId !== sceneId) continue;
    for (const wall of chunk.walls ?? []) centers.add(cellOf(...wallMidpoint(wall)));
    const heights = chunkHeights(chunk);
    const marks = chunkMarks(chunk);
    if (!heights && !marks) continue;
    for (let k = 0; k < CHUNK_CELLS * CHUNK_CELLS; k++) {
      if ((heights?.[k] ?? 0) === 0 && (marks?.[k] ?? ".") === ".") continue;
      centers.add(`${chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS)},${chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS)}`);
    }
  }
  for (const stamp of Object.values(view?.stamps ?? {})) if (stamp?.sceneId === sceneId) centers.add(cellOf(stamp.x, stamp.y));
  for (const light of Object.values(view?.lights ?? {})) if (light?.sceneId === sceneId) centers.add(cellOf(light.x, light.y));
  return (key) => {
    const { x, y } = parseCell(key);
    const sides = [`${x},${y},n`, `${x},${y},w`];
    if (!bounds || y + 1 < bounds.h) sides.push(`${x},${y + 1},n`);
    if (!bounds || x + 1 < bounds.w) sides.push(`${x + 1},${y},w`);
    return centers.has(key) || boxes.some((box) => boxTouchesCell(box, x, y)) || sides.some((edge) => edgeAt(view, sceneId, edge) !== undefined);
  };
}
