import { legFeet, pointCellBox, stepsBetween, tokenCellBox, type CellBox } from "#shared/rules/distance.ts";
import { hexAnchor, type FootprintToken } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { HEX_R, HEX_S, hexCenter, hexInScene, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import type { DistanceRules } from "./ruler.ts";

/**
 * Range rings around a token (features section 4), kept free of React and
 * Konva so they are tested under plain Node.
 *
 * A ring is the edge of the ground cells within its distance, measured the
 * way a ruler from the token to a free point reads (design 9.2): from the
 * token's footprint, with its elevation, under the room's diagonal rule.
 * So "every diagonal 5 ft" draws a square, 5-10-5 an octagon, and true
 * distance a stepped circle, each the exact cells a ruler would call in
 * range. A flier's ring shrinks once its height counts, and is gone when
 * the ground is out of reach. Cells off the scene are left out, and the
 * scene's edge is not drawn as part of a ring.
 *
 * On a hex scene (docs/design-v1-hex-grids.md 4.3) the ring runs along hex
 * sides round the hexes in range, every hex one step from the token's
 * hexes, the room's rule counting only height.
 */

/** Presets offered in the token's menu, the common 2024 spell and weapon ranges. */
export const RING_PRESETS = [5, 10, 15, 30, 60, 90, 120, 150] as const;

export type RingShape = {
  /** Flat `[x0, y0, x1, y1, ...]` segments in cells, one per straight run of edge. */
  segments: number[];
  /**
   * Where the label sits: the middle of the ring's top edge, or of its
   * bottom edge (`below`) when the scene cuts off the top, or null when it
   * cuts off both.
   */
  label: { x: number; y: number; below: boolean } | null;
};

export function ringShape(g: Grid, token: FootprintToken, rangeFt: number, rules: DistanceRules, bounds: { w: number; h: number }): RingShape {
  if (g.shape === "hex") return hexRingShape(g, token, rangeFt, rules, bounds);
  const box = tokenCellBox(g, token, rules.feetPerCell);
  const reach = Math.ceil(rangeFt / rules.feetPerCell) + 1;
  const x0 = Math.max(0, box.x0 - reach);
  const x1 = Math.min(bounds.w, box.x1 + reach);
  const y0 = Math.max(0, box.y0 - reach);
  const y1 = Math.min(bounds.h, box.y1 + reach);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) inside[y * w + x] = boxInRange(box, x0 + x, y0 + y, rangeFt, rules) ? 1 : 0;
  }
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? inside[y * w + x] === 1 : false);
  const onScene = (x: number, y: number) => x0 + x >= 0 && y0 + y >= 0 && x0 + x < bounds.w && y0 + y < bounds.h;

  const segments: number[] = [];
  // Horizontal edges: the top of row y, between rows y - 1 and y.
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && at(x, y - 1) !== at(x, y) && onScene(x, y - 1) && onScene(x, y);
      if (edge && run < 0) run = x;
      if (!edge && run >= 0) {
        segments.push(x0 + run, y0 + y, x0 + x, y0 + y);
        run = -1;
      }
    }
  }
  // Vertical edges: the left of column x, between columns x - 1 and x.
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && at(x - 1, y) !== at(x, y) && onScene(x - 1, y) && onScene(x, y);
      if (edge && run < 0) run = y;
      if (!edge && run >= 0) {
        segments.push(x0 + x, y0 + run, x0 + x, y0 + y);
        run = -1;
      }
    }
  }

  // The label goes on the edge above or below the token's middle column, where the ring is easiest to read.
  const cx = Math.floor((box.x0 + box.x1 - 1) / 2) - x0;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (!at(cx, y)) continue;
    if (top < 0) top = y;
    bottom = y;
  }
  const middle = (box.x0 + box.x1) / 2;
  let label: RingShape["label"] = null;
  if (top >= 0 && y0 + top > 0) label = { x: middle, y: y0 + top, below: false };
  else if (bottom >= 0 && y0 + bottom + 1 < bounds.h) label = { x: middle, y: y0 + bottom + 1, below: true };
  return { segments, label };
}

/** Whether the ground cell (x, y) is within range of the token: what a ring encloses. On hexes, the hex whose center is that point's. */
export function cellInRange(g: Grid, token: FootprintToken, x: number, y: number, rangeFt: number, rules: DistanceRules): boolean {
  const box = tokenCellBox(g, token, rules.feetPerCell);
  if (g.shape === "hex") return groundInRange(box, pointCellBox(g, { x, y }, rules.feetPerCell), rangeFt, rules);
  return boxInRange(box, x, y, rangeFt, rules);
}

function boxInRange(box: CellBox, x: number, y: number, rangeFt: number, rules: DistanceRules): boolean {
  return groundInRange(box, { x0: x, x1: x + 1, y0: y, y1: y + 1, z0: 0, z1: 1 }, rangeFt, rules);
}

function groundInRange(box: CellBox, ground: CellBox, rangeFt: number, rules: DistanceRules): boolean {
  const { dx, dy, dz } = stepsBetween(box, ground);
  const ft = legFeet(dx, dy, dz, rules.diagonal, rules.feetPerCell);
  return (rules.diagonal === "euclid" ? Math.round(ft) : ft) <= rangeFt;
}

