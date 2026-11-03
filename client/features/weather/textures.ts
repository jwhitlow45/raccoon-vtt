/**
 * The weather's textures, made in code on a kind's first use (the weather
 * design note, 6.4): a 256 px tiling noise sheet per color for fog and a
 * sandstorm, and a 144 by 24 atlas of six leaves.
 */

export const NOISE_SIZE = 256;
export const LEAF_CELL = 24;
export const LEAF_COUNT = 6;

/** Makes a canvas: `document.createElement("canvas")` in the app, a fake in tests. */
export type CanvasMaker = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;

/** A tiling noise sheet's alpha, 0 to 255, row by row: the same seed gives the same sheet. */
export function noiseAlpha(size: number, seed: number): Uint8Array {
  void seed;
  return new Uint8Array(size * size);
}

/** Draws the six leaves into a 144 by 24 canvas, one 24 px cell each. */
export function drawLeafAtlas(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
  void g;
}

/** What a draw takes its images from. Null until made, and a draw skips what is missing. */
export type TextureSource = {
  noise(color: string): CanvasImageSource | null;
  leaves(): CanvasImageSource | null;
};

/** The textures of one controller: each made once on first use, all let go by `release`. */
export class WeatherTextures implements TextureSource {
  readonly #make: CanvasMaker;
  constructor(make: CanvasMaker) {
    this.#make = make;
  }
  noise(color: string): CanvasImageSource | null {
    void color;
    void this.#make;
    return null;
  }
  leaves(): CanvasImageSource | null {
    return null;
  }
  /** Bytes the textures made so far hold. */
  bytes(): number {
    return 0;
  }
  release(): void {}
}
