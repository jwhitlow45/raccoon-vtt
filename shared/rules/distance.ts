import type { DiagonalRule, RoomSettings } from "../model.ts";
import { occupiedHexes, occupiedRange, verticalExtentFt, type FootprintToken } from "./footprint.ts";
import type { Grid } from "./grid.ts";
import { hexAt, hexDistance, type Hex, type HexGrid } from "./hex.ts";

/**
 * Grid distance (design section 9.2).
 *
 * Everything is counted in steps between cells on each axis, then turned into
 * feet by the room's diagonal rule. Creatures and ruler points share one
 * representation, a box of whole cells, so "the same function between points"
 * holds by construction: a point is a box one cell on each side.
 *
 * On hexes (docs/design-v1-hex-grids.md 4.3) a box also holds the hexes it
 * stands on, and the steps between two boxes are the fewest hex steps
 * between any hex of one and any hex of the other, with no second axis:
 * a hex has no diagonal, so the room's rule only combines those steps with
 * the vertical ones. A box is built for a grid, so the typecheck lists
 * every place that builds one.
 */

export type DistanceSettings = Pick<RoomSettings, "feetPerCell" | "diagonal">;

/**
 * Half-open whole-cell ranges on each axis. z is in cells, converted from
 * feet. On hexes `hexes` holds what it stands on, and x and y are the cells
 * those hexes reach into (footprint.ts occupiedRange).
 */
export type CellBox = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; hexes?: HexCells };

/** The hexes a box stands on, with their grid, whose orientation the steps between them read. */
export type HexCells = { g: HexGrid; at: readonly Hex[] };

/** A ruler point: x and y in cells, z in feet (0 when omitted). */
export type RulerPoint = { x: number; y: number; z?: number };

/**
 * Diagonals counted so far on a path, for the fiveTen rule. `h` counts
 * horizontal diagonals, `v` the diagonals of the second, vertical pass.
 */
export type DiagonalCounter = { h: number; v: number };

export function tokenCellBox(g: Grid, token: FootprintToken, feetPerCell: number): CellBox {
  const r = occupiedRange(g, token);
  const { lo, hi } = verticalExtentFt(token, feetPerCell);
  const z0 = Math.floor(lo / feetPerCell);
  // A zero-height object still occupies the layer of cells it stands in.
  const z1 = Math.max(z0 + 1, Math.ceil(hi / feetPerCell));
  const box: CellBox = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, z0, z1 };
  if (g.shape === "hex") box.hexes = { g, at: occupiedHexes(g, token) };
  return box;
}

/** A ruler point's box: its cell, or on hexes the hex that holds it (hex.ts hexAt). */
export function pointCellBox(g: Grid, p: RulerPoint, feetPerCell: number): CellBox {
  const x0 = Math.floor(p.x);
  const y0 = Math.floor(p.y);
  const z0 = Math.floor((p.z ?? 0) / feetPerCell);
  const box: CellBox = { x0, x1: x0 + 1, y0, y1: y0 + 1, z0, z1: z0 + 1 };
  if (g.shape === "hex") box.hexes = { g, at: [hexAt(g, p)] };
  return box;
}

/**
 * Steps between two half-open ranges: "count from a square adjacent to one to
 * the other's square". Adjacent ranges are 1 step apart, overlapping ones 0.
 */
export function axisSteps(a0: number, a1: number, b0: number, b1: number): number {
  return b0 >= a1 ? b0 - a1 + 1 : a0 >= b1 ? a0 - b1 + 1 : 0;
}

/**
 * Steps between two boxes on each axis. On hexes `dx` is the fewest hex
 * steps between any hex of one and any of the other (4.3), shared hexes 0
 * and neighbors 1, and `dy` is 0, so the diagonal rules read them as
 * straight steps: `five` gives max(h, v), `euclid` hypot(h, v), and
 * `fiveTen` carries only its vertical counter.
 */
