import type { SceneMap } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { HEX_R, HEX_S, hexAt, hexCenter } from "#shared/rules/hex.ts";

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
 * A box over BOX_CELLS x BOX_CELLS squares of the map art, in canonical
 * pixels: its top-left corner and its side. On hexes (HX-D12) it holds the
 * 7 hexes of one and its six neighbors, `size` its side 3 hexes across
 * their flats, and its other side HEX_BOX_DEPTH of that: 3 by 2.89 cells
 * on hex rows, 2.89 by 3 on hex columns. It keeps that shape however it is
 * dragged, resized or nudged.
 */
export type CalBox = { x: number; y: number; size: number };

/** The hex box's depth over its width: two rows apart plus a corner above and below, over 3 hexes across. */
export const HEX_BOX_DEPTH = (2 * HEX_S + 2 * HEX_R) / BOX_CELLS;

/** The box's sides in canonical pixels, by the scene's grid. */
export function boxSides(box: CalBox, g: Grid): { w: number; h: number } {
  if (!isHex(g)) return { w: box.size, h: box.size };
  return g.orient === "rows" ? { w: box.size, h: box.size * HEX_BOX_DEPTH } : { w: box.size * HEX_BOX_DEPTH, h: box.size };
}

/**
 * The box the grid tool starts with, or moves to on a tap, at a world
 * point under the current calibration: the 3 by 3 squares around the
 * cell there, or the 7 hexes around the hex there.
 */
export function boxAt(cal: Calibration, g: Grid, at: Point): CalBox {
  if (!isHex(g)) return boxAtCell(cal, Math.floor(at.x) - 1, Math.floor(at.y) - 1);
  const c = worldToCanonical(cal, hexCenter(g, hexAt(g, at)));
  const size = BOX_CELLS * cal.cellPx;
  const { w, h } = boxSides({ x: 0, y: 0, size }, g);
  return { x: c.x - w / 2, y: c.y - h / 2, size };
}

