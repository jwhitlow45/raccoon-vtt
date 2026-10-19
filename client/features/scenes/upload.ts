import { api, ApiError, type AssetRow } from "../../lib/api.ts";
import { fitWithin, keepsReencoded, reencodesPastedMap } from "../images/sizing.ts";
import { MAX_MAP_SIDE, MAX_MAP_UPLOAD_BYTES, RESIZE_QUALITY, thisDevice } from "../uvtt/limits.ts";
import type { MapAsset } from "./create.ts";

/** A map past the server's limit, refused before a byte goes up rather than after the whole file has. */
export class MapTooLarge extends Error {
  constructor() {
    super("That image is too large. Maps can be up to 32 MB.");
  }
}

/**
 * A pasted map over 8 MB on a computer, re-encoded as WebP at its own size
 * up to the server's full size (docs/design-v1-paste.md 5), so nothing the
 * server keeps is lost: the server re-encodes every map as WebP anyway. A
 * picture the browser cannot decode goes up as it is, for the server to
 * judge.
 */
async function shrinkPastedMap(file: File): Promise<Blob> {
  if (!reencodesPastedMap(file.size, thisDevice())) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_MAP_SIDE) ?? { width: bitmap.width, height: bitmap.height };
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", RESIZE_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    return keepsReencoded<Blob>(file, encoded);
  } finally {
    bitmap.close();
  }
}

/**
 * Uploads a map image as it is. Maps are never downscaled on the device,
 * because their resolution matters (design 11.1). The server makes the
 * phone-sized copy. The file name goes along only so a name like
 * `crypt_30x20.jpg` can suggest the grid's scale. A pasted map may be
 * re-encoded first (`pasted`), since a paste's PNG can be several times
 * the size of the map's own file, and once named it no longer says so.
 */
export async function uploadMap(
  roomId: string,
  file: File,
  options: { onWaiting?: (waiting: boolean) => void; signal?: AbortSignal; pasted?: boolean } = {},
): Promise<MapAsset> {
  const { pasted, ...rest } = options;
  const prepared = pasted ? await shrinkPastedMap(file) : file;
  if (prepared.size > MAX_MAP_UPLOAD_BYTES) throw new MapTooLarge();
  // Some browsers report no type for a file picked from cloud storage. The
  // server checks the bytes themselves, so any image type gets it in the door.
  const body = prepared.type.startsWith("image/") ? prepared : new Blob([prepared], { type: "image/jpeg" });
  const row: AssetRow = await api.uploadAsset(roomId, "map", body, { name: file.name, ...rest });
  return { id: row.id, width: row.width, height: row.height, cellPx: row.cellPx };
}

export function uploadErrorText(err: unknown): string {
  if (err instanceof MapTooLarge) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 415) return "That file is not an image the server accepts. Use JPEG, PNG, WebP, GIF or AVIF.";
    if (err.status === 413) return "That image is too large. Maps can be up to 32 MB.";
    if (err.status === 422) return "That image could not be read. It may be damaged.";
    return err.message;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Upload cancelled.";
  return "The upload failed. Try again.";
}
