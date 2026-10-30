import { occupiedHexes, occupiedRange, type PlacedToken } from "#shared/rules/footprint.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexNeighbors, sameHex, sceneHexes, sceneHexSpan, type HexGrid } from "#shared/rules/hex.ts";
import type { Point } from "./camera.ts";

/**
 * The cells drawn ground stands on, on either grid
 * (docs/design-v1-iso-hex-relief.md 5.1): pure geometry over the shared
 * square and hex helpers, read by every renderer and pointer reader that
 * meets drawn heights. A cell is named by its key, `col` along x and `row`
 * along y, which on hexes is the hex's offset key and never a world point.
 * A world point is a `Point`. The two never mix: a key reaches the world
 * only through `cellPolygon` or `cellCenter`, and a point a key only
 * through `cellAtPoint`.
 *
 * Squares keep their arithmetic. Hexes use the canonical corners
 * (hex.ts cornerAt, rounded to the 1/64 lattice), so every reader meets
 * the same polygon walls and fog already draw. `hexAt` stays the rules'
 * answer for a point. Here it is only the first guess, since a point near
 * a rounded edge can lie in the neighbor's canonical polygon.
 */

export type GroundCell = { readonly col: number; readonly row: number };

/** A world rectangle in cells, its far edges included. */
export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * The drawn ground a viewer's pieces and presses read, in cells of height:
 * 0 outside the scene, in the unused strip between the last whole hexes
 * and the scene's rectangle, and wherever this viewer has not seen.
 */
export type GroundSurface = {
  readonly grid: Grid;
  /** The scene's rectangle in cells. */
  readonly bounds: { w: number; h: number };
  atCell(cell: GroundCell): number;
  atPoint(p: Point): number;
  /** The scene's cells whose polygons meet a world rectangle, border touches included. */
  cellsIn(box: WorldRect): GroundCell[];
  polygon(cell: GroundCell): readonly Point[];
};

/** A cell key as one number, for maps: keys reach a few cells past the scene on every side (off-scene wall hosts), and at most 229 inside it. */
export function cellId(c: GroundCell): number {
  return (c.row + 4096) * 8192 + (c.col + 4096);
}

export function sameCell(a: GroundCell, b: GroundCell): boolean {
  return a.col === b.col && a.row === b.row;
}

/** A square's four sides in the order the relief keeps: north, east, south, west. */
const SQUARE_STEPS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** How many sides a cell has: 4 squares, 6 hexes. */
export function sideCount(grid: Grid): number {
  return isHex(grid) ? 6 : 4;
}

const hexPolys: Record<"rows" | "columns", Map<number, readonly Point[]>> = { rows: new Map(), columns: new Map() };

/**
 * A cell's polygon in world cells. A square's corners run from its top
 * left clockwise. A hex's are its canonical corners in hex.ts hexCorners
 * order, so neighbors share their corner points exactly.
 */
export function cellPolygon(grid: Grid, c: GroundCell): readonly Point[] {
  if (!isHex(grid)) return [{ x: c.col, y: c.row }, { x: c.col + 1, y: c.row }, { x: c.col + 1, y: c.row + 1 }, { x: c.col, y: c.row + 1 }];
  const cache = hexPolys[grid.orient];
  const id = cellId(c);
  let poly = cache.get(id);
  if (!poly) {
    poly = hexCorners(grid, { col: c.col, row: c.row }).map((k) => cornerAt(grid, k));
    // Bounded, so a long session over many scenes keeps a modest cache.
    if (cache.size > 200_000) cache.clear();
    cache.set(id, poly);
  }
  return poly;
}

export function cellCenter(grid: Grid, c: GroundCell): Point {
  return isHex(grid) ? hexCenter(grid, { col: c.col, row: c.row }) : { x: c.col + 0.5, y: c.row + 0.5 };
}

/** The cell across side `i`: a square's in north, east, south, west order, a hex's in hex.ts hexNeighbors order. */
export function neighborOf(grid: Grid, c: GroundCell, i: number): GroundCell {
  if (isHex(grid)) return hexNeighbors(grid, { col: c.col, row: c.row })[i]!;
  const [dx, dy] = SQUARE_STEPS[i]!;
  return { col: c.col + dx, row: c.row + dy };
}

