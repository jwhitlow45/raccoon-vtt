import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  barShift,
  cameraForView,
  keepInView,
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
import { cameraAt, cameraOfStage, holdStill, screenToView, viewToScreen } from "./camera.ts";
import { CameraGesture, LongPress } from "./gestures.ts";
import { isometric, toView, turned, viewBox, type Turn } from "./view.ts";

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

describe("the camera in view space (docs/design-v1-isometric-view.md 4.1, 4.2)", () => {
  const cam: Camera = { x: 100, y: 50, scale: 40 };

  test("view and screen round trip", () => {
    const s = viewToScreen(cam, toView(isometric(0), { x: 0, y: 0 }));
    assert.deepEqual(s, { x: 100, y: 50 });
    const v = screenToView(cam, { x: 321, y: -7 });
    assert.deepEqual(viewToScreen(cam, v), { x: 321, y: -7 });
  });

  test("a camera at a point shows that point there", () => {
    const at = toView(isometric(2), { x: 12, y: 7 }, 3);
    const c = cameraAt({ x: 195, y: 400 }, at, 55);
    assert.equal(c.scale, 55);
    const s = viewToScreen(c, at);
    close(s.x, 195);
    close(s.y, 400);
    assert.deepEqual(cameraForView({ width: 390, height: 800 }, at, 55), cameraAt({ x: 195, y: 400 }, at, 55));
  });

  test("a turn with the selected token on screen keeps it put at the same scale, through every turn and back", () => {
    const token = { x: 14.5, y: 9.5 };
    let turn: Turn = 0;
    let c: Camera = cameraAt({ x: 200, y: 300 }, toView(isometric(turn), token), 48);
    for (const by of [1, 1, 1, 1, -1, -1] as const) {
      const next = turned(turn, by);
      c = holdStill(c, toView(isometric(turn), token), toView(isometric(next), token));
      turn = next;
      const s = viewToScreen(c, toView(isometric(turn), token));
      close(s.x, 200);
      close(s.y, 300);
      assert.equal(c.scale, 48);
    }
  });

  test("Fit in Isometric frames the scene's whole diamond", () => {
    const viewport = { width: 390, height: 844 };
    for (const turn of [0, 1, 2, 3] as const) {
      const view = isometric(turn);
      const c = fitRect(viewport, viewBox(view, { x: 0, y: 0, width: 40, height: 25 }), 24);
      for (const corner of [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 0, y: 25 },
        { x: 40, y: 25 },
      ]) {
        const s = viewToScreen(c, toView(view, corner));
        assert.ok(s.x >= 24 - 1e-9 && s.x <= 390 - 24 + 1e-9 && s.y >= 24 - 1e-9 && s.y <= 844 - 24 + 1e-9, `turn ${turn} corner ${corner.x},${corner.y}`);
      }
    }
  });

  test("a stage's camera reads its position and scale, an unscaled stage as 1", () => {
    assert.deepEqual(cameraOfStage({ x: () => 3, y: () => 4, scaleX: () => 20 }), { x: 3, y: 4, scale: 20 });
    assert.deepEqual(cameraOfStage({ x: () => 3, y: () => 4, scaleX: () => 0 }), { x: 3, y: 4, scale: 1 });
  });
});

