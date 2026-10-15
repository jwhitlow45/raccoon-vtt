import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cameraForView,
  clampScale,
  fitRect,
  rectClear,
  MAX_SCALE,
  MIN_SCALE,
  pinchCamera,
  screenToWorld,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
  type Camera,
} from "./camera.ts";
import { CameraGesture, LongPress } from "./gestures.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe("camera", () => {
  const cam: Camera = { x: 100, y: 50, scale: 40 };

  test("world and screen round trip", () => {
    const s = worldToScreen(cam, { x: 2.5, y: -1 });
    assert.deepEqual(s, { x: 200, y: 10 });
    assert.deepEqual(screenToWorld(cam, s), { x: 2.5, y: -1 });
  });

  test("zooming keeps the point under the cursor in place", () => {
    const anchor = { x: 321, y: 123 };
    const before = screenToWorld(cam, anchor);
    const zoomed = zoomAt(cam, anchor, 1.7);
    close(zoomed.scale, 68);
    const after = screenToWorld(zoomed, anchor);
    close(after.x, before.x);
    close(after.y, before.y);
  });

  test("zoom is bounded", () => {
    assert.equal(zoomAt(cam, { x: 0, y: 0 }, 1000).scale, MAX_SCALE);
    assert.equal(zoomAt(cam, { x: 0, y: 0 }, 0.0001).scale, MIN_SCALE);
    assert.equal(clampScale(50), 50);
  });

  test("wheel zoom is symmetric and stronger for trackpad pinches", () => {
    close(wheelZoomFactor(100, 0, false) * wheelZoomFactor(-100, 0, false), 1);
    assert.ok(wheelZoomFactor(-10, 0, true) > wheelZoomFactor(-10, 0, false));
    assert.ok(wheelZoomFactor(-3, 1, false) > 1, "line mode zooms in for a scroll up");
  });

  test("fit centers the rectangle and fits its longer side", () => {
    const fitted = fitRect({ width: 400, height: 300 }, { x: 0, y: 0, width: 30, height: 20 }, 0);
    close(fitted.scale, 400 / 30);
    const center = worldToScreen(fitted, { x: 15, y: 10 });
    close(center.x, 200);
    close(center.y, 150);
  });

  test("fit keeps the rectangle clear of the bars over the canvas", () => {
    // A tablet: a 52 px top bar, and a 56 px toolbar under a 53 px tool options bar.
    const viewport = { width: 820, height: 1180 };
    const insets = { top: 52, right: 0, bottom: 109, left: 0 };
    const fitted = fitRect(viewport, { x: 0, y: 0, width: 30, height: 40 }, 12, insets);
    const topLeft = worldToScreen(fitted, { x: 0, y: 0 });
    const bottomRight = worldToScreen(fitted, { x: 30, y: 40 });
    assert.ok(topLeft.y >= 52 + 12 - 1e-9, `top row at ${topLeft.y} is under the top bar`);
    assert.ok(bottomRight.y <= 1180 - 109 - 12 + 1e-9, `bottom row at ${bottomRight.y} is under the bars`);
    close((topLeft.y + bottomRight.y) / 2, 52 + (1180 - 52 - 109) / 2);
    close((topLeft.x + bottomRight.x) / 2, 410);
  });

  test("a rectangle is clear when no inset covers any of it", () => {
    const fitted = fitRect({ width: 400, height: 300 }, { x: 0, y: 0, width: 30, height: 20 }, 0, { top: 0, right: 0, bottom: 50, left: 0 });
    const rect = { x: 0, y: 0, width: 30, height: 20 };
    assert.equal(rectClear(fitted, rect, { width: 400, height: 300 }, { top: 0, right: 0, bottom: 50, left: 0 }), true);
    assert.equal(rectClear(fitted, rect, { width: 400, height: 300 }, { top: 0, right: 0, bottom: 20, left: 0 }), true);
    assert.equal(rectClear(fitted, rect, { width: 400, height: 300 }, { top: 0, right: 0, bottom: 80, left: 0 }), false);
  });

  test("a saved view puts its point at the center", () => {
    const c = cameraForView({ width: 400, height: 300 }, { x: 10, y: 5, zoom: 50 });
    assert.deepEqual(worldToScreen(c, { x: 10, y: 5 }), { x: 200, y: 150 });
  });

  test("pinch keeps the world point under the fingers pinned while they move", () => {
    const base = { cam, mid: { x: 200, y: 200 }, dist: 100 };
    const pinned = screenToWorld(cam, base.mid);
    const next = pinchCamera(base, { mid: { x: 260, y: 180 }, dist: 150 });
    close(next.scale, 60);
    const under = screenToWorld(next, { x: 260, y: 180 });
    close(under.x, pinned.x);
    close(under.y, pinned.y);
  });
});

