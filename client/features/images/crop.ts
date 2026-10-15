import { cropSourceRect } from "../../lib/tokenView.ts";

/**
 * Crop editor math (design section 11.4). The token stores
 * `image.crop = {cx, cy, zoom}` and the canvas draws it with
 * `cropSourceRect` in lib/tokenView.ts: `cx` and `cy` are the center of the
 * shown region as fractions of the image's width and height, and zoom 1
 * shows the largest region of the footprint's shape that fits the image.
 * Everything here goes through that same function, so the editor's preview
 * and the token on the map always show the same pixels.
 */

export type Crop = { cx: number; cy: number; zoom: number };
export type ImageSize = { width: number; height: number };

export const MIN_ZOOM = 1;
/** The protocol's cap on `zoom`. */
export const MAX_ZOOM = 10;
export const DEFAULT_CROP: Crop = { cx: 0.5, cy: 0.5, zoom: 1 };

/** Four decimals is a tenth of a pixel on a 1000 px image, and keeps the op small. */
function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : MIN_ZOOM));
}

/**
 * The crop as the canvas will actually show it: zoom within bounds, and the
 * center moved to where the region stops at the image's edge. Saving this
 * form means a later pan starts from what is on screen, not from a center
 * that was pushed past the edge.
 */
export function normalizeCrop(image: ImageSize, crop: Crop, aspect = 1): Crop {
  const zoom = clampZoom(crop.zoom);
  const r = cropSourceRect(image, { ...crop, zoom }, aspect);
  return {
    cx: round((r.x + r.width / 2) / image.width),
    cy: round((r.y + r.height / 2) / image.height),
    zoom: round(zoom),
  };
}

/**
 * A drag of `dx`, `dy` CSS pixels over a viewport `viewportWidth` wide. The
 * image follows the finger, so the shown region moves the other way.
 */
export function panCrop(image: ImageSize, crop: Crop, aspect: number, dx: number, dy: number, viewportWidth: number): Crop {
  const r = cropSourceRect(image, crop, aspect);
  const perPx = r.width / Math.max(1, viewportWidth);
  const cx = (r.x + r.width / 2 - dx * perPx) / image.width;
  const cy = (r.y + r.height / 2 - dy * perPx) / image.height;
  return normalizeCrop(image, { cx, cy, zoom: crop.zoom }, aspect);
}

/**
 * A new zoom that keeps the image point under `focus` still, where `focus`
 * is a position in the viewport as fractions of its width and height (the
 * pinch midpoint, or the middle for the slider).
 */
export function zoomCrop(image: ImageSize, crop: Crop, aspect: number, zoom: number, focus = { u: 0.5, v: 0.5 }): Crop {
  const before = cropSourceRect(image, crop, aspect);
  const fx = before.x + focus.u * before.width;
  const fy = before.y + focus.v * before.height;
  const nextZoom = clampZoom(zoom);
  const after = cropSourceRect(image, { ...crop, zoom: nextZoom }, aspect);
  const x = fx - focus.u * after.width;
  const y = fy - focus.v * after.height;
  return normalizeCrop(image, { cx: (x + after.width / 2) / image.width, cy: (y + after.height / 2) / image.height, zoom: nextZoom }, aspect);
}

/**
 * Where to draw the whole image inside a viewport `viewportWidth` wide so
 * the crop's region fills it exactly: the image's CSS size and offset.
 */
export function cropTransform(image: ImageSize, crop: Crop, aspect: number, viewportWidth: number): { left: number; top: number; width: number; height: number } {
  const r = cropSourceRect(image, crop, aspect);
  const scale = viewportWidth / r.width;
  return { left: -r.x * scale, top: -r.y * scale, width: image.width * scale, height: image.height * scale };
}

/** The slider runs on a log scale, so each step feels the same at 1x and at 8x. */
export function zoomToSlider(zoom: number): number {
  return Math.log(clampZoom(zoom)) / Math.log(MAX_ZOOM);
}

export function sliderToZoom(t: number): number {
  return clampZoom(Math.exp(Math.min(1, Math.max(0, t)) * Math.log(MAX_ZOOM)));
}
