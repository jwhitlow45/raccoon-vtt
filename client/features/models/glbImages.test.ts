import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { HEADER_STEPS, imageHeader } from "./glbImages.ts";

/** A texture's size from its header alone (docs/design/design-v1-token-models.md 5, D-261127-476), on images sharp makes from flat colors. */

const flat = (width: number, height: number, alpha = false) => sharp({ create: { width, height, channels: alpha ? 4 : 3, background: { r: 40, g: 120, b: 200, alpha: 0.5 } } });
const bytes = async (s: ReturnType<typeof sharp>) => new Uint8Array(await s.toBuffer());


const u32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const type = (b: Uint8Array, i: number) => String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
const box = (name: string, payload: Uint8Array) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(payload, 8);
  return out;
};
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** A box's children as byte ranges, from `from` to `to`. */
function children(b: Uint8Array, from: number, to: number): { type: string; bytes: Uint8Array }[] {
  const out: { type: string; bytes: Uint8Array }[] = [];
  for (let i = from; i < to; i += u32(b, i)) out.push({ type: type(b, i), bytes: b.slice(i, i + u32(b, i)) });
  return out;
}

/**
 * A real AVIF with an unused 1 by 1 extent put first among its properties
 * and `pad` empty boxes before its `meta`: every property index in `ipma`
 * and every data offset in `iloc` is moved to match, so a decoder still
 * reads it at its real size. A walk that gives up partway has seen only
 * the decoy.
 */
