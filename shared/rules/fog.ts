import { CHUNK_CELLS, FOG_SUBCELLS, type FogOp, type FogShape, type FogTile, type Label, type Token } from "../model.ts";
import { tileKey } from "../keys.ts";
import { footprintSubcells, occupiedCells, type CellRange, type PlacedToken } from "./footprint.ts";
import type { Grid } from "./grid.ts";
import { labelBox } from "./labels.ts";

/**
 * The fog bitmap (design section 13.1). One tile covers 16 x 16 cells at 4 x 4
 * sub-cells per cell: 64 x 64 bits, 512 bytes, carried as base64. Bit 1 means
 * revealed. A tile that is entirely fogged is absent from the state.
 *
 * Rasterization works in integer fixed point (eighths of a cell), so every
 * platform computes the same bits. A sub-cell flips when its center is inside
 * the shape. Nothing here uses Math.hypot or trigonometry, whose rounding is
 * not pinned down across engines.
 */
export const TILE_CELLS = CHUNK_CELLS;
export const TILE_SUB = TILE_CELLS * FOG_SUBCELLS;
export const TILE_BYTES = (TILE_SUB * TILE_SUB) / 8;

/** Fixed-point units per cell: sub-cell centers sit on odd eighths. */
const FP = FOG_SUBCELLS * 2;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeTile(bits: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bits.length; i += 3) {
    const a = bits[i]!;
    const b = bits[i + 1];
    const c = bits[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? "=" : B64[(n >> 6) & 63]!;
    out += c === undefined ? "=" : B64[n & 63]!;
  }
  return out;
}

/*
 * Each character's base64 value by its UTF-16 code: PAD for "=", BAD for
 * anything outside the alphabet. Projections, the fog gate and every fog
 * draw decode tiles, so a decode reads this table per character instead of
 * searching the alphabet, and builds no array per group.
 */
const PAD = -2;
const BAD = -1;
const B64_VALUE = (() => {
  const t = new Int8Array(128).fill(BAD);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["=".charCodeAt(0)] = PAD;
  return t;
})();

function b64Value(code: number): number {
  return code < 128 ? B64_VALUE[code]! : BAD;
}

/**
 * Decodes a tile, or returns null for anything that is not exactly 512
 * bytes of valid base64, which the gate treats as fogged. "=" may end any
 * group, as it always could here: a group short of bytes only adds fewer.
 */
export function decodeTile(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const out = new Uint8Array((text.length / 4) * 3);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = b64Value(text.charCodeAt(i));
    const b = b64Value(text.charCodeAt(i + 1));
    const c = b64Value(text.charCodeAt(i + 2));
    const d = b64Value(text.charCodeAt(i + 3));
    if (a < 0 || b < 0 || c === BAD || d === BAD) return null;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) {
      if (c < 0) return null;
      out[o++] = ((c & 3) << 6) | d;
    }
  }
  if (o !== TILE_BYTES) return null;
  return out.subarray(0, o);
}

export function fullTileBits(): Uint8Array {
  return new Uint8Array(TILE_BYTES).fill(0xff);
}

export const FULL_TILE = encodeTile(fullTileBits());

export function isEmptyBits(bits: Uint8Array): boolean {
  for (let i = 0; i < bits.length; i++) if (bits[i] !== 0) return false;
  return true;
}

function bitIndex(sx: number, sy: number): number {
  return sy * TILE_SUB + sx;
}

export function getBit(bits: Uint8Array, sx: number, sy: number): boolean {
  const i = bitIndex(sx, sy);
  return ((bits[i >> 3]! >> (i & 7)) & 1) === 1;
}

function setBit(bits: Uint8Array, sx: number, sy: number, on: boolean): void {
  const i = bitIndex(sx, sy);
  if (on) bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
  else bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
}

/** How many tiles a scene of the given cell size needs per axis. */
export function tilesAcross(cells: number): number {
  return Math.max(1, Math.ceil(cells / TILE_CELLS));
}

export type Cell = { x: number; y: number };

type TileMap = Record<string, FogTile>;

/** Whether every sub-cell of a cell is fogged. A missing or unreadable tile counts as fogged. */
export function isCellFullyFogged(tiles: TileMap, sceneId: string, cell: Cell): boolean {
  const tx = Math.floor(cell.x / TILE_CELLS);
  const ty = Math.floor(cell.y / TILE_CELLS);
  const tile = tiles[tileKey(sceneId, tx, ty)];
  if (!tile) return true;
  const bits = decodeTile(tile.bits);
  if (!bits) return true;
  const bx = (cell.x - tx * TILE_CELLS) * FOG_SUBCELLS;
  const by = (cell.y - ty * TILE_CELLS) * FOG_SUBCELLS;
  for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
    for (let sx = 0; sx < FOG_SUBCELLS; sx++) {
      if (getBit(bits, bx + sx, by + sy)) return false;
    }
  }
  return true;
}

