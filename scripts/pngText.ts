import { crc32 } from "node:zlib";

/**
 * PNG tEXt chunks, so a rendered image can carry the value it was made from
 * (the README's Docker Hub button carries its release version) and a test can
 * check it against the source without reading pixels.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png: Buffer): { type: string; data: Buffer; start: number }[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const out: { type: string; data: Buffer; start: number }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length), start: at });
    at += 12 + length;
  }
  return out;
}

/** The text of the tEXt chunk with this keyword, or undefined. */
export function readPngText(png: Buffer, keyword: string): string | undefined {
  for (const chunk of chunks(png)) {
    if (chunk.type !== "tEXt") continue;
    const split = chunk.data.indexOf(0);
    if (chunk.data.toString("latin1", 0, split) === keyword) return chunk.data.toString("latin1", split + 1);
  }
  return undefined;
}

/** The PNG with one tEXt chunk for this keyword, placed before IEND, replacing any earlier one. */
export function writePngText(png: Buffer, keyword: string, text: string): Buffer {
  const kept = chunks(png).filter((c) => !(c.type === "tEXt" && c.data.toString("latin1", 0, c.data.indexOf(0)) === keyword));
  const data = Buffer.from(`${keyword}\0${text}`, "latin1");
  const body = Buffer.concat([Buffer.from("tEXt", "latin1"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  const parts: Buffer[] = [SIGNATURE];
  for (const c of kept) {
    if (c.type === "IEND") parts.push(chunk);
    parts.push(png.subarray(c.start, c.start + 12 + c.data.length));
  }
  return Buffer.concat(parts);
}
