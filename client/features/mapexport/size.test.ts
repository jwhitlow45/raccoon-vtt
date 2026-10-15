import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PX_PER_CELL, exportSize, mapVariantFor, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE } from "./size.ts";

describe("exportSize", () => {
  test("a scene that fits keeps the chosen scale", () => {
    assert.deepEqual(exportSize({ w: 30, h: 20 }, 70), { pxPerCell: 70, requested: 70, width: 2100, height: 1400 });
    assert.deepEqual(exportSize({ w: 30, h: 20 }, 100), { pxPerCell: 100, requested: 100, width: 3000, height: 2000 });
  });

  test("a scene too large for the pixel cap gets the largest whole scale that fits", () => {
    const size = exportSize({ w: 60, h: 40 }, 100);
    assert.equal(size.pxPerCell, 83);
    assert.equal(size.requested, 100);
    assert.deepEqual([size.width, size.height], [4980, 3320]);
    assert.ok(size.width * size.height <= MAX_EXPORT_PIXELS);
    // One more pixel per square would not fit.
    assert.ok(60 * 84 * 40 * 84 > MAX_EXPORT_PIXELS);
  });

  test("the cap is exactly the iPhone canvas limit, so 58 x 58 squares still fit at 70 px", () => {
    assert.equal(MAX_EXPORT_PIXELS, 4096 * 4096);
    assert.equal(exportSize({ w: 58, h: 58 }, 70).pxPerCell, 70);
    assert.equal(exportSize({ w: 59, h: 59 }, 70).pxPerCell, 69);
  });

  test("the largest scene still exports, at 20 px per square", () => {
    const size = exportSize({ w: 200, h: 200 }, 100);
    assert.deepEqual(size, { pxPerCell: 20, requested: 100, width: 4000, height: 4000 });
  });

  test("a long thin scene is held to the side limit as well as the area", () => {
    const size = exportSize({ w: 200, h: 1 }, 100);
    assert.equal(size.pxPerCell, 81);
    assert.ok(size.width <= MAX_EXPORT_SIDE);
    assert.equal(exportSize({ w: 200, h: 1 }, 100, { maxPixels: MAX_EXPORT_PIXELS, maxSide: 8000 }).pxPerCell, 40);
  });

  test("every scene size at every offered scale stays within both limits", () => {
    for (const requested of [50, 70, 100]) {
      for (let w = 1; w <= 200; w += 7) {
        for (let h = 1; h <= 200; h += 11) {
          const s = exportSize({ w, h }, requested);
          assert.ok(s.width * s.height <= MAX_EXPORT_PIXELS, `${w}x${h} at ${requested}`);
          assert.ok(Math.max(s.width, s.height) <= MAX_EXPORT_SIDE, `${w}x${h} at ${requested}`);
          assert.ok(s.pxPerCell >= 1 && s.pxPerCell <= requested);
          assert.ok(Number.isInteger(s.pxPerCell));
        }
      }
    }
  });

  test("a scale that is not a whole number is rounded down, and nonsense falls back to the default", () => {
    assert.equal(exportSize({ w: 10, h: 10 }, 70.9).pxPerCell, 70);
    assert.equal(exportSize({ w: 10, h: 10 }, Number.NaN).pxPerCell, DEFAULT_PX_PER_CELL);
    assert.equal(exportSize({ w: 10, h: 10 }, 0).pxPerCell, 1);
  });

  test("bounds that are not whole squares are refused", () => {
    assert.throws(() => exportSize({ w: 0, h: 10 }, 70), RangeError);
    assert.throws(() => exportSize({ w: 10.5, h: 10 }, 70), RangeError);
  });
});

describe("mapVariantFor", () => {
  const map = { widthPx: 8000, heightPx: 6000, cellPx: 200 };

  test("the phone copy when it has enough pixels for the scale", () => {
    // The phone copy is 4096 px wide, about 102 px per square.
    assert.equal(mapVariantFor(map, 100, "full"), "mobile");
    assert.equal(mapVariantFor(map, 70, "full"), "mobile");
  });

  test("the full copy when the scale needs more and the device loads full maps", () => {
    assert.equal(mapVariantFor({ ...map, cellPx: 100 }, 70, "full"), "full");
  });

  test("a phone always uses its phone copy", () => {
    assert.equal(mapVariantFor({ ...map, cellPx: 100 }, 100, "mobile"), "mobile");
  });

  test("a small map's phone copy is the full image, so it is always enough", () => {
    assert.equal(mapVariantFor({ widthPx: 2000, heightPx: 1500, cellPx: 50 }, 100, "full"), "mobile");
  });
});
