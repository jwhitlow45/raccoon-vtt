import { FOG_SUBCELLS, type CreatureSize } from "../model.ts";
import type { Point } from "./geom.ts";

/**
 * Hex grid geometry (docs/design-v1-hex-grids.md section 4).
 *
 * The world stays in cells: one cell is the distance between two
 * neighboring hex centers, so a hex is one cell across its flat sides. Hex
 * rows have pointed tops, and every rule here is written for them. Hex
 * columns read the same rules with x and y swapped, a mirror rather than a
 * turn, so anything with a handedness (the neighbor order, the corners)
 * that runs clockwise from east on rows runs counterclockwise from south on
 * columns.
 *
 * A hex is named by offset coordinates, odd rows shifted half a cell right
 * (odd columns half a cell down on columns). Distances, lines and rounding
 * go through cube coordinates inside this file, and those never reach
 * stored data.
 *
 * The reducer reads this on replay and sight will read it for withheld
 * tokens, so every device must agree bit for bit: it uses only `+`, `-`,
 * `*`, `/`, floor, round, abs, min and max, which every engine rounds alike
 * (hex.test.ts checks it, as segments.test.ts checks sight).
 */

export type HexOrient = "rows" | "columns";
export type HexGrid = { shape: "hex"; orient: HexOrient };

/** A hex by its offset coordinates on either orientation: `col` counts along x and `row` along y. */
export type Hex = { col: number; row: number };

/**
 * One corner of the hex lattice, named by the one hex whose pointed corner
 * it is: `k` 0 the hex's first point (north on rows, west on columns), 1
 * its second (south on rows, east on columns). Every corner is exactly one
 * hex's point, so this names each corner once.
 */
export type HexCorner = { hex: Hex; k: 0 | 1 };

/** The sizes the hex table knows (section 4.2). A custom size reads as its category. */
export type HexSize = Exclude<CreatureSize, "custom">;

/** √3/2, the spacing of rows, as a literal: sqrt is not on this file's list. */
export const HEX_S = 0.8660254037844386;
/** 1/√3, center to corner. In doubles `1.5 * HEX_R !== HEX_S`, so no corner is ever derived from a center. */
export const HEX_R = 0.5773502691896258;

/** Corners and anchors round to the free walls' lattice (FREE_WALL_LATTICE in model.ts), so walls and anchors meet exactly. */
const CORNER_LATTICE = 64;

/** Cube rounding's tie breaker (section 4.4): the start of every line moves by this much, summing to zero. */
const NUDGE = { q: 1e-6, r: 2e-6, s: -3e-6 };

/** A hex on the rows lattice: `c` along the row, `r` the row. Columns reach it through `toLat`. */
type Lat = { c: number; r: number };

function parity(r: number): number {
  return r - 2 * Math.floor(r / 2);
}

/** Folds -0 into 0, so a key never reads "-0". */
function plain(n: number): number {
  return n + 0;
}

function toLat(g: HexGrid, h: Hex): Lat {
  return g.orient === "rows" ? { c: h.col, r: h.row } : { c: h.row, r: h.col };
}

function fromLat(g: HexGrid, l: Lat): Hex {
  return g.orient === "rows" ? { col: plain(l.c), row: plain(l.r) } : { col: plain(l.r), row: plain(l.c) };
}

/** The mirror between the world and the rows lattice, its own inverse. */
function mirror(g: HexGrid, p: Point): Point {
  return g.orient === "rows" ? p : { x: p.y, y: p.x };
}

function latCenter(l: Lat): Point {
  return { x: l.c + 0.5 + 0.5 * parity(l.r), y: HEX_R + l.r * HEX_S };
}

/**
 * The hex whose center is nearest, on the rows lattice. A point between
 * two rows' center lines lies in one of those two rows (a hex reaches only
 * HEX_R above and below its center, less than the rows' spacing), and in
 * each row in one of the two hexes either side of it. Ties go to the
 * smaller row, then the smaller column, by the order the four are tried.
 */