/** Every neighbor across a side, in side order. */
export function neighborsOf(grid: Grid, c: GroundCell): GroundCell[] {
  if (isHex(grid)) return hexNeighbors(grid, { col: c.col, row: c.row });
  return SQUARE_STEPS.map(([dx, dy]) => ({ col: c.col + dx, row: c.row + dy }));
}

/**
 * Side `i`'s two ends. A square keeps the relief's existing ends, so its
 * pixels do not move. A hex's side toward neighbor `d` runs between its
 * corners d + 1 and d + 2, as walls.ts hexSideEnds reads it.
 */
export function sideEnds(grid: Grid, c: GroundCell, i: number): [Point, Point] {
  if (isHex(grid)) {
    const poly = cellPolygon(grid, c);
    return [poly[(i + 1) % 6]!, poly[(i + 2) % 6]!];
  }
  const { col: x, row: y } = c;
  switch (i) {
    case 0:
      return [{ x, y }, { x: x + 1, y }];
    case 1:
      return [{ x: x + 1, y }, { x: x + 1, y: y + 1 }];
    case 2:
      return [{ x, y: y + 1 }, { x: x + 1, y: y + 1 }];
    default:
      return [{ x, y }, { x, y: y + 1 }];
  }
}

/** The outward step across side `i`, center to neighbor's center: what says whether the side faces a viewer. */
export function sideOutward(grid: Grid, c: GroundCell, i: number): Point {
  if (!isHex(grid)) {
    const [dx, dy] = SQUARE_STEPS[i]!;
    return { x: dx, y: dy };
  }
  const a = cellCenter(grid, c);
  const b = cellCenter(grid, neighborOf(grid, c, i));
  return { x: b.x - a.x, y: b.y - a.y };
}

export function cellInScene(grid: Grid, bounds: { w: number; h: number }, c: GroundCell): boolean {
  if (isHex(grid)) return hexInScene(grid, bounds, { col: c.col, row: c.row });
  return c.col >= 0 && c.row >= 0 && c.col < bounds.w && c.row < bounds.h;
}

/** How far a scene's keys run: its size on squares, sceneHexSpan on hexes. */
export function keySpan(grid: Grid, bounds: { w: number; h: number }): { cols: number; rows: number } {
  return isHex(grid) ? sceneHexSpan(grid, bounds) : { cols: bounds.w, rows: bounds.h };
}

/** The sign of the polygon's turning: hex rows wind one way, hex columns, their mirror, the other. */
function winding(poly: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a >= 0 ? 1 : -1;
}

/**
 * Where a point lies against a convex polygon: 1 strictly inside, 0 on its
 * boundary within `eps`, -1 outside.
 */
export function polygonSide(poly: readonly Point[], p: Point, eps = 1e-12): -1 | 0 | 1 {
  const w = winding(poly);
  let on = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = w * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (cross < -eps) return -1;
    if (cross <= eps) on = true;
  }
  return on ? 0 : 1;
}

/** Rows lattice order, the tie order every hex reader keeps: the smaller row, then the smaller column (on hex columns, the smaller column, then the smaller row). */
function latticeBefore(grid: HexGrid, a: GroundCell, b: GroundCell): boolean {
  const [ar, ac, br, bc] = grid.orient === "rows" ? [a.row, a.col, b.row, b.col] : [a.col, a.row, b.col, b.row];
  return ar !== br ? ar < br : ac < bc;
}

/**
 * The cell whose drawn polygon holds a world point, scene or not: a
 * square's floor, and on hexes the canonical polygon, `hexAt` first and
 * its six neighbors when rounding put the point across an edge. A point on
 * a shared edge goes by the lattice tie order.
 */
