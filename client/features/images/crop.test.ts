import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { cropSourceRect } from "../../lib/tokenView.ts";
import { MAX_ZOOM, cropTransform, normalizeCrop, panCrop, sliderToZoom, zoomCrop, zoomToSlider } from "./crop.ts";

const wide = { width: 400, height: 200 };
const close = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

describe("crop math matches what the canvas draws", () => {
  test("normalizing keeps the shown region and pulls the center inside", () => {
    const crop = { cx: 0, cy: 0, zoom: 2 };
    const n = normalizeCrop(wide, crop);
    assert.deepEqual(cropSourceRect(wide, n), cropSourceRect(wide, crop));
    assert.deepEqual(n, { cx: 0.125, cy: 0.25, zoom: 2 });
  });

  test("zoom stays within 1 to 10, the protocol's bounds", () => {
    assert.equal(normalizeCrop(wide, { cx: 0.5, cy: 0.5, zoom: 0.2 }).zoom, 1);
    assert.equal(normalizeCrop(wide, { cx: 0.5, cy: 0.5, zoom: 50 }).zoom, MAX_ZOOM);
    assert.equal(normalizeCrop(wide, { cx: 0.5, cy: 0.5, zoom: Number.NaN }).zoom, 1);
  });

  test("dragging moves the image with the finger", () => {
    const start = { cx: 0.5, cy: 0.5, zoom: 2 };
    const before = cropSourceRect(wide, start);
    // A 100 px drag right over a 200 px viewport showing 100 source pixels moves the region 50 px left.
    const moved = panCrop(wide, start, 1, 100, 0, 200);
    const after = cropSourceRect(wide, moved);
    close(after.x, before.x - 50);
    close(after.y, before.y);
  });

  test("a drag past the edge stops at the edge", () => {
    const moved = panCrop(wide, { cx: 0.5, cy: 0.5, zoom: 1 }, 1, 0, 500, 200);
    assert.deepEqual(cropSourceRect(wide, moved), cropSourceRect(wide, { cx: 0.5, cy: 0.5, zoom: 1 }));
    const far = panCrop(wide, { cx: 0.5, cy: 0.5, zoom: 1 }, 1, 10_000, 0, 200);
    assert.equal(cropSourceRect(wide, far).x, 0);
  });

  test("zooming keeps the point under the fingers still", () => {
    const start = { cx: 0.5, cy: 0.5, zoom: 1 };
    const before = cropSourceRect(wide, start);
    const focus = { u: 0.25, v: 0.75 };
    const zoomed = zoomCrop(wide, start, 1, 2, focus);
    const after = cropSourceRect(wide, zoomed);
    close(before.x + focus.u * before.width, after.x + focus.u * after.width);
    close(before.y + focus.v * before.height, after.y + focus.v * after.height);
    assert.equal(zoomed.zoom, 2);
  });

  test("the preview transform puts the region exactly in the viewport", () => {
    const crop = { cx: 0.3, cy: 0.6, zoom: 3 };
    const r = cropSourceRect(wide, crop);
    const t = cropTransform(wide, crop, 1, 240);
    close(t.left + r.x * (t.width / wide.width), 0);
    close(t.top + r.y * (t.height / wide.height), 0);
    close((r.width * t.width) / wide.width, 240);
  });

  test("a non-square footprint crops to its own shape", () => {
    const t = cropTransform({ width: 300, height: 300 }, { cx: 0.5, cy: 0.5, zoom: 1 }, 2, 200);
    // A 2:1 region of a square image is 300 x 150, shown 200 px wide.
    close(t.width, 200);
    close(t.top, -50);
  });

  test("the slider is logarithmic and round-trips", () => {
    assert.equal(sliderToZoom(0), 1);
    close(sliderToZoom(1), MAX_ZOOM);
    close(sliderToZoom(0.5), Math.sqrt(MAX_ZOOM));
    close(sliderToZoom(zoomToSlider(3.3)), 3.3);
  });

  test("a saved crop is a valid op", () => {
    const crop = panCrop(wide, zoomCrop(wide, { cx: 0.5, cy: 0.5, zoom: 1 }, 1, 7.123456), 1, 33, -12, 240);
    const op = { t: "token.update", tokenId: "t1", patch: { image: { assetId: "a1", crop } } };
    assert.ok(clientOpSchema.safeParse(op).success);
  });
});
