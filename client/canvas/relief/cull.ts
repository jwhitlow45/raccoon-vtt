import { screenToView, type Camera } from "../../lib/camera.ts";
import type { CameraFit } from "../../state/liveCamera.ts";
import type { VBox } from "./pieces.ts";

/** The culling box grows in steps of screen pixels, so a pan sorts the view again only when it crosses one (docs/design-v1-relief-pan.md 5.6). */
export const CULL_STEP_PX = 128;

/** The layout's cull box at a camera, its key, and the view on screen, in view units. */
export type Cull = { box: VBox; key: string; view: VBox };

/**
 * The view box the board lays out for at a camera: the canvas's, grown and
 * snapped to steps of `stepPx` screen pixels with a step to spare on every
 * side, and its key, which changes only when a pan crosses a step. The
 * kept picture's tests lay out in smaller steps, to cross more of them.
 */
export function cullOf(cam: Camera, size: { width: number; height: number }, stepPx: number = CULL_STEP_PX): Cull {
  const step = stepPx / cam.scale;
  const topLeft = screenToView(cam, { x: 0, y: 0 });
  const bottomRight = screenToView(cam, { x: size.width, y: size.height });
  const box: VBox = {
    x0: (Math.floor(topLeft.x / step) - 1) * step,
    y0: (Math.floor(topLeft.y / step) - 1) * step,
    x1: (Math.ceil(bottomRight.x / step) + 1) * step,
    y1: (Math.ceil(bottomRight.y / step) + 1) * step,
  };
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
