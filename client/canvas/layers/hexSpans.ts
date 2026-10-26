import { HEX_R, HEX_S, hexInScene, sceneHexSpan, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import type { Point } from "../../lib/camera.ts";

/**
 * The hexes whose shapes may meet a convex polygon on the ground, such as
 * the canvas's corners seen on the ground in the isometric view
 * (docs/design-v1-isometric-view.md 4.4, the hex design's HX-D18). Each
 * row of the hex lattice takes only the span of hexes across the polygon's
 * width over that row's band, so the work is the hexes on screen, not the
 * 6.6 times as many in the polygon's bounding box. The hex lines draw from
 * these spans (`strokeHexLines`, MapLayer.tsx).
 */
export function hexesInView(g: HexGrid, bounds: { w: number; h: number }, polygon: readonly Point[]): Hex[] {
  const out: Hex[] = [];
  for (const { r, c0, c1 } of hexRowSpans(g, bounds, polygon)) {
    for (let c = c0; c <= c1; c++) out.push(g.orient === "rows" ? { col: c, row: r } : { col: r, row: c });
  }
  return out;
}

/**
 * The same hexes as row spans of the rows lattice (hex.ts: hex columns read
 * with x and y swapped): for each lattice row `r` in view, the run of
 * lattice columns `c0` to `c1` it holds, every one of them a scene hex.
 */
export type HexRowSpan = { r: number; c0: number; c1: number };

export function hexRowSpans(g: HexGrid, bounds: { w: number; h: number }, polygon: readonly Point[]): HexRowSpan[] {
  if (polygon.length === 0) return [];
  // On hex columns the lattice's rows run down the map: the same walk with x and y swapped.
  const pts = g.orient === "rows" ? polygon : polygon.map((p) => ({ x: p.y, y: p.x }));
  const span = sceneHexSpan(g, bounds);
  const rows = g.orient === "rows" ? span.rows : span.cols;
  const along = g.orient === "rows" ? span.cols : span.rows;
  const ys = pts.map((p) => p.y);
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - 2 * HEX_R) / HEX_S));
  const r1 = Math.min(rows - 1, Math.ceil((Math.max(...ys) + HEX_R) / HEX_S));
  const out: HexRowSpan[] = [];
  for (let r = r0; r <= r1; r++) {
    const cy = HEX_R + r * HEX_S;
    const extent = bandExtent(pts, cy - HEX_R, cy + HEX_R);
    if (!extent) continue;
    const shift = 0.5 + 0.5 * (r - 2 * Math.floor(r / 2));
    // A hex reaches half a cell either side of its center.
    let c0 = Math.max(0, Math.floor(extent[0] - 0.5 - shift));
    let c1 = Math.min(along - 1, Math.ceil(extent[1] + 0.5 - shift));
    // A row's scene hexes run from its first column without a gap, so trimming its ends leaves a span.
    const at = (c: number) => (g.orient === "rows" ? { col: c, row: r } : { col: r, row: c });
    while (c0 <= c1 && !hexInScene(g, bounds, at(c0))) c0++;
    while (c1 >= c0 && !hexInScene(g, bounds, at(c1))) c1--;
    if (c0 <= c1) out.push({ r, c0, c1 });
  }
  return out;
}

/** Where a path goes: the canvas's own two calls, so the lines draw straight into Konva's context and a test counts them. */
export type PathSink = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void };

/**
 * The hex lines of the spans, each side once (HX-D18): a hex draws its
 * west and two upper sides, and its east and two lower sides only where
 * no hex in view lies across them, so a side two hexes share is drawn by
 * one of them and the edge of the view or the scene is closed. Corners are
 * worked out from each hex's center here, for drawing only: no rule reads
 * them, so they need not be the rules' rounded corners (hex.ts cornerAt).
 */
export function strokeHexLines(g: HexGrid, spans: readonly HexRowSpan[], sink: PathSink): number {
  const swap = g.orient === "columns";
  const move = swap ? (x: number, y: number) => sink.moveTo(y, x) : (x: number, y: number) => sink.moveTo(x, y);
  const line = swap ? (x: number, y: number) => sink.lineTo(y, x) : (x: number, y: number) => sink.lineTo(x, y);
  const byRow = new Map<number, HexRowSpan>();
  for (const s of spans) byRow.set(s.r, s);
  const has = (c: number, r: number) => {
    const s = byRow.get(r);
    return s !== undefined && c >= s.c0 && c <= s.c1;
  };
  const top = HEX_R / 2;
  let sides = 0;
  for (const { r, c0, c1 } of spans) {
    const p = r - 2 * Math.floor(r / 2);
    const cy = HEX_R + r * HEX_S;
    for (let c = c0; c <= c1; c++) {
      const cx = c + 0.5 + 0.5 * p;
      // South-west, west, north-west and north: up the west side and over the top to the north-east point.
      move(cx - 0.5, cy + top);
      line(cx - 0.5, cy - top);
      line(cx, cy - HEX_R);
      line(cx + 0.5, cy - top);
      sides += 3;
      const east = !has(c + 1, r);
      const southEast = !has(c + p, r + 1);
      const southWest = !has(c - 1 + p, r + 1);
      if (east) {
        line(cx + 0.5, cy + top);
        sides++;
      }
      if (southEast) {
        if (!east) move(cx + 0.5, cy + top);
        line(cx, cy + HEX_R);
        sides++;
      }
      if (southWest) {
        if (!southEast) move(cx, cy + HEX_R);
        line(cx - 0.5, cy + top);
        sides++;
      }
    }
  }
  return sides;
}

/** The fewest screen pixels across a hex at which its lines draw (HX-D18): below it a zoomed-out map would be a grey wash of lines. */
export const HEX_LINES_MIN_PX = 6;

/**
 * The hex lines of what a canvas shows (HX-D18): `corners` the canvas's
 * corners on the ground, `pxPerCell` how many screen pixels a cell takes
 * there, nothing while a hex is under HEX_LINES_MIN_PX. The sides drawn.
 */
export function hexLinesInView(g: HexGrid, bounds: { w: number; h: number }, view: { corners: readonly Point[]; pxPerCell: number }, sink: PathSink): number {
  if (!(view.pxPerCell >= HEX_LINES_MIN_PX)) return 0;
  return strokeHexLines(g, hexRowSpans(g, bounds, view.corners), sink);
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
