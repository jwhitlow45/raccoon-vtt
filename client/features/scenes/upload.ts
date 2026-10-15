import { api, ApiError, type AssetRow } from "../../lib/api.ts";
import type { MapAsset } from "./create.ts";

/**
 * Uploads a map image as it is. Maps are never downscaled on the device,
 * because their resolution matters (design 11.1). The server makes the
 * phone-sized copy. The file name goes along only so a name like
 * `crypt_30x20.jpg` can suggest the grid's scale.
 */
export async function uploadMap(
  roomId: string,
  file: File,
  options: { onWaiting?: (waiting: boolean) => void; signal?: AbortSignal } = {},
): Promise<MapAsset> {
  // Some browsers report no type for a file picked from cloud storage. The
  // server checks the bytes themselves, so any image type gets it in the door.
  const body = file.type.startsWith("image/") ? file : new Blob([file], { type: "image/jpeg" });
  const row: AssetRow = await api.uploadAsset(roomId, "map", body, { name: file.name, ...options });
  return { id: row.id, width: row.width, height: row.height, cellPx: row.cellPx };
}

export function uploadErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 415) return "That file is not an image the server accepts. Use JPEG, PNG, WebP, GIF or AVIF.";
    if (err.status === 413) return "That image is too large. Maps can be up to 32 MB.";
    if (err.status === 422) return "That image could not be read. It may be damaged.";
    return err.message;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Upload cancelled.";
  return "The upload failed. Try again.";
}
