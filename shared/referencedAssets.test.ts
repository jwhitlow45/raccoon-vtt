import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { MapVideo, ModelRef, RoomState } from "./model.ts";
import { entityAssetRefs, referencedAssetIds, referencedVideoIds, restoreAddedAssets } from "./referencedAssets.ts";
import { character, companionBlock, customMonster, imageRef, room, scene, srdImage, token } from "./testutil.ts";

const page = (assetId: string) => ({ assetId, width: 1584, height: 2048 });
const sheet = (assetId: string): ModelRef => ({ assetId, side: 1.4, anchorY: 0.82, boxes: Array.from({ length: 8 }, () => [20, 10, 80, 95] as [number, number, number, number]) });
const video = (assetId: string): MapVideo => ({ assetId, widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 6_000 });

/** Every place a room names an image, each with its own asset id: the walk must find them all. */
function everyReference(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", {
    map: { assetId: "map", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 }, video: video("mapVideo") },
    thumb: "thumb",
    phases: [
      { id: "ph", name: "Night", assetId: "phase", widthPx: 100, heightPx: 100, video: video("mapVideo") },
      { id: "ph2", name: "Storm", assetId: "phase", widthPx: 100, heightPx: 100, video: video("phaseVideo") },
    ],
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
  state.handouts.h2 = { id: "h2", rev: 0, assetId: "page1", pages: [page("page1"), page("page2"), page("page1")], title: "Strange letter", to: "all", shownAt: "2026-10-14T00:00:00.000Z" };
  state.handoutDocs.d1 = { id: "d1", rev: 0, title: "Strange letter", pages: [page("docPage1"), page("docPage2")], createdAt: "2026-10-14T00:00:00.000Z" };
  state.companionBlocks.b1 = companionBlock("b1", "c1", { defaultImage: imageRef("blockImage") });
  // A 3D model's sheet on each place an image goes, on an upload and on an icon (docs/design/design-v1-token-models.md 4.5).
  state.tokens.t3 = token("t3", { image: { ...imageRef("modelFace"), model: sheet("tokenModel") }, altImages: [{ icon: "lorc/wolf-head", color: "#336699", model: sheet("altModel") }] });
  state.characters.c2 = character("c2", { defaultImage: { icon: "lorc/skull", color: "#000000", model: sheet("portraitModel") } });
  state.monsters.m2 = customMonster("m2", { defaultImage: { ...imageRef("monsterImage"), model: sheet("monsterModel") } });
  state.srdImages.bandit = srdImage("bandit", "srdImage", { image: { ...imageRef("srdImage"), model: sheet("srdModel") } });
  state.companionBlocks.b2 = companionBlock("b2", "c1", { defaultImage: { ...imageRef("blockImage"), model: sheet("blockModel") } });
  // Stamps players remember (docs/design/design-v1-map-discovery.md 5.4): the party's and a holder's, whatever the stamp is now.
  const remembered = (id: string, assetId: string) => ({ ...state.stamps.st1!, id, art: { assetId } });
  state.memory = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, stamps: { st1: remembered("st1", "rememberedStamp"), gone: null } } };
  state.memoryBy = { "s1:p1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, memberId: "p1", stamps: { st3: remembered("st3", "holderStamp"), st4: { ...remembered("st4", "x"), art: { key: "oak-tree" } } } } };
  // A sound names its file (docs/design/design-v1-music.md 7.3). Its playlists and what plays name sounds, never files.
  state.sounds = { rain: { id: "rain", rev: 0, name: "Rain", assetId: "soundFile", ms: 60_000, use: "loop" } };
  state.playlists = { pl: { id: "pl", rev: 0, name: "Tavern night", sounds: [], repeat: "all", fade: 5 } };
  state.playing = { rev: 1, music: null, loops: { l1: { soundId: "rain", at: 0, volume: 70 } }, effects: [], volume: { music: 100, effects: 100 } };
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

describe("referencedAssetIds (docs/design/design-v1-dm-tools.md 3.19)", () => {
  test("finds every reference the model can hold, and no shipped icon or stamp", () => {
    const state = everyReference();
    const found = referencedAssetIds(state);
    // A field added to the model that names an asset shows here first, and fails until the walk knows it.
    assert.deepEqual([...found].sort(), [...namedAssets(state)].sort());
    assert.deepEqual([...found].sort(), [
      "altImage",
      "altModel",
      "blockImage",
      "blockModel",
      "docPage1",
      "docPage2",
      "handout",
      "holderStamp",
      "map",
      "mapVideo",
      "modelFace",
      "monsterImage",
      "monsterModel",
      "page1",
      "page2",
      "phase",
      "phaseVideo",
      "portrait",
      "portraitModel",
      "rememberedStamp",
      "soundFile",
      "srdImage",
      "srdModel",
      "stampImage",
      "thumb",
      "tokenImage",
      "tokenModel",
    ]);
  });

  test("a 3D model's sheet is a model row wherever an image carries it, so cleanup keeps it and a restore checks its kind (docs/design/design-v1-token-models.md 4.5)", () => {
    const state = everyReference();
    const refsOf = (key: Parameters<typeof entityAssetRefs>[0], value: unknown) => entityAssetRefs(key, value);
    assert.deepEqual(refsOf(keys.token("t3"), state.tokens.t3), [
      { assetId: "modelFace", kind: "token" },
      { assetId: "tokenModel", kind: "model" },
      { assetId: "altModel", kind: "model" },
    ]);
    assert.deepEqual(refsOf(keys.character("c2"), state.characters.c2), [{ assetId: "portraitModel", kind: "model" }], "an icon's model, with no picture row");
    assert.deepEqual(refsOf(keys.monster("m2"), state.monsters.m2), [
      { assetId: "monsterImage", kind: "token" },
      { assetId: "monsterModel", kind: "model" },
    ]);
    assert.deepEqual(refsOf(keys.srdImage("bandit"), state.srdImages.bandit), [
      { assetId: "srdImage", kind: "token" },
      { assetId: "srdModel", kind: "model" },
    ]);
    assert.deepEqual(refsOf(keys.companionBlock("b2"), state.companionBlocks.b2), [
      { assetId: "blockImage", kind: "token" },
      { assetId: "blockModel", kind: "model" },
    ]);
    // Removing the model leaves the picture in use and frees the sheet, and an undo of the removal adds the sheet alone.
    const before = state.tokens.t3!;
    const removed = { ...state, tokens: { ...state.tokens, t3: { ...before, image: imageRef("modelFace"), altImages: [] } } };
    assert.equal(referencedAssetIds(removed).has("tokenModel"), false);
    assert.equal(referencedAssetIds(removed).has("modelFace"), true);
    assert.deepEqual(restoreAddedAssets([{ key: keys.token("t3"), value: before }], removed), [
      { assetId: "tokenModel", kind: "model" },
      { assetId: "altModel", kind: "model" },
    ]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.token("t3"), value: before }], state), []);
  });

  test("a sound's file is a sound row, so cleanup keeps it while the library names it and a restore checks its kind (docs/design/design-v1-music.md 6.6)", () => {
    const state = everyReference();
    const rain = state.sounds!.rain!;
    const deleted = { ...state, sounds: {} };
    assert.equal(referencedAssetIds(deleted).has("soundFile"), false, "a deleted sound's row is no longer named");
    assert.deepEqual(restoreAddedAssets([{ key: keys.sound("rain"), value: rain }], deleted), [{ assetId: "soundFile", kind: "sound" }]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.sound("rain"), value: { ...rain, name: "Storm" } }], state), [], "a rename adds no file");
  });

  test("a map's and its phases' videos are video rows, so a restore checks their kind and the switch sees them (docs/design/design-v1-animated-maps.md 9.2)", () => {
    const state = everyReference();
    const before = state.scenes.s1!;
    const still = { ...before, map: { ...before.map!, video: undefined }, phases: before.phases!.map(({ video: _video, ...p }) => p) };
    const changed = { ...state, scenes: { ...state.scenes, s1: still } };
    assert.deepEqual(restoreAddedAssets([{ key: keys.scene("s1"), value: before }], changed), [
      { assetId: "mapVideo", kind: "video" },
      { assetId: "mapVideo", kind: "video" },
      { assetId: "phaseVideo", kind: "video" },
    ]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.scene("s1"), value: before }], state), []);
    assert.deepEqual([...referencedVideoIds(state)].sort(), ["mapvideo", "phasevideo"], "lowercased, as the actor reads rows");
    assert.deepEqual([...referencedVideoIds(changed)], []);
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

  test("a handout's every page is a handout image, each once, and a restore adds the pages it does not hold now (docs/design/design-v1-pdf-handouts.md 3.5)", () => {
    const state = everyReference();
    const before = state.handouts.h2!;
    const now = { ...before, assetId: "page2", pages: [page("page2")] };
    const changed = { ...state, handouts: { ...state.handouts, h2: now } };
    assert.deepEqual(restoreAddedAssets([{ key: keys.handout("h2"), value: before }], changed), [{ assetId: "page1", kind: "handout" }]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.handout("h2"), value: before }], state), []);
    const gone = { ...state, handouts: { h1: state.handouts.h1! } };
    assert.deepEqual(restoreAddedAssets([{ key: keys.handout("h2"), value: before }], gone), [
      { assetId: "page1", kind: "handout" },
      { assetId: "page2", kind: "handout" },
    ]);
  });

  test("a document's every page is a handout image, and putting a deleted one back adds every page", () => {
    const state = everyReference();
    const doc = state.handoutDocs.d1!;
    const deleted = { ...state, handoutDocs: {} };
    assert.deepEqual(restoreAddedAssets([{ key: keys.handoutDoc("d1"), value: doc }], deleted), [
      { assetId: "docPage1", kind: "handout" },
      { assetId: "docPage2", kind: "handout" },
    ]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.handoutDoc("d1"), value: doc }], state), []);
  });

  test("a companion block's picture is a token image, which putting the deleted block back adds (docs/design/design-v1-companion-stat-blocks.md 4.3)", () => {
    const state = everyReference();
    const block = state.companionBlocks.b1!;
    const deleted = { ...state, companionBlocks: {} };
    assert.deepEqual(restoreAddedAssets([{ key: keys.companionBlock("b1"), value: block }], deleted), [{ assetId: "blockImage", kind: "token" }]);
    assert.deepEqual(restoreAddedAssets([{ key: keys.companionBlock("b1"), value: block }], state), []);
  });
});