describe("camera gesture", () => {
  const cam: Camera = { x: 0, y: 0, scale: 50 };

  test("one finger on empty map pans", () => {
    const g = new CameraGesture();
    assert.equal(g.down(1, { x: 10, y: 10 }, cam, true), "pan");
    assert.deepEqual(g.move(1, { x: 30, y: 5 }), { x: 20, y: -5, scale: 50 });
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false });
    assert.equal(g.mode, "idle");
  });

  test("a press that stays within 8 px is a tap", () => {
    const g = new CameraGesture();
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.move(1, { x: 14, y: 13 });
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: true });
  });

  test("one finger on a token is left to Konva", () => {
    const g = new CameraGesture();
    assert.equal(g.down(1, { x: 10, y: 10 }, cam, false), "tool");
    assert.equal(g.move(1, { x: 50, y: 50 }), null);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false });
  });

  test("a second finger starts a pinch, even over a token drag", () => {
    const g = new CameraGesture();
    g.down(1, { x: 100, y: 100 }, cam, false);
    assert.equal(g.down(2, { x: 200, y: 100 }, cam, true), "pinch");
    const zoomed = g.move(2, { x: 300, y: 100 });
    assert.ok(zoomed);
    close(zoomed.scale, 100);
    // The midpoint moved from 150 to 200 and the world point under it stayed.
    const pinned = screenToWorld(cam, { x: 150, y: 100 });
    const under = screenToWorld(zoomed, { x: 200, y: 100 });
    close(under.x, pinned.x);
    close(under.y, pinned.y);
  });

  test("lifting one of two fingers re-baselines, so the camera does not jump", () => {
    const g = new CameraGesture();
    g.down(1, { x: 100, y: 100 }, cam, true);
    g.down(2, { x: 200, y: 100 }, cam, true);
    const zoomed = g.move(2, { x: 300, y: 100 })!;
    g.up(2, zoomed);
    assert.equal(g.mode, "pan");
    // The remaining finger has not moved yet, so the camera holds.
    assert.deepEqual(g.move(1, { x: 100, y: 100 }), zoomed);
    assert.deepEqual(g.move(1, { x: 110, y: 100 }), { ...zoomed, x: zoomed.x + 10 });
    assert.deepEqual(g.up(1, zoomed), { tapOnEmpty: false });
  });

  test("three or more fingers are ignored, and going back to two re-baselines", () => {
    const g = new CameraGesture();
    g.down(1, { x: 0, y: 0 }, cam, true);
    g.down(2, { x: 100, y: 0 }, cam, true);
    assert.equal(g.down(3, { x: 50, y: 50 }, cam, true), "ignored");
    assert.equal(g.move(3, { x: 80, y: 80 }), null);
    g.up(3, cam);
    assert.equal(g.mode, "pinch");
    assert.deepEqual(g.move(1, { x: 0, y: 0 }), cam);
  });

  test("moves of unknown pointers are ignored", () => {
    const g = new CameraGesture();
    assert.equal(g.move(9, { x: 1, y: 1 }), null);
    assert.deepEqual(g.up(9, cam), { tapOnEmpty: false });
  });
});

describe("long press", () => {
  function fakeTimers() {
    const pending = new Map<number, () => void>();
    let next = 1;
    return {
      timers: {
        set: (fn: () => void) => {
          pending.set(next, fn);
          return next++;
        },
        clear: (h: unknown) => void pending.delete(h as number),
      },
      fire: () => {
        for (const [h, fn] of [...pending]) {
          pending.delete(h);
          fn();
        }
      },
      pending,
    };
  }

  test("fires when the press holds still", () => {
    const t = fakeTimers();
    const lp = new LongPress({ timers: t.timers });
    let fired = 0;
    lp.start({ x: 0, y: 0 }, () => fired++);
    lp.move({ x: 5, y: 5 });
    t.fire();
    assert.equal(fired, 1);
    assert.equal(lp.pending, false);
  });

  test("8 px of movement cancels it", () => {
    const t = fakeTimers();
    const lp = new LongPress({ timers: t.timers });
    let fired = 0;
    lp.start({ x: 0, y: 0 }, () => fired++);
    lp.move({ x: 9, y: 0 });
    t.fire();
    assert.equal(fired, 0);
  });

  test("an explicit cancel stops it", () => {
    const t = fakeTimers();
    const lp = new LongPress({ timers: t.timers });
    let fired = 0;
    lp.start({ x: 0, y: 0 }, () => fired++);
    lp.cancel();
    t.fire();
    assert.equal(fired, 0);
    assert.equal(t.pending.size, 0);
  });
});
