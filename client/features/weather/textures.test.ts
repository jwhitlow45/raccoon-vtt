import assert from "node:assert/strict";
import { test } from "node:test";
import { LEAF_COLORS } from "./looks.ts";
import { drawLeafAtlas, LEAF_CELL, LEAF_COUNT, NOISE_SIZE, noiseAlpha, noisePixels, WeatherTextures, type CanvasMaker } from "./textures.ts";

test("the noise sheet tiles: its opposite edges meet as smoothly as any two neighbors", () => {
  for (const seed of [1, 2, 99]) {
    const a = noiseAlpha(NOISE_SIZE, seed);
    const at = (x: number, y: number) => a[y * NOISE_SIZE + x]!;
    let inner = 0;
    let seam = 0;
    for (let k = 0; k < NOISE_SIZE; k++) {
      for (let x = 0; x + 1 < NOISE_SIZE; x++) inner = Math.max(inner, Math.abs(at(x, k) - at(x + 1, k)), Math.abs(at(k, x) - at(k, x + 1)));
      seam = Math.max(seam, Math.abs(at(NOISE_SIZE - 1, k) - at(0, k)), Math.abs(at(k, NOISE_SIZE - 1) - at(k, 0)));
    }
    assert.ok(seam <= inner, `seed ${seed}: seam ${seam}, neighbors ${inner}`);
    assert.ok(inner <= 24, "and it is smooth");
  }
});

test("the noise has banks and gaps, the same seed the same sheet", () => {
  const a = noiseAlpha(NOISE_SIZE, 5);
  let lo = 255;
  let hi = 0;
  let sum = 0;
  for (const v of a) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    sum += v;
  }
  assert.ok(lo < 30 && hi > 220, `alpha spans ${lo} to ${hi}`);
  const mean = sum / a.length;
  assert.ok(mean > 60 && mean < 200, `mean ${mean}`);
  assert.deepEqual(noiseAlpha(64, 5), noiseAlpha(64, 5));
  assert.notDeepEqual(noiseAlpha(64, 5), noiseAlpha(64, 6));
});

test("the sheet's pixels are its color, alpha from the noise, in range", () => {
  const px = noisePixels("#d9dee4", 32);
  assert.equal(px.length, 32 * 32 * 4);
  for (let k = 0; k < px.length; k += 4) {
    assert.deepEqual([px[k], px[k + 1], px[k + 2]], [0xd9, 0xde, 0xe4]);
    assert.ok(px[k + 3]! >= 0 && px[k + 3]! <= 255);
  }
});

function fakeCanvas(): { make: CanvasMaker; made: { width: number; height: number; drawn: string[] }[] } {
  const made: { width: number; height: number; drawn: string[] }[] = [];
  const make: CanvasMaker = (width, height) => {
    const canvas = { width, height, drawn: [] as string[], getContext: () => context };
    const context = new Proxy(
      {},
      {
        get: (_t, name) => {
          if (name === "createImageData") return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
          return (..._a: unknown[]) => void canvas.drawn.push(String(name));
        },
        set: () => true,
      },
    );
    made.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  };
  return { make, made };
}

test("textures are made once on first use, counted, and all let go together", () => {
  const { make, made } = fakeCanvas();
  const t = new WeatherTextures(make);
  assert.equal(t.bytes(), 0);
  const fog = t.noise("#d9dee4");
  assert.equal(t.noise("#d9dee4"), fog);
  t.noise("#d6b77a");
  assert.equal(t.leaves(), t.leaves());
  assert.equal(made.length, 3);
  assert.equal(t.bytes(), 2 * 256 * 256 * 4 + 144 * 24 * 4, "two sheets of 256 KB and the atlas");
  assert.deepEqual([made[2]!.width, made[2]!.height], [LEAF_CELL * LEAF_COUNT, LEAF_CELL]);
  assert.ok(made[0]!.drawn.includes("putImageData"));
  t.release();
  assert.equal(t.bytes(), 0);
  assert.ok(made.every((c) => c.width === 0 && c.height === 0), "released canvases hold no pixels");
  assert.notEqual(t.noise("#d9dee4"), fog, "made again after a release");
});

test("the atlas draws six leaves in the four colors, each inside its own cell", () => {
  const fills: string[] = [];
  const origins: number[] = [];
  let style = "";
  const g = {
    set fillStyle(v: string) { style = v; },
    set strokeStyle(_v: string) {},
    lineWidth: 1,
    setTransform: (_a: number, _b: number, _c: number, _d: number, e: number) => origins.push(e),
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, stroke() {},
    fill: () => fills.push(style),
  };
  drawLeafAtlas(g as unknown as CanvasRenderingContext2D);
  assert.equal(fills.length, 6);
  assert.deepEqual(new Set(fills), new Set(LEAF_COLORS));
  assert.deepEqual(origins, [12, 36, 60, 84, 108, 132, 0]);
});
