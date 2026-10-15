import assert from "node:assert/strict";
import { test } from "node:test";
import { cellPxHint } from "./kinds.ts";

test("a cols x rows name suggests the cell size when both axes agree", () => {
  assert.equal(cellPxHint("crypt_30x20.jpg", 3000, 2000), 100);
  assert.equal(cellPxHint("Crypt 30 X 20 final.png", 2100, 1400), 70);
  assert.equal(cellPxHint("road-24×18.webp", 1680, 1260), 70);
  assert.equal(cellPxHint("odd_7x5.png", 1000, 714), 142.86);
});

test("no suggestion when the name has no hint or the axes disagree", () => {
  assert.equal(cellPxHint(undefined, 3000, 2000), undefined);
  assert.equal(cellPxHint("tavern.jpg", 3000, 2000), undefined);
  assert.equal(cellPxHint("crypt_30x20.jpg", 3000, 3000), undefined);
});

test("pixel sizes and out-of-range counts are not cell counts", () => {
  assert.equal(cellPxHint("wallpaper_1920x1080.jpg", 1920, 1080), undefined);
  assert.equal(cellPxHint("big_300x200.jpg", 6000, 4000), undefined);
  assert.equal(cellPxHint("zero_0x10.jpg", 100, 100), undefined);
});
