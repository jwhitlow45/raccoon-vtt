import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeBase64, decodeImageBase64, planImage, sniffImage } from "./image.ts";
import { base64, pngHeader } from "./synthetic.ts";

const MiB = 1024 * 1024;

function bytesOf(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
}

describe("base64", () => {
  test("decodes what Buffer encodes, at every padding length", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const text = Buffer.from(bytes).toString("base64");
      assert.deepEqual(decodeBase64(text), bytes, text);
      assert.deepEqual(decodeImageBase64(text), bytes);
    }
  });

  test("takes a data URL prefix, line breaks and the URL-safe alphabet", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    const plain = Buffer.from(bytes).toString("base64");
    assert.deepEqual(decodeBase64(`data:image/png;base64,${plain}`), bytes);
    assert.deepEqual(decodeBase64(plain.replace(/(.{20})/g, "$1\r\n")), bytes);
    assert.deepEqual(decodeBase64(Buffer.from(bytes).toString("base64url")), bytes);
  });

  test("refuses what is not base64", () => {
    assert.equal(decodeBase64("ab$d"), null);
    assert.equal(decodeBase64("abcde"), null);
    assert.equal(decodeBase64("ab==cd"), null);
    assert.equal(decodeBase64("é"), null);
  });
});

describe("the image's type and size from its header", () => {
  test("a PNG", () => {
    assert.deepEqual(sniffImage(pngHeader(1400, 980)), { type: "image/png", width: 1400, height: 980 });
    assert.deepEqual(sniffImage(decodeBase64(base64(pngHeader(70_000, 3))) ?? new Uint8Array()), { type: "image/png", width: 70_000, height: 3 });
  });

  test("a lossy, a lossless and an extended WebP", () => {
    const lossy = bytesOf("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [0x78, 0x05], [0xd4, 0x03]);
    assert.deepEqual(sniffImage(lossy), { type: "image/webp", width: 1400, height: 980 });
    // 14 bits of width - 1, then 14 of height - 1: 1399 and 979.
    const bits = 1399 | (979 << 14);
    const lossless = bytesOf("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], [0, 0, 0, 0, 0]);
    assert.deepEqual(sniffImage(lossless), { type: "image/webp", width: 1400, height: 980 });
    const extended = bytesOf("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], [0xff, 0x31, 0], [0xff, 0x31, 0], [0, 0]);
    assert.deepEqual(sniffImage(extended), { type: "image/webp", width: 12_800, height: 12_800 });
  });

  test("a JPEG, past its other segments", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
    const sof = [0xff, 0xc2, 0x00, 0x11, 0x08, 0x03, 0xd4, 0x05, 0x78, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    assert.deepEqual(sniffImage(bytesOf([0xff, 0xd8], app0, sof)), { type: "image/jpeg", width: 1400, height: 980 });
  });

  test("anything else is not an image the import takes", () => {
    assert.equal(sniffImage(bytesOf("GIF89a", [10, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
    assert.equal(sniffImage(bytesOf("<svg xmlns='http://www.w3.org/2000/svg'>")), null);
    assert.equal(sniffImage(pngHeader(0, 10)), null);
    assert.equal(sniffImage(new Uint8Array()), null);
  });
});

describe("whether the image goes up as it is", () => {
  test("8,192 px or less on the long side and 32 MiB or less goes as it is", () => {
    assert.deepEqual(planImage({ width: 8192, height: 4000, bytes: 32 * MiB }, "phone"), { kind: "as-is" });
  });

  test("a larger image is drawn down to 8,192 px on a computer", () => {
    assert.deepEqual(planImage({ width: 12_800, height: 6_400, bytes: 20 * MiB }, "computer"), { kind: "resize", width: 8192, height: 4096 });
    // Small enough, but too many bytes: encoded again at the same size.
    assert.deepEqual(planImage({ width: 6000, height: 6000, bytes: 33 * MiB }, "computer"), { kind: "resize", width: 6000, height: 6000 });
  });

  test("a phone cannot resize past its canvas limit, and says so", () => {
    assert.deepEqual(planImage({ width: 12_800, height: 12_800, bytes: 30 * MiB }, "phone"), {
      kind: "refuse",
      error: "This map's image is 12,800 by 12,800 pixels, too large for a phone to resize. Import it on a computer.",
    });
    assert.deepEqual(planImage({ width: 9000, height: 1000, bytes: 10 * MiB }, "phone"), { kind: "resize", width: 8192, height: 910 });
  });

  test("an iPad has the same canvas limit, whatever its screen size", () => {
    assert.deepEqual(planImage({ width: 12_800, height: 12_800, bytes: 30 * MiB }, "iPad"), {
      kind: "refuse",
      error: "This map's image is 12,800 by 12,800 pixels, too large for an iPad to resize. Import it on a computer.",
    });
    // 8,192 by 4,096 is 33.5 million pixels, twice what iOS draws: the resize would come out blank.
    assert.equal(planImage({ width: 12_800, height: 6_400, bytes: 20 * MiB }, "iPad").kind, "refuse");
    assert.deepEqual(planImage({ width: 9000, height: 1000, bytes: 10 * MiB }, "iPad"), { kind: "resize", width: 8192, height: 910 });
  });

  test("an image past what any browser draws is refused before it is decoded", () => {
    const plan = planImage({ width: 70_000, height: 3, bytes: 1000 }, "computer");
    assert.equal(plan.kind, "refuse");
    assert.equal(planImage({ width: 20_000, height: 20_000, bytes: MiB }, "computer").kind, "refuse");
  });
});