function latAt(p: Point): Lat {
  const r0 = Math.floor((p.y - HEX_R) / HEX_S);
  let best: Lat = { c: 0, r: 0 };
  let bestD = Infinity;
  for (let r = r0; r <= r0 + 1; r++) {
    const c0 = Math.floor(p.x - 0.5 - 0.5 * parity(r));
    for (let c = c0; c <= c0 + 1; c++) {
      const center = latCenter({ c, r });
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { c, r };
      }
    }
  }
  return best;
}

type Cube = { q: number; r: number; s: number };

function toCube(l: Lat): Cube {
  const q = l.c - Math.floor(l.r / 2);
  return { q, r: l.r, s: -q - l.r };
}

function fromCube(c: Cube): Lat {
  return { c: c.q + Math.floor(c.r / 2), r: c.r };
}

function roundCube(q: number, r: number, s: number): Cube {
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  else rs = -rq - rr;
  return { q: rq, r: rr, s: rs };
}

/** Steps clockwise from east on the rows lattice, in cube coordinates. */
const DIRECTIONS: readonly Cube[] = [
  { q: 1, r: 0, s: -1 },
  { q: 0, r: 1, s: -1 },
  { q: -1, r: 1, s: 0 },
  { q: -1, r: 0, s: 1 },
  { q: 0, r: -1, s: 1 },
  { q: 1, r: -1, s: 0 },
];

function latStep(l: Lat, direction: number): Lat {
  const c = toCube(l);
  const d = DIRECTIONS[direction]!;
  return fromCube({ q: c.q + d.q, r: c.r + d.r, s: c.s + d.s });
}

export function hexKey(h: Hex): string {
  return `${h.col},${h.row}`;
}

/** A `"col,row"` key's hex, or null when it is not two whole numbers. */
export function parseHexKey(key: string): Hex | null {
  const parts = key.split(",");
  if (parts.length !== 2) return null;
  const col = Number(parts[0]);
  const row = Number(parts[1]);
  return Number.isInteger(col) && Number.isInteger(row) && parts[0] !== "" && parts[1] !== "" ? { col, row } : null;
}

export function sameHex(a: Hex, b: Hex): boolean {
  return a.col === b.col && a.row === b.row;
}

export function hexCenter(g: HexGrid, h: Hex): Point {
  return mirror(g, latCenter(toLat(g, h)));
}

/** The hex that holds a point: the nearest center, ties to the smaller row, then the smaller column (on the rows lattice). */
export function hexAt(g: HexGrid, p: Point): Hex {
  return fromLat(g, latAt(mirror(g, p)));
}

/** Steps between two hexes. Every hex is one step: a hex has no diagonal (section 4.3). */
export function hexDistance(g: HexGrid, a: Hex, b: Hex): number {
  const x = toCube(toLat(g, a));
  const y = toCube(toLat(g, b));
  return Math.max(Math.abs(x.q - y.q), Math.abs(x.r - y.r), Math.abs(x.s - y.s));
}

/** The six neighbors, clockwise from east on hex rows, so counterclockwise from south on hex columns. */
export function hexNeighbors(g: HexGrid, h: Hex): Hex[] {
  const l = toLat(g, h);
  return DIRECTIONS.map((_, i) => fromLat(g, latStep(l, i)));
}

/**
 * The hexes a straight line from `a` to `b` passes through, `a` and `b`
 * included, each next to the last: hexDistance + 1 of them. The line
 * starts a hair off center (NUDGE), so a line along the side between two
 * hexes always falls the same way, on every device and every replay.
 */
export function hexLine(g: HexGrid, a: Hex, b: Hex): Hex[] {
  const n = hexDistance(g, a, b);
  const x = toCube(toLat(g, a));
  const y = toCube(toLat(g, b));
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const q = x.q + NUDGE.q + (y.q - x.q) * t;
    const r = x.r + NUDGE.r + (y.r - x.r) * t;
    const s = x.s + NUDGE.s + (y.s - x.s) * t;
    out.push(fromLat(g, fromCube(roundCube(q, r, s))));
  }
  return out;
}

function onLattice(v: number): number {
  return plain(Math.round(v * CORNER_LATTICE) / CORNER_LATTICE);
}

/**
 * Where a corner is, rounded to the 1/64 lattice. Each corner is worked
 * out from its own name alone, never from the center of a hex that asks,
 * so every hex around it gets the very same point.
 */
