import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { AssetImage, IconImage, ImageRef, ModelRef } from "./model.ts";
import { copyImage, imageAssetId, imageAssetIds, imageModelId, keepModel, sameImage, withoutModel } from "./imageRef.ts";

/**
 * The image helpers with a 3D model on the picture
 * (docs/design/design-v1-token-models.md 3.4 and 4.2): every copy keeps the
 * model whole, a new picture keeps the one it replaces, and two images are
 * the same only with the same whole model.
 */

const BOXES: ModelRef["boxes"] = [
  [20, 10, 80, 95],
  [18, 10, 82, 95],
  [15, 12, 85, 95],
  [18, 10, 82, 95],
  [20, 10, 80, 95],
  [18, 10, 82, 95],
  [15, 12, 85, 95],
  [18, 10, 82, 95],
];
const model = (over: Partial<ModelRef> = {}): ModelRef => ({ assetId: "sheet", side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]), ...over });
const upload = (over: Partial<AssetImage> = {}): AssetImage => ({ assetId: "face", crop: { cx: 0.1, cy: -0.2, zoom: 1.5 }, ...over });
const icon = (over: Partial<IconImage> = {}): IconImage => ({ icon: "lorc/wolf-head", color: "#336699", ...over });

/** Whether two values share any object at any depth: a deep copy shares none. */
function sharesObject(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a === b) return true;
  return Object.keys(a).some((key) => sharesObject((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

describe("copyImage", () => {
  test("copies an upload and an icon whole, model included, sharing no object", () => {
    for (const image of [upload(), upload({ model: model() }), icon(), icon({ model: model() })] as ImageRef[]) {
      const copy = copyImage(image);
      assert.deepEqual(copy, image);
      assert.equal(sharesObject(copy, image), false, JSON.stringify(image));
    }
  });

  test("adds no model key to an image without one, so a copy is byte for byte the image", () => {
    assert.equal("model" in copyImage(upload()), false);
    assert.equal(JSON.stringify(copyImage(icon())), JSON.stringify(icon()));
  });

  test("keeps only the known fields, as the copies it replaces did", () => {
    const stray = { ...upload({ model: model() }), extra: 1 } as AssetImage;
    assert.deepEqual(copyImage(stray), upload({ model: model() }));
  });
});

describe("keepModel", () => {
  test("a new picture, a crop and an icon each keep the model of the image they replace", () => {
    const current = upload({ model: model() });
    assert.deepEqual(keepModel(upload({ assetId: "other" }), current), upload({ assetId: "other", model: model() }));
    assert.deepEqual(keepModel(upload({ crop: { cx: 0, cy: 0, zoom: 2 } }), current), upload({ crop: { cx: 0, cy: 0, zoom: 2 }, model: model() }));
    assert.deepEqual(keepModel(icon(), current), icon({ model: model() }));
    assert.deepEqual(keepModel(upload(), icon({ model: model({ assetId: "iconSheet" }) })), upload({ model: model({ assetId: "iconSheet" }) }));
  });

  test("a model the new image carries wins over the one it replaces", () => {
    assert.deepEqual(keepModel(upload({ model: model({ assetId: "mine" }) }), upload({ model: model() })).model?.assetId, "mine");
  });

  test("with nothing to keep it is a plain copy, and the result shares nothing with either", () => {
    assert.deepEqual(keepModel(upload(), undefined), upload());
    assert.deepEqual(keepModel(icon(), null), icon());
    assert.equal("model" in keepModel(upload(), upload()), false);
    const current = upload({ model: model() });
    const next = upload({ assetId: "other" });
    const kept = keepModel(next, current);
    assert.equal(sharesObject(kept, current) || sharesObject(kept, next), false);
    kept.model!.boxes[0]![0] = 99;
    assert.equal(current.model!.boxes[0]![0], 20, "the kept model is a copy");
  });
});

describe("withoutModel", () => {
  test("takes off the model and nothing else, leaving the image it was given as it was", () => {
    const image = upload({ model: model() });
    assert.deepEqual(withoutModel(image), upload());
    assert.deepEqual(withoutModel(icon({ model: model() })), icon());
    assert.ok(image.model, "the original keeps its model");
  });
});

describe("the asset ids an image names", () => {
  test("the upload, then the model's sheet, and an icon only its sheet", () => {
    assert.deepEqual(imageAssetIds(upload({ model: model() })), ["face", "sheet"]);
    assert.deepEqual(imageAssetIds(upload()), ["face"]);
    assert.deepEqual(imageAssetIds(icon({ model: model() })), ["sheet"]);
    assert.deepEqual(imageAssetIds(icon()), []);
    assert.deepEqual(imageAssetIds(undefined), []);
    assert.deepEqual(imageAssetIds(null), []);
    assert.equal(imageAssetId(icon({ model: model() })), undefined, "an icon's picture names no asset, whatever its model");
    assert.equal(imageModelId(icon({ model: model() })), "sheet");
    assert.equal(imageModelId(upload()), undefined);
  });
});

describe("sameImage over the whole model (D-261127-414)", () => {
  test("the same picture with the same model, or neither with one, is the same image", () => {
    assert.equal(sameImage(upload({ model: model() }), upload({ model: model() })), true);
    assert.equal(sameImage(icon({ model: model() }), icon({ model: model() })), true);
    assert.equal(sameImage(upload(), upload()), true);
    assert.equal(sameImage(undefined, null), true);
  });

  test("a model on one and not the other, or another sheet, side, anchor or box, is another image", () => {
    const base = upload({ model: model() });
    assert.equal(sameImage(base, upload()), false);
    assert.equal(sameImage(upload(), base), false);
    assert.equal(sameImage(icon({ model: model() }), icon()), false);
    assert.equal(sameImage(base, upload({ model: model({ assetId: "other" }) })), false);
    assert.equal(sameImage(base, upload({ model: model({ side: 1.5 }) })), false);
    assert.equal(sameImage(base, upload({ model: model({ anchorY: 0.8 }) })), false);
    for (let frame = 0; frame < 8; frame++) {
      for (let edge = 0; edge < 4; edge++) {
        const boxes = BOXES.map((b) => [...b] as [number, number, number, number]);
        boxes[frame]![edge]! += 1;
        assert.equal(sameImage(base, upload({ model: model({ boxes }) })), false, `frame ${frame} edge ${edge}`);
      }
    }
    assert.equal(sameImage(base, upload({ model: model({ boxes: BOXES.slice(0, 7) }) })), false, "a short list of boxes");
  });

  test("the picture still counts as before: crop and asset, key and color", () => {
    assert.equal(sameImage(upload({ model: model() }), upload({ assetId: "x", model: model() })), false);
    assert.equal(sameImage(upload({ model: model() }), upload({ crop: { cx: 0.1, cy: -0.2, zoom: 1.6 }, model: model() })), false);
    assert.equal(sameImage(icon({ model: model() }), icon({ color: "#000000", model: model() })), false);
    assert.equal(sameImage(icon({ model: model() }), upload({ model: model() })), false);
  });
});

const arbBox = fc.tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 })).chain(([x0, y0]) => fc.tuple(fc.constant(x0), fc.constant(y0), fc.integer({ min: x0 + 1, max: 100 }), fc.integer({ min: y0 + 1, max: 100 })));
const arbModel: fc.Arbitrary<ModelRef> = fc.record({
  assetId: fc.constantFrom("sheet-a", "sheet-b"),
  side: fc.constantFrom(0.25, 1, 1.4, 4),
  anchorY: fc.constantFrom(0, 0.5, 0.82, 1),
  boxes: fc.array(arbBox, { minLength: 8, maxLength: 8 }),
});
const arbImage: fc.Arbitrary<ImageRef> = fc.tuple(
  fc.oneof(
    fc.record({ assetId: fc.constantFrom("face", "other"), crop: fc.record({ cx: fc.constantFrom(-1, 0, 0.5), cy: fc.constantFrom(-1, 0, 0.5), zoom: fc.constantFrom(0.1, 1, 10) }) }),
    fc.record({ icon: fc.constantFrom("lorc/wolf-head", "lorc/skull"), color: fc.constantFrom("#336699", "#000000") }),
  ),
  fc.option(arbModel, { nil: undefined }),
).map(([picture, m]) => JSON.parse(JSON.stringify(m ? { ...picture, model: m } : picture)) as ImageRef);

describe("the helpers over random images", () => {
  test("a copy is the same image and equal, keepModel keeps a model whenever either had one, and sameImage is equality of the copies", () => {
    fc.assert(
      fc.property(arbImage, arbImage, (a, b) => {
        assert.equal(sameImage(copyImage(a), a), true);
        assert.deepEqual(copyImage(a), a);
        const kept = keepModel(a, b);
        assert.deepEqual(kept.model, a.model ?? b.model);
        assert.equal(sameImage(withoutModel(kept), withoutModel(a)), true, "the picture is the new one");
        assert.equal(sameImage(a, b), JSON.stringify(copyImage(a)) === JSON.stringify(copyImage(b)));
        assert.equal(sameImage(a, b), sameImage(b, a));
        assert.deepEqual(imageAssetIds(a), [imageAssetId(a), imageModelId(a)].filter((id) => id !== undefined));
      }),
      { numRuns: 500 },
    );
  });
});
