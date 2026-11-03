import { LEAF_COLORS } from "./looks.ts";

/**
 * The weather's textures, made in code on a kind's first use (the weather
 * design note, 6.4): a 256 px tiling noise sheet per color for fog and a
 * sandstorm, and a 144 by 24 atlas of six leaves. No image files.
 */

export const NOISE_SIZE = 256;
export const LEAF_CELL = 24;
export const LEAF_COUNT = 6;

/** Makes a canvas: `document.createElement("canvas")` in the app, a fake in tests. */
export type CanvasMaker = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function hash01(seed: number, a: number, b: number, c: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77) ^ Math.imul(c + 1, 0xc2b2ae3d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Lattice cells across the sheet per octave, and each one's weight. Every count divides the size, so the lattice wraps and the sheet tiles. */
const OCTAVES: readonly (readonly [number, number])[] = [
  [4, 0.5],
  [8, 0.27],
  [16, 0.15],
  [32, 0.08],
];

/** A tiling noise sheet's alpha, 0 to 255, row by row: the same seed gives the same sheet. */
export function noiseAlpha(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size * size);
  const sum = new Float64Array(size * size);
  for (let o = 0; o < OCTAVES.length; o++) {
    const [cells, weight] = OCTAVES[o]!;
    const step = size / cells;
    const lattice = new Float64Array(cells * cells);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) lattice[j * cells + i] = hash01(seed, o, i, j);
    for (let y = 0; y < size; y++) {
      const gy = y / step;
      const j0 = Math.floor(gy);
      const ty = smooth(gy - j0);
      const r0 = (j0 % cells) * cells;
      const r1 = ((j0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const i0 = Math.floor(gx);
        const tx = smooth(gx - i0);
        const c0 = i0 % cells;
        const c1 = (i0 + 1) % cells;
        const top = lattice[r0 + c0]! + (lattice[r0 + c1]! - lattice[r0 + c0]!) * tx;
        const bottom = lattice[r1 + c0]! + (lattice[r1 + c1]! - lattice[r1 + c0]!) * tx;
        sum[y * size + x] = sum[y * size + x]! + weight * (top + (bottom - top) * ty);
      }
    }
  }
  // Pull the middle apart, so the sheet reads as banks of mist with clear gaps rather than an even gray.
  for (let k = 0; k < out.length; k++) out[k] = Math.round(255 * Math.min(1, Math.max(0, (sum[k]! - 0.3) / 0.45)));
  return out;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A seed per color, so fog's sheet and sand's are not the same banks. */
function seedOf(color: string): number {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) h = Math.imul(h ^ color.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rgbOf(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The noise sheet's pixels: one color, alpha from the noise. */
export function noisePixels(color: string, size: number = NOISE_SIZE): Uint8ClampedArray<ArrayBuffer> {
  const alpha = noiseAlpha(size, seedOf(color));
  const [r, g, b] = rgbOf(color);
  const px = new Uint8ClampedArray(size * size * 4);
  for (let k = 0; k < alpha.length; k++) {
    px[k * 4] = r;
    px[k * 4 + 1] = g;
    px[k * 4 + 2] = b;
    px[k * 4 + 3] = alpha[k]!;
  }
  return px;
}

/**
 * The six leaf outlines, each in a cell centered on (0, 0) about 20 px long,
 * pointing up: an oval, a willow, a round leaf, an oak's lobes, a maple's
 * points and a heart.
 */
function leafPath(g: Context2D, shape: number): void {
  g.beginPath();
  switch (shape) {
    case 0:
      g.moveTo(0, -10);
      g.quadraticCurveTo(7, -3, 0, 10);
      g.quadraticCurveTo(-7, -3, 0, -10);
      break;
    case 1:
      g.moveTo(0, -11);
      g.quadraticCurveTo(4, 0, 0, 11);
      g.quadraticCurveTo(-4, 0, 0, -11);
      break;
    case 2:
      g.moveTo(0, -9);
      g.bezierCurveTo(9, -9, 9, 6, 0, 9);
      g.bezierCurveTo(-9, 6, -9, -9, 0, -9);
      break;
    case 3:
      g.moveTo(0, -10);
      for (const [x, y] of [[4, -7], [3, -4], [7, -2], [5, 1], [7, 4], [2, 6], [0, 10], [-2, 6], [-7, 4], [-5, 1], [-7, -2], [-3, -4], [-4, -7]] as const) g.lineTo(x, y);
      break;
    case 4:
      g.moveTo(0, -10);
      for (const [x, y] of [[2, -4], [8, -6], [5, 0], [9, 3], [3, 4], [1, 10], [-1, 10], [-3, 4], [-9, 3], [-5, 0], [-8, -6], [-2, -4]] as const) g.lineTo(x, y);
      break;
    default:
      g.moveTo(0, 9);
      g.bezierCurveTo(-10, 2, -7, -9, 0, -5);
      g.bezierCurveTo(7, -9, 10, 2, 0, 9);
  }
  g.closePath();
}

/** Draws the six leaves into a 144 by 24 canvas, one 24 px cell each, in LEAF_COLORS by turn. */
export function drawLeafAtlas(g: Context2D): void {
  for (let k = 0; k < LEAF_COUNT; k++) {
    g.setTransform(1, 0, 0, 1, k * LEAF_CELL + LEAF_CELL / 2, LEAF_CELL / 2);
    leafPath(g, k);
    g.fillStyle = LEAF_COLORS[k % LEAF_COLORS.length]!;
    g.fill();
    // The midrib, darker, so a turning leaf reads as a leaf and not a chip of paint.
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(0, 9);
    g.strokeStyle = "rgba(40, 20, 10, 0.45)";
    g.lineWidth = 1;
    g.stroke();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/** What a draw takes its images from. Null until made, and a draw skips what is missing. */
export type TextureSource = {
  noise(color: string): CanvasImageSource | null;
  leaves(): CanvasImageSource | null;
};

/** The textures of one controller: each made once on first use, all let go by `release`. */
export class WeatherTextures implements TextureSource {
  readonly #make: CanvasMaker;
  readonly #sheets = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  #leaves: HTMLCanvasElement | OffscreenCanvas | null = null;

  constructor(make: CanvasMaker) {
    this.#make = make;
  }

  noise(color: string): CanvasImageSource | null {
    const kept = this.#sheets.get(color);
    if (kept) return kept;
    const canvas = this.#make(NOISE_SIZE, NOISE_SIZE);
    const g = canvas.getContext("2d") as Context2D | null;
    if (!g) return null;
    const image = g.createImageData(NOISE_SIZE, NOISE_SIZE);
    image.data.set(noisePixels(color));
    g.putImageData(image, 0, 0);
    this.#sheets.set(color, canvas);
    return canvas;
  }

  leaves(): CanvasImageSource | null {
    if (this.#leaves) return this.#leaves;
    const canvas = this.#make(LEAF_CELL * LEAF_COUNT, LEAF_CELL);
    const g = canvas.getContext("2d") as Context2D | null;
    if (!g) return null;
    drawLeafAtlas(g);
    this.#leaves = canvas;
    return canvas;
  }

  /** Bytes the textures made so far hold. */
  bytes(): number {
    return this.#sheets.size * NOISE_SIZE * NOISE_SIZE * 4 + (this.#leaves ? LEAF_CELL * LEAF_COUNT * LEAF_CELL * 4 : 0);
  }

  /** Lets every texture go. A canvas sized to nothing frees its pixels at once, where waiting for the collector could hold them for minutes. */
  release(): void {
    for (const canvas of this.#sheets.values()) canvas.width = canvas.height = 0;
    if (this.#leaves) this.#leaves.width = this.#leaves.height = 0;
    this.#sheets.clear();
    this.#leaves = null;
  }
}
