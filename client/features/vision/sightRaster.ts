import { FOG_SUBCELLS, type SightTile } from "#shared/model.ts";
import { TILE_SUB } from "#shared/rules/fog.ts";

/**
 * The party's sight as pixels (docs/design-v1-maps-vision.md sections 4.3.4
 * and 4.3.7). The server sends sight as tiles of 64 x 64 sub-cells, the
 * fog's tiles, at 2 bits per sub-cell: 0 not seen, 1 grey (darkvision in
 * darkness), 2 dim, 3 bright. This keeps one pixel per sub-cell for a whole
 * scene and rewrites only the tiles whose objects changed, so a move that
 * changes a handful of tiles costs a handful of tiles.
 *
 * The client never computes sight. It only draws the levels it was sent,
 * and fails closed: a scene's tile that is missing, or that does not decode
 * to exactly one tile, draws as not seen.
 *
 * A tile's `b` is base64 of 1,024 bytes. Sub-cell i of the tile (row-major,
 * i = sy * 64 + sx) is bits 2(i mod 4) and 2(i mod 4) + 1 of byte i / 4,
 * low bits first, as shared/rules/vision.ts encodes it. `f` is a tile all at
 * one level.
 */

export const NOT_SEEN = 0;
export const GREY = 1;
export const DIM = 2;
export const BRIGHT = 3;

/** Bytes of one tile at 2 bits per sub-cell. */
export const SIGHT_TILE_BYTES = (TILE_SUB * TILE_SUB) / 4;

/** One RGBA color per level, 0 to 3, each byte 0 to 255. */
export type Palette = readonly [Rgba, Rgba, Rgba, Rgba];
export type Rgba = readonly [number, number, number, number];

/**
 * What players see over the map (section 4.3.7): bright light clear, dim
 * light black at 35%, darkvision's grey a blue-grey at 55%, and ground seen
 * before but not now black at 65%. Fog still covers what was never seen.
 */
export const PARTY_PALETTE: Palette = [
  [0, 0, 0, alpha(0.65)],
  [38, 48, 66, alpha(0.55)],
  [0, 0, 0, alpha(0.35)],
  [0, 0, 0, 0],
];

/**
 * The DM's "Party sight" (section 4.3.1): what the party cannot see, veiled
 * at 40%. The DM keeps a fully lit map to work on, so the levels inside the
 * party's sight are left clear.
 */
