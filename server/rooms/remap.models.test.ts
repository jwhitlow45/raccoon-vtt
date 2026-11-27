import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ImageRef, ModelRef, RoomState, Token } from "#shared/model.ts";
import { visibleAssetIds } from "#shared/project.ts";
import { P1, character, companionBlock, customMonster, imageRef, room, srdImage, token } from "#shared/testutil.ts";
import type { AssetKind } from "../assets/kinds.ts";
import { remapState, type ImportedAsset } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A 3D model on an imported room's images (docs/design/design-v1-token-models.md
 * 4.6): the import made a new asset of each sheet that came through, and
 * every model follows its sheet to the new id, on an upload's picture and
 * on a shipped icon's alike. A model whose sheet did not come through as a
 * `model` asset goes alone, and the creature keeps its picture.
 */

const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, (_, i) => [10 + i, 5, 90 - i, 98]);
const sheet = (assetId: string): ModelRef => ({ assetId, side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]) });
const upload = (assetId: string, model?: string): ImageRef => ({ ...imageRef(assetId), ...(model ? { model: sheet(model) } : {}) });
const icon = (model?: string): ImageRef => ({ icon: "lorc/wolf-head", color: "#336699", ...(model ? { model: sheet(model) } : {}) });

function kinds(table: Record<string, [string, AssetKind]>): Map<string, ImportedAsset> {
  return new Map(Object.entries(table).map(([old, [id, kind]]) => [old, { id, kind }]));
}

/** The import's assets: the picture and three sheets came through, `lost` did not, and `face2` came through as a sheet by a hand-made file's word. */
const ASSETS = kinds({ face: ["face-new", "token"], sheet: ["sheet-new", "model"], iconSheet: ["iconSheet-new", "model"], art: ["art-new", "token"], face2: ["face2-new", "model"] });

function modelRoom(): RoomState {
  const state = room();
  state.tokens.both = token("both", { name: "Both", image: upload("face", "sheet"), altImages: [icon("iconSheet"), upload("art", "lost")] });
  state.tokens.iconic = token("iconic", { name: "Iconic", image: icon("iconSheet") });
  state.tokens.lostSheet = token("lostSheet", { name: "Lost sheet", image: upload("face", "lost") });
  state.tokens.lostIcon = token("lostIcon", { name: "Lost icon", image: icon("lost") });
  state.tokens.wrongKind = token("wrongKind", { name: "Wrong kind", image: upload("face", "art") });
  state.tokens.lostPicture = token("lostPicture", { name: "Lost picture", image: upload("gone", "sheet") });
  state.tokens.sheetAsPicture = token("sheetAsPicture", { name: "Sheet as picture", image: upload("face2") });
  state.characters.c1 = character("c1", { ownerIds: [], defaultImage: icon("sheet") });
  state.monsters.m1 = customMonster("m1", { defaultImage: upload("face", "sheet") });
  state.srdImages.bandit = srdImage("bandit", "face", { image: upload("face", "lost") });
  state.companionBlocks.b1 = companionBlock("b1", "c1", { defaultImage: icon("iconSheet") });
  return state;
}

function byName(state: RoomState): Record<string, Token> {
  return Object.fromEntries(Object.values(state.tokens).map((t) => [t.name, t]));
}

describe("remapState with models", () => {
  test("a model follows its sheet to its new id, on an upload's picture and on a shipped icon's", () => {
    const out = remapState(modelRoom(), { assets: ASSETS, newId: () => uuidv7() });
    const tokens = byName(out);
    assert.deepEqual(tokens.Both!.image, upload("face-new", "sheet-new"));
    assert.deepEqual(tokens.Iconic!.image, icon("iconSheet-new"));
    assert.deepEqual(Object.values(out.characters)[0]!.defaultImage, icon("sheet-new"));
    assert.deepEqual(Object.values(out.monsters)[0]!.defaultImage, upload("face-new", "sheet-new"));
    assert.deepEqual(Object.values(out.companionBlocks)[0]!.defaultImage, icon("iconSheet-new"));
  });

  test("a model whose sheet did not come through as a model goes alone, and its picture stays, on both kinds of picture", () => {
    const out = remapState(modelRoom(), { assets: ASSETS, newId: () => uuidv7() });
    const tokens = byName(out);
    assert.deepEqual(tokens["Lost sheet"]!.image, upload("face-new"));
    assert.deepEqual(tokens["Lost icon"]!.image, icon());
    assert.deepEqual(tokens["Wrong kind"]!.image, upload("face-new"), "a token image is no sheet");
    assert.deepEqual(tokens.Both!.altImages, [icon("iconSheet-new"), upload("art-new")]);
    assert.deepEqual(Object.values(out.srdImages)[0]!.image, upload("face-new"));
  });

  test("a picture that did not come through takes its model with it, and a sheet is no picture", () => {
    const out = remapState(modelRoom(), { assets: ASSETS, newId: () => uuidv7() });
    const tokens = byName(out);
    assert.equal(tokens["Lost picture"]!.image, undefined);
    assert.equal(tokens["Sheet as picture"]!.image, undefined);
  });

  test("no old asset id survives, the result is a room the stored schema takes, and a player reads the new sheet", () => {
    const out = remapState(modelRoom(), { assets: ASSETS, newId: () => uuidv7() });
    const text = JSON.stringify(out);
    for (const old of ['"sheet"', '"iconSheet"', '"lost"', '"face"', '"art"']) assert.equal(text.includes(old), false, old);
    const parsed = parseRoomState(JSON.parse(text));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const shown = byName(out).Both!;
    out.meta.playerSceneId = shown.sceneId;
    const visible = visibleAssetIds(out, P1, { sceneId: shown.sceneId });
    assert.ok(visible.has("face-new") && visible.has("sheet-new"));
  });
});
