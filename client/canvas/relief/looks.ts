import type { TerrainId } from "#shared/model.ts";
import { TERRAIN_COLORS, TERRAIN_SWATCHES } from "../../features/builder/textures.ts";
import { isSymbolTerrain, type TexturedTerrain } from "../../features/builder/geometry.ts";
import { theme } from "../../lib/theme.ts";
import type { FogView } from "./fogView.ts";
import type { SideLook } from "./pieces.ts";

/**
 * What a raised side wears (docs/design-v1-isometric-view.md 5.5,
 * D-261026-7): its cell's builder texture, a stair's swatch, or on a map
 * image with no builder terrain a flat tone tinted to the average color of
 * its top. The tint reads only pixels wholly inside the cell, from the map
 * image Top-down draws, copied 1:1 so nothing is resampled across the
 * cell's edge. The thumbnail is never read: its downsampling blends
 * neighbors, so a revealed cell's tint could carry art from under the fog.
 * For a player only cells with every sub-cell revealed take the tint, and
 * the rest the neutral side tone.
 */

/** The look of a side whose cell has this terrain, or none. `tint` is the cell's map tint when it may take one. */
export function sideLook(terrain: TerrainId | null, tint: string | null): SideLook {
  if (terrain === "stairs") return { texture: null, color: TERRAIN_SWATCHES.stairs };
  if (terrain === "pillar") return { texture: "stone", color: TERRAIN_SWATCHES.pillar };
  if (terrain && isSymbolTerrain(terrain)) return { texture: "stone", color: TERRAIN_COLORS.stone };
  if (terrain) return { texture: terrain, color: TERRAIN_COLORS[terrain as TexturedTerrain] };
  return { texture: null, color: tint ?? theme.relief.side };
}

/**
 * A cell's side look for this viewer: a builder terrain's whatever the fog,
 * since Top-down draws the floor under the fog too and the fog hides it,
 * and the map tint only on a cell this viewer sees whole.
 */
export function cellLook(fog: FogView, tints: CellTints | null, x: number, y: number, terrain: TerrainId | null): SideLook {
  if (terrain) return sideLook(terrain, null);
  return sideLook(null, tints && fog.cellClear(x, y) ? tints.at(x, y) : null);
}

/** A rectangle of image pixels. */
export type PixelRect = { sx: number; sy: number; sw: number; sh: number };

/**
 * The image pixels wholly inside a cell: those whose whole square lies
 * within the cell's rectangle, with the map stretched to `rect` in cells
 * and `size` pixels across. Null when no pixel fits.
 */
export function pixelsInside(cell: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): PixelRect | null {
  const kx = size.width / rect.width;
  const ky = size.height / rect.height;
  // A hair of slack, so a cell edge that lands exactly on a pixel edge keeps that pixel.
  const sx0 = Math.max(0, Math.ceil((cell.x - rect.x) * kx - 1e-9));
  const sy0 = Math.max(0, Math.ceil((cell.y - rect.y) * ky - 1e-9));
  const sx1 = Math.min(size.width, Math.floor((cell.x + 1 - rect.x) * kx + 1e-9));
  const sy1 = Math.min(size.height, Math.floor((cell.y + 1 - rect.y) * ky + 1e-9));
  if (sx1 <= sx0 || sy1 <= sy0) return null;
  return { sx: sx0, sy: sy0, sw: sx1 - sx0, sh: sy1 - sy0 };
}

/** The average of RGBA pixels as a CSS color, transparent pixels left out. Null when none is opaque enough to count. */
export function averageColor(data: ArrayLike<number>): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 0.5) continue;
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
    n++;
  }
  if (n === 0) return null;
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

/** Reads a rectangle of the map's pixels 1:1, as `ImageData.data` would give them. */
export type ReadPixels = (r: PixelRect) => ArrayLike<number> | null;

/** The map tint of each cell, read once per cell for the life of one decoded image. */
export class CellTints {
  readonly #read: ReadPixels;
  readonly #rect: { x: number; y: number; width: number; height: number };
  readonly #size: { width: number; height: number };
  readonly #known = new Map<number, string | null>();

  constructor(read: ReadPixels, rect: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }) {
    this.#read = read;
    this.#rect = rect;
    this.#size = size;
  }

  /** The tint of a cell, or null where no pixel lies wholly inside it. */
  at(x: number, y: number): string | null {
    const key = y * 1_000_000 + x;
    if (this.#known.has(key)) return this.#known.get(key)!;
    const r = pixelsInside({ x, y }, this.#rect, this.#size);
    const data = r ? this.#read(r) : null;
    const tint = data ? averageColor(data) : null;
    this.#known.set(key, tint);
    return tint;
  }
}

/**
 * Reads a decoded map image's pixels through one small canvas, drawn at
 * the source rectangle's own size so the copy is 1:1 and the browser
 * resamples nothing. Null where no canvas can be made.
 */
export function imageReader(image: CanvasImageSource): ReadPixels | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  return (r) => {
    if (canvas.width < r.sw) canvas.width = r.sw;
    if (canvas.height < r.sh) canvas.height = r.sh;
    g.clearRect(0, 0, r.sw, r.sh);
    g.imageSmoothingEnabled = false;
    g.drawImage(image, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
    try {
      return g.getImageData(0, 0, r.sw, r.sh).data;
    } catch {
      // A map from another origin without CORS would taint the canvas: no tint then, the neutral tone.
      return null;
    }
  };
}

/** One pattern per texture image, made once and shared by every side and wall that wears it. */
const patterns = new WeakMap<HTMLImageElement, CanvasPattern | null>();

export function patternOf(g: CanvasRenderingContext2D, image: HTMLImageElement): CanvasPattern | null {
  let p = patterns.get(image);
  if (p === undefined) patterns.set(image, (p = g.createPattern(image, "repeat")));
  return p;
}