/**
 * The section 13.4 test: every occupied cell of the token is fully fogged.
 * On hexes, every fog sub-cell inside its hexes (docs/design-v1-hex-grids.md
 * HX-D10), so a hex half in a revealed cell shows the creature only when a
 * revealed sub-cell lies inside one of its hexes.
 *
 * Only tests read it, against one tile map. The live rule is project.ts
 * `footprintFogged`, which reads the layers each viewer's fog joins
 * (reviews HX2-OPUS-09, HX2-SEC-03).
 */
export function isTokenFullyFogged(g: Grid, tiles: TileMap, sceneId: string, token: PlacedToken): boolean {
  if (g.shape === "hex") return footprintSubcells(g, token).every(([sx, sy]) => isSubcellFogged(tiles, sceneId, sx, sy));
  return occupiedCells(g, token).every((cell) => isCellFullyFogged(tiles, sceneId, cell));
}

/** Whether one fog sub-cell, by its scene-wide raster index, is fogged. A missing or unreadable tile counts as fogged. It decodes the tile each time, so it serves tests, as `isTokenFullyFogged` does. */
export function isSubcellFogged(tiles: TileMap, sceneId: string, sx: number, sy: number): boolean {
  if (sx < 0 || sy < 0) return true;
  const tx = Math.floor(sx / TILE_SUB);
  const ty = Math.floor(sy / TILE_SUB);
  const tile = tiles[tileKey(sceneId, tx, ty)];
  if (!tile) return true;
  const bits = decodeTile(tile.bits);
  return !bits || !getBit(bits, sx - tx * TILE_SUB, sy - ty * TILE_SUB);
}

/**
 * The cells a label's text covers any part of: the box labelBox estimates,
 * the one an erase tests too (rules/labels.ts), so a label is withheld under
 * the fog by exactly the cells an erase would take it with. The box always
 * has some width, so the range holds at least one cell.
 */
export function labelCells(label: Pick<Label, "x" | "y" | "text" | "size">): CellRange {
  const box = labelBox(label);
  return { x0: Math.floor(box.x0), y0: Math.floor(box.y0), x1: Math.ceil(box.x1), y1: Math.ceil(box.y1) };
}

/**
 * Whether every cell of a range is fully fogged. A missing tile is all fog,
 * so only the cells of tiles that exist need a look, which keeps a wide
 * label on a mostly dark scene cheap. `cellFogged` lets a caller bring a
 * decode cache.
 */
export function isRangeFullyFogged(
  tiles: TileMap,
  sceneId: string,
  range: CellRange,
  cellFogged: (x: number, y: number) => boolean = (x, y) => isCellFullyFogged(tiles, sceneId, { x, y }),
): boolean {
  for (let ty = Math.floor(range.y0 / TILE_CELLS); ty * TILE_CELLS < range.y1; ty++) {
    for (let tx = Math.floor(range.x0 / TILE_CELLS); tx * TILE_CELLS < range.x1; tx++) {
      if (!tiles[tileKey(sceneId, tx, ty)]) continue;
      const y1 = Math.min(range.y1, (ty + 1) * TILE_CELLS);
      const x1 = Math.min(range.x1, (tx + 1) * TILE_CELLS);
      for (let y = Math.max(range.y0, ty * TILE_CELLS); y < y1; y++) {
        for (let x = Math.max(range.x0, tx * TILE_CELLS); x < x1; x++) if (!cellFogged(x, y)) return false;
      }
    }
  }
  return true;
}

/**
 * The 13.4 rule in one place: a player owner or the DM's exemption lifts the
 * token above the fog. Ownership can come through the token's character, so
 * the caller decides `playerOwned` (see project.ts).
 *
 * The automatic exemption (`fogExemptAuto`) no longer does: since a
 * decision of 2026-10-14, a creature revealed on its turn is shown only where
 * players could see it, so it follows the fog and the party's sight like
 * any other creature. The reducer still sets and clears the flag, since
 * stored ops must replay to the state they made (shared/migrate.ts, step 3
 * to 4).
 */
export function isAboveFog(token: Pick<Token, "fogExempt">, playerOwned: boolean): boolean {
  return playerOwned || token.fogExempt;
}

// Rasterization.

type Bounds = { w: number; h: number };

