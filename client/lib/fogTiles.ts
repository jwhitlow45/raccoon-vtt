import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { decodeTile, encodeTile, getBit, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";

/**
 * Committed fog as pixels for drawing (design sections 13.1 and 13.3). The
 * tile format and its decoding are shared/rules/fog.ts, the same code the
 * server rasterizes and projects with, so the client can never read a bit
 * differently. Everything here fails closed: a tile that is missing or does
 * not decode to exactly one tile counts as fully fogged.
 */

/** A scene's whole fog: one byte per sub-cell, 1 = revealed, `width` x `height` sub-cells. */
export type FogMask = { width: number; height: number; revealed: Uint8Array };

/**
 * Builds the mask for a scene from the tiles in the view. Only tiles of this
 * scene with integer coordinates inside its bounds contribute. The scene's
 * bounds must already be validated by the caller.
 */
export function revealedMask(
  bounds: { w: number; h: number },
  sceneId: string,
  tiles: Record<string, FogTile | undefined>,
): FogMask {
  const width = bounds.w * FOG_SUBCELLS;
  const height = bounds.h * FOG_SUBCELLS;
  const revealed = new Uint8Array(width * height);
  for (const tile of Object.values(tiles)) {
    if (!tile || tile.sceneId !== sceneId) continue;
    const { tx, ty } = tile;
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0) continue;
    const x0 = tx * TILE_SUB;
    const y0 = ty * TILE_SUB;
    if (x0 >= width || y0 >= height) continue;
    const bits = decodeTile(tile.bits);
    if (!bits) continue;
    const xEnd = Math.min(TILE_SUB, width - x0);
    const yEnd = Math.min(TILE_SUB, height - y0);
    for (let sy = 0; sy < yEnd; sy++) {
      const row = (y0 + sy) * width + x0;
      for (let sx = 0; sx < xEnd; sx++) {
        if (getBit(bits, sx, sy)) revealed[row + sx] = 1;
      }
    }
  }
  return { width, height, revealed };
}

/**
 * RGBA pixels for the fog image, one pixel per sub-cell. Fogged pixels are
 * fully opaque, so the map can never show through. The soft edge is drawn on
 * the revealed side only: revealed pixels that touch fog (or the scene's edge,
 * past which everything is fogged) get a light tint of the fog color.
 */
