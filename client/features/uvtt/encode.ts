import type { UvttHead } from "./write.ts";

/**
 * An exported file's bytes (docs/design/design-v1-uvtt-export.md section 4):
 * the head's JSON, then the PNG as base64 under `image`, the last key, as
 * Dungeondraft writes it. A 25 MB PNG is 33 MB of base64, so it is made in
 * slices of the PNG's bytes, yielding between them so the busy button
 * paints, and the file is a Blob of the parts, never one joined string.
 */

/** A multiple of 3, so no slice but the last ends in padding and the slices join as one base64 string. */
export const SLICE_BYTES = 3 * 1024 * 1024;

/** btoa takes a binary string, and String.fromCharCode takes its arguments on the stack, so bytes go in a piece at a time. */
const CHARS = 0x8000;

export function base64Slice(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHARS) binary += String.fromCharCode(...bytes.subarray(i, i + CHARS));
  return btoa(binary);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function uvttFile(head: UvttHead, png: Blob, options: { sliceBytes?: number } = {}): Promise<Blob> {
  const slice = options.sliceBytes ?? SLICE_BYTES;
  if (slice % 3 !== 0) throw new RangeError("a slice must be a multiple of 3 bytes");
  const { image: _image, ...rest } = head.json;
  const json = JSON.stringify(rest);
  const parts: string[] = [`${json.slice(0, -1)}${json.length > 2 ? "," : ""}"image":"`];
  const bytes = new Uint8Array(await png.arrayBuffer());
  for (let at = 0; at < bytes.length; at += slice) {
    parts.push(base64Slice(bytes.subarray(at, at + slice)));
    await tick();
  }
  parts.push('"}');
  return new Blob(parts, { type: "application/json" });
}
