import { open } from "node:fs/promises";
import type { FastifyReply } from "fastify";
import { AssetError } from "./errors.ts";

/**
 * Headers on every image (design section 11.2).
 *
 * - `private` keeps Cloudflare from caching an access-controlled image at
 *   its edge, and `immutable` is safe because a variant's URL never changes
 *   bytes (the pipeline version is in the file name).
 * - The fixed type, nosniff and the sandboxing CSP mean that even a file
 *   that somehow held markup could never run as a page on this origin.
 * - CORP same-origin keeps other sites from embedding the images.
 */
export const ASSET_HEADERS = {
  "cache-control": "private, max-age=31536000, immutable",
  "content-type": "image/webp",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

/** Streams one variant file. The caller has already authorized the read and built `path` from the row. */
export async function sendVariant(reply: FastifyReply, path: string): Promise<FastifyReply> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AssetError(404, "not_found");
    throw err;
  }
  try {
    const { size } = await handle.stat();
    reply.headers({ ...ASSET_HEADERS, "content-length": String(size) });
    return reply.send(handle.createReadStream({ autoClose: true }));
  } catch (err) {
    await handle.close();
    throw err;
  }
}
