import assert from "node:assert/strict";
import { test } from "node:test";
import { base64Slice, uvttFile } from "./encode.ts";
import { decodeImageBase64 } from "./image.ts";
import { readUvtt } from "./schema.ts";
import { chunksOf, WALL } from "./exportTestutil.ts";
import { uvttGeometry } from "./write.ts";

/* The export's bytes (docs/design/design-v1-uvtt-export.md section 4): base64 made in slices, joined in a Blob. */

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = x = (x * 1103515245 + 12345) & 0xff;
  return out;
}

const head = uvttGeometry({ scene: { bounds: { w: 6, h: 4 } }, chunks: chunksOf({ walls: [{ a: [1, 1], b: [2.5, 3], f: WALL }] }), rule: "off", lights: [], feetPerCell: 5, pxPerCell: 70 }, "dm");

test("slices of a multiple of 3 bytes join into the one btoa of the whole, at every remainder", async () => {
  for (const n of [0, 1, 2, 3, 299, 300, 301, 302]) {
    const png = bytes(n);
    const blob = await uvttFile(head, new Blob([png as Uint8Array<ArrayBuffer>]), { sliceBytes: 30 });
    const parsed = JSON.parse(await blob.text()) as Record<string, unknown>;
    assert.equal(parsed.image, Buffer.from(png).toString("base64"), `${n} bytes`);
    assert.equal(parsed.image, base64Slice(png));
  }
});

test("the Blob parses as the head with the image last, and the import reads back the PNG's bytes", async () => {
  const png = bytes(100_000, 3);
  const blob = await uvttFile(head, new Blob([png as Uint8Array<ArrayBuffer>]), { sliceBytes: 3 * 1024 });
  const parsed = JSON.parse(await blob.text()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).at(-1), "image");
  const { image, ...rest } = parsed;
  assert.deepEqual(rest, head.json);
  assert.deepEqual(decodeImageBase64(image as string), png);
  const read = readUvtt(parsed);
  assert.ok(read.ok);
});

test("a slice that is not a multiple of 3 is refused, since it would pad mid-string", async () => {
  await assert.rejects(uvttFile(head, new Blob([]), { sliceBytes: 32 }), RangeError);
});