/**
 * A ring on hexes: the sides between a scene hex in range and a scene hex
 * out of range. Range on hexes grows with steps alone, the height rule's
 * part the same for every ground hex, so the hexes in range are those
 * within some number of steps of the token's hexes, and the ring runs
 * between the band of hexes exactly that many steps out and the band one
 * step further. Only those two bands are walked, so a 1,000 ft ring costs
 * the hexes round its edge. The token's own hexes may lie off the scene,
 * after a move onto an edge hex or a switch from squares: each band is
 * found from all of them, and only its scene hexes draw.
 */
function hexRingShape(g: HexGrid, token: FootprintToken, rangeFt: number, rules: DistanceRules, bounds: { w: number; h: number }): RingShape {
  const box = tokenCellBox(g, token, rules.feetPerCell);
  const own = box.hexes?.at ?? [];
  const steps = hexStepsInRange(g, box, own, rangeFt, rules);
  if (steps < 0) return { segments: [], label: null };
  const cubes = new OwnCubes(g, own);
  const corners = hexPointsAround(g);
  const segments: number[] = [];
  for (const [q, r] of cubes.band(steps)) {
    const h = cubes.hexOf(q, r);
    if (!hexInScene(g, bounds, h)) continue;
    const c = hexCenter(g, h);
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = CUBE_STEPS[i]!;
      // A side on the scene's edge is not the ring's, as on squares.
      if (cubes.away(q + dq, r + dr) !== steps + 1 || !hexInScene(g, bounds, cubes.hexOf(q + dq, r + dr))) continue;
      const [a, b] = corners[i]!;
      segments.push(c.x + a.x, c.y + a.y, c.x + b.x, c.y + b.y);
    }
  }
  return { segments, label: hexRingLabel(g, token, cubes, steps, bounds) };
}

/** Steps to the six neighbors in cube coordinates (q, r), in hexNeighbors' order, on the rows lattice. */
const CUBE_STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
];

/**
 * A token's hexes in cube coordinates on the rows lattice (hex columns
 * mirrored onto it, as hex.ts does), for the many distance reads a ring
 * makes without building a hex for each.
 */
class OwnCubes {
  private readonly g: HexGrid;
  private readonly qs: number[] = [];
  private readonly rs: number[] = [];

  constructor(g: HexGrid, own: readonly Hex[]) {
    this.g = g;
    for (const h of own) {
      const c = g.orient === "rows" ? h.col : h.row;
      const r = g.orient === "rows" ? h.row : h.col;
      this.qs.push(c - Math.floor(r / 2));
      this.rs.push(r);
    }
  }

  /** The cube coordinates of a hex. */
  cubeOf(h: Hex): [number, number] {
    const c = this.g.orient === "rows" ? h.col : h.row;
    const r = this.g.orient === "rows" ? h.row : h.col;
    return [c - Math.floor(r / 2), r];
  }

  hexOf(q: number, r: number): Hex {
    const c = q + Math.floor(r / 2) + 0;
    return this.g.orient === "rows" ? { col: c, row: r + 0 } : { col: r + 0, row: c };
  }

  /** Steps from the nearest of the token's hexes. */
  away(q: number, r: number): number {
    let best = Infinity;
    for (let i = 0; i < this.qs.length; i++) {
      const dq = q - this.qs[i]!;
      const dr = r - this.rs[i]!;
      const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      if (d < best) best = d;
    }
    return best;
  }

  /** The hexes exactly `k` steps from the nearest of the token's hexes: each own hex's ring of `k`, less what another holds closer. */
  band(k: number): [number, number][] {
    const out: [number, number][] = [];
    const taken = new Set<number>();
    const visit = (q: number, r: number) => {
      // A scene is at most a few thousand cells across, so this key never collides.
      const key = (q + 1e6) * 4e6 + (r + 1e6);
      if (taken.has(key) || this.away(q, r) !== k) return;
      taken.add(key);
      out.push([q, r]);
    };
    for (let i = 0; i < this.qs.length; i++) {
      if (k === 0) {
        visit(this.qs[i]!, this.rs[i]!);
        continue;
      }
      // Round the ring from its start `k` steps one way, as scene.ts hexRing walks it.
      let q = this.qs[i]! + CUBE_STEPS[4]![0] * k;
      let r = this.rs[i]! + CUBE_STEPS[4]![1] * k;
      for (let side = 0; side < 6; side++) {
        const [dq, dr] = CUBE_STEPS[side]!;
        for (let j = 0; j < k; j++) {
          visit(q, r);
          q += dq;
          r += dr;
        }
      }
    }
    return out;
  }
}

/**
 * The most hex steps from a token's hexes that are in range of it, the
 * room's rule counting height, or -1 when none is. Feet grow with steps
 * under every rule, so the first step out of range ends the count.
 */
