import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ImageRef } from "#shared/model.ts";
import { api, ApiError } from "../../lib/api.ts";
import { cropSourceRect } from "../../lib/tokenView.ts";
import { imageErrorMessage } from "../images/errors.ts";
import { rememberAsset } from "../images/library.ts";

/**
 * A model's uploads (docs/design/design-v1-token-models.md 3.1 and 4.3).
 * The sheet goes up as kind `model` straight through `api.uploadAsset`,
 * never `uploadTokenImage`, whose downscale would draw the 2048 px sheet
 * down to 1024 (D-261127-389). The front view, for a wearer with no
 * picture, is a token picture of 512 px, already under the token cap, so it
 * goes up as kind `token` the same way.
 */
export async function uploadModelAsset(roomId: string, kind: "model" | "token", blob: Blob, signal: AbortSignal): Promise<string> {
  const row = await api.uploadAsset(roomId, kind, blob, { signal });
  rememberAsset(roomId, row);
  return row.id;
}

/**
 * The words for a refused upload. `bad_model_sheet` reaches only a client
 * that drew a sheet of the wrong shape, so it says to draw it again
 * (D-261127-615), and the token picture's 10 MB words would be wrong for a
 * sheet, whose cap is its own.
 */
export function modelUploadWords(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "bad_model_sheet") return "The model's views came out the wrong shape, so the server refused them. Choose the file again.";
    if (err.code === "too_large") return `The model's views came out over ${Math.round(MODEL_LIMITS.sheetBytes / (1024 * 1024))} MB. Choose the file again at a smaller Size.`;
  }
  return imageErrorMessage(err);
}

/** The side of the square the picture's color is read from: enough to average, cheap to read. */
const SAMPLE_PX = 24;

/**
 * Picture's color (D-261127-175): an icon's own disk color, or an upload's
 * mean color over the part its crop shows, read from its thumbnail, with
 * clear pixels left out. Null where it cannot be read, which draws Stone.
 */
export async function pictureColor(image: ImageRef, url: (assetId: string) => string): Promise<string | null> {
  if ("icon" in image) return /^#[0-9a-f]{6}$/i.test(image.color) ? image.color.toLowerCase() : null;
  try {
    const picture = new Image();
    picture.src = url(image.assetId);
    await picture.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_PX;
    canvas.height = SAMPLE_PX;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const r = cropSourceRect({ width: picture.naturalWidth, height: picture.naturalHeight }, image.crop, 1);
    ctx.drawImage(picture, r.x, r.y, r.width, r.height, 0, 0, SAMPLE_PX, SAMPLE_PX);
    return meanColor(ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data);
  } catch {
    return null;
  }
}

/** The mean of the opaque pixels as `#rrggbb`, each weighted by its alpha, or null when all are clear. */
export function meanColor(rgba: ArrayLike<number>): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    r += rgba[i]! * a;
    g += rgba[i + 1]! * a;
    b += rgba[i + 2]! * a;
    w += a;
  }
  if (w === 0) return null;
  const hex = (v: number) => Math.round(v / w).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
