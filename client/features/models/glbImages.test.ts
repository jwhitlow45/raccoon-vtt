import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { imageHeader } from "./glbImages.ts";

/** A texture's size from its header alone (docs/design/design-v1-token-models.md 5, D-261127-476), on images sharp makes from flat colors. */

const flat = (width: number, height: number, alpha = false) => sharp({ create: { width, height, channels: alpha ? 4 : 3, background: { r: 40, g: 120, b: 200, alpha: 0.5 } } });
const bytes = async (s: ReturnType<typeof sharp>) => new Uint8Array(await s.toBuffer());

describe("texture headers", () => {
  test("read PNG, JPEG, WebP (lossy, lossless and extended) and AVIF sizes, naming the format from the bytes", async () => {
    const cases: [Uint8Array, string, number, number][] = [
      [await bytes(flat(37, 21).png()), "image/png", 37, 21],
      [await bytes(flat(37, 21).jpeg()), "image/jpeg", 37, 21],
      [await bytes(flat(1000, 3).jpeg({ progressive: true })), "image/jpeg", 1000, 3],
      [await bytes(flat(37, 21).webp({ quality: 50 })), "image/webp", 37, 21],
      [await bytes(flat(37, 21).webp({ lossless: true })), "image/webp", 37, 21],
      [await bytes(flat(37, 21, true).webp({ quality: 50 })), "image/webp", 37, 21],
      [await bytes(flat(64, 48).avif()), "image/avif", 64, 48],
    ];
    for (const [data, mime, width, height] of cases) assert.deepEqual(imageHeader(data), { mime, width, height }, mime);
  });

  test("read a header claiming 20,000 px a side without decoding anything", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 20_000);
    new DataView(png.buffer).setUint32(20, 20_000);
    assert.deepEqual(imageHeader(png), { mime: "image/png", width: 20_000, height: 20_000 });
  });

  test("give null for a header that cannot be read: cut short, a zero size, KTX2, or not a picture", async () => {
    const png = await bytes(flat(8, 8).png());
    const jpeg = await bytes(flat(8, 8).jpeg());
    const webp = await bytes(flat(8, 8).webp());
    for (const data of [png.subarray(0, 20), jpeg.subarray(0, 30), webp.subarray(0, 24), new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]), new TextEncoder().encode("not a picture"), new Uint8Array(0)]) {
      assert.equal(imageHeader(data), null);
    }
    const zero = png.slice();
    new DataView(zero.buffer).setUint32(16, 0);
    assert.equal(imageHeader(zero), null);
  });

  test("walk a JPEG's segments by their lengths and stop at one that runs past the end", async () => {
    const jpeg = await bytes(flat(8, 8).jpeg());
    const broken = jpeg.slice();
    // The first segment after the start marker claims to run to the far end of the file.
    new DataView(broken.buffer).setUint16(4, 0xfff0);
    assert.equal(imageHeader(broken), null);
  });
});
