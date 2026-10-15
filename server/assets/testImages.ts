import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import sharp from "sharp";

/**
 * Test fixtures, made from `create` and raw pixel input only. Those inputs
 * do not go through a libvips loader, so they still work after
 * configureSharp() has blocked every loader except the five allowed ones.
 */

export async function tempDir(prefix = "rvtt-assets-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function solid(width: number, height: number, color = "#3a6") {
  return sharp({ create: { width, height, channels: 3, background: color } });
}

export async function writeImage(dir: string, name: string, data: Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

/** A 1 px checkerboard: a few KB as PNG, hundreds of KB as WebP. */
export async function checkerboardPng(side: number): Promise<Buffer> {
  const raw = Buffer.alloc(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) raw[y * side + x] = (x + y) & 1 ? 255 : 0;
  return sharp(raw, { raw: { width: side, height: side, channels: 1 } }).png({ compressionLevel: 9, palette: true, colours: 2 }).toBuffer();
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Inserts a chunk right after IHDR (the 8-byte signature plus the 25-byte IHDR chunk). */
export function withPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  return Buffer.concat([png.subarray(0, 33), pngChunk(type, data), png.subarray(33)]);
}

/** A valid-looking PNG whose header claims `width` x `height` with almost no data behind it. */
export function hugeHeaderPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64"/></svg>',
);