/** Whether a canonical point lies in the box. */
export function insideBox(box: CalBox, g: Grid, p: Point): boolean {
  const { w, h } = boxSides(box, g);
  return p.x >= box.x && p.x <= box.x + w && p.y >= box.y && p.y <= box.y + h;
}

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
export function boxFromDrag(cal: Calibration, from: Point, to: Point, g: Grid = SQUARES): CalBox {
  const a = worldToCanonical(cal, from);
  const b = worldToCanonical(cal, to);
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  // On hexes the box keeps its shape: the finger sets whichever side it pulls farther, the other follows.
  const size = !isHex(g) ? Math.max(dx, dy) : g.orient === "rows" ? Math.max(dx, dy / HEX_BOX_DEPTH) : Math.max(dy, dx / HEX_BOX_DEPTH);
  const { w, h } = boxSides({ x: 0, y: 0, size }, g);
  return {
    x: b.x < a.x ? a.x - w : a.x,
    y: b.y < a.y ? a.y - h : a.y,
    size,
  };
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** The box's corner, in canonical pixels. */
export function boxCorner(box: CalBox, corner: Corner, g: Grid = SQUARES): Point {
  const { w, h } = boxSides(box, g);
  return {
    x: corner === "nw" || corner === "sw" ? box.x : box.x + w,
    y: corner === "nw" || corner === "ne" ? box.y : box.y + h,
  };
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

/** Drags one corner to a world point, keeping the opposite corner where it is. */
export function resizeBox(cal: Calibration, box: CalBox, corner: Corner, to: Point, g: Grid = SQUARES): CalBox {
  const fixed = boxCorner(box, OPPOSITE[corner], g);
  const fixedWorld = canonicalToWorld(cal, fixed);
  return boxFromDrag(cal, fixedWorld, to, g);
}

/** Moves the box by canonical pixels and grows it about its center, keeping its shape. */
export function nudgeBox(box: CalBox, dx: number, dy: number, dsize = 0, g: Grid = SQUARES): CalBox {
  const size = Math.max(BOX_CELLS * MIN_CELL_PX, box.size + dsize);
  const before = boxSides(box, g);
  const after = boxSides({ ...box, size }, g);
  return { x: box.x + dx - (after.w - before.w) / 2, y: box.y + dy - (after.h - before.h) / 2, size };
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
export function calibrationFromBox(box: CalBox, g: Grid = SQUARES): Calibration {
  const cellPx = round(Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, box.size / BOX_CELLS)), 4);
  if (isHex(g)) return hexCalibration(box, g.orient, cellPx);
  return { cellPx, originPx: { x: snappedOrigin(box.x, cellPx), y: snappedOrigin(box.y, cellPx) } };
}

/**
 * The hex box's calibration (section 4.1): its middle is a hex center,
 * and the origin, the canonical pixel of world (0, 0), is reduced to the
 * first one at or after the image's top-left that puts a hex center there,
 * so it is never negative and the scene starts at the art's first whole
 * row. Hex rows are written along x, and hex columns read them mirrored.
 * Moving the origin down one row shifts the row half a hex, so the row's
 * parity carries into x. An origin within ORIGIN_SNAP of a cell from the
 * image's edge, or from the next row, is on the edge, as a square box's is.
 */
function hexCalibration(box: CalBox, orient: "rows" | "columns", cellPx: number): Calibration {
  const { w, h } = boxSides(box, { shape: "hex", orient });
  const slack = cellPx * ORIGIN_SNAP;
  return { cellPx, originPx: hexOrigin({ x: box.x + w / 2, y: box.y + h / 2 }, orient, cellPx, slack, slack) };
}

/**
 * The origin of hexes of `cellPx` with a center at `mid`, reduced to the
 * first row at or after the image's top-left (section 4.1). An origin
 * within `low` of the image's edge folds onto it, and one within `high`
 * under the next row or hex starts there instead.
 */
function hexOrigin(mid: Point, orient: "rows" | "columns", cellPx: number, low: number, high: number): Point {
  const [along, across] = orient === "rows" ? [mid.x, mid.y] : [mid.y, mid.x];
  const rowPx = HEX_S * cellPx;
  const first = across - HEX_R * cellPx;
  let row = Math.floor(first / rowPx);
  let b = first - row * rowPx;
  if (b >= rowPx - high) {
    b = 0;
    row += 1;
  } else if (b <= low) b = 0;
  const odd = ((row % 2) + 2) % 2 === 1;
  let a = mod(along - (odd ? 1 : 0.5) * cellPx, cellPx);
  if (a <= low || a >= cellPx - high) a = 0;
  const ox = round(orient === "rows" ? a : b, 2);
  const oy = round(orient === "rows" ? b : a, 2);
  return { x: ox, y: oy };
}

function snappedOrigin(v: number, cellPx: number): number {
  const origin = round(mod(v, cellPx), 2);
  const slack = cellPx * ORIGIN_SNAP;
  return origin <= slack || origin >= cellPx - slack ? 0 : origin;
}

/** A measured origin this close under a whole cell, as a fraction of a cell or at least FOUND_SNAP_PX, is taken as on the image's edge. */
export const FOUND_SNAP = 0.01;
export const FOUND_SNAP_PX = 1;

/**
 * The calibration a grid found in the map's pixels describes
 * (docs/design-v1-grid-detect.md section 6). The detector places the lines
 * to a fraction of a pixel, so its origin is kept as measured. The wide
 * snap of a hand-drawn box (ORIGIN_SNAP) would move a line found 6 px in
 * onto the image's edge, off the drawn lines.
 *
 * Only an origin just under a whole cell folds to 0. That is a line found
 * a hair before the image's edge, which would otherwise start cell (0, 0)
 * one square in, and the art's first row or column would fall outside the
 * scene (the LP5-OPS-4 case). An origin just past 0 keeps that square
 * already.
 */
export function calibrationFromFind(found: { cellPx: number; originPx: Point }): Calibration {
  const cellPx = round(Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, found.cellPx)), 4);
  const slack = Math.max(FOUND_SNAP_PX, cellPx * FOUND_SNAP);
  const origin = (v: number) => {
    const o = round(mod(v, cellPx), 2);
    return o >= cellPx - slack ? 0 : o;
  };
  return { cellPx, originPx: { x: origin(found.originPx.x), y: origin(found.originPx.y) } };
}

/**
 * The calibration a hex grid found in the map's pixels describes
 * (docs/design-v1-grid-detect.md 10.7): its center taken as a hex center
 * and the origin reduced as Line up grid's hex box reduces it, so Apply
 * and the box agree. As for a square find, the measured origin is kept:
 * only one just under a whole row or hex folds onto the image's edge
 * (FOUND_SNAP), never the box's ORIGIN_SNAP.
 */
export function calibrationFromHexFind(found: { cellPx: number; center: Point; orient: "rows" | "columns" }): Calibration {
  const cellPx = round(Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, found.cellPx)), 4);
  return { cellPx, originPx: hexOrigin(found.center, found.orient, cellPx, 0, Math.max(FOUND_SNAP_PX, cellPx * FOUND_SNAP)) };
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
