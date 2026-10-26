import { FOG_SUBCELLS, SIZE_CELLS, type Token } from "../model.ts";
import type { Point, Rect } from "./geom.ts";
import type { Grid } from "./grid.ts";
import { footprintHexes, hexCenter, cornerAt, hexSubcells, referenceHex, snapAnchor, type Hex, type HexGrid } from "./hex.ts";

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
 * On a hex scene (docs/design-v1-hex-grids.md 4.2) a creature takes its
 * size's hexes, a custom size by its category, around the anchor nearest
 * the middle of its stored box: 1 hex up to Medium, 3 for Large, 7 for Huge
 * and 12 for Gargantuan. Every function here whose answer depends on the
 * grid takes it, so the typecheck lists every caller. The square path is
 * the code from before hex grids. Squeezing on hexes is phase H2's: a hex
 * scene holds no squeezed token in H1, so the hex path never reads one.
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

/** The footprint a turn's path stop keeps for the token as it stands (PathStop.footprint): its size, and whether it is squeezed. */
export function stopFootprint(token: PlacedToken): { w: number; h: number; squeeze?: true } {
  return { ...footprintSize(token), ...(isSqueezed(token) ? { squeeze: true as const } : {}) };
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
 * squeezes, else the full one after snapping. On hexes it is the size's box
 * around the anchor (4.2), where the map draws the token once it snaps, so
 * its middle is the anchor and its side the size's: a custom size reads as
 * its category.
 */
export function footprintRect(g: Grid, token: PlacedToken): Rect {
  if (g.shape === "hex") {
    const a = hexAnchor(g, token);
    const side = SIZE_CELLS[sizeCategory(token)];
    return { x: a.x - side / 2, y: a.y - side / 2, w: side, h: side };
  }
  if (isSqueezed(token)) return squeezedRect(token);
  const { w, h } = footprintSize(token);
  const step = sizeStep(w, h);
  return { x: snap(token.x, step), y: snap(token.y, step), w, h };
}

function sizeStep(w: number, h: number): number {
  return Math.min(w, h) < 1 ? 0.5 : 1;
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
 *
 * On hexes no range of cells is a footprint, so this is the cells its
 * hexes' fog sub-cells lie in: a bound for finding the tiles and chunks a
 * creature touches. A rule that counts what a creature stands on reads
 * `occupiedHexes`, and fog and sight read `footprintSubcells`.
 */
export function occupiedRange(g: Grid, token: PlacedToken): CellRange {
  if (g.shape === "hex") return subcellRange(footprintSubcells(g, token));
  const r = footprintRect(g, token);
  return rectRange(r.x, r.y, r.w, r.h);
}

/**
 * The cells an unsqueezed footprint of `w` by `h` cells (`footprintSize`)
 * overlaps at x, y: `occupiedRange` without a token to read, for a walk
 * that asks at every spot (docs/design-v1-traps.md 9). Squares only: the
 * walks that ask it (ground under a walk, traps) are square rules until
 * hex grids' phases H2 and H3.
 */
export function rangeAt(w: number, h: number, x: number, y: number): CellRange {
  return rangeAtInto({ x0: 0, y0: 0, x1: 0, y1: 0 }, w, h, x, y);
}

/** `rangeAt` written into `out`, for a walk that asks at every spot and keeps no range past the next. */
export function rangeAtInto(out: CellRange, w: number, h: number, x: number, y: number): CellRange {
  const step = sizeStep(w, h);
  const sx = snap(x, step);
  const sy = snap(y, step);
  out.x0 = Math.floor(sx);
  out.y0 = Math.floor(sy);
  out.x1 = Math.max(out.x0 + 1, Math.ceil(sx + w - EDGE_SLACK));
  out.y1 = Math.max(out.y0 + 1, Math.ceil(sy + h - EDGE_SLACK));
  return out;
}

function rectRange(x: number, y: number, w: number, h: number): CellRange {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  return {
    x0,
    y0,
    x1: Math.max(x0 + 1, Math.ceil(x + w - EDGE_SLACK)),
    y1: Math.max(y0 + 1, Math.ceil(y + h - EDGE_SLACK)),
  };
}

/** The cells of `occupiedRange`: on squares the cells the footprint stands in, on hexes those its hexes reach into. */
export function occupiedCells(g: Grid, token: PlacedToken): Point[] {
  const r = occupiedRange(g, token);
  const cells: Point[] = [];
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) cells.push({ x, y });
  }
  return cells;
}

