import { legFeet, stepsBetween, tokenCellBox, type CellBox } from "#shared/rules/distance.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import type { DistanceRules } from "./ruler.ts";
import { SQUARES } from "#shared/rules/grid.ts";

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

export function ringShape(token: FootprintToken, rangeFt: number, rules: DistanceRules, bounds: { w: number; h: number }): RingShape {
  const box = tokenCellBox(SQUARES, token, rules.feetPerCell);
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

/** Whether the ground cell (x, y) is within range of the token: what a ring encloses. */
export function cellInRange(token: FootprintToken, x: number, y: number, rangeFt: number, rules: DistanceRules): boolean {
  return boxInRange(tokenCellBox(SQUARES, token, rules.feetPerCell), x, y, rangeFt, rules);
}

function boxInRange(box: CellBox, x: number, y: number, rangeFt: number, rules: DistanceRules): boolean {
  const { dx, dy, dz } = stepsBetween(box, { x0: x, x1: x + 1, y0: y, y1: y + 1, z0: 0, z1: 1 });
  const ft = legFeet(dx, dy, dz, rules.diagonal, rules.feetPerCell);
  return (rules.diagonal === "euclid" ? Math.round(ft) : ft) <= rangeFt;
}

/** "30 ft", or "30/60 ft" style for the menu's summary of a token's rings. */
export function ringsText(rings: readonly number[]): string {
  return rings.length === 0 ? "None" : `${rings.join("/")} ft`;
}