describe("the camera's bounds with a token bar over the map (docs/design-v1-bar-compact.md 4 and 3.6)", () => {
  // A 390 x 844 canvas, a 30 x 20 scene at 44 px a cell (1320 x 880), and the strip's cover of 182 px at the foot over a 52 px top bar.
  const viewport = { width: 390, height: 844 };
  const bounds = { w: 30, h: 20 };
  const insets = { top: 52, right: 0, bottom: 182, left: 0 };

  test("a pan clamps as before where the camera stood inside its bounds", () => {
    // The map's top edge may come down to 64 px above the strip, at 844 - 182 - 64 = 598.
    const from = { x: 0, y: 500, scale: 44 };
    assert.deepEqual(keepInView({ x: 0, y: 700, scale: 44 }, viewport, bounds, insets, 64, from), { x: 0, y: 598, scale: 44 });
    assert.deepEqual(keepInView({ x: 0, y: 700, scale: 44 }, viewport, bounds, insets), { x: 0, y: 598, scale: 44 });
  });

  test("a camera the strip appeared over, past the bound, may come toward it or stay, and never jumps to it or goes further out (BC-OPUS-7)", () => {
    const from = { x: 0, y: 650, scale: 44 };
    assert.deepEqual(keepInView({ x: 0, y: 640, scale: 44 }, viewport, bounds, insets, 64, from), { x: 0, y: 640, scale: 44 }, "toward the bound");
    const still = { x: 10, y: 650, scale: 44 };
    assert.equal(keepInView(still, viewport, bounds, insets, 64, from), still, "a sideways pan leaves it");
    assert.deepEqual(keepInView({ x: 0, y: 700, scale: 44 }, viewport, bounds, insets, 64, from), { x: 0, y: 650, scale: 44 }, "no further out");
    // With no `from`, the old clamp jumps it.
    assert.deepEqual(keepInView({ x: 0, y: 650, scale: 44 }, viewport, bounds, insets), { x: 0, y: 598, scale: 44 });
    // The far edge keeps the same rule: a map whose bottom stood 20 px under the top bar stays, and goes no higher.
    const high = { x: 0, y: 52 + 20 - 880, scale: 44 };
    assert.deepEqual(keepInView({ x: 0, y: high.y - 30, scale: 44 }, viewport, bounds, insets, 64, high), high);
    // A pinch from there compares the edges on screen, whatever the scale.
    const zoomed = keepInView({ x: 0, y: 700, scale: 22 }, viewport, bounds, insets, 64, from);
    assert.equal(zoomed.y, 650);
    // Pinched out from the high map, its bottom edge, at 72 on screen, still goes no higher: 72 - 440 at 22 px a cell.
    assert.equal(keepInView({ x: 0, y: high.y - 30, scale: 22 }, viewport, bounds, insets, 64, high).y, 72 - 440);
  });

  test("the clearing move goes up just as asked inside the bounds, stops at the pan limit, and never past it (BAR-ASTRA-07)", () => {
    const cam = { x: 0, y: -100, scale: 44 };
    assert.deepEqual(barShift(cam, -72, viewport, bounds, insets), { x: 0, y: -172, scale: 44 });
    // The map's bottom edge may rise to 64 px under the top bar, at 116: y = 116 - 880 = -764.
    const low = { x: 0, y: -740, scale: 44 };
    assert.deepEqual(barShift(low, -72, viewport, bounds, insets), { x: 0, y: -764, scale: 44 }, "at the pan limit");
    const past = { x: 0, y: -790, scale: 44 };
    assert.deepEqual(barShift(past, -72, viewport, bounds, insets), past, "past the limit already: it goes no further");
    // At 130% the frame's 72 chrome px are 93.6 canvas px.
    close(barShift(cam, -72 * 1.3, viewport, bounds, insets).y, -100 - 93.6);
  });
});

describe("camera gesture", () => {
  const cam: Camera = { x: 0, y: 0, scale: 50 };

  test("one finger on empty map pans", () => {
    const g = new CameraGesture();
    assert.equal(g.down(1, { x: 10, y: 10 }, cam, true), "pan");
    assert.deepEqual(g.move(1, { x: 30, y: 5 }), { x: 20, y: -5, scale: 50 });
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
    assert.equal(g.mode, "idle");
  });

  test("a press that stays within 8 px is a tap", () => {
    const g = new CameraGesture();
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.move(1, { x: 14, y: 13 });
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: true, held: false });
  });

  test("one finger on a token is left to Konva", () => {
    const g = new CameraGesture();
    assert.equal(g.down(1, { x: 10, y: 10 }, cam, false), "tool");
    assert.equal(g.move(1, { x: 50, y: 50 }), null);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
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
    assert.deepEqual(g.up(1, zoomed), { tapOnEmpty: false, held: false });
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

  test("a press its hold-to-ping fired for is a held tap, and the next press starts unheld", () => {
    const g = new CameraGesture();
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.move(1, { x: 13, y: 12 });
    g.hold(1);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: true, held: true });
    g.down(1, { x: 10, y: 10 }, cam, true);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: true, held: false });
  });

  test("a still press on a token or for a box the ping reported is held, though it is no tap on empty map", () => {
    const g = new CameraGesture();
    // Multi-select's box gesture goes down as "tool", not on empty map (Stage.tsx).
    g.down(1, { x: 10, y: 10 }, cam, false);
    g.move(1, { x: 14, y: 13 });
    g.hold(1);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: true });
    g.down(1, { x: 10, y: 10 }, cam, false);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
    // Moved past the slop after the ping: a box drag, not a hold.
    g.down(1, { x: 10, y: 10 }, cam, false);
    g.hold(1);
    g.move(1, { x: 60, y: 10 });
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
  });

  test("a ping report for another pointer, for a pan, or for a pinch's finger holds nothing", () => {
    const g = new CameraGesture();
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.hold(2);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: true, held: false });
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.move(1, { x: 40, y: 10 });
    g.hold(1);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
    g.down(1, { x: 10, y: 10 }, cam, true);
    g.down(2, { x: 90, y: 10 }, cam, true);
    g.hold(1);
    g.up(2, cam);
    assert.deepEqual(g.up(1, cam), { tapOnEmpty: false, held: false });
  });

  test("moves of unknown pointers are ignored", () => {
    const g = new CameraGesture();
    assert.equal(g.move(9, { x: 1, y: 1 }), null);
    assert.deepEqual(g.up(9, cam), { tapOnEmpty: false, held: false });
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