export const VEIL_PALETTE: Palette = [
  [0, 0, 0, alpha(0.4)],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

function alpha(a: number): number {
  return Math.round(a * 255);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
/** 1,024 bytes are 341 groups of three and one byte left, so 1,368 characters ending in "==". */
const B64_CHARS = Math.ceil(SIGHT_TILE_BYTES / 3) * 4;

type SetFromBase64 = (this: Uint8Array, text: string, options: { lastChunkHandling: "strict" }) => { read: number; written: number };

/**
 * The browser's own base64 decoder, where it has one (Chrome 140, Safari
 * 18.2, Firefox 133), which writes into an array with no string or array
 * made on the way. Decoding is about half the work of writing a tile.
 */
const nativeDecode = (Uint8Array.prototype as Uint8Array & { setFromBase64?: SetFromBase64 }).setFromBase64;

/**
 * Decodes a `b` tile's base64 into `out`, or returns false for anything
 * that is not exactly one tile of canonical base64: the browser's decoder
 * in strict mode where there is one, else a lookup table, which unlike
 * atob never throws or builds a string.
 */
export function decodeSightBits(text: unknown, out: Uint8Array): boolean {
  if (typeof text !== "string" || text.length !== B64_CHARS || out.length < SIGHT_TILE_BYTES) return false;
  if (text.charCodeAt(B64_CHARS - 1) !== 61 || text.charCodeAt(B64_CHARS - 2) !== 61) return false;
  if (nativeDecode) {
    try {
      // The decoder skips whitespace, so a tile holding any comes out short.
      const target = out.length === SIGHT_TILE_BYTES ? out : out.subarray(0, SIGHT_TILE_BYTES);
      return nativeDecode.call(target, text, { lastChunkHandling: "strict" }).written === SIGHT_TILE_BYTES;
    } catch {
      return false;
    }
  }
  return decodeByTable(text, out);
}

/**
 * The lookup table decoder, for text already checked to be 1,368
 * characters ending in "==". Exported so a test can run it where the
 * runtime has a native decoder too.
 */
export function decodeByTable(text: string, out: Uint8Array): boolean {
  let o = 0;
  const groups = B64_CHARS / 4 - 1;
  for (let g = 0, i = 0; g < groups; g++, i += 4) {
    const a = B64_VALUE[text.charCodeAt(i)] ?? -1;
    const b = B64_VALUE[text.charCodeAt(i + 1)] ?? -1;
    const c = B64_VALUE[text.charCodeAt(i + 2)] ?? -1;
    const d = B64_VALUE[text.charCodeAt(i + 3)] ?? -1;
    if ((a | b | c | d) < 0) return false;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const i = groups * 4;
  const a = B64_VALUE[text.charCodeAt(i)] ?? -1;
  const b = B64_VALUE[text.charCodeAt(i + 1)] ?? -1;
  // The last byte uses all of a and the top 2 bits of b. Anything in b's
  // low 4 bits is not canonical base64 of 1,024 bytes.
  if ((a | b) < 0 || (b & 15) !== 0) return false;
  out[o] = (a << 2) | (b >> 4);
  return true;
}

/** A tile's level where it is uniform, `"bits"` when its `b` decoded into the scratch bytes, or null when unreadable. */
function readTile(tile: unknown, scratch: Uint8Array): number | "bits" | null {
  if (!tile || typeof tile !== "object") return null;
  const t = tile as Partial<{ b: unknown; f: unknown }>;
  if ("f" in t) return t.f === 1 || t.f === 2 || t.f === 3 ? t.f : null;
  return decodeSightBits(t.b, scratch) ? "bits" : null;
}

/** A region of the raster to copy to the screen's canvas, in pixels (sub-cells). */
export type DirtyRect = { x: number; y: number; w: number; h: number };

const TILE_AT = /^(\d{1,4}),(\d{1,4})$/;

/**
 * One scene's sight at one pixel per sub-cell, in RGBA as a canvas's
 * ImageData holds it. `pixels` is that data, viewed as one 32-bit value per
 * pixel so a level writes with a single store.
 */
export class SightRaster {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, `width * height * 4`, for ImageData. */
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  private readonly pixels: Uint32Array;
  private readonly colors: Uint32Array;
  /** The four pixels each byte of a tile writes, `byte * 4 + k`, so a tile is written a byte at a time. */
  private readonly quads: Uint32Array;
  /** The tile object last written at each `"tx,ty"`, so an unchanged tile is never decoded again. */
  private readonly written = new Map<string, unknown>();
  private readonly scratch = new Uint8Array(SIGHT_TILE_BYTES);
  private readonly tilesAcross: number;
  private readonly tilesDown: number;

  constructor(bounds: { w: number; h: number }, palette: Palette) {
    this.width = bounds.w * FOG_SUBCELLS;
    this.height = bounds.h * FOG_SUBCELLS;
    this.tilesAcross = Math.ceil(this.width / TILE_SUB);
    this.tilesDown = Math.ceil(this.height / TILE_SUB);
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4);
    this.pixels = new Uint32Array(this.rgba.buffer);
    // The colors in the platform's own byte order, by writing them as bytes.
    const bytes = new Uint8ClampedArray(16);
    palette.forEach((c, i) => bytes.set(c, i * 4));
    this.colors = new Uint32Array(bytes.buffer);
    this.quads = new Uint32Array(256 * 4);
    for (let b = 0; b < 256; b++) for (let k = 0; k < 4; k++) this.quads[b * 4 + k] = this.colors[(b >> (k * 2)) & 3]!;
    this.pixels.fill(this.colors[NOT_SEEN]!);
  }

  /**
   * Whether the last update stopped at its limit with changed tiles left
   * unwritten. The next update with the same map goes on from there.
   */
  behind = false;

  /**
   * Brings the raster up to date with a projected state's sight map (keyed
   * `"<sceneId>:<tx>,<ty>"`): writes every tile of this scene whose object
   * changed, and returns a tile's last level to not seen where its tile is
   * gone. Entries of other scenes and keys that do not name a tile inside
   * the scene are ignored. Writes at most `limit` tiles, so a change of
   * every tile can be spread over a few frames, and returns the regions it
   * rewrote.
   */
  update(sight: Readonly<Record<string, SightTile | undefined>> | undefined, sceneId: string, limit = Infinity): DirtyRect[] {
    const dirty: DirtyRect[] = [];
    const prefix = `${sceneId}:`;
    const seen = new Set<string>();
    this.behind = false;
    for (const key in sight) {
      if (!key.startsWith(prefix)) continue;
      const at = key.slice(prefix.length);
      const m = TILE_AT.exec(at);
      if (!m) continue;
      const tx = Number(m[1]);
      const ty = Number(m[2]);
      if (tx >= this.tilesAcross || ty >= this.tilesDown) continue;
      const tile = sight[key];
      if (tile === undefined) continue;
      seen.add(at);
      if (this.written.get(at) === tile) continue;
      if (dirty.length >= limit) {
        this.behind = true;
        continue;
      }
      this.written.set(at, tile);
      dirty.push(this.writeTile(tx, ty, tile));
    }
    for (const at of this.written.keys()) {
      if (seen.has(at)) continue;
      if (dirty.length >= limit) {
        this.behind = true;
        break;
      }
      this.written.delete(at);
      const [tx, ty] = at.split(",").map(Number) as [number, number];
      dirty.push(this.writeTile(tx, ty, null));
    }
    return dirty;
  }

  /** Writes one tile's levels, a missing or unreadable tile as not seen. */
  private writeTile(tx: number, ty: number, tile: unknown): DirtyRect {
    const x0 = tx * TILE_SUB;
    const y0 = ty * TILE_SUB;
    const w = Math.min(TILE_SUB, this.width - x0);
    const h = Math.min(TILE_SUB, this.height - y0);
    const read = tile === null ? null : readTile(tile, this.scratch);
    const { pixels, colors, width } = this;
    if (read !== "bits") {
      const color = colors[read ?? NOT_SEEN]!;
      for (let sy = 0; sy < h; sy++) {
        const row = (y0 + sy) * width + x0;
        pixels.fill(color, row, row + w);
      }
      return { x: x0, y: y0, w, h };
    }
    // A scene's width is a whole number of cells, 4 sub-cells each, so a
    // clipped tile row still ends on a whole byte of 4 sub-cells.
    const bytes = this.scratch;
    const quads = this.quads;
    const rowBytes = w >> 2;
    for (let sy = 0; sy < h; sy++) {
      let o = (y0 + sy) * width + x0;
      const first = sy * (TILE_SUB >> 2);
      for (let j = 0; j < rowBytes; j++) {
        const q = bytes[first + j]! << 2;
        pixels[o++] = quads[q]!;
        pixels[o++] = quads[q + 1]!;
        pixels[o++] = quads[q + 2]!;
        pixels[o++] = quads[q + 3]!;
      }
    }
    return { x: x0, y: y0, w, h };
  }

  /** The level drawn at a sub-cell, for tests. */
  levelAt(sx: number, sy: number): number {
    const v = this.pixels[sy * this.width + sx];
    const i = this.colors.indexOf(v ?? -1);
    return i < 0 ? -1 : i;
  }
}