export function stepsBetween(a: CellBox, b: CellBox): { dx: number; dy: number; dz: number } {
  const dz = axisSteps(a.z0, a.z1, b.z0, b.z1);
  if (a.hexes && b.hexes) return { dx: hexSetSteps(a.hexes.g, a.hexes.at, b.hexes.at), dy: 0, dz };
  return {
    dx: axisSteps(a.x0, a.x1, b.x0, b.x1),
    dy: axisSteps(a.y0, a.y1, b.y0, b.y1),
    dz,
  };
}

/** The fewest hex steps between any hex of `a` and any of `b`: at most 12 by 12 pairs, a Gargantuan's. */
export function hexSetSteps(g: HexGrid, a: readonly Hex[], b: readonly Hex[]): number {
  let steps = Infinity;
  for (const h of a) for (const k of b) steps = Math.min(steps, hexDistance(g, h, k));
  return steps;
}

/**
 * Feet for one leg of `dx`, `dy`, `dz` steps. Under fiveTen, `counter` carries
 * the diagonals already taken, so every second diagonal costs double across
 * the whole path (the DMG variant), and it is updated in place. A fresh
 * counter gives `max + floor(min / 2)` horizontally, then the same rule again
 * between that result and the vertical steps.
 *
 * Euclid is returned unrounded so a caller can choose where to round.
 */
export function legFeet(
  dx: number,
  dy: number,
  dz: number,
  rule: DiagonalRule,
  feetPerCell: number,
  counter: DiagonalCounter = { h: 0, v: 0 },
): number {
  if (rule === "five") return Math.max(dx, dy, dz) * feetPerCell;
  if (rule === "euclid") return Math.hypot(dx, dy, dz) * feetPerCell;
  const hMin = Math.min(dx, dy);
  const horizontal = Math.max(dx, dy) + Math.floor((counter.h + hMin) / 2) - Math.floor(counter.h / 2);
  counter.h += hMin;
  const vMin = Math.min(horizontal, dz);
  const total = Math.max(horizontal, dz) + Math.floor((counter.v + vMin) / 2) - Math.floor(counter.v / 2);
  counter.v += vMin;
  return total * feetPerCell;
}

function roundFeet(ft: number, rule: DiagonalRule): number {
  return rule === "euclid" ? Math.round(ft) : ft;
}

/** Distance in feet between two creatures on a scene's grid. Symmetric. */
export function distanceFt(g: Grid, a: FootprintToken, b: FootprintToken, settings: DistanceSettings): number {
  return boxDistanceFt(tokenCellBox(g, a, settings.feetPerCell), tokenCellBox(g, b, settings.feetPerCell), settings);
}

export function boxDistanceFt(a: CellBox, b: CellBox, settings: DistanceSettings): number {
  const { dx, dy, dz } = stepsBetween(a, b);
  return roundFeet(legFeet(dx, dy, dz, settings.diagonal, settings.feetPerCell), settings.diagonal);
}

/**
 * A measured path through stops (cell boxes, so a ruler can start or end on a
 * token). Each leg is rounded on its own and the total is their sum, so the
 * numbers a ruler shows always add up.
 */
export function pathDistanceFt(stops: readonly CellBox[], settings: DistanceSettings): { totalFt: number; legsFt: number[] } {
  const counter: DiagonalCounter = { h: 0, v: 0 };
  const legsFt: number[] = [];
  let totalFt = 0;
  for (let i = 1; i < stops.length; i++) {
    const { dx, dy, dz } = stepsBetween(stops[i - 1]!, stops[i]!);
    const ft = roundFeet(legFeet(dx, dy, dz, settings.diagonal, settings.feetPerCell, counter), settings.diagonal);
    legsFt.push(ft);
    totalFt += ft;
  }
  return { totalFt, legsFt };
}

export function rulerDistanceFt(g: Grid, points: readonly RulerPoint[], settings: DistanceSettings): { totalFt: number; legsFt: number[] } {
  return pathDistanceFt(
    points.map((p) => pointCellBox(g, p, settings.feetPerCell)),
    settings,
  );
}

export function pointDistanceFt(g: Grid, a: RulerPoint, b: RulerPoint, settings: DistanceSettings): number {
  return boxDistanceFt(pointCellBox(g, a, settings.feetPerCell), pointCellBox(g, b, settings.feetPerCell), settings);
}