function hexStepsInRange(g: HexGrid, box: CellBox, own: readonly Hex[], rangeFt: number, rules: DistanceRules): number {
  if (own.length === 0) return -1;
  // The ground's height part is the same at every hex, so one ground box gives it.
  const { dz } = stepsBetween(box, pointCellBox(g, hexCenter(g, own[0]!), rules.feetPerCell));
  const inRange = (n: number) => {
    const ft = legFeet(n, 0, dz, rules.diagonal, rules.feetPerCell);
    return (rules.diagonal === "euclid" ? Math.round(ft) : ft) <= rangeFt;
  };
  const most = Math.ceil(rangeFt / rules.feetPerCell);
  let n = -1;
  while (n < most && inRange(n + 1)) n++;
  return n;
}

/**
 * The two corners of the side a hex shares with each neighbor, in
 * hexNeighbors' order, as offsets from its center: on hex rows east, south
 * east, south west, west, north west and north east, mirrored on columns.
 */
function hexPointsAround(g: HexGrid): [{ x: number; y: number }, { x: number; y: number }][] {
  const half = HEX_R / 2;
  const n = { x: 0, y: -HEX_R };
  const ne = { x: 0.5, y: -half };
  const se = { x: 0.5, y: half };
  const s = { x: 0, y: HEX_R };
  const sw = { x: -0.5, y: half };
  const nw = { x: -0.5, y: -half };
  const rows: [{ x: number; y: number }, { x: number; y: number }][] = [
    [ne, se],
    [se, s],
    [s, sw],
    [sw, nw],
    [nw, n],
    [n, ne],
  ];
  return g.orient === "rows" ? rows : rows.map(([a, b]) => [{ x: a.y, y: a.x }, { x: b.y, y: b.x }]);
}

/**
 * Where a hex ring's label sits: the top of the highest hex in range over
 * the token's anchor, or the bottom of the lowest when the scene's edge
 * cuts the top, or none when it cuts both. A hex is over the anchor when
 * its center is no further across than its own half width, and of two in
 * one row the one further left counts.
 */
function hexRingLabel(g: HexGrid, token: FootprintToken, cubes: OwnCubes, steps: number, bounds: { w: number; h: number }): RingShape["label"] {
  const a = hexAnchor(g, token);
  const half = g.orient === "rows" ? { x: 0.5, y: HEX_R } : { x: HEX_R, y: 0.5 };
  const held = (h: Hex) => hexInScene(g, bounds, h) && cubes.away(...cubes.cubeOf(h)) <= steps;
  const out = (h: Hex) => hexInScene(g, bounds, h) && cubes.away(...cubes.cubeOf(h)) > steps;
  let top: { h: Hex; x: number; y: number } | null = null;
  let bottom: { h: Hex; x: number; y: number } | null = null;
  for (const h of hexesOver(g, a, steps + 8)) {
    const c = hexCenter(g, h);
    if (Math.abs(c.x - a.x) > half.x + 1e-9 || !held(h)) continue;
    if (!top || c.y < top.y || (c.y === top.y && c.x < top.x)) top = { h, x: c.x, y: c.y };
    if (!bottom || c.y > bottom.y || (c.y === bottom.y && c.x < bottom.x)) bottom = { h, x: c.x, y: c.y };
  }
  // The ring draws a side above (below) its end hex where a neighbor that way is out of range on the scene.
  const opens = (h: Hex, up: boolean) => hexNeighbors(g, h).some((n) => (hexCenter(g, n).y < hexCenter(g, h).y) === up && hexCenter(g, n).y !== hexCenter(g, h).y && out(n));
  if (top && opens(top.h, true)) return { x: top.x, y: top.y - half.y, below: false };
  if (bottom && opens(bottom.h, false)) return { x: bottom.x, y: bottom.y + half.y, below: true };
  return null;
}

/**
 * The hexes whose centers lie within a hex's half width across of `a`,
 * and within `span` cells up or down: one or two a row on hex rows, one or
 * two columns on hex columns. A few at each end may fall outside the band,
 * which the caller's own test leaves out.
 */
function* hexesOver(g: HexGrid, a: { x: number; y: number }, span: number): Generator<Hex> {
  if (g.orient === "rows") {
    for (let r = Math.floor((a.y - span) / HEX_S) - 1; r <= Math.ceil((a.y + span) / HEX_S) + 1; r++) {
      const shift = r - 2 * Math.floor(r / 2) === 1 ? 0.5 : 0;
      for (let c = Math.floor(a.x - 1 - shift) - 1; c <= Math.ceil(a.x - shift) + 1; c++) yield { col: c, row: r };
    }
    return;
  }
  for (let col = Math.floor((a.x - 2 * HEX_R) / HEX_S) - 1; col <= Math.ceil(a.x / HEX_S) + 1; col++) {
    for (let row = Math.floor(a.y - span) - 1; row <= Math.ceil(a.y + span) + 1; row++) yield { col, row };
  }
}

/** "30 ft", or "30/60 ft" style for the menu's summary of a token's rings. */
export function ringsText(rings: readonly number[]): string {
  return rings.length === 0 ? "None" : `${rings.join("/")} ft`;
}
