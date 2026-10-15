import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { fitRect, keepInView, sceneMinScale, zoomAt, pinchCamera, MIN_SCALE } from "./camera.ts";
import { fitTarget } from "./fitTarget.ts";

const bounds = { w: 20, h: 10 };

function mask(cells: [number, number][]) {
  const width = bounds.w * FOG_SUBCELLS;
  const height = bounds.h * FOG_SUBCELLS;
  const revealed = new Uint8Array(width * height);
  for (const [cx, cy] of cells) {
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) revealed[(cy * FOG_SUBCELLS + sy) * width + cx * FOG_SUBCELLS + sx] = 1;
  }
  return { width, height, revealed };
}

describe("fit map", () => {
  test("a DM, or a scene without fog, fits the whole scene", () => {
    assert.deepEqual(fitTarget({ bounds, revealed: null, own: [] }), { x: 0, y: 0, width: 20, height: 10 });
  });

  test("a player under fog fits what is revealed and their own tokens, with a cell to spare", () => {
    const target = fitTarget({ bounds, revealed: mask([[5, 4], [6, 4]]), own: [{ x: 9, y: 6, width: 1, height: 1 }] });
    assert.deepEqual(target, { x: 4, y: 3, width: 7, height: 5 });
  });

  test("nothing revealed and no tokens falls back to the whole scene", () => {
    assert.deepEqual(fitTarget({ bounds, revealed: mask([]), own: [] }), { x: 0, y: 0, width: 20, height: 10 });
  });

  test("the margin never reaches past the scene", () => {
    assert.deepEqual(fitTarget({ bounds, revealed: mask([[0, 0]]), own: [] }), { x: 0, y: 0, width: 2, height: 2 });
  });

  test("fits inside what the top bar and toolbar leave clear", () => {
    const cam = fitRect({ width: 400, height: 800 }, { x: 0, y: 0, width: 10, height: 10 }, 0, { top: 52, bottom: 60, left: 0, right: 0 });
    assert.equal(cam.scale, 40);
    // The 400 px square sits centered between the bars, not the canvas.
    assert.equal(cam.y, 52 + (688 - 400) / 2);
  });
});

describe("zoom limits", () => {
  test("a small scene zooms out only until it fills half the screen", () => {
    const viewport = { width: 400, height: 800 };
    const min = sceneMinScale(viewport, bounds);
    assert.equal(min, 10);
    assert.equal(zoomAt({ x: 0, y: 0, scale: 20 }, { x: 0, y: 0 }, 0.01, min).scale, 10);
    const base = { cam: { x: 0, y: 0, scale: 20 }, mid: { x: 0, y: 0 }, dist: 100 };
    assert.equal(pinchCamera(base, { mid: { x: 0, y: 0 }, dist: 1 }, min).scale, 10);
  });

  test("a big scene keeps the old floor", () => {
    assert.equal(sceneMinScale({ width: 400, height: 800 }, { w: 200, h: 200 }), MIN_SCALE);
  });

  test("a camera already under the floor may stay there, but not go further", () => {
    assert.equal(zoomAt({ x: 0, y: 0, scale: 6 }, { x: 0, y: 0 }, 0.5, 10).scale, 6);
    assert.equal(zoomAt({ x: 0, y: 0, scale: 6 }, { x: 0, y: 0 }, 2, 10).scale, 12);
  });

  test("a pan keeps part of the scene on screen", () => {
    const viewport = { width: 400, height: 800 };
    const far = keepInView({ x: 5000, y: -5000, scale: 20 }, viewport, bounds);
    assert.deepEqual(far, { x: 400 - 64, y: 64 - 200, scale: 20 });
    const fine = { x: 10, y: 10, scale: 20 };
    assert.equal(keepInView(fine, viewport, bounds), fine);
  });

  test("the part of the scene a pan keeps is clear of the bars", () => {
    const viewport = { width: 400, height: 800 };
    const insets = { top: 52, right: 0, bottom: 60, left: 0 };
    const under = keepInView({ x: 10, y: 800 - 70, scale: 20 }, viewport, bounds, insets);
    assert.deepEqual(under, { x: 10, y: 800 - 60 - 64, scale: 20 });
    const above = keepInView({ x: 10, y: -190, scale: 20 }, viewport, bounds, insets);
    assert.deepEqual(above, { x: 10, y: 52 + 64 - 200, scale: 20 });
  });
});
