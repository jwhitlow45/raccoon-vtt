/**
 * Zooming a handout image (features section 16). The room stops the page
 * itself from zooming (a pinch on a phone would otherwise strand the
 * player in a zoomed page), so a handout's small print needs a zoom of its
 * own: pinch, double tap and the mouse wheel, with Reset.
 *
 * The image keeps its fitted size and moves by a CSS transform:
 * `translate(x, y) scale(scale)` from its top-left corner, in pixels of the
 * fitted box. It never shrinks below the box, and never leaves a gap at an
 * edge, so a pan cannot lose it.
 */

export type ZoomView = { scale: number; x: number; y: number };
export type Box = { width: number; height: number };
export type Point = { x: number; y: number };

export const MAX_ZOOM = 6;
/** One double tap zooms this far, enough to read a letter's handwriting on a phone. */
export const TAP_ZOOM = 2.5;
export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

export function clampView(v: ZoomView, box: Box): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale));
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size * (1 - scale), value));
  return { scale, x: clamp(v.x, box.width), y: clamp(v.y, box.height) };
}

/** Zooms by `factor`, keeping the image point under `anchor` (in box pixels) where it is. */
export function zoomAround(v: ZoomView, anchor: Point, factor: number, box: Box): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale * factor));
  const ix = (anchor.x - v.x) / v.scale;
  const iy = (anchor.y - v.y) / v.scale;
  return clampView({ scale, x: anchor.x - ix * scale, y: anchor.y - iy * scale }, box);
}

/**
 * A pinch, from the view and the fingers when the second one landed. Worked
 * out from that baseline every time, so the point between the fingers
 * stays under them with no drift, and moving both fingers pans.
 */
export function pinchView(base: { view: ZoomView; mid: Point; dist: number }, now: { mid: Point; dist: number }, box: Box): ZoomView {
  const ratio = base.dist > 0 ? now.dist / base.dist : 1;
  const scale = Math.min(MAX_ZOOM, Math.max(1, base.view.scale * ratio));
  const ix = (base.mid.x - base.view.x) / base.view.scale;
  const iy = (base.mid.y - base.view.y) / base.view.scale;
  return clampView({ scale, x: now.mid.x - ix * scale, y: now.mid.y - iy * scale }, box);
}

export function panView(base: ZoomView, dx: number, dy: number, box: Box): ZoomView {
  return clampView({ scale: base.scale, x: base.x + dx, y: base.y + dy }, box);
}

/** A double tap zooms in on the spot tapped, or back out to the whole image. */
export function doubleTapView(v: ZoomView, at: Point, box: Box): ZoomView {
  return v.scale > 1 ? FIT : zoomAround(v, at, TAP_ZOOM, box);
}

/** Two taps this close in time and place make a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

export function isDoubleTap(prev: { at: number; p: Point } | null, now: { at: number; p: Point }): boolean {
  return prev !== null && now.at - prev.at <= DOUBLE_TAP_MS && Math.hypot(now.p.x - prev.p.x, now.p.y - prev.p.y) <= DOUBLE_TAP_PX;
}
