import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { rng } from "#shared/testutil.ts";
import { boardViewOf } from "../canvas/boardView.ts";
import { followCamera } from "../features/display/logic.ts";
import { focusFromStage } from "../features/dm/camera.ts";
import { viewEvent } from "../features/dm/tableDisplay.ts";
import { findCamera } from "../features/find/findToken.ts";
import { viewFromCamera } from "../features/scenes/create.ts";
import {
  cameraAt,
  cameraForView,
  cameraOfStage,
  clampScale,
  fitRect,
  MIN_SCALE,
  panBy,
  pinchCamera,
  rectClear,
  screenToView,
  viewToScreen,
  zoomAt,
  type Camera,
  type Insets,
  type Point,
  type Rect,
  type Size,
} from "./camera.ts";
import { flatHeights, groundAtMiddle, liveOfStage, pickGround, TOP_DOWN, toView, toWorld, viewBox } from "./view.ts";

/**
 * The rename's differential test (lane ISO-1): with Isometric out of reach,
 * every screen's camera math gives the very numbers it gave before the
 * rename. `before` holds the code as it stood then, copied as it was, and
 * each case compares it with the call site's path today, exactly.
 */
const before = {
  worldToScreen: (cam: Camera, p: Point): Point => ({ x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y }),
  screenToWorld: (cam: Camera, p: Point): Point => ({ x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale }),
  zoomAt(cam: Camera, anchor: Point, factor: number, minScale: number = MIN_SCALE): Camera {
    const scale = clampScale(cam.scale * factor, Math.min(minScale, cam.scale));
    const world = before.screenToWorld(cam, anchor);
    return { x: anchor.x - world.x * scale, y: anchor.y - world.y * scale, scale };
  },
  fitRect(viewport: Size, rect: Rect, paddingPx = 24, insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }): Camera {
    const clearW = viewport.width - insets.left - insets.right;
    const clearH = viewport.height - insets.top - insets.bottom;
    const w = Math.max(1, clearW - paddingPx * 2);
    const h = Math.max(1, clearH - paddingPx * 2);
    const scale = clampScale(Math.min(w / Math.max(rect.width, 1e-6), h / Math.max(rect.height, 1e-6)));
    return { x: insets.left + clearW / 2 - (rect.x + rect.width / 2) * scale, y: insets.top + clearH / 2 - (rect.y + rect.height / 2) * scale, scale };
  },
  rectClear(cam: Camera, rect: Rect, viewport: Size, insets: Insets): boolean {
    const a = before.worldToScreen(cam, { x: rect.x, y: rect.y });
    const b = before.worldToScreen(cam, { x: rect.x + rect.width, y: rect.y + rect.height });
    return a.x >= insets.left && a.y >= insets.top && b.x <= viewport.width - insets.right && b.y <= viewport.height - insets.bottom;
  },
  cameraForView(viewport: Size, view: { x: number; y: number; zoom: number }): Camera {
    const scale = clampScale(view.zoom);
    return { x: viewport.width / 2 - view.x * scale, y: viewport.height / 2 - view.y * scale, scale };
  },
  pinchCamera(base: { cam: Camera; mid: Point; dist: number }, current: { mid: Point; dist: number }, minScale: number = MIN_SCALE): Camera {
    const ratio = base.dist > 0 ? current.dist / base.dist : 1;
    const scale = clampScale(base.cam.scale * ratio, Math.min(minScale, base.cam.scale));
    const world = before.screenToWorld(base.cam, base.mid);
    return { x: current.mid.x - world.x * scale, y: current.mid.y - world.y * scale, scale };
  },
  /** The spawns' center (CharacterCard, CompanionsSection, EncountersPanel, the grid tool). */
  middle: (camera: Camera, viewport: Size): Point => ({ x: (viewport.width / 2 - camera.x) / camera.scale, y: (viewport.height / 2 - camera.y) / camera.scale }),
  viewFromCamera(camera: Camera, viewport: Size): { x: number; y: number; zoom: number } {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      x: round(clamp((viewport.width / 2 - camera.x) / camera.scale, -1_000, 1_000)),
      y: round(clamp((viewport.height / 2 - camera.y) / camera.scale, -1_000, 1_000)),
      zoom: round(clamp(camera.scale, 0.01, 100)),
    };
  },
  focusFromStage(stage: { x: number; y: number; scale: number; width: number; height: number }): { x: number; y: number; zoom: number } {
    const scale = stage.scale > 0 ? stage.scale : 1;
    return { x: (stage.width / 2 - stage.x) / scale, y: (stage.height / 2 - stage.y) / scale, zoom: scale };
  },
  viewEvent(stage: { x: number; y: number; scale: number; width: number; height: number }) {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const scale = stage.scale > 0 ? stage.scale : 1;
    return {
      k: "view",
      x: clamp((stage.width / 2 - stage.x) / scale, -1_000, 1_000),
      y: clamp((stage.height / 2 - stage.y) / scale, -1_000, 1_000),
      w: clamp(stage.width / scale, 0.01, 2_000),
      h: clamp(stage.height / scale, 0.01, 2_000),
    };
  },
  boardViewOf: (cam: Camera, size: Size, insets: Insets) => ({
    x0: (insets.left - cam.x) / cam.scale,
    y0: (insets.top - cam.y) / cam.scale,
    x1: (size.width - insets.right - cam.x) / cam.scale,
    y1: (size.height - insets.bottom - cam.y) / cam.scale,
  }),
  findCamera(viewport: Size, target: Rect, bars: Insets, cover: Insets): Camera {
    const { scale } = before.fitRect(viewport, target, 24, bars);
    const left = bars.left + cover.left;
    const right = bars.right + cover.right;
    const top = bars.top + cover.top;
    const bottom = bars.bottom + cover.bottom;
    const clear = viewport.width - left - right > 0 && viewport.height - top - bottom > 0;
    const cx = clear ? left + (viewport.width - left - right) / 2 : bars.left + (viewport.width - bars.left - bars.right) / 2;
    const cy = clear ? top + (viewport.height - top - bottom) / 2 : bars.top + (viewport.height - bars.top - bars.bottom) / 2;
    return { x: cx - (target.x + target.width / 2) * scale, y: cy - (target.y + target.height / 2) * scale, scale };
  },
  followCamera: (viewport: Size, view: { x: number; y: number; w: number; h: number }) =>
    before.fitRect(viewport, { x: view.x - view.w / 2, y: view.y - view.h / 2, width: view.w, height: view.h }, 0),
  /** Stage.tsx's pan to an initiative row's token. */
  panTo: (c: Camera, at: Point, p: Point): Camera => ({ ...c, x: at.x - p.x * c.scale, y: at.y - p.y * c.scale }),
  /** PinLayer.tsx's tap and PingLayer.tsx's hold, read from the stage. */
  pinCamera: (stage: Stage): Camera => ({ x: stage.x(), y: stage.y(), scale: stage.scaleX() || 1 }),
  ping(stage: Stage, p: Point): [number, number] {
    const scale = stage.scaleX() || 1;
    return [(p.x - stage.x()) / scale, (p.y - stage.y()) / scale];
  },
  /** CameraLayer.tsx's reading of the stage for the view event and the focus. */
  stageReading: (stage: Stage) => ({ x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() }),
};

