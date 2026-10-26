import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fogSeam, type Affine, type Box } from "./fogSeam.ts";

/** `p` then `q`: the transform that applies q first, as a canvas's transform() calls compose. */
function times(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    e: p.a * q.e + p.c * q.f + p.e,
    f: p.b * q.e + p.d * q.f + p.f,
  };
}

/** A board's camera at a canvas pixel ratio: cells to canvas pixels. */
function camera(ratio: number, scale: number, x: number, y: number): Affine {
  return { a: ratio * scale, b: 0, c: 0, d: ratio * scale, e: ratio * x, f: ratio * y };
}

/** Isometric's ground under a camera (lib/view.ts groundGroups): turned, then halved in height. */
function ground(cam: Affine, turn: number): Affine {
  const r = ((45 + 90 * turn) * Math.PI) / 180;
  return times(times(cam, { a: 1, b: 0, c: 0, d: 0.5, e: 0, f: 0 }), { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
}

function apply(t: Affine, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
}

/** A box's corners on the canvas, as its left, top, right and bottom. */
function onCanvas(t: Affine, box: Box): [number, number, number, number] {
  const p = apply(t, box.x, box.y);
  const q = apply(t, box.x + box.w, box.y + box.h);
  return [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];
}

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);

/** The canvas distance between the lines through two points of a cell axis, across that axis. */
function across(t: Affine, axis: "x" | "y", at: number, from: number): number {
  const along = axis === "x" ? [0, 1] : [1, 0];
  const p0 = axis === "x" ? apply(t, from, 0) : apply(t, 0, from);
  const p1 = axis === "x" ? apply(t, at, 0) : apply(t, 0, at);
  const dir = apply({ ...t, e: 0, f: 0 }, along[0]!, along[1]!);
  const len = Math.hypot(dir.x, dir.y);
  return Math.abs((p1.x - p0.x) * dir.y - (p1.y - p0.y) * dir.x) / len;
}

describe("where the fog's frame and image meet (fogSeam.ts)", () => {
  test("Top-down off the pixel grid: both covers meet on the whole pixels just inside the scene's edges", () => {
    for (const ratio of [1, 2]) {
      for (const [scale, x, y] of [
        [23.37, 100.37, 50.13],
        [31.81, -7.71, 3.29],
        [47.66, 0.5, 0.83],
      ] as const) {
        const t = camera(ratio, scale, x, y);
        const { hole, image } = fogSeam(t, 8, 6);
        assert.deepEqual(hole, image, "the image fills the hole exactly, so nothing overlaps");
        const [l, tp, r, b] = onCanvas(t, hole);
        const [sl, st, sr, sb] = onCanvas(t, { x: 0, y: 0, w: 8, h: 6 });
        for (const [v, what] of [
          [l, "left"],
          [tp, "top"],
          [r, "right"],
          [b, "bottom"],
        ] as const)
          near(v, Math.round(v), `${what} on a whole pixel`);
        assert.ok(l >= sl - 1e-6 && l < sl + 1, `left within a pixel inside: ${l} for ${sl}`);
        assert.ok(tp >= st - 1e-6 && tp < st + 1, `top within a pixel inside: ${tp} for ${st}`);
        assert.ok(r <= sr + 1e-6 && r > sr - 1, `right within a pixel inside: ${r} for ${sr}`);
        assert.ok(b <= sb + 1e-6 && b > sb - 1, `bottom within a pixel inside: ${b} for ${sb}`);
      }
    }
  });

  test("Top-down on the pixel grid already, or a hair off it from float error: the scene's own rectangle", () => {
    for (const t of [camera(2, 40, 100, 60), camera(1, 25, 10 + 1e-9, 20 - 1e-9)]) {
      const { hole, image } = fogSeam(t, 8, 6);
      for (const box of [hole, image]) {
        near(box.x, 0, "x");
        near(box.y, 0, "y");
        near(box.w, 8, "w");
        near(box.h, 6, "h");
      }
    }
  });

  test("a mirrored or quarter-turned transform still runs along the grid: the covers meet on whole pixels", () => {
    for (const t of [
      { a: -30.3, b: 0, c: 0, d: 30.3, e: 500.37, f: 20.71 },
      { a: 0, b: 30.3, c: -30.3, d: 0, e: 400.37, f: 20.71 },
    ]) {
      const { hole, image } = fogSeam(t, 8, 6);
      assert.deepEqual(hole, image);
      for (const v of onCanvas(t, hole)) near(v, Math.round(v), "corner on a whole pixel");
      assert.ok(hole.w > 8 - 2 / 30.3 && hole.w <= 8 && hole.h > 6 - 2 / 30.3 && hole.h <= 6, `shrunk by less than a pixel each side: ${JSON.stringify(hole)}`);
    }
  });

  test("Isometric at every turn and pixel ratio: the image covers the scene, and the frame's hole is one canvas pixel in across each edge", () => {
    for (const turn of [0, 1, 2, 3]) {
      for (const ratio of [1, 2]) {
        const t = ground(camera(ratio, 31.81, 300.37, 120.71), turn);
        const { hole, image } = fogSeam(t, 8, 6);
        assert.deepEqual(image, { x: 0, y: 0, w: 8, h: 6 });
        near(across(t, "x", hole.x, 0), 1, `turn ${turn} at ${ratio}: the west side`);
        near(across(t, "x", 8, hole.x + hole.w), 1, `turn ${turn} at ${ratio}: the east side`);
        near(across(t, "y", hole.y, 0), 1, `turn ${turn} at ${ratio}: the north side`);
        near(across(t, "y", 6, hole.y + hole.h), 1, `turn ${turn} at ${ratio}: the south side`);
      }
    }
  });

  test("a scene narrower than a pixel leaves no hole and no image, so the frame fogs it all", () => {
    const { hole, image } = fogSeam(camera(1, 0.05, 10.3, 10.3), 8, 6);
    assert.equal(hole.w * hole.h, 0);
    assert.equal(image.w * image.h, 0);
    const slanted = fogSeam(ground(camera(1, 0.05, 10.3, 10.3), 0), 8, 6);
    assert.equal(slanted.hole.w * slanted.hole.h, 0);
  });

  test("a transform with no area, as a hidden stage's, keeps the scene's rectangle", () => {
    const scene = { x: 0, y: 0, w: 8, h: 6 };
    assert.deepEqual(fogSeam({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 8, 6), { hole: scene, image: scene });
  });
});
