import { legFeet, pointCellBox, stepsBetween, tokenCellBox, type CellBox } from "#shared/rules/distance.ts";
import { hexAnchor, type FootprintToken } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexCenter, hexInScene, hexKey, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
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
 * A ring on hexes: the sides between a hex in range and a scene hex out
 * of range, found by walking out from the token's hexes a step at a time
 * as far as the range could reach, so it costs the hexes round the ring.
 * The label goes on the top or bottom point of the ring over the token's
 * anchor, where its hexes meet a side the ring draws.
 */
function hexRingShape(g: HexGrid, token: FootprintToken, rangeFt: number, rules: DistanceRules, bounds: { w: number; h: number }): RingShape {
  const box = tokenCellBox(g, token, rules.feetPerCell);
  const own = box.hexes?.at ?? [];
  const reach = Math.ceil(rangeFt / rules.feetPerCell) + 1;
  const ground = (h: Hex) => pointCellBox(g, hexCenter(g, h), rules.feetPerCell);
  // Every scene hex within `reach` steps of the token's hexes, each with whether it is in range.
  const inside = new Map<string, boolean>();
  let edge = own.filter((h) => hexInScene(g, bounds, h));
  const seen = new Set(own.map(hexKey));
  for (const h of edge) inside.set(hexKey(h), groundInRange(box, ground(h), rangeFt, rules));
  for (let step = 0; step < reach && edge.length > 0; step++) {
    const next: Hex[] = [];
    for (const h of edge) {
      for (const n of hexNeighbors(g, h)) {
        const k = hexKey(n);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!hexInScene(g, bounds, n)) continue;
        inside.set(k, groundInRange(box, ground(n), rangeFt, rules));
        next.push(n);
      }
    }
    edge = next;
  }
  const corners = hexPointsAround(g);
  const segments: number[] = [];
  const kept: Hex[] = [];
  for (const [k, inRange] of inside) {
    if (!inRange) continue;
    const [col, row] = k.split(",").map(Number) as [number, number];
    const h = { col, row };
    kept.push(h);
    const c = hexCenter(g, h);
    const around = hexNeighbors(g, h);
    for (let i = 0; i < 6; i++) {
      const n = around[i]!;
      // A side on the scene's edge is not the ring's, as on squares.
      if (inside.get(hexKey(n)) !== false) continue;
      const [a, b] = corners[i]!;
      segments.push(c.x + a.x, c.y + a.y, c.x + b.x, c.y + b.y);
    }
  }
  return { segments, label: hexRingLabel(g, token, kept, inside) };
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
 * its center is no further across than its own half width.
 */
function hexRingLabel(g: HexGrid, token: FootprintToken, kept: readonly Hex[], inside: ReadonlyMap<string, boolean>): RingShape["label"] {
  const a = hexAnchor(g, token);
  const half = g.orient === "rows" ? { x: 0.5, y: HEX_R } : { x: HEX_R, y: 0.5 };
  let top: { h: Hex; y: number } | null = null;
  let bottom: { h: Hex; y: number } | null = null;
  for (const h of kept) {
    const c = hexCenter(g, h);
    if (Math.abs(c.x - a.x) > half.x + 1e-9) continue;
    if (!top || c.y < top.y) top = { h, y: c.y };
    if (!bottom || c.y > bottom.y) bottom = { h, y: c.y };
  }
  // The ring draws a side above (below) its end hex where a neighbor that way is out of range on the scene.
  const opens = (h: Hex, up: boolean) => hexNeighbors(g, h).some((n) => (hexCenter(g, n).y < hexCenter(g, h).y) === up && hexCenter(g, n).y !== hexCenter(g, h).y && inside.get(hexKey(n)) === false);
  if (top && opens(top.h, true)) {
    const c = hexCenter(g, top.h);
    return { x: c.x, y: c.y - half.y, below: false };
  }
  if (bottom && opens(bottom.h, false)) {
    const c = hexCenter(g, bottom.h);
    return { x: c.x, y: c.y + half.y, below: true };
  }
  return null;
}

/** "30 ft", or "30/60 ft" style for the menu's summary of a token's rings. */
export function ringsText(rings: readonly number[]): string {
  return rings.length === 0 ? "None" : `${rings.join("/")} ft`;
}
