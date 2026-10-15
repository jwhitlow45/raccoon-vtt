/**
 * Text widths for board label placement, measured in the font Konva draws
 * them in. Placement runs on every zoom step of a pinch, for every token, so
 * widths are cached. The key is the exact font size: boardScale.ts rounds
 * every board text size to half a pixel and the canvas draws that same size,
 * so a cached width is always the width drawn.
 */

/** Konva's default family, which token labels use. */
export const LABEL_FAMILY = "Arial";
const LABEL_WEIGHT = 600;
const CACHE_LIMIT = 4000;

let context: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

function measureWith(font: string, text: string, fallbackEm: number, px: number): number {
  const key = `${font}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  context ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  let width: number;
  if (context) {
    context.font = font;
    width = context.measureText(text).width;
  } else {
    width = text.length * px * fallbackEm;
  }
  // A long session at many zooms would otherwise grow the cache without end.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, width);
  return width;
}

/** A token label's width: weight 600 Arial at `px`. */
export function measureLabel(text: string, px: number): number {
  return measureWith(`${LABEL_WEIGHT} ${px}px ${LABEL_FAMILY}`, text, 0.58, px);
}

/** A pill's width: bold in `family` at `px`, the widest of its lines. */
export function measurePill(text: string, px: number, family: string): number {
  return Math.max(...text.split("\n").map((line) => measureWith(`bold ${px}px ${family}`, line, 0.62, px)));
}
