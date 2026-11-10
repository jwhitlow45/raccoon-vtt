import { HEX_R, HEX_S, hexInScene, sceneHexSpan, type HexGrid } from "#shared/rules/hex.ts";
import type { Point } from "../../lib/camera.ts";
import { HEX_LINES_MIN_PX, hexRowSpans, type PathSink } from "./hexSpans.ts";

/*
 * The grid's lines as paths in world cells, built once and placed on screen
 * by the camera's matrix (FU52PERF-LEFT). A camera move used to walk every
 * hex in view and work out each corner's screen point in script, about a
 * third of an isometric pan's frame on a hex scene. Now a move adds kept
 * paths through `addPath`, which transforms their points in the canvas's
 * own code, so it costs a few calls, not the hexes.
 */

/** A camera's affine matrix, as Path2D's `addPath` takes it. */
export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

/** A path the lines go into, which can also take another path through a matrix (Path2D, or a test's recorder). */
export type LinePath<P> = PathSink & { addPath(path: P, transform: Matrix): void };

/**
 * Lattice rows and columns on a tile's side. A tile reaches past the canvas
 * by less than its side, so smaller tiles stroke fewer hexes off screen,
 * and larger ones add fewer paths each move.
 */
export const GRID_TILE = 8;

/** The tiles a view needs: for each band of tile rows, its first and last tile column. Two views with the same key need the same tiles. */
export type TileSet = { key: string; bands: ReadonlyMap<number, { lo: number; hi: number }> };

export type HexLineTiles<P> = {
  /**
   * The tiles that draw every side of the hexes a canvas shows: `corners`
   * the canvas's corners on the ground, `pxPerCell` the screen pixels a
   * cell takes. None while a hex is under HEX_LINES_MIN_PX.
   */
  need(view: { corners: readonly Point[]; pxPerCell: number }): TileSet;
  /** Adds the tiles to `out` through `m`, building those not built yet. The tiles added. */
  add(set: TileSet, out: P, m: Matrix): number;
  /** `add` of what `need` gives. */
  inView(view: { corners: readonly Point[]; pxPerCell: number }, out: P, m: Matrix): number;
  /** How many tiles have been built, for the tests. */
  built(): number;
};

/**
 * A hex scene's lines cut into square tiles of the rows lattice (hex.ts),
 * each built the first time it comes into view and kept while the grid and
 * the scene's size stay. A tile's hexes draw their west and two upper
 * sides, and their east and two lower sides only where no scene hex lies
 * across, so the tiles together draw each side of the scene once, as
 * strokeHexLines draws each side in view once, and each hex's sides go in
 * as the same strokes it draws, so their joins match. A tile reaches past
 * the view only by hexes that do not meet the canvas.
 */
export function hexLineTiles<P extends LinePath<P>>(g: HexGrid, bounds: { w: number; h: number }, make: () => P): HexLineTiles<P> {
  const span = sceneHexSpan(g, bounds);
  const rows = g.orient === "rows" ? span.rows : span.cols;
  const along = g.orient === "rows" ? span.cols : span.rows;
  // A lattice row's scene hexes run from its first column without a gap (hexSpans.ts), so its length says which it holds.
  const lengths = new Int32Array(rows);
  for (let r = 0; r < rows; r++) {
    let n = along;
    while (n > 0 && !hexInScene(g, bounds, g.orient === "rows" ? { col: n - 1, row: r } : { col: r, row: n - 1 })) n--;
    lengths[r] = n;
  }
  const has = (c: number, r: number) => r >= 0 && r < rows && c >= 0 && c < lengths[r]!;
  const tileColumns = Math.ceil(along / GRID_TILE);
  const tileRows = Math.ceil(rows / GRID_TILE);
  const tiles = new Map<number, P>();

  const build = (tr: number, tc: number): P => {
    const path = make();
    const swap = g.orient === "columns";
    const move = swap ? (x: number, y: number) => path.moveTo(y, x) : (x: number, y: number) => path.moveTo(x, y);
    const line = swap ? (x: number, y: number) => path.lineTo(y, x) : (x: number, y: number) => path.lineTo(x, y);
    const top = HEX_R / 2;
    for (let r = tr * GRID_TILE, r1 = Math.min(rows, r + GRID_TILE); r < r1; r++) {
      const p = r - 2 * Math.floor(r / 2);
      const cy = HEX_R + r * HEX_S;
      for (let c = tc * GRID_TILE, c1 = Math.min(lengths[r]!, c + GRID_TILE); c < c1; c++) {
        // The same strokes as strokeHexLines (hexSpans.ts), with the scene's hexes in place of those in view.
        const cx = c + 0.5 + 0.5 * p;
        move(cx - 0.5, cy + top);
        line(cx - 0.5, cy - top);
        line(cx, cy - HEX_R);
        line(cx + 0.5, cy - top);
        const east = !has(c + 1, r);
        const southEast = !has(c + p, r + 1);
        const southWest = !has(c - 1 + p, r + 1);
        if (east) line(cx + 0.5, cy + top);
        if (southEast) {
          if (!east) move(cx + 0.5, cy + top);
          line(cx, cy + HEX_R);
        }
        if (southWest) {
          if (!southEast) move(cx, cy + HEX_R);
          line(cx - 0.5, cy + top);
        }
      }
    }
    return path;
  };

  const need = (view: { corners: readonly Point[]; pxPerCell: number }): TileSet => {
    const bands = new Map<number, { lo: number; hi: number }>();
    if (!(view.pxPerCell >= HEX_LINES_MIN_PX)) return { key: "", bands };
    // The tile columns of the hexes in view, and of the neighbors east and below that draw the sides those hexes share
    // with them, so every side of a hex in view is drawn, as strokeHexLines draws it.
    for (const s of hexRowSpans(g, bounds, view.corners)) {
      const lo = Math.max(0, Math.floor((s.c0 - 1) / GRID_TILE));
      const hi = Math.min(tileColumns - 1, Math.floor((s.c1 + 1) / GRID_TILE));
      for (let tr = Math.floor(s.r / GRID_TILE), last = Math.min(tileRows - 1, Math.floor((s.r + 1) / GRID_TILE)); tr <= last; tr++) {
        const band = bands.get(tr);
        if (!band) bands.set(tr, { lo, hi });
        else {
          band.lo = Math.min(band.lo, lo);
          band.hi = Math.max(band.hi, hi);
        }
      }
    }
    let key = "";
    for (const [tr, band] of bands) key += `${tr}:${band.lo}-${band.hi};`;
    return { key, bands };
  };
  const add = (set: TileSet, out: P, m: Matrix): number => {
    let added = 0;
    for (const [tr, band] of set.bands) {
      for (let tc = band.lo; tc <= band.hi; tc++) {
        const key = tr * tileColumns + tc;
        let tile = tiles.get(key);
        if (!tile) tiles.set(key, (tile = build(tr, tc)));
        out.addPath(tile, m);
        added++;
      }
    }
    return added;
  };

  return {
    need,
    add,
    inView: (view, out, m) => add(need(view), out, m),
    built: () => tiles.size,
  };
}

/** A squares scene's lines, every column line then every row line, in world cells. */
export function squareLines<P extends PathSink>(bounds: { w: number; h: number }, path: P): P {
  const { w, h } = bounds;
  for (let x = 0; x <= w; x++) {
    path.moveTo(x, 0);
    path.lineTo(x, h);
  }
  for (let y = 0; y <= h; y++) {
    path.moveTo(0, y);
    path.lineTo(w, y);
  }
  return path;
}