type Stage = { x(): number; y(): number; scaleX(): number; width(): number; height(): number };

const random = rng(1301);
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const camera = (): Camera => ({ x: between(-6000, 6000), y: between(-6000, 6000), scale: random() < 0.1 ? MIN_SCALE : between(MIN_SCALE, 400) });
const point = (): Point => ({ x: between(-1000, 1000), y: between(-1000, 1000) });
const size = (): Size => ({ width: Math.round(between(200, 2600)), height: Math.round(between(200, 1600)) });
const rect = (): Rect => ({ x: between(-50, 150), y: between(-50, 150), width: random() < 0.05 ? 0 : between(0.5, 200), height: between(0.5, 200) });
const insets = (): Insets => ({ top: Math.round(between(0, 120)), right: Math.round(between(0, 300)), bottom: Math.round(between(0, 400)), left: Math.round(between(0, 80)) });
const stage = (scale = between(MIN_SCALE, 400)): Stage => {
  const c = camera();
  const s = size();
  return { x: () => c.x, y: () => c.y, scaleX: () => scale, width: () => s.width, height: () => s.height };
};

const ROUNDS = 2000;

describe("the rename keeps every screen's numbers (lane ISO-1)", () => {
  test("a map point to the screen and back, and a press's point, as worldToScreen and screenToWorld gave them", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const cam = camera();
      const p = point();
      assert.deepEqual(viewToScreen(cam, toView(TOP_DOWN, p)), before.worldToScreen(cam, p));
      const s = before.worldToScreen(cam, point());
      assert.deepEqual(toWorld(TOP_DOWN, screenToView(cam, s)), before.screenToWorld(cam, s));
      assert.deepEqual(pickGround({ camera: cam, view: TOP_DOWN, grid: SQUARES, heights: flatHeights({ w: 200, h: 200 }) }, s), before.screenToWorld(cam, s));
    }
  });

  test("zoom, pinch, fit, a rectangle's clearance and a starting view", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const cam = camera();
      const anchor = point();
      const factor = between(0.2, 5);
      const floor = between(MIN_SCALE, 40);
      assert.deepEqual(zoomAt(cam, anchor, factor, floor), before.zoomAt(cam, anchor, factor, floor));
      const base = { cam, mid: point(), dist: random() < 0.05 ? 0 : between(1, 600) };
      const current = { mid: point(), dist: between(1, 600) };
      assert.deepEqual(pinchCamera(base, current, floor), before.pinchCamera(base, current, floor));
      const viewport = size();
      const r = rect();
      const bars = insets();
      const pad = between(0, 40);
      assert.deepEqual(fitRect(viewport, viewBox(TOP_DOWN, r), pad, bars), before.fitRect(viewport, r, pad, bars));
      assert.equal(rectClear(cam, viewBox(TOP_DOWN, r), viewport, bars), before.rectClear(cam, r, viewport, bars));
      // Near a fit, where a rectangle is clear on some sides only.
      const fitted = panBy(before.fitRect(viewport, r, pad, bars), between(-60, 60), between(-60, 60));
      assert.equal(rectClear(fitted, viewBox(TOP_DOWN, r), viewport, bars), before.rectClear(fitted, r, viewport, bars));
      const view = { ...point(), zoom: random() < 0.1 ? between(0.01, 3) : between(3, 500) };
      assert.deepEqual(cameraForView(viewport, toView(TOP_DOWN, view), view.zoom), before.cameraForView(viewport, view));
    }
  });

  test("the spawns, a saved starting view, the focus, the view event and the board's boxes", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const cam = camera();
      const viewport = size();
      const live = { camera: cam, viewport, view: TOP_DOWN };
      assert.deepEqual(groundAtMiddle(live), before.middle(cam, viewport));
      const tool = camera();
      assert.deepEqual(groundAtMiddle({ ...live, camera: tool }), before.middle(tool, viewport), "the grid tool's own camera");
      assert.deepEqual(viewFromCamera(live), before.viewFromCamera(cam, viewport));
      const st = stage(random() < 0.1 ? [0, -3, Number.NaN][Math.floor(random() * 3)]! : between(MIN_SCALE, 400));
      assert.deepEqual(focusFromStage(liveOfStage(st, TOP_DOWN)), before.focusFromStage(before.stageReading(st)));
      assert.deepEqual(viewEvent(liveOfStage(st, TOP_DOWN)), before.viewEvent(before.stageReading(st)));
      const bars = insets();
      assert.deepEqual(boardViewOf(cam, viewport, bars), before.boardViewOf(cam, viewport, bars));
    }
  });

  test("Find my token, Follow the DM, the pan to a row's token, and the pin and ping layers' stage readings", () => {
    for (let i = 0; i < ROUNDS; i++) {
      const viewport = size();
      const target = rect();
      const bars = insets();
      const cover = insets();
      assert.deepEqual(findCamera(viewport, target, bars, cover), before.findCamera(viewport, target, bars, cover));
      const dm = { x: between(-1000, 1000), y: between(-1000, 1000), w: between(0.01, 2000), h: between(0.01, 2000) };
      assert.deepEqual(followCamera(viewport, dm), before.followCamera(viewport, dm));
      const c = camera();
      const at = point();
      const p = point();
      assert.deepEqual(cameraAt(at, toView(TOP_DOWN, p), c.scale), before.panTo(c, at, p));
      const st = stage(random() < 0.1 ? 0 : between(MIN_SCALE, 400));
      assert.deepEqual(cameraOfStage(st), before.pinCamera(st));
      const press = point();
      const pinged = toWorld(TOP_DOWN, screenToView(cameraOfStage(st), press));
      assert.deepEqual([pinged.x, pinged.y], before.ping(st, press));
    }
  });
});