export function fogPixels(mask: FogMask, rgb: readonly [number, number, number], edgeAlpha = 0.35): Uint8ClampedArray {
  const { width, height, revealed } = mask;
  const out = new Uint8ClampedArray(width * height * 4);
  const edge = Math.round(edgeAlpha * 255);
  const isOpen = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && revealed[y * width + x] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let alpha = 255;
      if (revealed[i] === 1) {
        const touchesFog = !isOpen(x - 1, y) || !isOpen(x + 1, y) || !isOpen(x, y - 1) || !isOpen(x, y + 1);
        alpha = touchesFog ? edge : 0;
      }
      const o = i * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** A region of a raster to copy to its canvas, in pixels (sub-cells). */
export type FogDirty = { x: number; y: number; w: number; h: number };

/**
 * The fog image kept up to date a tile at a time: the pixels of
 * `fogPixels(revealedMask(...))`, rewritten only where a tile changed.
 *
 * Why: with party vision on, the party's exploration changes the fog
 * players get on most moves (docs/design-v1-maps-vision.md section 4.3.3),
 * and building the whole image again took about 10 ms for a 200 x 200
 * scene on a laptop, several times that on a phone. A changed tile's
 * revealed bits are written again, then the pixels of that tile and the
 * one sub-cell ring around it, whose edge tint looks at its neighbors.
 * Every tile at one place counts, so a DM's two fog layers, held under
 * keys of their own, still draw as their union. It fails closed exactly as
 * revealedMask does, and a test holds the two to the same pixels.
 */
export class FogRaster {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, `width * height * 4`, for ImageData. */
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  private readonly pixels: Uint32Array;
  private readonly revealed: Uint8Array;
  /** Fogged, revealed beside fog, and clear, in the platform's byte order. */
  private readonly colors: Uint32Array;
  /** The tiles last drawn at each `"tx,ty"`, in order, so an unchanged place is left alone. */
  private readonly drawn = new Map<string, readonly FogTile[]>();

  constructor(bounds: { w: number; h: number }, rgb: readonly [number, number, number], edgeAlpha = 0.35) {
    this.width = bounds.w * FOG_SUBCELLS;
    this.height = bounds.h * FOG_SUBCELLS;
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4);
    this.pixels = new Uint32Array(this.rgba.buffer);
    this.revealed = new Uint8Array(this.width * this.height);
    const bytes = new Uint8ClampedArray(12);
    bytes.set([rgb[0], rgb[1], rgb[2], 255], 0);
    bytes.set([rgb[0], rgb[1], rgb[2], Math.round(edgeAlpha * 255)], 4);
    bytes.set([rgb[0], rgb[1], rgb[2], 0], 8);
    this.colors = new Uint32Array(bytes.buffer);
    this.pixels.fill(this.colors[0]!);
  }

  /** Brings the image up to date with a scene's tiles, and returns the regions whose pixels it rewrote. */
  update(tiles: Readonly<Record<string, FogTile | undefined>>, sceneId: string): FogDirty[] {
    const { width, height } = this;
    const now = new Map<string, FogTile[]>();
    for (const tile of Object.values(tiles)) {
      if (!tile || tile.sceneId !== sceneId) continue;
      const { tx, ty } = tile;
      if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0) continue;
      if (tx * TILE_SUB >= width || ty * TILE_SUB >= height) continue;
      const at = `${tx},${ty}`;
      const list = now.get(at);
      if (list) list.push(tile);
      else now.set(at, [tile]);
    }
    const changed: [number, number][] = [];
    for (const [at, list] of now) {
      const before = this.drawn.get(at);
      if (before && before.length === list.length && before.every((t, i) => t === list[i])) continue;
      this.drawn.set(at, list);
      changed.push(at.split(",").map(Number) as [number, number]);
    }
    for (const at of this.drawn.keys()) {
      if (now.has(at)) continue;
      this.drawn.delete(at);
      changed.push(at.split(",").map(Number) as [number, number]);
    }
    const dirty: FogDirty[] = [];
    for (const [tx, ty] of changed) {
      this.writeMask(tx, ty, now.get(`${tx},${ty}`) ?? []);
      // The ring around the tile too: a pixel's edge tint depends on its four neighbors.
      const x0 = Math.max(0, tx * TILE_SUB - 1);
      const y0 = Math.max(0, ty * TILE_SUB - 1);
      const x1 = Math.min(width, (tx + 1) * TILE_SUB + 1);
      const y1 = Math.min(height, (ty + 1) * TILE_SUB + 1);
      dirty.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    for (const r of dirty) this.writePixels(r);
    return dirty;
  }

  private writeMask(tx: number, ty: number, list: readonly FogTile[]): void {
    const { width, height, revealed } = this;
    const x0 = tx * TILE_SUB;
    const y0 = ty * TILE_SUB;
    const xEnd = Math.min(TILE_SUB, width - x0);
    const yEnd = Math.min(TILE_SUB, height - y0);
    for (let sy = 0; sy < yEnd; sy++) revealed.fill(0, (y0 + sy) * width + x0, (y0 + sy) * width + x0 + xEnd);
    for (const tile of list) {
      const bits = decodeTile(tile.bits);
      if (!bits) continue;
      for (let sy = 0; sy < yEnd; sy++) {
        const row = (y0 + sy) * width + x0;
        for (let sx = 0; sx < xEnd; sx++) if (getBit(bits, sx, sy)) revealed[row + sx] = 1;
      }
    }
  }

  private writePixels(r: FogDirty): void {
    const { width, height, revealed, pixels, colors } = this;
    const fogged = colors[0]!;
    const edge = colors[1]!;
    const clear = colors[2]!;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * width + x;
        if (revealed[i] !== 1) {
          pixels[i] = fogged;
          continue;
        }
        const open =
          x > 0 && revealed[i - 1] === 1 && x < width - 1 && revealed[i + 1] === 1 && y > 0 && revealed[i - width] === 1 && y < height - 1 && revealed[i + width] === 1;
        pixels[i] = open ? clear : edge;
      }
    }
  }
}

/** One tile from a predicate over its sub-cells, in the shared encoding. For the dev fixture and tests. */
export function encodeTileFrom(isRevealed: (sx: number, sy: number) => boolean): string {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let sy = 0; sy < TILE_SUB; sy++) {
    for (let sx = 0; sx < TILE_SUB; sx++) {
      if (!isRevealed(sx, sy)) continue;
      const i = sy * TILE_SUB + sx;
      bytes[i >> 3]! |= 1 << (i & 7);
    }
  }
  return encodeTile(bytes);
}
