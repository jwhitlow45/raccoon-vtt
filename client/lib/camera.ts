import type { ViewPoint } from "./view.ts";

/**
 * Camera math for the map canvas.
 *
 * World units are grid cells (design section 5). The camera maps a world
 * point to a screen point as `screen = world * scale + (x, y)`, so `scale` is
 * screen pixels per cell and `(x, y)` is where world (0, 0) lands. That is
 * exactly a Konva stage's scale and position, so the stage takes the camera
 * as is.
 */
export type Camera = { x: number; y: number; scale: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Pixels per cell. Below 4 a 200-cell scene fits a phone, above 400 one cell fills it. */
export const MIN_SCALE = 4;
export const MAX_SCALE = 400;

/** `min` is a scene's own floor (sceneMinScale), never below MIN_SCALE. */
export function clampScale(scale: number, min: number = MIN_SCALE): number {
  return Math.min(MAX_SCALE, Math.max(min, scale));
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };
}

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale };
}

export function viewToScreen(cam: Camera, p: ViewPoint): Point {
  return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };
}

export function screenToView(cam: Camera, p: Point): ViewPoint {
  return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale } as ViewPoint;
}

/** The camera at `scale` that shows the view point `at` at the screen point `screen`. */
export function cameraAt(screen: Point, at: ViewPoint, scale: number): Camera {
  return { x: screen.x - at.x * scale, y: screen.y - at.y * scale, scale };
}

/**
 * The camera after a turn or a view switch (docs/design-v1-isometric-view.md
 * 4.2): panned so the world point that showed at `before` in the old view,
 * at `after` in the new, stays where it was on screen. The scale stays.
 */
export function holdStill(cam: Camera, before: ViewPoint, after: ViewPoint): Camera {
  return { x: cam.x + (before.x - after.x) * cam.scale, y: cam.y + (before.y - after.y) * cam.scale, scale: cam.scale };
}

/** The camera a Konva stage holds, for a layer that reads it where the stage stands. A stage not yet scaled reads as 1. */
export function cameraOfStage(stage: { x(): number; y(): number; scaleX(): number }): Camera {
  return { x: stage.x(), y: stage.y(), scale: stage.scaleX() || 1 };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { x: cam.x + dx, y: cam.y + dy, scale: cam.scale };
}

/** Zooms by `factor`, keeping the world point under `anchor` (a screen point) where it is. */
export function zoomAt(cam: Camera, anchor: Point, factor: number, minScale: number = MIN_SCALE): Camera {
  const scale = clampScale(cam.scale * factor, Math.min(minScale, cam.scale));
  const world = screenToWorld(cam, anchor);
  return { x: anchor.x - world.x * scale, y: anchor.y - world.y * scale, scale };
}

/**
 * Wheel deltas to a zoom factor. An exponential keeps zooming in and back out
 * by the same scroll symmetric. Line-mode deltas (Firefox with a mouse wheel)
 * count as 16 pixels per line. A trackpad pinch arrives as a wheel event with
 * ctrlKey and small deltas, so it gets a stronger response.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-200, Math.min(200, pixels));
  return Math.exp(-clamped * (pinch ? 0.01 : 0.002));
}

/** Screen pixels along each side of the viewport that something else covers, such as a toolbar. */
export type Insets = { top: number; right: number; bottom: number; left: number };

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The camera that shows all of `rect` (world units) centered in the part of
 * the viewport that `insets` leave clear. When even the smallest zoom
 * cannot fit it, its middle sits in the middle of that part.
 */
export function fitRect(viewport: Size, rect: Rect, paddingPx = 24, insets: Insets = NO_INSETS): Camera {
  const clearW = viewport.width - insets.left - insets.right;
  const clearH = viewport.height - insets.top - insets.bottom;
  const w = Math.max(1, clearW - paddingPx * 2);
  const h = Math.max(1, clearH - paddingPx * 2);
  const scale = clampScale(Math.min(w / Math.max(rect.width, 1e-6), h / Math.max(rect.height, 1e-6)));
  return {
    x: insets.left + clearW / 2 - (rect.x + rect.width / 2) * scale,
    y: insets.top + clearH / 2 - (rect.y + rect.height / 2) * scale,
    scale,
  };
}

/** Whether all of `rect` (world units) shows in the part of the viewport that `insets` leave clear. */
export function rectClear(cam: Camera, rect: Rect, viewport: Size, insets: Insets): boolean {
  const a = worldToScreen(cam, { x: rect.x, y: rect.y });
  const b = worldToScreen(cam, { x: rect.x + rect.width, y: rect.y + rect.height });
  return a.x >= insets.left && a.y >= insets.top && b.x <= viewport.width - insets.right && b.y <= viewport.height - insets.bottom;
}