export function cornerAt(g: HexGrid, corner: HexCorner): Point {
  return mirror(g, latCorner(toLat(g, corner.hex), corner.k));
}

/** A corner on the rows lattice, by its hex and point, on the 1/64 lattice: the one place a corner's numbers come from. */
function latCorner(l: Lat, k: 0 | 1): Point {
  const x = l.c + 0.5 + 0.5 * parity(l.r);
  const top = l.r * HEX_S;
  return { x: onLattice(x), y: onLattice(k === 0 ? top : top + 2 * HEX_R) };
}

/**
 * A hex's six corners by their names, clockwise from its first point on
 * hex rows (north, then north-east and on round), mirrored on hex columns.
 * A side corner is a point of the neighbor above or below it.
 */
export function hexCorners(g: HexGrid, h: Hex): HexCorner[] {
  const l = toLat(g, h);
  const at = (direction: number) => fromLat(g, latStep(l, direction));
  return [
    { hex: h, k: 0 },
    { hex: at(5), k: 1 },
    { hex: at(1), k: 0 },
    { hex: h, k: 1 },
    { hex: at(2), k: 0 },
    { hex: at(4), k: 1 },
  ];
}

/** Large and Gargantuan stand on a corner, the one their top three hexes share. The rest stand on a hex's center. */
function onCorner(size: HexSize): boolean {
  return size === "large" || size === "gargantuan";
}

/**
 * The anchor nearest a point for a creature of this size (section 4.2): a
 * hex's center, or for Large and Gargantuan the shared corner, a hex's
 * second point. Those corners are the centers moved by HEX_R toward the
 * second point, so the nearest unrounded one is the second point of the
 * hex nearest the point moved back by as much. Anchors are the corners as
 * rounded to the 1/64 lattice, which can make a neighbor's the nearer, so
 * the rounded corners of that hex and its six neighbors are compared, ties
 * to the smaller row, then the smaller column, as `hexAt` sends them.
 */