/*
 * Hex footprints (docs/design-v1-hex-grids.md 4.2). The stored x, y stay
 * the top-left of the size's box, so drawing, hit areas and labels work
 * unchanged, and only the rules read the hexes.
 */

/** The anchor a creature stands on: the one nearest the middle of its stored box, for its size's category. */
export function hexAnchor(g: HexGrid, token: PlacedToken): Point {
  return snapAnchor(g, sizeCategory(token), storedCenter(token));
}

/** The hexes a creature stands on, its reference hex first (hex.ts footprintHexes). */
export function occupiedHexes(g: HexGrid, token: PlacedToken): Hex[] {
  return footprintHexes(g, sizeCategory(token), hexAnchor(g, token));
}

/** The hex a creature's steps count from (4.2): its own, a Huge one's center hex, a Large or Gargantuan one's top hex. */
export function tokenRefHex(g: HexGrid, token: PlacedToken): Hex {
  return referenceHex(g, sizeCategory(token), hexAnchor(g, token));
}

/** The anchor of a size whose reference hex is `ref`: the hex's center, or for Large and Gargantuan its second point. */
export function anchorOfHex(g: HexGrid, size: SizeCategory, ref: Hex): Point {
  return size === "large" || size === "gargantuan" ? cornerAt(g, { hex: ref, k: 1 }) : hexCenter(g, ref);
}

/**
 * Where a creature's stored box goes for its anchor to stand on `ref` as
 * its reference hex: the top-left of its box, whose middle is the anchor.
 * A move, a resize and a walk's spots on hexes place a creature by it.
 */
export function placedOnHex(g: HexGrid, token: PlacedToken, ref: Hex): Point {
  const a = anchorOfHex(g, sizeCategory(token), ref);
  const { w, h } = footprintSize(token);
  return { x: a.x - w / 2 + 0, y: a.y - h / 2 + 0 };
}

/**
 * The fog sub-cells inside a creature's hexes (hex.ts hexSubcells), as
 * `[sx, sy]` raster indices: what the fog and sight tests read on hexes
 * (HX-D10). Each sub-cell belongs to one hex, so none repeats.
 */
export function footprintSubcells(g: HexGrid, token: PlacedToken): [number, number][] {
  return occupiedHexes(g, token).flatMap((h) => hexSubcells(g, h));
}

/** The cells sub-cells lie in. A footprint always holds some, so the range is never empty. */
function subcellRange(subs: readonly (readonly [number, number])[]): CellRange {
  let sx0 = Infinity;
  let sy0 = Infinity;
  let sx1 = -Infinity;
  let sy1 = -Infinity;
  for (const [sx, sy] of subs) {
    if (sx < sx0) sx0 = sx;
    if (sx > sx1) sx1 = sx;
    if (sy < sy0) sy0 = sy;
    if (sy > sy1) sy1 = sy;
  }
  return { x0: Math.floor(sx0 / FOG_SUBCELLS), y0: Math.floor(sy0 / FOG_SUBCELLS), x1: Math.floor(sx1 / FOG_SUBCELLS) + 1, y1: Math.floor(sy1 / FOG_SUBCELLS) + 1 };
}

/** The six sizes the rules name, smallest first. */
export type SizeCategory = Exclude<Token["size"], "custom">;
const SIZE_ORDER: readonly SizeCategory[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

/**
 * The size the rules read for a creature (docs/design-v1-movement.md 4.5):
 * a standard size is itself, and a custom one is the smallest standard size
 * whose square holds its footprint's longer side. The longer side, since a
 * creature's size is the space it controls, and a 1 by 3 creature controls
 * a run of 3 squares. Custom never reads as Small, since Small and Medium
 * share a square.
 */
export function sizeCategory(token: Pick<PlacedToken, "size" | "w" | "h">): SizeCategory {
  if (token.size !== "custom") return token.size;
  const side = Math.max(customSide(token.w), customSide(token.h));
  if (side <= 0.5) return "tiny";
  if (side <= 1) return "medium";
  if (side <= 2) return "large";
  if (side <= 3) return "huge";
  return "gargantuan";
}

/** How many sizes apart two creatures are by `sizeCategory`. */
export function sizeSteps(a: Pick<PlacedToken, "size" | "w" | "h">, b: Pick<PlacedToken, "size" | "w" | "h">): number {
  return Math.abs(SIZE_ORDER.indexOf(sizeCategory(a)) - SIZE_ORDER.indexOf(sizeCategory(b)));
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
