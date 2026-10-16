import { HANDOUT_MAX_BYTES } from "../downscale.ts";
import { PAGE_LONG_SIDE } from "./options.ts";

/**
 * A drawn page's size and its encoding under the upload cap
 * (docs/design-v1-pdf-handouts.md 4.1.4 and 4.2.2). Nothing here loads
 * pdf.js, so the job and its tests use it freely.
 */

/**
 * A page's drawing size: the long side PAGE_LONG_SIDE, so a small page draws
 * larger and a poster smaller (4.2.2), and each side at least 1 px. `width`
 * and `height` are the page's size in points with its own rotation applied.
 */
export function renderSize(width: number, height: number): { scale: number; width: number; height: number } {
  const scale = PAGE_LONG_SIDE / Math.max(width, height);
  return { scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The encodings tried in order until a page fits the upload cap (4.1.4):
 * the first type at its quality, lower qualities, then smaller sizes. WebP
 * first, and JPEG where the browser cannot encode WebP (Safari). Never PNG,
 * which takes several MB for a page with art.
 */
export type EncodeStep = { type: "image/webp" | "image/jpeg"; quality: number; longSide: number };

export function encodeSteps(type: EncodeStep["type"]): EncodeStep[] {
  const first = type === "image/webp" ? 0.9 : 0.92;
  return [
    { type, quality: first, longSide: PAGE_LONG_SIDE },
    { type, quality: 0.8, longSide: PAGE_LONG_SIDE },
    { type, quality: 0.7, longSide: PAGE_LONG_SIDE },
    { type, quality: 0.7, longSide: 1600 },
    { type, quality: 0.7, longSide: 1200 },
  ];
}

/** What encodeWithin needs of a drawn page: its size, and an encoder at a given type, quality and long side. */
export type EncodeSource = {
  width: number;
  height: number;
  encode(step: EncodeStep): Promise<Blob | null>;
};

export type Encoded = { blob: Blob; width: number; height: number };

/**
 * The page encoded at the first step that fits `maxBytes`, or null when
 * even the smallest does not ("Page 7 is too large to upload"). A browser
 * that hands back another type than WebP is asked for JPEG from then on.
 */
export async function encodeWithin(source: EncodeSource, maxBytes: number = HANDOUT_MAX_BYTES): Promise<Encoded | null> {
  let steps = encodeSteps("image/webp");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const blob = await source.encode(step);
    if (!blob) continue;
    if (step.type === "image/webp" && blob.type !== "image/webp") {
      steps = encodeSteps("image/jpeg");
      i = -1;
      continue;
    }
    if (blob.size <= maxBytes) return { blob, ...scaledSize(source.width, source.height, step.longSide) };
  }
  return null;
}

function scaledSize(width: number, height: number, longSide: number): { width: number; height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** A drawn page as encodeWithin reads it: the canvas itself, or a smaller copy for the smaller steps. */
export function canvasSource(canvas: HTMLCanvasElement): EncodeSource {
  return {
    width: canvas.width,
    height: canvas.height,
    async encode(step) {
      const size = scaledSize(canvas.width, canvas.height, step.longSide);
      if (size.width === canvas.width && size.height === canvas.height) return toBlob(canvas, step.type, step.quality);
      const small = document.createElement("canvas");
      small.width = size.width;
      small.height = size.height;
      const ctx = small.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, size.width, size.height);
      try {
        return await toBlob(small, step.type, step.quality);
      } finally {
        small.width = 0;
        small.height = 0;
      }
    },
  };
}

/** The long side of a page's small picture, kept for a page that may be left in the library (4.1.6). */
export const THUMB_LONG_SIDE = 96;

/**
 * A few KB picture of a drawn page, as a data URL, so a page whose upload
 * never answered can be shown in the summary and the recovery line, and the
 * DM can spot the image in the Library.
 */
export function pageThumb(canvas: HTMLCanvasElement): string | null {
  const size = scaledSize(canvas.width, canvas.height, THUMB_LONG_SIDE);
  const small = document.createElement("canvas");
  small.width = size.width;
  small.height = size.height;
  const ctx = small.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, size.width, size.height);
  try {
    return small.toDataURL("image/jpeg", 0.6);
  } finally {
    small.width = 0;
    small.height = 0;
  }
}

