import type { SceneMap } from "#shared/model.ts";

/**
 * How large an exported map image is, and which copy of the map art it is
 * drawn from. Pure, so the limits are tested without a canvas.
 */

/** The scales offered, in image pixels per grid square. 70 is a common VTT import size. */
export const PX_PER_CELL_CHOICES = [50, 70, 100] as const;
export const DEFAULT_PX_PER_CELL = 70;

/**
 * The export draws on one canvas, and iOS Safari refuses a canvas over
 * 16,777,216 pixels (4096 x 4096): it draws nothing and reports no error.
 * Every device keeps under that, so a scene exports at the same size on a
 * phone and a desktop. A larger image would need a hand-written PNG encoder
 * working through tiles, and this app's own map upload shrinks anything past
 * 8192 px on the long side anyway (design 11.1). Lowering the scale costs
 * only very large scenes: 58 x 58 squares still fit at 70 px.
 *
 * No side may pass 16,384 px either, which some desktop browsers refuse
 * even when the area fits.
 */
export const MAX_EXPORT_PIXELS = 16_777_216;
export const MAX_EXPORT_SIDE = 16_384;

export type ExportSize = {
  /** Image pixels per grid square, as drawn. */
  pxPerCell: number;
  /** What the DM chose, when the limits lowered it. */
  requested: number;
  width: number;
  height: number;
};

export type ExportLimits = { maxPixels: number; maxSide: number };

const LIMITS: ExportLimits = { maxPixels: MAX_EXPORT_PIXELS, maxSide: MAX_EXPORT_SIDE };

/**
 * The image size for a scene at the chosen scale, lowered to the largest
 * whole number of pixels per square that fits the limits. Whole numbers
 * keep every grid line on a pixel boundary and the file name exact.
 */
export function exportSize(bounds: { w: number; h: number }, requested: number, limits: ExportLimits = LIMITS): ExportSize {
  const { w, h } = bounds;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError("scene bounds must be whole squares");
  const ask = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_PX_PER_CELL));
  let px = Math.min(ask, Math.floor(Math.sqrt(limits.maxPixels / (w * h))), Math.floor(limits.maxSide / Math.max(w, h)));
  px = Math.max(1, px);
  // The square root can land a hair above the true value.
  while (px > 1 && w * px * h * px > limits.maxPixels) px--;
  return { pxPerCell: px, requested: ask, width: w * px, height: h * px };
}

/** The phone-sized copy of a map is at most this many pixels on its long side (design 11.1). */
export const MOBILE_MAP_SIDE = 4096;

/**
 * Which copy of the map art to draw from. The phone copy when it has enough
 * pixels for the export's scale, since it is a quarter of the memory. The
 * full copy only when the export needs more and this device already loads
 * full maps: a phone that cannot spare 256 MiB for an 8192 px map in play
 * cannot spare it for an export either.
 */
export function mapVariantFor(map: Pick<SceneMap, "widthPx" | "heightPx" | "cellPx">, pxPerCell: number, device: "full" | "mobile"): "full" | "mobile" {
  const longSide = Math.max(map.widthPx, map.heightPx);
  // A map no larger than the phone copy's limit was not shrunk for it.
  if (device === "mobile" || longSide <= MOBILE_MAP_SIDE) return "mobile";
  return pxPerCell / map.cellPx <= MOBILE_MAP_SIDE / longSide ? "mobile" : "full";
}
