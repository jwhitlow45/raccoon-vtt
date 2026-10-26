import { HEX_R, HEX_S, hexInScene, sceneHexSpan, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import type { Point } from "../../lib/camera.ts";

/**
 * The hexes whose shapes may meet a convex polygon on the ground, such as
 * the canvas's corners seen on the ground in the isometric view
 * (docs/design-v1-isometric-view.md 4.4, the hex design's HX-D18). Each
 * row of the hex lattice takes only the span of hexes across the polygon's
 * width over that row's band, so the work is the hexes on screen, not the
 * 6.6 times as many in the polygon's bounding box. The hex lines draw from
 * this (MapLayer.tsx), once the hex lines draw on the client.
 */
export function hexesInView(g: HexGrid, bounds: { w: number; h: number }, polygon: readonly Point[]): Hex[] {
  if (polygon.length === 0) return [];
  // On hex columns the lattice's rows run down the map: the same walk with x and y swapped.
  const pts = g.orient === "rows" ? polygon : polygon.map((p) => ({ x: p.y, y: p.x }));
  const span = sceneHexSpan(g, bounds);
  const rows = g.orient === "rows" ? span.rows : span.cols;
  const along = g.orient === "rows" ? span.cols : span.rows;
  const ys = pts.map((p) => p.y);
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - 2 * HEX_R) / HEX_S));
  const r1 = Math.min(rows - 1, Math.ceil((Math.max(...ys) + HEX_R) / HEX_S));
  const out: Hex[] = [];
  for (let r = r0; r <= r1; r++) {
    const cy = HEX_R + r * HEX_S;
    const extent = bandExtent(pts, cy - HEX_R, cy + HEX_R);
    if (!extent) continue;
    const shift = 0.5 + 0.5 * (r - 2 * Math.floor(r / 2));
    // A hex reaches half a cell either side of its center.
    const c0 = Math.max(0, Math.floor(extent[0] - 0.5 - shift));
    const c1 = Math.min(along - 1, Math.ceil(extent[1] + 0.5 - shift));
    for (let c = c0; c <= c1; c++) {
      const h = g.orient === "rows" ? { col: c, row: r } : { col: r, row: c };
      if (hexInScene(g, bounds, h)) out.push(h);
    }
  }
  return out;
}

/** The x a convex polygon spans over the band from y0 to y1, or null when it misses the band. */
function bandExtent(pts: readonly Point[], y0: number, y1: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (x: number) => {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (a.y >= y0 && a.y <= y1) take(a.x);
    for (const y of [y0, y1]) {
      if ((a.y - y) * (b.y - y) < 0) take(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}