/** A predicate over fixed-point sub-cell centers, with its bounding box in sub-cells. */
type Raster = {
  sx0: number;
  sy0: number;
  sx1: number;
  sy1: number;
  inside: (px: number, py: number) => boolean;
};

function fp(v: number): number {
  return Math.round(v * FP);
}

function clampRange(a: number, b: number, max: number): [number, number] {
  return [Math.max(0, a), Math.min(max, b)];
}

function rasterOf(shape: FogShape, bounds: Bounds): Raster | null {
  const maxSx = bounds.w * FOG_SUBCELLS;
  const maxSy = bounds.h * FOG_SUBCELLS;
  switch (shape.kind) {
    case "all":
      return { sx0: 0, sy0: 0, sx1: maxSx, sy1: maxSy, inside: () => true };
    case "rect": {
      const x0 = fp(shape.x);
      const y0 = fp(shape.y);
      const x1 = fp(shape.x + shape.w);
      const y1 = fp(shape.y + shape.h);
      const [sx0, sx1] = clampRange(Math.floor(shape.x * FOG_SUBCELLS), Math.ceil((shape.x + shape.w) * FOG_SUBCELLS), maxSx);
      const [sy0, sy1] = clampRange(Math.floor(shape.y * FOG_SUBCELLS), Math.ceil((shape.y + shape.h) * FOG_SUBCELLS), maxSy);
      return { sx0, sy0, sx1, sy1, inside: (px, py) => px >= x0 && px < x1 && py >= y0 && py < y1 };
    }
    case "cells": {
      const set = new Set<string>();
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const key of shape.cells) {
        const [xs, ys] = key.split(",");
        const x = Number(xs);
        const y = Number(ys);
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        set.add(`${x},${y}`);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (set.size === 0) return null;
      const [sx0, sx1] = clampRange(minX * FOG_SUBCELLS, (maxX + 1) * FOG_SUBCELLS, maxSx);
      const [sy0, sy1] = clampRange(minY * FOG_SUBCELLS, (maxY + 1) * FOG_SUBCELLS, maxSy);
      return {
        sx0,
        sy0,
        sx1,
        sy1,
        inside: (px, py) => set.has(`${Math.floor(px / FP)},${Math.floor(py / FP)}`),
      };
    }
    case "poly": {
      const pts: number[] = shape.points.map(fp);
      const n = Math.floor(pts.length / 2);
      if (n < 3) return null;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        minX = Math.min(minX, pts[2 * i]!);
        maxX = Math.max(maxX, pts[2 * i]!);
        minY = Math.min(minY, pts[2 * i + 1]!);
        maxY = Math.max(maxY, pts[2 * i + 1]!);
      }
      const [sx0, sx1] = clampRange(Math.floor(minX / FP) * FOG_SUBCELLS, Math.ceil(maxX / FP) * FOG_SUBCELLS, maxSx);
      const [sy0, sy1] = clampRange(Math.floor(minY / FP) * FOG_SUBCELLS, Math.ceil(maxY / FP) * FOG_SUBCELLS, maxSy);
      return { sx0, sy0, sx1, sy1, inside: (px, py) => pointInPolygonFixed(pts, n, px, py) };
    }
    case "stroke": {
      const pts: number[] = shape.points.map(fp);
      const n = Math.floor(pts.length / 2);
      if (n < 1) return null;
      const r = Math.max(1, Math.round((shape.width / 2) * FP));
      const r2 = r * r;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        minX = Math.min(minX, pts[2 * i]! - r);
        maxX = Math.max(maxX, pts[2 * i]! + r);
        minY = Math.min(minY, pts[2 * i + 1]! - r);
        maxY = Math.max(maxY, pts[2 * i + 1]! + r);
      }
      const [sx0, sx1] = clampRange(Math.floor(minX / FP) * FOG_SUBCELLS, Math.ceil(maxX / FP) * FOG_SUBCELLS, maxSx);
      const [sy0, sy1] = clampRange(Math.floor(minY / FP) * FOG_SUBCELLS, Math.ceil(maxY / FP) * FOG_SUBCELLS, maxSy);
      return {
        sx0,
        sy0,
        sx1,
        sy1,
        inside: (px, py) => {
          if (n === 1) return dist2(px, py, pts[0]!, pts[1]!) <= r2;
          for (let i = 0; i < n - 1; i++) {
            if (segmentDist2(px, py, pts[2 * i]!, pts[2 * i + 1]!, pts[2 * i + 2]!, pts[2 * i + 3]!) <= r2) return true;
          }
          return false;
        },
      };
    }
  }
}

function dist2(px: number, py: number, x: number, y: number): number {
  const dx = px - x;
  const dy = py - y;
  return dx * dx + dy * dy;
}

