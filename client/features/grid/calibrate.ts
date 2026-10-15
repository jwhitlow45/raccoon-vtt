import type { SceneMap } from "#shared/model.ts";

/**
 * Grid alignment math (design section 5).
 *
 * Alignment edits only `cellPx` and `originPx`, both in the canonical pixel
 * space of the map's `full` variant. The DM works in world cells on the
 * canvas, and the map image is placed there by the scene's current
 * calibration, so a world point converts to a canonical pixel through that
 * calibration alone. Which variant the device happens to show (a phone shows
 * the half-size `mobile` one) never enters the math, because every variant
 * is stretched to the same world rectangle.
 */

export type Point = { x: number; y: number };

/** Map fields the math needs. */
export type Calibration = Pick<SceneMap, "cellPx" | "originPx">;
export type MapSize = Pick<SceneMap, "widthPx" | "heightPx">;

/** Squares per side of the alignment box. Three squares average out a hand-placed corner. */
export const BOX_CELLS = 3;

/** The schema's bounds for cellPx (shared/protocol.ts). */
export const MIN_CELL_PX = 1;
export const MAX_CELL_PX = 16_384;

/** The largest scene side in cells (design 10.5). */
const MAX_SCENE_CELLS = 200;

/**
 * A square box over BOX_CELLS x BOX_CELLS squares of the map art, in
 * canonical pixels: its top-left corner and its side.
 */
export type CalBox = { x: number; y: number; size: number };

export function worldToCanonical(cal: Calibration, p: Point): Point {
  return { x: p.x * cal.cellPx + cal.originPx.x, y: p.y * cal.cellPx + cal.originPx.y };
}

export function canonicalToWorld(cal: Calibration, p: Point): Point {
  return { x: (p.x - cal.originPx.x) / cal.cellPx, y: (p.y - cal.originPx.y) / cal.cellPx };
}

/** A box over the BOX_CELLS squares that start at cell (cx, cy) under the current calibration. */
export function boxAtCell(cal: Calibration, cx: number, cy: number): CalBox {
  const corner = worldToCanonical(cal, { x: cx, y: cy });
  return { x: corner.x, y: corner.y, size: BOX_CELLS * cal.cellPx };
}

/**
 * The box a drag between two world points draws. Map squares are square,
 * so the box is too: its side is the larger of the two spans, and it grows
 * from the point where the drag started, toward the finger.
 */
export function boxFromDrag(cal: Calibration, from: Point, to: Point): CalBox {
  const a = worldToCanonical(cal, from);
  const b = worldToCanonical(cal, to);
  const size = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return {
    x: b.x < a.x ? a.x - size : a.x,
    y: b.y < a.y ? a.y - size : a.y,
    size,
  };
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** The box's corner, in canonical pixels. */
export function boxCorner(box: CalBox, corner: Corner): Point {
  return {
    x: corner === "nw" || corner === "sw" ? box.x : box.x + box.size,
    y: corner === "nw" || corner === "ne" ? box.y : box.y + box.size,
  };
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

/** Drags one corner to a world point, keeping the opposite corner where it is. */
export function resizeBox(cal: Calibration, box: CalBox, corner: Corner, to: Point): CalBox {
  const fixed = boxCorner(box, OPPOSITE[corner]);
  const fixedWorld = canonicalToWorld(cal, fixed);
  return boxFromDrag(cal, fixedWorld, to);
}

/** Moves the box by canonical pixels and grows it about its center. */
export function nudgeBox(box: CalBox, dx: number, dy: number, dsize = 0): CalBox {
  const size = Math.max(BOX_CELLS * MIN_CELL_PX, box.size + dsize);
  const grow = (size - box.size) / 2;
  return { x: box.x + dx - grow, y: box.y + dy - grow, size };
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** `v` modulo `m` in [0, m), with float noise next to m folded back to 0. */
function mod(v: number, m: number): number {
  const r = ((v % m) + m) % m;
  return m - r < 1e-6 ? 0 : r;
}

/** An origin this close to the image's edge, as a fraction of a cell, is taken as on it. */
export const ORIGIN_SNAP = 0.05;

/**
 * The calibration the box describes. The origin is moved to the first grid
 * intersection at or right of and below the image's top-left corner, so
 * cell (0, 0) is the first whole square of the art and a margin before the
 * first printed line falls outside the scene.
 *
 * A hand-drawn box never lands exactly on the lines. On art whose squares
 * start at its edge, a box a hair above or left of a line put the origin
 * just under a whole cell, and the scene lost the art's first row or column
 * (LP5-OPS-4). So an origin within ORIGIN_SNAP of a cell from 0 or from a
 * whole cell is 0. A real margin is wider than that and is kept.
 */
export function calibrationFromBox(box: CalBox): Calibration {
  const cellPx = round(Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, box.size / BOX_CELLS)), 4);
  return { cellPx, originPx: { x: snappedOrigin(box.x, cellPx), y: snappedOrigin(box.y, cellPx) } };
}

function snappedOrigin(v: number, cellPx: number): number {
  const origin = round(mod(v, cellPx), 2);
  const slack = cellPx * ORIGIN_SNAP;
  return origin <= slack || origin >= cellPx - slack ? 0 : origin;
}

/**
 * "Cells across by cells down": the art is that many squares edge to edge,
 * so the origin is its corner. Squares are square, so the two sizes are
 * averaged, and `mismatch` (0 for a perfect fit) says how far apart they
 * were, as a fraction, for a warning when the counts look wrong.
 */
export function calibrationFromCounts(map: MapSize, across: number, down: number): Calibration & { mismatch: number } {
  const byWidth = map.widthPx / across;
  const byHeight = map.heightPx / down;
  const cellPx = round(Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, (byWidth + byHeight) / 2)), 4);
  const mismatch = Math.abs(byWidth - byHeight) / Math.max(byWidth, byHeight);
  return { cellPx, originPx: { x: 0, y: 0 }, mismatch };
}

/**
 * How many squares the image spans under its grid, for "Or count the
 * squares" to start from: the whole squares from the grid's first line on,
 * as fitBounds counts them. Image size over cell size would count a margin
 * before the first line or after the last as part of a square, so a map
 * lined up just now would show counts that do not match it (LP3-TABLE-3).
 * Not the scene's size: a Universal VTT import with a fractional origin
 * also covers the partial square before the image
 * (docs/design-v1-maps-vision.md section 3.1, step 3), and the DM can size
 * a scene past its image. Either would show counts the image does not have.
 */
export function imageSquares(map: MapSize & Calibration): { across: number; down: number } {
  const { w, h } = fitBounds(map);
  return { across: w, down: h };
}

/**
 * The scene size that covers the whole squares of the map, from cell (0, 0)
 * to the last square that fits. A sliver of float error does not cost a
 * square.
 */
export function fitBounds(map: MapSize & Calibration): { w: number; h: number } {
  const side = (px: number, origin: number) =>
    Math.min(MAX_SCENE_CELLS, Math.max(1, Math.floor((px - origin) / map.cellPx + 0.02)));
  return { w: side(map.widthPx, map.originPx.x), h: side(map.heightPx, map.originPx.y) };
}

/** Whether two calibrations draw the same grid, to the precision the app stores. */
export function sameCalibration(a: Calibration, b: Calibration): boolean {
  return (
    Math.abs(a.cellPx - b.cellPx) < 1e-3 &&
    Math.abs(a.originPx.x - b.originPx.x) < 1e-2 &&
    Math.abs(a.originPx.y - b.originPx.y) < 1e-2
  );
}