export function cellAtPoint(grid: Grid, p: Point): GroundCell {
  if (!isHex(grid)) return { col: Math.floor(p.x), row: Math.floor(p.y) };
  const guess = hexAt(grid, p);
  const first = { col: guess.col, row: guess.row };
  if (polygonSide(cellPolygon(grid, first), p) === 1) return first;
  let best: GroundCell | null = null;
  for (const c of [first, ...neighborsOf(grid, first)]) {
    if (polygonSide(cellPolygon(grid, c), p) < 0) continue;
    if (!best || latticeBefore(grid, c, best)) best = c;
  }
  return best ?? first;
}

/** Whether a convex polygon meets a closed rectangle, by separating axes: the rectangle's two and the polygon's sides. */
function polygonMeetsRect(poly: readonly Point[], r: WorldRect): boolean {
  let px0 = Infinity;
  let py0 = Infinity;
  let px1 = -Infinity;
  let py1 = -Infinity;
  for (const p of poly) {
    px0 = Math.min(px0, p.x);
    py0 = Math.min(py0, p.y);
    px1 = Math.max(px1, p.x);
    py1 = Math.max(py1, p.y);
  }
  if (px1 < r.x0 || px0 > r.x1 || py1 < r.y0 || py0 > r.y1) return false;
  const w = winding(poly);
  const corners = [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    // Every rectangle corner strictly outside this side separates them.
    if (corners.every((c) => w * ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < -1e-12)) return false;
  }
  return true;
}

/**
 * The cells whose polygons meet a world rectangle: on squares the cells
 * the existing loops read (floor to ceil, at least one), on hexes every
 * hex the rectangle touches. `bounds` keeps only the scene's cells, and
 * null keeps the lattice's off the scene too, the perimeter hosts.
 */
export function cellsMeeting(grid: Grid, box: WorldRect, bounds: { w: number; h: number } | null): GroundCell[] {
  const out: GroundCell[] = [];
  if (!isHex(grid)) {
    const x0 = Math.floor(box.x0);
    const y0 = Math.floor(box.y0);
    const x1 = Math.max(x0 + 1, Math.ceil(box.x1));
    const y1 = Math.max(y0 + 1, Math.ceil(box.y1));
    for (let y = bounds ? Math.max(0, y0) : y0; y < (bounds ? Math.min(bounds.h, y1) : y1); y++) {
      for (let x = bounds ? Math.max(0, x0) : x0; x < (bounds ? Math.min(bounds.w, x1) : x1); x++) out.push({ col: x, row: y });
    }
    return out;
  }
  // The whole scene, as a fit or a drag's levels ask: its hexes in order, without a test each.
  if (bounds && box.x0 <= 0 && box.y0 <= 0 && box.x1 >= bounds.w && box.y1 >= bounds.h) return sceneHexes(grid, bounds).map((h) => ({ col: h.col, row: h.row }));
  const { r0, r1, c0, c1 } = hexSpan(grid, box);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = grid.orient === "rows" ? { col: c, row: r } : { col: r, row: c };
      if (bounds && !hexInScene(grid, bounds, cell)) continue;
      if (polygonMeetsRect(cellPolygon(grid, cell), box)) out.push(cell);
    }
  }
  return out;
}

/** The lattice rows and columns of hexes that can meet a box, in the rows frame (a columns grid swaps them). */
function hexSpan(grid: HexGrid, box: WorldRect): { r0: number; r1: number; c0: number; c1: number } {
  // On the rows lattice a hex's row r spans y from r·S to r·S + 2R, and its column c spans x from c to c + 1.5.
  const S = 0.8660254037844386;
  const R2 = 1.1547005383792515;
  const m = grid.orient === "rows" ? box : { x0: box.y0, y0: box.x0, x1: box.y1, y1: box.x1 };
  return { r0: Math.floor((m.y0 - R2) / S) - 1, r1: Math.ceil(m.y1 / S) + 1, c0: Math.floor(m.x0 - 1.5) - 1, c1: Math.ceil(m.x1) + 1 };
}

/**
 * The hexes `cellsMeeting` gives for a box with no scene bounds, in the
 * same order, one at a time, and `null` after each candidate it tests and
 * rejects: a build sliced by a budget charges every candidate as it goes,
 * so a large box never runs past the build's slice in one enumeration.
 */