function decoyAvif(real: Uint8Array, pad: number): Uint8Array {
  const top = children(real, 0, real.length);
  const meta = top.find((c) => c.type === "meta")!.bytes;
  const parts = children(meta, 12, meta.length);
  const iprp = parts.find((c) => c.type === "iprp")!.bytes;
  const inner = children(iprp, 8, iprp.length);
  const ipco = inner.find((c) => c.type === "ipco")!.bytes;
  const ipma = inner.find((c) => c.type === "ipma")!.bytes;
  const decoy = box("ispe", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]));
  const shift = 1;
  const newIpco = box("ipco", join([decoy, ipco.slice(8)]));
  const padding = Array.from({ length: pad }, () => box("free", new Uint8Array(0)));
  // ipma rewritten with 16-bit indices, each moved past the inserted boxes.
  const version = ipma[8]!;
  const wide = (ipma[11]! & 1) === 1;
  const entries = u32(ipma, 12);
  const out: number[] = [version, 0, 0, 1, ...ipma.slice(12, 16)];
  let i = 16;
  for (let e = 0; e < entries; e++) {
    const idBytes = version < 1 ? 2 : 4;
    out.push(...ipma.slice(i, i + idBytes));
    i += idBytes;
    const count = ipma[i++]!;
    out.push(count);
    for (let a = 0; a < count; a++) {
      const raw = wide ? (ipma[i]! << 8) | ipma[i + 1]! : ipma[i]!;
      i += wide ? 2 : 1;
      const essential = wide ? raw & 0x8000 : (raw & 0x80) << 8;
      const index = (wide ? raw & 0x7fff : raw & 0x7f) + shift;
      out.push((essential | index) >> 8, index & 0xff);
    }
  }
  const newIprp = box("iprp", join(inner.map((c) => (c.type === "ipco" ? newIpco : c.type === "ipma" ? box("ipma", new Uint8Array(out)) : c.bytes))));
  const newMeta = join([new Uint8Array(4), new TextEncoder().encode("meta"), meta.slice(8, 12), ...parts.map((c) => (c.type === "iprp" ? newIprp : c.bytes))]);
  new DataView(newMeta.buffer).setUint32(0, newMeta.length);
  // iloc's offsets point into mdat, which now starts later by the padding and what the meta grew.
  const delta = newMeta.length - meta.length + pad * 8;
  const at = 12 + parts.slice(0, parts.findIndex((c) => c.type === "iloc")).reduce((n, c) => n + c.bytes.length, 0);
  const iloc = new DataView(newMeta.buffer, at);
  const iv = iloc.getUint8(8);
  const offsetSize = iloc.getUint8(12) >> 4;
  const lengthSize = iloc.getUint8(12) & 15;
  const baseSize = iloc.getUint8(13) >> 4;
  const indexSize = iv > 0 ? iloc.getUint8(13) & 15 : 0;
  let j = 14;
  const items = iv < 2 ? iloc.getUint16(j) : iloc.getUint32(j);
  j += iv < 2 ? 2 : 4;
  const add = (o: number, size: number) => (size === 4 ? iloc.setUint32(o, iloc.getUint32(o) + delta) : size === 8 ? iloc.setBigUint64(o, iloc.getBigUint64(o) + BigInt(delta)) : undefined);
  for (let n = 0; n < items; n++) {
    j += iv < 2 ? 2 : 4;
    if (iv > 0) j += 2;
    j += 2;
    if (baseSize > 0) add(j, baseSize);
    j += baseSize;
    const extents = iloc.getUint16(j);
    j += 2;
    for (let x = 0; x < extents; x++) {
      j += indexSize;
      if (baseSize === 0) add(j, offsetSize);
      j += offsetSize + lengthSize;
    }
  }
  return join(top.flatMap((c) => (c.type === "meta" ? [...padding, newMeta] : [c.bytes])));
}

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

  test("give null when an AVIF walk stops before its end, never a decoy's size read partway", async () => {
    const real = await bytes(flat(32, 16).avif());
    // A decoder reads both files at 32 by 16: the decoy and the empty boxes are unused properties.
    const near = decoyAvif(real, HEADER_STEPS - 20);
    const past = decoyAvif(real, HEADER_STEPS);
    for (const file of [near, past]) assert.deepEqual(await sharp(file).metadata().then((m) => [m.width, m.height]), [32, 16]);
    // Within the walk's budget the real extent is reached and is the largest; past it the walk gives up with no size at all.
    assert.deepEqual(imageHeader(near), { mime: "image/avif", width: 32, height: 16 });
    assert.equal(imageHeader(past), null);
    // An extent outside ipco is no extent, and a box running past its parent stops the walk.
    const loose = new Uint8Array([...real.slice(0, 28), ...box("ispe", new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0])), ...real.slice(28)]);
    assert.deepEqual(imageHeader(loose), { mime: "image/avif", width: 32, height: 16 });
    const cut = real.slice(0, real.length - 3);
    assert.equal(imageHeader(cut), null);
    // A file that ends inside a box's own header, after the extent was read, is cut short too.
    const mdat = real.findIndex((_, i) => String.fromCharCode(...real.subarray(i, i + 4)) === "mdat") - 4;
    assert.ok(mdat > 0, "the encoder's mdat follows meta");
    assert.equal(imageHeader(real.slice(0, mdat + 5)), null);
  });

  test("give null when an AVIF walk's budget runs out after the decoy, and never the decoy's size at any padding", async () => {
    const real = await bytes(flat(32, 16).avif());
    // With 990 empty boxes the budget runs out inside ipco, after the decoy is read and before the real extent.
    const after = decoyAvif(real, HEADER_STEPS - 10);
    assert.deepEqual(await sharp(after).metadata().then((m) => [m.width, m.height]), [32, 16]);
    assert.equal(imageHeader(after), null);
    for (let pad = HEADER_STEPS - 20; pad <= HEADER_STEPS; pad++) {
      const size = imageHeader(decoyAvif(real, pad));
      assert.ok(size === null || (size.width === 32 && size.height === 16), `${pad} empty boxes: ${JSON.stringify(size)}`);
    }
  });

  test("walk at most 1,000 JPEG segments to the size, and give null past them", async () => {
    const jpeg = await bytes(flat(8, 8).jpeg());
    // Comment segments put before the frame: each four bytes, a marker and a length of 2.
    const padded = (n: number) => new Uint8Array([0xff, 0xd8, ...Array.from({ length: n }, () => [0xff, 0xfe, 0, 2]).flat(), ...jpeg.slice(2)]);
    assert.deepEqual(imageHeader(padded(HEADER_STEPS - 20)), { mime: "image/jpeg", width: 8, height: 8 });
    assert.equal(imageHeader(padded(HEADER_STEPS)), null);
  });

  test("walk a JPEG's segments by their lengths and stop at one that runs past the end", async () => {
    const jpeg = await bytes(flat(8, 8).jpeg());
    const broken = jpeg.slice();
    // The first segment after the start marker claims to run to the far end of the file.
    new DataView(broken.buffer).setUint16(4, 0xfff0);
    assert.equal(imageHeader(broken), null);
  });
});
