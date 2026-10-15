import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { ORIENTED_JPEG } from "./orientation.ts";

/**
 * The browser check is only as good as its probe image, so the probe is
 * decoded here with libjpeg (through sharp, the same decoder the server
 * uses) under the server's strictest setting.
 */
describe("the orientation probe image", () => {
  test("is a valid 2 x 1 JPEG tagged Orientation 6", async () => {
    const meta = await sharp(Buffer.from(ORIENTED_JPEG), { failOn: "warning" }).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 2);
    assert.equal(meta.height, 1);
    assert.equal(meta.orientation, 6);
  });

  test("decodes to 1 x 2 once the tag is applied", async () => {
    const { info, data } = await sharp(Buffer.from(ORIENTED_JPEG), { failOn: "warning" }).rotate().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1);
    assert.equal(info.height, 2);
    // Mid gray: a DC difference of 0 is the level shift alone.
    for (const v of data) assert.ok(Math.abs(v - 128) <= 1, `pixel value ${v}`);
  });

  test("starts and ends like a JPEG and stays tiny", () => {
    assert.deepEqual([...ORIENTED_JPEG.slice(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...ORIENTED_JPEG.slice(-2)], [0xff, 0xd9]);
    assert.ok(ORIENTED_JPEG.length < 200);
  });
});
