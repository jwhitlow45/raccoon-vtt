import { screenToView, type Camera } from "../../lib/camera.ts";
import type { CameraFit } from "../../state/liveCamera.ts";
import type { VBox } from "./pieces.ts";

/**
 * The culling box grows in steps of screen pixels, so a pan sorts the view
 * again only when it crosses one (docs/design/design-v1-relief-pan.md 5.6).
 * Each step crossed is a board render and a whole repaint of the relief,
 * about three times a scrolled frame's cost and the one frame a steady pan
 * drops on a large map. At 128 px a pan dropped one about every 16 frames
 * on a 100 by 100 dungeon. 256 px halves those frames for a layout a step
 * wider, which scrolled frames do not feel (ISOPAN, D-261127-151).
 */
export const CULL_STEP_PX = 256;

/** The layout's cull box at a camera, its key, and the view on screen, in view units. */
export type Cull = { box: VBox; key: string; view: VBox };

/**
 * The view box the board lays out for at a camera, in steps of `stepPx`
 * screen pixels, and its key. The kept picture's tests lay out in smaller
 * steps, to cross more of them.
 *
 * The box keeps one size at a zoom and moves only with the step the view's
 * top-left lies in, so its key changes once for each step a pan crosses on
 * each axis. A box snapped at all four edges changed its key at each
 * edge's own step, about three times as often on a pan, and every change
 * is a board render and a whole repaint (HXPERF-3). It starts a step
 * before the view and reaches past it by the view's own steps and three
 * more: one for where the view lies in its first step, at least one to
 * spare, and the canvas's part step.
 */
export function cullOf(cam: Camera, size: { width: number; height: number }, stepPx: number = CULL_STEP_PX): Cull {
  const step = stepPx / cam.scale;
  const topLeft = screenToView(cam, { x: 0, y: 0 });
  const bottomRight = screenToView(cam, { x: size.width, y: size.height });
  const x0 = (Math.floor(topLeft.x / step) - 1) * step;
  const y0 = (Math.floor(topLeft.y / step) - 1) * step;
  const box: VBox = { x0, y0, x1: x0 + (Math.ceil(size.width / stepPx) + 3) * step, y1: y0 + (Math.ceil(size.height / stepPx) + 3) * step };
  return { box, key: `${box.x0},${box.y0},${box.x1},${box.y1}`, view: { x0: topLeft.x, y0: topLeft.y, x1: bottomRight.x, y1: bottomRight.y } };
}

/**
 * How a camera stands to the layout rendered for `rendered`: in its cull
 * step, past it with the view still inside the rendered box, so strips lie
 * inside the layout until the board renders again, or out of it.
 */
export function cullFit(rendered: { key: string; box: VBox }, cam: Camera, size: { width: number; height: number }, stepPx: number = CULL_STEP_PX): CameraFit {
  const now = cullOf(cam, size, stepPx);
  if (now.key === rendered.key) return "inside";
  const v = now.view;
  const b = rendered.box;
  return v.x0 >= b.x0 && v.y0 >= b.y0 && v.x1 <= b.x1 && v.y1 <= b.y1 ? "step" : "out";
}
