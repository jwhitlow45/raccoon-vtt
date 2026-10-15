import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema, MAX_NAME } from "#shared/protocol.ts";
import { copyName, DUPLICATE_DEFAULTS, duplicateOp, fogHint } from "./duplicate.ts";

describe("duplicating a scene", () => {
  test("the copy is named after the original", () => {
    assert.equal(copyName("Crypt"), "Crypt (copy)");
    assert.equal(copyName("  Crypt  "), "Crypt (copy)");
    assert.equal(copyName(""), "Scene (copy)");
  });

  test("a long name is shortened so the copy's name stays within the limit, never inside an emoji", () => {
    const long = copyName("x".repeat(MAX_NAME));
    assert.equal(long.length, MAX_NAME);
    assert.ok(long.endsWith("x (copy)"));
    // 36 emoji take 72 code units. With the suffix that is 79, and a 37th would pass 80.
    const emoji = copyName("🐉".repeat(40));
    assert.equal(emoji, `${"🐉".repeat(36)} (copy)`);
    assert.ok(emoji.length <= MAX_NAME);
  });

  test("the defaults copy creatures but no player characters, fog or drawings, and the op is one the protocol takes", () => {
    assert.deepEqual(DUPLICATE_DEFAULTS, { creatures: true, characters: false, fog: false, drawings: false });
    const op = duplicateOp("crypt", "copy-id", "Crypt", DUPLICATE_DEFAULTS);
    assert.deepEqual(op, { t: "scene.duplicate", sceneId: "crypt", newSceneId: "copy-id", name: "Crypt (copy)", include: DUPLICATE_DEFAULTS });
    assert.ok(clientOpSchema.safeParse(op).success);
    assert.ok(clientOpSchema.safeParse(duplicateOp("crypt", "copy-id", "y".repeat(MAX_NAME), DUPLICATE_DEFAULTS)).success);
  });

  test("the Fog hint says what the copy gets on this scene", () => {
    const map = { assetId: "m", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    const fogged = "Left off, the copy starts fully fogged.";
    const off = "Fog is off on this scene, so the copy's is too.";
    // A map scene's copy is fogged whatever the original's setting, unless its fog is copied as it is.
    assert.equal(fogHint({ map, fogEnabled: true }, false), fogged);
    assert.equal(fogHint({ map, fogEnabled: false }, false), fogged);
    assert.equal(fogHint({ map, fogEnabled: true }, true), fogged);
    assert.equal(fogHint({ map, fogEnabled: false }, true), off);
    // A blank mat's copy keeps the original's setting.
    assert.equal(fogHint({ fogEnabled: true }, false), fogged);
    assert.equal(fogHint({ fogEnabled: false }, false), off);
    assert.equal(fogHint({ fogEnabled: false }, true), off);
  });
});
