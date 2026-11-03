import { open } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AssetError } from "./errors.ts";

/**
 * Headers on every image, video and sound (design section 11.2).
 *
 * - `private` keeps Cloudflare from caching an access-controlled file at
 *   its edge, and `immutable` is safe because a variant's URL never changes
 *   bytes (the pipeline version is in the file name).
 * - The fixed type, nosniff and the sandboxing CSP mean that even a file
 *   that somehow held markup could never run as a page on this origin. A
 *   video's or a sound's type comes from its row, never from its bytes
 *   (docs/design/design-v1-animated-maps.md 7, docs/design/design-v1-sound.md 7.2).
 * - CORP same-origin keeps other sites from embedding them.
 */
export const ASSET_HEADERS = {
  "cache-control": "private, max-age=31536000, immutable",
  "content-type": "image/webp",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

async function openVariant(path: string) {
  try {
    return await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AssetError(404, "not_found");
    throw err;
  }
}

/** Streams one variant file. The caller has already authorized the read and built `path` from the row. */
export async function sendVariant(reply: FastifyReply, path: string): Promise<FastifyReply> {
  const handle = await openVariant(path);
  try {
    const { size } = await handle.stat();
    reply.headers({ ...ASSET_HEADERS, "content-length": String(size) });
    return reply.send(handle.createReadStream({ autoClose: true }));
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export type ByteRange = { start: number; end: number };

/**
 * The one range a `Range` header asks for (RFC 9110 14.2), "unsatisfiable"
 * when it starts past the end, or null for the whole file: no header, a
 * header this server does not read, or several ranges, which a browser's
 * media element never asks for and which would need a multipart answer
 * (D-261102-457).
 */
export function requestedRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from, to] = m;
  if (from === "" && to === "") return null;
  if (from === "") {
    const suffix = Number(to);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const last = to === "" ? Infinity : Number(to);
  // A last position before the first makes the header invalid, which is ignored (RFC 9110 14.1.1).
  if (!Number.isSafeInteger(start) || (to !== "" && (!Number.isSafeInteger(last) || last < start))) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(last, size - 1) };
}

/** A video's or a sound's strong ETag: its upload's hash and its pipeline name exactly one file's bytes. */
export function mediaEtag(sha256Hex: string, pipeline: number): string {
  return `"${sha256Hex}-v${pipeline}"`;
}

/**
 * Streams a video or a sound, whole or one range of it
 * (docs/design/design-v1-animated-maps.md 10, Serving,
 * docs/design/design-v1-sound.md 7.2): Safari plays neither without range
 * answers. Its type comes from the row's media. An `If-Range` that is not
 * this file's ETag gets the whole file, as RFC 9110 13.1.5 asks. The caller
 * has authorized this very request, as it does every image request.
 */
export async function sendMedia(req: FastifyRequest, reply: FastifyReply, path: string, media: { type: "video/webm" | "video/mp4" | "audio/mpeg"; etag: string }): Promise<FastifyReply> {
  const handle = await openVariant(path);
  try {
    const { size } = await handle.stat();
    const ifRange = req.headers["if-range"];
    const range = ifRange === undefined || ifRange === media.etag ? requestedRange(req.headers.range, size) : null;
    reply.headers({ ...ASSET_HEADERS, "content-type": media.type, "accept-ranges": "bytes", etag: media.etag });
    if (range === "unsatisfiable") {
      await handle.close();
      return reply.code(416).header("content-range", `bytes */${size}`).header("content-length", "0").send();
    }
    if (range === null) {
      reply.header("content-length", String(size));
      return reply.send(handle.createReadStream({ autoClose: true }));
    }
    reply.code(206).headers({ "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) });
    return reply.send(handle.createReadStream({ start: range.start, end: range.end, autoClose: true }));
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
