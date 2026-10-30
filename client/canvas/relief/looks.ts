import { FOG_SUBCELLS, type TerrainId } from "#shared/model.ts";
import { hexSubcells, type HexGrid } from "#shared/rules/hex.ts";
import { cellPolygon, type GroundCell } from "../../lib/groundCells.ts";
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
 *
 * A hex's tint reads the pixels wholly inside its canonical polygon whose
 * squares touch only its own fog sub-cells, and only for a hex whose every
 * sub-cell this viewer has revealed: a hex seen in part stays neutral
 * (docs/design-v1-iso-hex-relief.md D-261030-465). Painted ground stays
 * square, so a hex wears its stair's swatch or this.
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

/** A hex's side look for this viewer: a stair's swatch, or the hex's map tint where this viewer has revealed all of it, else the neutral tone. */
export function hexLook(fog: FogView, tints: CellTints | null, grid: HexGrid, cell: GroundCell, terrain: TerrainId | null): SideLook {
  if (terrain === "stairs") return sideLook("stairs", null);
  if (!tints) return sideLook(null, null);
  const subs = hexSubcells(grid, { col: cell.col, row: cell.row });
  return sideLook(null, subs.every(([sx, sy]) => fog.revealed(sx, sy)) ? tints.hexAt(grid, cell) : null);
}

/** The sign of a polygon's turning, so its sides' insides face the same way on hex rows and their mirror. */
function winding(poly: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a >= 0 ? 1 : -1;
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

  /**
   * The tint of a hex: the pixels of the box around its polygon whose
   * squares lie wholly inside the polygon and touch only the hex's own
   * fog sub-cells, so nothing of a neighbor's art, revealed or not, comes in.
   */
  hexAt(grid: HexGrid, cell: GroundCell): string | null {
    const key = -1 - ((cell.row + 4096) * 8192 + (cell.col + 4096));
    if (this.#known.has(key)) return this.#known.get(key)!;
    const poly = cellPolygon(grid, cell);
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const kx = this.#size.width / this.#rect.width;
    const ky = this.#size.height / this.#rect.height;
    const sx0 = Math.max(0, Math.floor((box.x - this.#rect.x) * kx));
    const sy0 = Math.max(0, Math.floor((box.y - this.#rect.y) * ky));
    const sx1 = Math.min(this.#size.width, Math.ceil((box.x + box.w - this.#rect.x) * kx));
    const sy1 = Math.min(this.#size.height, Math.ceil((box.y + box.h - this.#rect.y) * ky));
    let tint: string | null = null;
    if (sx1 > sx0 && sy1 > sy0) {
      const data = this.#read({ sx: sx0, sy: sy0, sw: sx1 - sx0, sh: sy1 - sy0 });
      if (data) {
        // The hex's sub-cells row by row, each row's run of columns: a pixel touching any other sub-cell is left out.
        const rows = new Map<number, [number, number]>();
        for (const [sx, sy] of hexSubcells(grid, { col: cell.col, row: cell.row })) {
          const r = rows.get(sy);
          rows.set(sy, r ? [Math.min(r[0], sx), Math.max(r[1], sx)] : [sx, sx]);
        }
        // The polygon's sides as half-planes, inside where a x + b y + c >= 0.
        const w0 = winding(poly);
        const planes = poly.map((p, k) => {
          const q = poly[(k + 1) % poly.length]!;
          return { a: -w0 * (q.y - p.y), b: w0 * (q.x - p.x), c: w0 * ((q.y - p.y) * p.x - (q.x - p.x) * p.y) };
        });
        const inside = (x: number, y: number) => planes.every((h) => h.a * x + h.b * y + h.c >= 0);
        const kept: number[] = [];
        const w = sx1 - sx0;
        for (let j = 0; j < sy1 - sy0; j++) {
          const y0 = this.#rect.y + (sy0 + j) / ky;
          const y1 = y0 + 1 / ky;
          const fy0 = Math.floor(y0 * FOG_SUBCELLS);
          const fy1 = Math.ceil(y1 * FOG_SUBCELLS);
          for (let i = 0; i < w; i++) {
            const x0 = this.#rect.x + (sx0 + i) / kx;
            const x1 = x0 + 1 / kx;
            // A convex polygon holds the square when it holds its four corners.
            if (!inside(x0, y0) || !inside(x1, y0) || !inside(x1, y1) || !inside(x0, y1)) continue;
            const fx0 = Math.floor(x0 * FOG_SUBCELLS);
            const fx1 = Math.ceil(x1 * FOG_SUBCELLS) - 1;
            let mine = true;
            for (let sy = fy0; sy < fy1; sy++) {
              const r = rows.get(sy);
              if (!r || fx0 < r[0] || fx1 > r[1]) {
                mine = false;
                break;
              }
            }
            if (!mine) continue;
            const at = 4 * (j * w + i);
            kept.push(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!);
          }
        }
        tint = averageColor(kept);
      }
    }
    this.#known.set(key, tint);
    return tint;
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
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return g ? pixelReader(image, g) : null;
}

/** What `pixelReader` uses of a 2D context. */
export type PixelContext = Pick<CanvasRenderingContext2D, "canvas" | "clearRect" | "drawImage" | "getImageData" | "imageSmoothingEnabled">;

/** `imageReader` over a given context, its canvas grown to each rectangle read. */
export function pixelReader(image: CanvasImageSource, g: PixelContext): ReadPixels {
  return (r) => {
    try {
      if (g.canvas.width < r.sw) g.canvas.width = r.sw;
      if (g.canvas.height < r.sh) g.canvas.height = r.sh;
      g.clearRect(0, 0, r.sw, r.sh);
      g.imageSmoothingEnabled = false;
      g.drawImage(image, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
      return g.getImageData(0, 0, r.sw, r.sh).data;
    } catch {
      // No tint then, the neutral tone: a closed bitmap or one with no pixels throws on the draw, and a map from another origin without CORS taints the canvas.
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
