import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DoubleSide, FrontSide } from "three";
import { PLAIN, type ModelPart, type PartMaterial } from "./mesh.ts";
import { decodeTexture, materialFor, outline, partTextures } from "./render.ts";

/**
 * The drawing's parts that run without WebGL (docs/design/design-v1-token-models.md
 * 5): each material's alpha as glTF says, textures shared by image and
 * wrap, the fallback decode, and the outline on a sheet's bytes. The frames
 * themselves are drawn in a browser.
 */

const material = (over: Partial<PartMaterial>): PartMaterial => ({ ...PLAIN, plain: false, ...over });

describe("a part's material", () => {
  test("MASK tests the base color's alpha factor against its cutoff, never an alpha of 1", () => {
    const m = materialFor(material({ alpha: "mask", alphaCutoff: 0.5, color: [1, 1, 1, 0.25] }), null, false);
    assert.equal(m.opacity, 0.25);
    assert.equal(m.alphaTest, 0.5);
    assert.equal(m.transparent, false, "a masked part is opaque where it is kept");
  });

  test("BLEND blends with its alpha and writes no depth, so its triangles never hide those behind them", () => {
    const m = materialFor(material({ alpha: "blend", color: [1, 0, 0, 0.4] }), null, true);
    assert.deepEqual([m.transparent, m.opacity, m.depthWrite, m.alphaTest, m.vertexColors], [true, 0.4, false, 0, true]);
  });

  test("OPAQUE ignores its alpha and writes depth, and doubleSided draws both sides", () => {
    const m = materialFor(material({ alpha: "opaque", color: [1, 1, 1, 0.1] }), null, false);
    assert.deepEqual([m.transparent, m.opacity, m.depthWrite, m.side], [false, 1, true, FrontSide]);
    assert.equal(materialFor(material({ doubleSided: true }), null, false).side, DoubleSide);
    assert.deepEqual([m.metalness, m.roughness], [0, 0.8]);
  });
});

describe("a model's textures", () => {
  const part = (texture: number, wrapS = 10497, wrapT = 10497, uvs = true): ModelPart => ({
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    index: null,
    uvs: uvs ? new Float32Array(6) : null,
    colors: null,
    material: material({ texture, wrapS, wrapT }),
  });

  test("groups reading one image with one wrap share one texture, another wrap shares its source, and each image has its own", () => {
    const bitmaps = [{ width: 4, height: 4 }, { width: 8, height: 8 }] as unknown as ImageBitmap[];
    const [a, b, c, d, none, missing] = partTextures([part(0), part(0), part(0, 33071), part(1), part(0, 10497, 10497, false), part(-1)], bitmaps);
    assert.ok(a && a === b, "one texture for one image and wrap");
    assert.ok(c && c !== a && c.source === a.source, "another wrap, the same upload");
    assert.ok(d && d.source !== a.source);
    assert.equal(none, null, "no coordinates, no texture");
    assert.equal(missing, null);
    assert.deepEqual([c.wrapS, c.wrapT, a.flipY, a.colorSpace], [1001, 1000, false, "srgb"]);
  });

  test("64 groups over one image make one texture", () => {
    const maps = partTextures(Array.from({ length: 64 }, () => part(0)), [{ width: 1024, height: 1024 }] as unknown as ImageBitmap[]);
    assert.equal(new Set(maps).size, 1);
  });

  test("a decode that cannot resize as it decodes draws down on a canvas and keeps the alpha unpremultiplied", async () => {
    const calls: unknown[] = [];
    const saved = { createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas };
    Object.assign(globalThis, {
      createImageBitmap: async (_source: unknown, options?: ImageBitmapOptions) => {
        calls.push(options);
        if (options?.resizeWidth) throw new TypeError("resize is not supported");
        return { width: 4096, height: 2048, close() {} };
      },
      OffscreenCanvas: class {
        getContext() {
          return { drawImage() {} };
        }
      },
    });
    try {
      await decodeTexture(new Uint8Array(8), "image/png", 4096, 2048);
    } finally {
      Object.assign(globalThis, saved);
    }
    assert.equal(calls.length, 3);
    for (const options of calls) assert.equal((options as ImageBitmapOptions).premultiplyAlpha, "none");
  });
});

describe("the outline", () => {
  /** A width by height image with a square from (x0, y0) of side `side` in one color and alpha. */
  function square(width: number, height: number, x0: number, y0: number, side: number, rgba: [number, number, number, number]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) out.set(rgba, (y * width + x) * 4);
    return out;
  }
  const px = (img: Uint8ClampedArray, width: number, x: number, y: number) => [...img.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

  test("leaves a broad translucent surface's color and alpha as drawn, and darkens only outside it", () => {
    const W = 48;
    const img = square(W, W, 12, 12, 24, [200, 100, 50, 128]);
    const before = img.slice();
    outline(img, W, W);
    for (let y = 12; y < 36; y++) for (let x = 12; x < 36; x++) assert.deepEqual(px(img, W, x, y), px(before, W, x, y), `inside at ${x}, ${y}`);
    const [r, g, b, a] = px(img, W, 11, 20);
    assert.deepEqual([r, g, b], [0, 0, 0]);
    assert.ok(a! > 40 && a! < 0.7 * 255, `a ring at the half-seen surface's edge: ${a}`);
    assert.deepEqual(px(img, W, 8, 20), [0, 0, 0, 0], "nothing 4 px out");
  });

  test("rings an opaque figure at 70% just outside it, fading by 2 px out", () => {
    const W = 40;
    const img = square(W, W, 10, 10, 20, [150, 150, 150, 255]);
    outline(img, W, W);
    assert.equal(px(img, W, 9, 20)[3], Math.round(255 * 0.7));
    assert.ok(px(img, W, 8, 20)[3]! < px(img, W, 9, 20)[3]!);
    assert.equal(px(img, W, 7, 20)[3], 0);
    assert.deepEqual(px(img, W, 15, 15), [150, 150, 150, 255]);
  });
});
