import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState } from "./model.ts";
import { referencedAssetIds, restoreAddedAssets } from "./referencedAssets.ts";
import { character, customMonster, imageRef, room, scene, srdImage, token } from "./testutil.ts";

/** Every place a room names an image, each with its own asset id: the walk must find them all. */
function everyReference(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", {
    map: { assetId: "map", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } },
    thumb: "thumb",
    phases: [{ id: "ph", name: "Night", assetId: "phase", widthPx: 100, heightPx: 100 }],
    phaseId: "ph",
    phaseGrid: { refWidthPx: 100, refHeightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } },
  });
  state.tokens.t1 = token("t1", { image: imageRef("tokenImage"), altImages: [imageRef("altImage"), { icon: "lorc/wolf-head", color: "#336699" }] });
  state.tokens.t2 = token("t2", { image: { icon: "lorc/skull", color: "#000000" } });
  state.characters.c1 = character("c1", { defaultImage: imageRef("portrait") });
  state.monsters.m1 = customMonster("m1", { defaultImage: imageRef("monsterImage") });
  state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "srdImage");
  state.stamps.st1 = { id: "st1", rev: 0, sceneId: "s1", art: { assetId: "stampImage" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
  state.stamps.st2 = { id: "st2", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
  state.handouts.h1 = { id: "h1", rev: 0, assetId: "handout", title: "Letter", to: "all", shownAt: "2026-10-14T00:00:00.000Z" };
  return state;
}

/** Every string a state holds under a field named like an asset reference, found without knowing the model. */
function namedAssets(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) namedAssets(item, out);
  else if (value && typeof value === "object") {
    for (const [field, inner] of Object.entries(value)) {
      if ((field === "assetId" || field === "thumb") && typeof inner === "string") out.add(inner);
      else namedAssets(inner, out);
    }
  }
  return out;
}

describe("referencedAssetIds (docs/design-v1-dm-tools.md 3.19)", () => {
  test("finds every reference the model can hold, and no shipped icon or stamp", () => {
    const state = everyReference();
    const found = referencedAssetIds(state);
    // A field added to the model that names an asset shows here first, and fails until the walk knows it.
    assert.deepEqual([...found].sort(), [...namedAssets(state)].sort());
    assert.deepEqual([...found].sort(), ["altImage", "handout", "map", "monsterImage", "phase", "portrait", "srdImage", "stampImage", "thumb", "tokenImage"]);
  });

  test("a restore adds only references the entity does not hold now, and never a thumbnail", () => {
    const state = everyReference();
    const before = state.tokens.t1!;
    const changed = { ...state, tokens: { ...state.tokens, t1: { ...before, image: imageRef("newer"), altImages: [] } } };
    assert.deepEqual(restoreAddedAssets([{ key: keys.token("t1"), value: before }], changed), [
      { assetId: "tokenImage", kind: "token" },
      { assetId: "altImage", kind: "token" },
    ]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.token("t1"), value: before }], state), []);
    const sceneNow = { ...state.scenes.s1!, thumb: "fresh" };
    const sceneState = { ...state, scenes: { ...state.scenes, s1: sceneNow } };
    assert.deepEqual(restoreAddedAssets([{ key: keys.scene("s1"), value: state.scenes.s1 }], sceneState), []);
    assert.deepEqual(restoreAddedAssets([{ key: keys.handout("h2"), value: { ...state.handouts.h1, id: "h2", assetId: "other" } }], state), [{ assetId: "other", kind: "handout" }]);
  });
});