export function snapAnchor(g: HexGrid, size: HexSize, center: Point): Point {
  if (!onCorner(size)) return hexCenter(g, hexAt(g, center));
  const p = mirror(g, center);
  const near = latAt({ x: p.x, y: p.y - HEX_R });
  const candidates = [near, ...DIRECTIONS.map((_, i) => latStep(near, i))].sort((a, b) => a.r - b.r || a.c - b.c);
  let best = near;
  let bestD = Infinity;
  for (const l of candidates) {
    const corner = latCorner(l, 1);
    const dx = p.x - corner.x;
    const dy = p.y - corner.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  return mirror(g, latCorner(best, 1));
}

/**
 * The hex a creature's steps count from (section 4.2): its own hex, the
 * center hex of a Huge one, and the top hex of a Large or Gargantuan one,
 * the hex whose second point is the anchor.
 */
export function referenceHex(g: HexGrid, size: HexSize, anchor: Point): Hex {
  if (!onCorner(size)) return hexAt(g, anchor);
  const p = mirror(g, anchor);
  return fromLat(g, latAt({ x: p.x, y: p.y - HEX_R }));
}

/**
 * The hexes a creature takes, its reference hex first (section 4.2, the
 * 2014 DMG's hex table): 1 for Tiny to Medium, 3 for Large (a hex and the
 * two below it), 7 for Huge (a hex and its six neighbors) and 12 for
 * Gargantuan (the Large three and the nine around them). The order is
 * fixed, so every reader walks them alike.
 */
export function footprintHexes(g: HexGrid, size: HexSize, anchor: Point): Hex[] {
  const ref = toLat(g, referenceHex(g, size, anchor));
  if (size === "huge") return [fromLat(g, ref), ...DIRECTIONS.map((_, i) => fromLat(g, latStep(ref, i)))];
  if (!onCorner(size)) return [fromLat(g, ref)];
  const three = [ref, latStep(ref, 1), latStep(ref, 2)];
  if (size === "large") return three.map((l) => fromLat(g, l));
  const out = [...three];
  const seen = new Set(three.map((l) => `${l.c},${l.r}`));
  for (const l of three) {
    for (let i = 0; i < DIRECTIONS.length; i++) {
      const n = latStep(l, i);
      const key = `${n.c},${n.r}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }
  return out.map((l) => fromLat(g, l));
}

/** The rows lattice's rectangle for a scene's bounds: as they are on rows, swapped on columns. */
function latBounds(g: HexGrid, bounds: { w: number; h: number }): { w: number; h: number } {
  return g.orient === "rows" ? bounds : { w: bounds.h, h: bounds.w };
}

/** Whether row `r` of the rows lattice lies wholly inside a height. */
function rowFits(r: number, h: number): boolean {
  return r >= 0 && r * HEX_S + 2 * HEX_R <= h;
}

/** How many hexes row `r` of the rows lattice holds inside a width: odd rows one fewer, shifted half a hex. */
function rowLength(r: number, w: number): number {
  return Math.max(0, Math.floor(w - 0.5 * parity(r)));
}

function rowCount(h: number): number {
  let n = Math.max(0, Math.floor((h - 2 * HEX_R) / HEX_S) + 1);
  while (n > 0 && !rowFits(n - 1, h)) n--;
  while (rowFits(n, h)) n++;
  return n;
}

/**
 * Whether a hex lies wholly inside a scene's rectangle (section 4.1). A 30
 * by 20 scene on hex rows holds 22 rows, 30 hexes in even rows and 29 in
 * odd ones.
 */
export function hexInScene(g: HexGrid, bounds: { w: number; h: number }, h: Hex): boolean {
  const b = latBounds(g, bounds);
  const l = toLat(g, h);
  return rowFits(l.r, b.h) && l.c >= 0 && l.c < rowLength(l.r, b.w);
}

/** A scene's hexes in the rows lattice's order: row by row on hex rows, column by column on hex columns. */
export function sceneHexes(g: HexGrid, bounds: { w: number; h: number }): Hex[] {
  const b = latBounds(g, bounds);
  const out: Hex[] = [];
  for (let r = 0, rows = rowCount(b.h); r < rows; r++) {
    for (let c = 0, n = rowLength(r, b.w); c < n; c++) out.push(fromLat(g, { c, r }));
  }
  return out;
}

/**
 * How far a scene's hexes reach in world terms: the columns and rows its
 * keys run over. A 30 by 20 scene on hex rows has 30 columns (its even
 * rows) and 22 rows.
 */
export function sceneHexSpan(g: HexGrid, bounds: { w: number; h: number }): { cols: number; rows: number } {
  const b = latBounds(g, bounds);
  const lines = rowCount(b.h);
  const along = lines === 0 ? 0 : rowLength(0, b.w);
  return g.orient === "rows" ? { cols: along, rows: lines } : { cols: lines, rows: along };
}

/**
 * The fog sub-cells whose centers a hex holds, as `[sx, sy]` raster
 * indices in row order (section 4.1). They are the sub-cells `hexAt` puts
 * in the hex, so every sub-cell belongs to exactly one hex. A sub-cell's
 * center is an odd multiple of 1/8, so the upright sides of hex rows never
 * split one, and the rounding settles the sloped sides the same way
 * everywhere. A hex holds 12 to 16 of them.
 */
export function hexSubcells(g: HexGrid, h: Hex): [number, number][] {
  const center = hexCenter(g, h);
  const half = mirror(g, { x: 0.5, y: HEX_R });
  const sx0 = Math.floor((center.x - half.x) * FOG_SUBCELLS);
  const sx1 = Math.floor((center.x + half.x) * FOG_SUBCELLS) + 1;
  const sy0 = Math.floor((center.y - half.y) * FOG_SUBCELLS);
  const sy1 = Math.floor((center.y + half.y) * FOG_SUBCELLS) + 1;
  const out: [number, number][] = [];
  for (let sy = sy0; sy < sy1; sy++) {
    for (let sx = sx0; sx < sx1; sx++) {
      if (sameHex(hexAt(g, { x: (sx + 0.5) / FOG_SUBCELLS, y: (sy + 0.5) / FOG_SUBCELLS }), h)) out.push([sx, sy]);
    }
  }
  return out;
}
