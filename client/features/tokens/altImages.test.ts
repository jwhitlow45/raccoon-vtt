import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImageRef } from "#shared/model.ts";
import { MAX_ALT_IMAGES, clientOpSchema } from "#shared/protocol.ts";
import { addPatch, canAdd, removePatch, swapPatch } from "./altImages.ts";

const img = (assetId: string, zoom = 1): ImageRef => ({ assetId, crop: { cx: 0, cy: 0, zoom } });

describe("a token's other images", () => {
  test("a swap wears the alternate and keeps the old image in its place, so the same tap swaps back", () => {
    const druid = { image: img("elf"), altImages: [img("wolf"), img("bear")] };
    const patch = swapPatch(druid, 1);
    assert.deepEqual(patch, { image: img("bear"), altImages: [img("wolf"), img("elf")] });
    assert.deepEqual(swapPatch({ ...druid, ...patch }, 1), { image: img("elf"), altImages: [img("wolf"), img("bear")] });
    assert.ok(clientOpSchema.safeParse({ t: "token.update", tokenId: "t", patch }).success);
  });

  test("a token with no image takes the alternate off the list", () => {
    assert.deepEqual(swapPatch({ altImages: [img("wolf"), img("bear")] }, 0), { image: img("wolf"), altImages: [img("bear")] });
    assert.equal(swapPatch({ image: img("elf") }, 0), null);
  });

  test("adding keeps the list short and free of the images it already has", () => {
    assert.deepEqual(addPatch({ image: img("elf") }, img("wolf")), { altImages: [img("wolf")] });
    assert.equal(addPatch({ image: img("elf") }, img("elf")), null);
    assert.deepEqual(addPatch({ image: img("elf") }, img("elf", 2)), { altImages: [img("elf", 2)] }, "the same picture cropped another way counts as another image");
    assert.equal(addPatch({ altImages: [img("wolf")] }, img("wolf")), null);
    const full = { altImages: Array.from({ length: MAX_ALT_IMAGES }, (_, i) => img(`a${i}`)) };
    assert.equal(canAdd(full), false);
    assert.equal(addPatch(full, img("one more")), null);
  });

  test("removing the last one clears the list", () => {
    assert.deepEqual(removePatch({ altImages: [img("wolf"), img("bear")] }, 0), { altImages: [img("bear")] });
    assert.deepEqual(removePatch({ altImages: [img("wolf")] }, 0), { altImages: null });
    assert.equal(removePatch({ altImages: [img("wolf")] }, 3), null);
  });
});