/** A scene's saved starting view: the world point at the viewport center, and a zoom. */
export function cameraForView(viewport: Size, view: { x: number; y: number; zoom: number }): Camera;
/** The camera that shows the view point `at` at the viewport's center, at a zoom. */
export function cameraForView(viewport: Size, at: ViewPoint, zoom: number): Camera;
export function cameraForView(viewport: Size, at: { x: number; y: number; zoom?: number }, zoom?: number): Camera {
  const scale = clampScale(zoom ?? at.zoom ?? 1);
  return { x: viewport.width / 2 - at.x * scale, y: viewport.height / 2 - at.y * scale, scale };
}

/**
 * Pinch-zoom from a baseline taken when the second finger landed (or when the
 * gesture was last re-baselined). Computing from the baseline every time,
 * instead of applying small increments per event, keeps the world point that
 * was under the fingers' midpoint pinned to it with no drift, and folds the
 * two-finger pan into the same step.
 */
export function pinchCamera(
  base: { cam: Camera; mid: Point; dist: number },
  current: { mid: Point; dist: number },
  minScale: number = MIN_SCALE,
): Camera {
  const ratio = base.dist > 0 ? current.dist / base.dist : 1;
  const scale = clampScale(base.cam.scale * ratio, Math.min(minScale, base.cam.scale));
  const world = screenToWorld(base.cam, base.mid);
  return { x: current.mid.x - world.x * scale, y: current.mid.y - world.y * scale, scale };
}

/**
 * How far out a scene zooms (UP-20): until the whole scene fills half the
 * screen, and no further. Past that a small map shrank to a few pixels a
 * square, with nothing to tap and no way to tell where it went. A scene too
 * big to fit even at MIN_SCALE keeps MIN_SCALE.
 */
export function sceneMinScale(viewport: Size, bounds: { w: number; h: number }): number {
  const fit = Math.min(viewport.width / Math.max(bounds.w, 1e-6), viewport.height / Math.max(bounds.h, 1e-6));
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit / 2));
}

/**
 * Keeps at least `marginPx` of the scene on screen on each axis, so a pan
 * can never leave the screen empty with no way back to the map. The margin
 * counts only in the part of the viewport that `insets` leave clear, since
 * a sliver of map under a toolbar is as good as gone.
 *
 * `from` is the camera before the gesture. Where it already stood past a
 * bound, as when an upright phone's token bar appeared over the map's
 * edge, that bound gives way to where its edge stood, so the camera may
 * come toward the bound or stay, and never jumps to it
 * (docs/design-v1-bar-compact.md 4, review BC-OPUS-7). The edges are
 * compared on screen, so a pinch that changes the scale keeps the rule.
 */
export function keepInView(cam: Camera, viewport: Size, bounds: { w: number; h: number }, insets: Insets = NO_INSETS, marginPx = 64, from?: Camera): Camera {
  const clampAxis = (pos: number, start: number, end: number, size: number, was: number | undefined, wasLength: number) => {
    const length = size * cam.scale;
    const margin = Math.min(marginPx, Math.max(0, end - start) / 2, length / 2);
    // The near edge may stand no lower than `end - margin`, and the far edge no higher than `start + margin`, unless it already did.
    const nearMost = was === undefined ? end - margin : Math.max(end - margin, was);
    const farLeast = was === undefined ? start + margin : Math.min(start + margin, was + wasLength);
    return Math.min(nearMost, Math.max(farLeast - length, pos));
  };
  const x = clampAxis(cam.x, insets.left, viewport.width - insets.right, bounds.w, from?.x, from ? bounds.w * from.scale : 0);
  const y = clampAxis(cam.y, insets.top, viewport.height - insets.bottom, bounds.h, from?.y, from ? bounds.h * from.scale : 0);
  return x === cam.x && y === cam.y ? cam : { x, y, scale: cam.scale };
}

/**
 * The camera after an upright phone's token bar moves the map to clear its
 * token (docs/design-v1-bar-compact.md 3.6, review BAR-ASTRA-07): `dy` in
 * the canvas's px, the move bounded as a pan from the camera as it stands
 * is, by the scene's bounds and the insets with the bar's cover. So the
 * move never takes the map further out than a pan could, and a camera
 * already past the bound may come toward it but never go further past.
 */
export function barShift(cam: Camera, dy: number, viewport: Size, bounds: { w: number; h: number }, insets: Insets): Camera {
  return keepInView(panBy(cam, 0, dy), viewport, bounds, insets, 64, cam);
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale;
}
