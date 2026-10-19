import type { Device } from "../uvtt/limits.ts";

/**
 * Size math for the client-side downscale before an upload (design section
 * 11.1). Pure, so it is tested without a browser.
 */

/** Token images: the server keeps 512 px, so 1024 px leaves it room to resample well. */
export const TOKEN_UPLOAD_MAX_PX = 1024;
/** The server's body limit for token uploads (design 10.7). */
export const TOKEN_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The size to draw an image at so its long side is at most `maxPx`, keeping
 * the aspect ratio and never enlarging. Null when it already fits, so the
 * original bytes can go up untouched.
 */
export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const long = Math.max(width, height);
  if (long <= maxPx) return null;
  const scale = maxPx / long;
  return {
    width: Math.max(1, Math.min(maxPx, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxPx, Math.round(height * scale))),
  };
}

/**
 * What to re-encode as. Photos stay JPEG. Anything that may have
 * transparency (PNG, WebP, GIF, AVIF) asks for WebP, which keeps the alpha
 * that cut-out token art depends on. A browser that cannot encode WebP
 * (Safari) hands back PNG instead, which keeps the alpha too.
 */
export function outputType(inputType: string): "image/jpeg" | "image/webp" {
  return /^image\/(jpeg|jpg|pjpeg)$/i.test(inputType) ? "image/jpeg" : "image/webp";
}

/** Keep the re-encoded file only when it actually came out smaller. */
export function smaller<T extends { size: number }>(original: T, encoded: T | null): T {
  return encoded && encoded.size > 0 && encoded.size < original.size ? encoded : original;
}

/**
 * A pasted map over this is re-encoded on a computer before it uploads
 * (docs/design-v1-paste.md 5). A paste hands over PNG: a painted 4096 px
 * map comes to about 15 MB that way, against a few MB as the file it was.
 */
export const PASTED_MAP_REENCODE_BYTES = 8 * 1024 * 1024;

/** Whether a pasted map is re-encoded first. A phone uploads the original, sparing its memory. */
export function reencodesPastedMap(bytes: number, device: Device): boolean {
  return device === "computer" && bytes > PASTED_MAP_REENCODE_BYTES;
}

/**
 * The re-encoded map, kept only when it is WebP and smaller. Safari's
 * `toBlob` hands back PNG when asked for WebP, which would gain nothing.
 */
export function keepsReencoded<T extends { size: number; type: string }>(original: T, encoded: T | null): T {
  return encoded && encoded.type === "image/webp" ? smaller(original, encoded) : original;
}