/**
 * Squared distance from a point to a segment in integer arithmetic. The
 * projection parameter is kept as a fraction (num / den), so the nearest
 * point is compared without a division or a square root. Coordinates are at
 * most a few thousand units, so the products stay far below 2^53.
 */
function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const den = abx * abx + aby * aby;
  if (den === 0) return dist2(px, py, ax, ay);
  const num = (px - ax) * abx + (py - ay) * aby;
  if (num <= 0) return dist2(px, py, ax, ay);
  if (num >= den) return dist2(px, py, bx, by);
  // Distance from P to the line, squared, times den: cross^2 / den.
  const cross = (px - ax) * aby - (py - ay) * abx;
  return (cross * cross) / den;
}

/** Even-odd rule on fixed-point coordinates. Centers lie on odd eighths, so they never sit exactly on an integer vertex. */
export function pointInPolygonFixed(pts: number[], n: number, px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i]!;
    const yi = pts[2 * i + 1]!;
    const xj = pts[2 * j]!;
    const yj = pts[2 * j + 1]!;
    if (yi > py !== yj > py) {
      // x of the edge at py, compared without division: px < xi + (py - yi) * (xj - xi) / (yj - yi)
      const lhs = (px - xi) * (yj - yi);
      const rhs = (py - yi) * (xj - xi);
      if (yj - yi > 0 ? lhs < rhs : lhs > rhs) inside = !inside;
    }
  }
  return inside;
}

export type RasterChange = Record<string, FogTile | null>;

/**
 * Applies fog ops in order to a scene's tiles and returns only the tiles that
 * changed, keyed like `fogTiles`, with null for tiles that became entirely
 * fogged. Revs are left to the caller.
 */
export function rasterizeFogOps(tiles: TileMap, sceneId: string, bounds: Bounds, ops: FogOp[]): RasterChange {
  const work = new Map<string, Uint8Array | null>();
  const tilesX = tilesAcross(bounds.w);
  const tilesY = tilesAcross(bounds.h);

  const load = (tx: number, ty: number): Uint8Array => {
    const key = tileKey(sceneId, tx, ty);
    const existing = work.get(key);
    if (existing) return existing;
    const stored = tiles[key];
    const bits = stored ? (decodeTile(stored.bits) ?? new Uint8Array(TILE_BYTES)) : new Uint8Array(TILE_BYTES);
    const copy = new Uint8Array(bits);
    work.set(key, copy);
    return copy;
  };

  for (const op of ops) {
    const on = op.mode === "reveal";
    if (op.shape.kind === "all") {
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          const bits = load(tx, ty);
          // Cells past the scene bounds stay fogged, so a partial edge tile is filled only inside.
          const limitX = Math.min(TILE_SUB, bounds.w * FOG_SUBCELLS - tx * TILE_SUB);
          const limitY = Math.min(TILE_SUB, bounds.h * FOG_SUBCELLS - ty * TILE_SUB);
          for (let sy = 0; sy < limitY; sy++) for (let sx = 0; sx < limitX; sx++) setBit(bits, sx, sy, on);
        }
      }
      continue;
    }
    const raster = rasterOf(op.shape, bounds);
    if (!raster) continue;
    for (let sy = raster.sy0; sy < raster.sy1; sy++) {
      const py = sy * 2 + 1;
      const ty = Math.floor(sy / TILE_SUB);
      const ly = sy - ty * TILE_SUB;
      for (let sx = raster.sx0; sx < raster.sx1; sx++) {
        if (!raster.inside(sx * 2 + 1, py)) continue;
        const tx = Math.floor(sx / TILE_SUB);
        setBit(load(tx, ty), sx - tx * TILE_SUB, ly, on);
      }
    }
  }

  const changes: RasterChange = {};
  for (const [key, bits] of work) {
    const before = tiles[key];
    if (!bits || isEmptyBits(bits)) {
      if (before) changes[key] = null;
      continue;
    }
    const encoded = encodeTile(bits);
    if (before && before.bits === encoded) continue;
    const [tx, ty] = key.slice(sceneId.length + 1).split(",").map(Number) as [number, number];
    changes[key] = { sceneId, tx, ty, rev: before?.rev ?? 0, bits: encoded };
  }
  return changes;
}

/** Every tile of a scene fully revealed, for `fog.reset` to revealed. */
export function allRevealedTiles(sceneId: string, bounds: Bounds): FogTile[] {
  const ops: FogOp[] = [{ id: "all", mode: "reveal", shape: { kind: "all" } }];
  return Object.values(rasterizeFogOps({}, sceneId, bounds, ops)).filter((t): t is FogTile => t !== null);
}
