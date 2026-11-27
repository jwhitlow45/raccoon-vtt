import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRoomState } from "#server/rooms/stateSchema.ts";
import { MODEL_LIMITS } from "./limits.ts";
import type { ImageRef, ModelRef } from "./model.ts";
import { clientOpSchema, dmToolSchemas } from "./protocol.ts";
import { character, imageRef, room, srdImage, token } from "./testutil.ts";

/**
 * A 3D model on an image in the protocol (docs/design/design-v1-token-models.md
 * 4.2): every op that carries an image carries its model as sent, on an
 * upload and on an icon, and the stored state takes it by the same shape.
 * The model is a strict object: its side, anchor and 8 drawn boxes are held
 * to their bounds, and nothing else rides on it.
 */

const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, (_, i) => [10 + i, 5, 90 - i, 98]);
const model = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ assetId: "sheet", side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]), ...over });
const upload = (m: Record<string, unknown> = model()) => ({ assetId: "face", crop: { cx: 0, cy: 0, zoom: 1 }, model: m });
const icon = (m: Record<string, unknown> = model()) => ({ icon: "lorc/wolf-head", color: "#336699", model: m });

const goblin = () => {
  const { id, sceneId, kind, name, size, x, y, actor } = token("g1");
  return { id, sceneId, kind, name, size, x, y, actor };
};

/** Every op that carries an image, wearing `image`. */
function opsWearing(image: unknown): Record<string, unknown>[] {
  return [
    { t: "token.create", token: { ...goblin(), image } },
    { t: "token.update", tokenId: "g1", patch: { image } },
    { t: "token.update", tokenId: "g1", patch: { altImages: [imageRef("plain"), image] } },
    { t: "token.updateMany", tokenIds: ["g1", "g2"], patch: { image } },
    { t: "character.update", characterId: "c1", patch: { defaultImage: image } },
    { t: "monster.update", monsterId: "m1", patch: { defaultImage: image } },
    { t: "companionBlock.update", blockId: "b1", patch: { defaultImage: image } },
    { t: "monster.setSrdImage", srdId: "goblin-warrior", image },
  ];
}

/** The value back from the schema through JSON, as the server receives it. */
function parsed(value: unknown): unknown {
  const result = clientOpSchema.safeParse(JSON.parse(JSON.stringify(value)));
  assert.ok(result.success, `${JSON.stringify(value)}: ${result.success ? "" : result.error.issues[0]?.message}`);
  return result.data;
}

const imageOk = (value: unknown) => assert.ok(dmToolSchemas.imageRef.safeParse(value).success, JSON.stringify(value));
const imageBad = (value: unknown, why: string) => assert.equal(dmToolSchemas.imageRef.safeParse(value).success, false, why);

describe("a model on an image, in every op that carries one", () => {
  test("comes back as it was sent, on an upload and on an icon", () => {
    for (const image of [upload(), icon()]) {
      for (const op of opsWearing(image)) assert.deepEqual(parsed(op), op, String(op.t));
    }
  });

  test("a model naming a bad id, or a picture's own bad shape, is refused in every op", () => {
    for (const image of [upload(model({ assetId: "" })), icon(model({ side: 4.01 })), { ...upload(), crop: { cx: 0, cy: 0, zoom: 11 } }]) {
      for (const op of opsWearing(image)) assert.equal(clientOpSchema.safeParse(op).success, false, `${String(op.t)} ${JSON.stringify(image)}`);
    }
  });
});

describe("the model's bounds", () => {
  test("side 0.25 to 4 and anchor 0 to 1, both ends included", () => {
    for (const side of [MODEL_LIMITS.minSide, 1, MODEL_LIMITS.maxSide]) imageOk(upload(model({ side })));
    for (const anchorY of [0, 0.5, 1]) imageOk(upload(model({ anchorY })));
    for (const side of [0.24, 4.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) imageBad(upload(model({ side })), `side ${String(side)}`);
    for (const anchorY of [-0.01, 1.01, Number.NaN, null]) imageBad(upload(model({ anchorY })), `anchorY ${String(anchorY)}`);
  });

  test("exactly 8 boxes, each four whole hundredths with its corners in order", () => {
    imageOk(upload(model({ boxes: Array.from({ length: 8 }, () => [0, 0, 100, 100]) })));
    imageBad(upload(model({ boxes: BOXES.slice(0, 7) })), "7 boxes");
    imageBad(upload(model({ boxes: [...BOXES, [0, 0, 1, 1]] })), "9 boxes");
    imageBad(upload(model({ boxes: [] })), "no boxes");
    const withBox = (box: unknown) => upload(model({ boxes: [box, ...BOXES.slice(1)] }));
    for (const box of [
      [10, 5, 10, 98],
      [10, 98, 90, 98],
      [90, 5, 10, 98],
      [10, 98, 90, 5],
      [10.5, 5, 90, 98],
      [-1, 5, 90, 98],
      [10, 5, 101, 98],
      [10, 5, 90],
      [10, 5, 90, 98, 99],
      [10, 5, 90, Number.NaN],
      "10,5,90,98",
    ]) {
      imageBad(withBox(box), `box ${JSON.stringify(box)}`);
    }
  });

  test("strict: no field beyond the four, and none of them left out", () => {
    imageBad(upload(model({ frames: 16 })), "an extra field");
    imageBad(upload(model({ url: "https://example.com/sheet.webp" })), "a link in place of an asset");
    for (const field of ["assetId", "side", "anchorY", "boxes"]) {
      const m = model();
      delete m[field];
      imageBad(upload(m), `without ${field}`);
    }
    imageBad({ ...upload(), model: null }, "a null model: an image without one leaves the field out");
  });

  test("an image without a model is as before", () => {
    imageOk(imageRef("face"));
    imageOk({ icon: "lorc/skull", color: "#000000" });
  });
});

describe("the stored state", () => {
  test("takes a model on a token's image and other images, a portrait and an SRD image, and refuses one out of bounds", () => {
    const state = room();
    state.tokens.t1 = token("t1", { image: upload() as ImageRef, altImages: [icon() as ImageRef] });
    state.characters.c1 = character("c1", { defaultImage: icon() as ImageRef });
    state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "face", { image: upload() as ImageRef });
    const kept = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(kept.ok, kept.ok ? "" : kept.message);
    assert.deepEqual(kept.state.tokens.t1, state.tokens.t1);
    assert.deepEqual(kept.state.characters.c1?.defaultImage, icon());
    state.tokens.t1 = token("t1", { image: upload(model({ boxes: BOXES.slice(0, 7) })) as ImageRef });
    assert.equal(parseRoomState(JSON.parse(JSON.stringify(state))).ok, false);
  });
});
