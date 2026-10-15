import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampView, doubleTapView, FIT, isDoubleTap, MAX_ZOOM, panView, pinchView, TAP_ZOOM, zoomAround } from "./zoom.ts";

const box = { width: 300, height: 400 };

describe("zooming a handout", () => {
  test("never smaller than the fitted image, never past the largest zoom", () => {
    assert.deepEqual(clampView({ scale: 0.5, x: 40, y: 40 }, box), FIT);
    assert.equal(zoomAround(FIT, { x: 0, y: 0 }, 100, box).scale, MAX_ZOOM);
  });

  test("the point under the fingers stays put while zooming", () => {
    const v = zoomAround(FIT, { x: 150, y: 200 }, 2, box);
    assert.deepEqual(v, { scale: 2, x: -150, y: -200 });
    // The image point (150, 200) was under the anchor and still is.
    assert.equal(v.x + 150 * v.scale, 150);
    assert.equal(v.y + 200 * v.scale, 200);
  });

  test("a pinch follows the fingers from where they landed", () => {
    const base = { view: FIT, mid: { x: 100, y: 100 }, dist: 100 };
    assert.deepEqual(pinchView(base, { mid: { x: 100, y: 100 }, dist: 300 }, box), { scale: 3, x: -200, y: -200 });
    // Spreading and moving both fingers also pans.
    assert.deepEqual(pinchView(base, { mid: { x: 120, y: 90 }, dist: 300 }, box), { scale: 3, x: -180, y: -210 });
  });

  test("a pan stops at the image's edges, so it cannot be lost", () => {
    const zoomed = { scale: 2, x: -100, y: -100 };
    assert.deepEqual(panView(zoomed, 500, 500, box), { scale: 2, x: 0, y: 0 });
    assert.deepEqual(panView(zoomed, -500, -500, box), { scale: 2, x: -300, y: -400 });
    assert.deepEqual(panView(FIT, 50, 50, box), FIT);
  });

  test("a double tap zooms in on the spot, and the next one zooms back out", () => {
    const inView = doubleTapView(FIT, { x: 60, y: 80 }, box);
    assert.equal(inView.scale, TAP_ZOOM);
    assert.equal(inView.x + 60 * inView.scale, 60);
    assert.deepEqual(doubleTapView(inView, { x: 10, y: 10 }, box), FIT);
  });

  test("two taps make a double tap only when close in time and place", () => {
    const first = { at: 1000, p: { x: 50, y: 50 } };
    assert.equal(isDoubleTap(first, { at: 1200, p: { x: 60, y: 55 } }), true);
    assert.equal(isDoubleTap(first, { at: 1400, p: { x: 50, y: 50 } }), false);
    assert.equal(isDoubleTap(first, { at: 1100, p: { x: 120, y: 50 } }), false);
    assert.equal(isDoubleTap(null, first), false);
  });
});