export function* hexesMeeting(grid: HexGrid, box: WorldRect): Generator<GroundCell | null, void, void> {
  const { r0, r1, c0, c1 } = hexSpan(grid, box);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = grid.orient === "rows" ? { col: c, row: r } : { col: r, row: c };
      yield polygonMeetsRect(cellPolygon(grid, cell), box) ? cell : null;
    }
  }
}

/** The world box holding every scene cell's polygon: past it the drawn ground is 0. */
export function sceneExtent(grid: Grid, bounds: { w: number; h: number }): WorldRect {
  if (!isHex(grid)) return { x0: 0, y0: 0, x1: bounds.w, y1: bounds.h };
  // Every hex of the scene lies inside its rectangle (hex.ts hexInScene), rounded corners within 1/128 of it.
  return { x0: -1 / 64, y0: -1 / 64, x1: bounds.w + 1 / 64, y1: bounds.h + 1 / 64 };
}

/**
 * The parameters along a line `a + t·d` inside a convex polygon, the
 * closed interval, or null where the line misses it. The ray walk and the
 * wall splits read it.
 */
export function lineInterval(poly: readonly Point[], a: Point, d: Point): [number, number] | null {
  const w = winding(poly);
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    // Inside where w·cross(q - p, x - p) >= 0, linear in t.
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const c0 = w * (ex * (a.y - p.y) - ey * (a.x - p.x));
    const c1 = w * (ex * d.y - ey * d.x);
    if (c1 === 0) {
      if (c0 < 0) return null;
      continue;
    }
    const t = -c0 / c1;
    if (c1 > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The most a rule-bound hit point moves toward its cell's center, in cells (D-261030-460). */
export const HIT_RECONCILE = 1 / 64;

/**
 * A hit point every reader names by the same cell: a pick on a rounded
 * hex edge or a near face can lie where `hexAt` names the neighbor, so the
 * point moves toward the hit hex's center only as far as `hexAt` needs to
 * agree, at most HIT_RECONCILE (section 7). The geometric point stays for
 * screen geometry. Squares pass their point through, as their face nudge
 * already keeps it inside.
 */
export function ruleBoundPoint(grid: Grid, cell: GroundCell, p: Point): Point {
  if (!isHex(grid)) return p;
  const hex = { col: cell.col, row: cell.row };
  if (sameHex(hexAt(grid, p), hex)) return p;
  const c = hexCenter(grid, hex);
  const dx = c.x - p.x;
  const dy = c.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return c;
  // 64 steps of 1/4096 cell: fine enough that the first one that agrees moves no further than it must.
  for (let k = 1; k <= 64; k++) {
    const t = Math.min(1, (k * HIT_RECONCILE) / 64 / len);
    const q = { x: p.x + dx * t, y: p.y + dy * t };
    if (sameHex(hexAt(grid, q), hex)) return q;
  }
  return { x: p.x + (dx / len) * Math.min(len, HIT_RECONCILE), y: p.y + (dy / len) * Math.min(len, HIT_RECONCILE) };
}

/**
 * The cells a creature stands on: on hexes its actual hexes
 * (footprint.ts occupiedHexes), squeezed when the token is, and on squares
 * the cells of its footprint. Never a hex range's bounding cells.
 */
export function footprintCells(grid: Grid, token: PlacedToken): GroundCell[] {
  if (isHex(grid)) return occupiedHexes(grid, token).map((h) => ({ col: h.col, row: h.row }));
  const r = occupiedRange(grid, token);
  const out: GroundCell[] = [];
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) out.push({ col: x, row: y });
  return out;
}

/**
 * A surface over a cell reader: `atCell` gives a scene cell's drawn
 * ground, and everything off the scene reads 0.
 */
export function groundSurface(grid: Grid, bounds: { w: number; h: number }, atCell: (c: GroundCell) => number): GroundSurface {
  const read = (c: GroundCell) => (cellInScene(grid, bounds, c) ? atCell(c) : 0);
  return {
    grid,
    bounds,
    atCell: read,
    atPoint: (p) => read(cellAtPoint(grid, p)),
    cellsIn: (box) => cellsMeeting(grid, box, bounds),
    polygon: (c) => cellPolygon(grid, c),
  };
}
