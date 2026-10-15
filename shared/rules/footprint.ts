import { SIZE_CELLS, type Token } from "../model.ts";
import type { Point, Rect } from "./geom.ts";

/**
 * Token footprints (design section 9.1).
 *
 * Every rules answer starts from the snapped footprint, not the raw position,
 * so a token dropped a little off the grid still gives clean answers: a
 * Medium creature at x = 2.4 is treated as standing in column 2.
 *
 * A squeezed token (docs/design-v1-maps-vision.md section 4.1) is the
 * exception: every rule reads its squeezed footprint, centered on its stored
 * center and never snapped, while the map draws it full size.
 *
 * Sight imports this file through heights.ts, so it keeps to the arithmetic
 * sight allows (section 4.3.4) and imports only types from geom.ts.
 */

/** The token fields a footprint depends on. */
export type FootprintToken = Pick<Token, "size" | "x" | "y" | "elevation"> & Partial<Pick<Token, "w" | "h" | "height" | "squeeze">>;

/** The fields the cells a token stands in depend on: its footprint without the vertical extent. */
export type PlacedToken = Pick<FootprintToken, "size" | "x" | "y" | "w" | "h" | "squeeze">;

/** Half-open cell ranges `[x0, x1)` by `[y0, y1)`. */
export type CellRange = { x0: number; y0: number; x1: number; y1: number };

/** Custom footprint bounds in cells (design section 10.5). */
export const CUSTOM_MIN_CELLS = 0.5;
export const CUSTOM_MAX_CELLS = 20;

/*
 * Positions are snapped before this is subtracted, so they are exact
 * multiples of a half cell, but custom sizes can be any float. Without the
 * slack, 0.1 + 0.2 style rounding could claim one cell too many.
 */
const EDGE_SLACK = 1e-9;

/** Footprint width and height in cells. */
export function footprintSize(token: PlacedToken): { w: number; h: number } {
  if (token.size === "custom") return { w: customSide(token.w), h: customSide(token.h) };
  const side = SIZE_CELLS[token.size];
  return { w: side, h: side };
}

function customSide(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 1;
  return v < CUSTOM_MIN_CELLS ? CUSTOM_MIN_CELLS : v > CUSTOM_MAX_CELLS ? CUSTOM_MAX_CELLS : v;
}

/** Whether a squeeze shrinks the footprint: it has a side of at least 2 cells. */
export function canSqueeze(token: PlacedToken): boolean {
  const { w, h } = footprintSize(token);
  return w >= 2 || h >= 2;
}

/**
 * The squeezed footprint's sides: one size smaller on every side of at
 * least 2 cells, as the SRD's narrow opening does (Large 1 x 1, Huge 2 x 2,
 * Gargantuan 3 x 3, a custom 1 x 3 token 1 x 2). Other sides keep their
 * length. Separate from the movement core (movement.ts), never derived from it.
 */
export function squeezedSize(token: PlacedToken): { w: number; h: number } {
  const { w, h } = footprintSize(token);
  return { w: w >= 2 ? w - 1 : w, h: h >= 2 ? h - 1 : h };
}

/** The middle of the footprint at the stored position, unsnapped: where the map draws the token's center. */
export function storedCenter(token: PlacedToken): Point {
  const { w, h } = footprintSize(token);
  return { x: token.x + w / 2, y: token.y + h / 2 };
}

/** The squeezed footprint at the stored position: centered on the stored center, never snapped. */
export function squeezedRect(token: PlacedToken): Rect {
  const c = storedCenter(token);
  const { w, h } = squeezedSize(token);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Whether every rule reads the token's squeezed footprint: it carries the flag and has a side a squeeze shrinks. */
export function isSqueezed(token: PlacedToken): boolean {
  return token.squeeze === true && canSqueeze(token);
}

/**
 * The grid a token snaps to: half cells for footprints narrower than a cell
 * (Tiny, or a small custom size), whole cells otherwise.
 */
export function snapStep(token: PlacedToken): number {
  const { w, h } = footprintSize(token);
  return Math.min(w, h) < 1 ? 0.5 : 1;
}

/**
 * The footprint rectangle every rule reads: the squeezed one while the token
 * squeezes, else the full one after snapping.
 */
export function footprintRect(token: PlacedToken): Rect {
  if (isSqueezed(token)) return squeezedRect(token);
  const { w, h } = footprintSize(token);
  const step = Math.min(w, h) < 1 ? 0.5 : 1;
  return { x: snap(token.x, step), y: snap(token.y, step), w, h };
}

// Adding 0 turns the -0 that Math.round gives for small negatives into 0.
function snap(v: number, step: number): number {
  return Math.round(v / step) * step + 0;
}

/**
 * The whole cells the snapped footprint overlaps. A Tiny creature snaps to
 * half cells and is half a cell wide, so it always lies inside exactly one
 * cell, the one it occupies. A squeezed footprint lies on cell boundaries
 * (a squeeze is accepted only there), so these are exactly its cells.
 */
export function occupiedRange(token: PlacedToken): CellRange {
  const r = footprintRect(token);
  const x0 = Math.floor(r.x);
  const y0 = Math.floor(r.y);
  return {
    x0,
    y0,
    x1: Math.max(x0 + 1, Math.ceil(r.x + r.w - EDGE_SLACK)),
    y1: Math.max(y0 + 1, Math.ceil(r.y + r.h - EDGE_SLACK)),
  };
}

export function occupiedCells(token: PlacedToken): Point[] {
  const r = occupiedRange(token);
  const cells: Point[] = [];
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) cells.push({ x, y });
  }
  return cells;
}

/**
 * Height in feet. Without an explicit height it is the footprint side, 5 ft
 * for Medium and 10 ft for Large at 5 ft per cell. A custom footprint that is
 * not square uses its shorter side, since a long thing such as a wagon is
 * rarely as tall as it is long. A squeeze leaves it as it is: a Large
 * creature in a corridor is still 10 ft tall, and its eye stays where it was.
 */
export function tokenHeightFt(token: FootprintToken, feetPerCell: number): number {
  if (token.height !== undefined && Number.isFinite(token.height) && token.height >= 0) return token.height;
  const { w, h } = footprintSize(token);
  return Math.min(w, h) * feetPerCell;
}

/** Vertical extent `[lo, hi]` in feet: from the elevation up by the height. */
export function verticalExtentFt(token: FootprintToken, feetPerCell: number): { lo: number; hi: number } {
  return { lo: token.elevation, hi: token.elevation + tokenHeightFt(token, feetPerCell) };
}
