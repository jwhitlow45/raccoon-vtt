import { api, type AssetRow, type RetryOptions } from "../../lib/api.ts";
import { honorsImageOrientation } from "./orientation.ts";
import { TOKEN_UPLOAD_MAX_BYTES, TOKEN_UPLOAD_MAX_PX, fitWithin, outputType, smaller } from "./sizing.ts";

/**
 * Getting a token image to the server (design section 11.1). A phone photo
 * of 3 to 8 MB is drawn down to 1024 px and re-encoded first, which spares
 * the remote player's mobile link and keeps the server's intake slots
 * short. The server re-checks and re-encodes everything anyway, so this
 * step is a convenience and never a trust boundary.
 */

export class PickError extends Error {}

/** SVG is an image type that can carry script, and the server refuses it, so it is refused here first. */
export function checkImageFile(file: Blob): void {
  if (!file.type.startsWith("image/")) throw new PickError("That file is not an image.");
  if (/^image\/svg/i.test(file.type)) throw new PickError("SVG images are not supported. Use a JPEG, PNG, WebP, GIF or AVIF image.");
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

/**
 * The bytes to upload: a copy drawn down to `maxPx` on the long side when
 * the browser keeps phone photos upright while drawing them, otherwise the
 * original, which the server's `autoOrient()` turns the right way up.
 * Token images and handouts both come through here.
 */
export async function prepareImageUpload(file: Blob, maxPx: number): Promise<Blob> {
  if (!(await honorsImageOrientation())) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // A format the browser cannot decode (HEIC on some browsers): the server decides.
    return file;
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxPx);
    if (!size) return file;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = await encode(canvas, outputType(file.type));
    // Free the canvas's pixels now rather than at the next collection: a
    // phone may be holding a decoded 12 MP photo as well.
    canvas.width = 0;
    canvas.height = 0;
    return smaller(file, encoded);
  } finally {
    bitmap.close();
  }
}

export async function uploadTokenImage(roomId: string, file: Blob, options: RetryOptions = {}): Promise<AssetRow> {
  checkImageFile(file);
  const prepared = await prepareImageUpload(file, TOKEN_UPLOAD_MAX_PX);
  if (prepared.size > TOKEN_UPLOAD_MAX_BYTES) throw new PickError("That image is too large. Token images can be up to 10 MB.");
  return api.uploadAsset(roomId, "token", prepared, options);
}

/** A pasted or typed link. Only https reaches the server's importer (design 10.6). */
export function checkImageUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PickError("Paste a full link that starts with https://");
  }
  if (url.protocol !== "https:") throw new PickError("Only https:// links can be imported.");
  if (text.length > 2048) throw new PickError("That link is too long.");
  return url.href;
}

let config: Promise<{ searchEnabled: boolean }> | undefined;

/**
 * Whether the server can search the web, from GET /api/config. Openverse
 * needs no key, so since wave 5 a server always can (docs/design-v1-dm-tools.md
 * 3.13), and the tab hides only when the config cannot be read. A failed
 * read counts as no search, and is tried again next time.
 */
export function searchConfig(): Promise<{ searchEnabled: boolean }> {
  config ??= fetch("/api/config", { credentials: "same-origin", mode: "same-origin", headers: { accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`config ${res.status}`);
      const body = (await res.json()) as { searchEnabled?: unknown };
      return { searchEnabled: body.searchEnabled === true };
    })
    .catch(() => {
      config = undefined;
      return { searchEnabled: false };
    });
  return config;
}
