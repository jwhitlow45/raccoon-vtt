import { viewToScreen, type Camera, type Point } from "../lib/camera.ts";
import { toView, type ViewPoint } from "../lib/view.ts";
import type { BoardPick } from "./boardPick.ts";
import { ellipseBox } from "./relief/standee.ts";

/**
 * Where the HTML chrome over the map stands by what it is about
 * (docs/design-v1-isometric-view.md 5.3): the action bar, the stop note,
 * the door pill and the height readout. Each takes the chrome's own camera
 * (features/device/layout.ts cameraInZoomed) and the board's view and drawn
 * heights (`pick`), so in Isometric it stands where the thing draws, raised
 * on its ground.
 */

/** A world point at its drawn height, `z` cells, on screen. */
export function groundAnchor(camera: Camera, pick: Pick<BoardPick, "view">, p: Point, z: number): Point {
  return viewToScreen(camera, toView(pick.view, p, z));
}

/**
 * Under a footprint, where a bar or a note hangs: its box's bottom middle in
 * Top-down, and in Isometric the bottom of its ring at its drawn base
 * (`base`, in cells).
 */
export function footAnchor(camera: Camera, pick: Pick<BoardPick, "view">, box: { x: number; y: number; w: number; h: number }, base: number): Point {
  const view = pick.view;
  if (view.kind === "topDown") return viewToScreen(camera, toView(view, { x: box.x + box.w / 2, y: box.y + box.h }));
  const center = toView(view, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, base);
  return viewToScreen(camera, { x: center.x, y: ellipseBox(view.turn, box.w, box.h, center).y1 } as ViewPoint);
}

/** A footprint's top on screen: its box's top edge in Top-down, its standee's art box's top in Isometric, the art standing on its ring at `base`. */
export function headAnchor(camera: Camera, pick: Pick<BoardPick, "view">, box: { x: number; y: number; w: number; h: number }, base: number): Point {
  const view = pick.view;
  if (view.kind === "topDown") return viewToScreen(camera, toView(view, { x: box.x, y: box.y }));
  const center = toView(view, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, base);
  return viewToScreen(camera, { x: center.x, y: center.y - box.h } as ViewPoint);
}
