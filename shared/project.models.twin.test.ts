import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withoutModel } from "./imageRef.ts";
import { keys, type EntityKey } from "./keys.ts";
import type { ImageRef, ModelRef, RoomState, Viewer } from "./model.ts";
import { projectEntity, projectState, stableStringify, visibleAssetIds } from "./project.ts";
import { DM, P1, P2, character, companionBlock, customMonster, imageRef, reveal, room, srdImage, token } from "./testutil.ts";

/**
 * The privacy twins of a 3D model on a picture (docs/design/design-v1-token-models.md
 * 4.5 and 10): a room whose secret images carry models, and its twin with
 * those models taken off. A player who may not see an image must receive
 * the same projection and the same readable assets from both, byte for
 * byte, so no model of a hidden token, of a creature still under fog or on
 * a scene they do not hold, of a disguise's true face, or on a monster's,
 * an SRD monster's or another player's companion block's default ever
 * reaches them, as data or as a sheet the asset route would serve. The
 * images they do see bring their models, and the DM's and the owners'
 * copies hold the secret ones, so the twins are not equal by accident.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const ON_S1 = { sceneId: "s1" };
const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, (_, i) => [10 + i, 5, 90 - i, 98]);
const sheet = (assetId: string): ModelRef => ({ assetId, side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]) });
const upload = (assetId: string, model: string): ImageRef => ({ ...imageRef(assetId), model: sheet(model) });
const icon = (model: string): ImageRef => ({ icon: "lorc/wolf-head", color: "#336699", model: sheet(model) });

/** Every sheet the secret places name, which no player without a right to them may ever receive. */
const SECRET_SHEETS = ["hiddenSheet", "fogSheet", "elsewhereSheet", "trueFaceSheet", "trueIconSheet", "monsterSheet", "srdSheet", "blockSheet", "blockIconSheet"];

/**
 * A room on s1, the players' scene, with fog on and its west part revealed:
 * a creature in plain sight wearing a model, and every secret place, each
 * wearing one of SECRET_SHEETS. P2 plays the disguised creature and Moth's
 * owner character, so P2's copy holds what P1's and the display's do not.
 */
function withModels(): RoomState {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
  reveal(state, "s1", { x: 0, y: 0, w: 12, h: 12 });
  state.tokens.shown = token("shown", { x: 4, y: 4, image: upload("shownFace", "shownSheet") });
  state.tokens.hidden = token("hidden", { x: 5, y: 5, visibility: "dm", image: upload("hiddenFace", "hiddenSheet") });
  state.tokens.fogged = token("fogged", { x: 30, y: 20, image: upload("fogFace", "fogSheet") });
  state.tokens.elsewhere = token("elsewhere", { sceneId: "s2", image: icon("elsewhereSheet") });
  // A disguise: the face shown carries no secret, and the true face's model sits in the other images.
  state.tokens.disguised = token("disguised", { x: 6, y: 4, ownerIds: ["p2"], image: imageRef("mask"), altImages: [upload("trueFace", "trueFaceSheet"), icon("trueIconSheet")] });
  state.monsters.m1 = customMonster("m1", { defaultImage: upload("monsterFace", "monsterSheet") });
  state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "srdFace", { image: upload("srdFace", "srdSheet") });
  state.characters.c2 = character("c2", { ownerIds: ["p2"], defaultImage: imageRef("hero") });
  state.companionBlocks.b1 = companionBlock("b1", "c2", { defaultImage: upload("blockFace", "blockSheet") });
  state.companionBlocks.b2 = companionBlock("b2", "c2", { defaultImage: icon("blockIconSheet") });
  return state;
}

/** The twin: every secret place's model taken off, the image it rode on kept. */
function withoutSecretModels(state: RoomState): RoomState {
  const twin = structuredClone(state);
  const strip = (image: ImageRef | undefined): ImageRef | undefined => (image && image.model && SECRET_SHEETS.includes(image.model.assetId) ? withoutModel(image) : image);
  for (const t of Object.values(twin.tokens)) {
    const image = strip(t.image);
    if (image) t.image = image;
    if (t.altImages) t.altImages = t.altImages.map((alt) => strip(alt)!);
  }
  for (const m of Object.values(twin.monsters)) if (m.defaultImage) m.defaultImage = strip(m.defaultImage)!;
  for (const s of Object.values(twin.srdImages)) s.image = strip(s.image)!;
  for (const b of Object.values(twin.companionBlocks)) if (b.defaultImage) b.defaultImage = strip(b.defaultImage)!;
  return twin;
}

const ENTITY_KEYS: EntityKey[] = [
  keys.token("shown"),
  keys.token("hidden"),
  keys.token("fogged"),
  keys.token("elsewhere"),
  keys.token("disguised"),
  keys.monster("m1"),
  keys.srdImage("goblin-warrior"),
  keys.character("c2"),
  keys.companionBlock("b1"),
  keys.companionBlock("b2"),
];

const sorted = (ids: Set<string>) => [...ids].sort();

describe("a model on a secret image reaches no player who may not see the image", () => {
  test("the twins give P1 and the table display the same projection, entity by entity, and the same readable assets", () => {
    const state = withModels();
    const twin = withoutSecretModels(state);
    assert.notEqual(stableStringify(state), stableStringify(twin), "the twins differ in the room itself");
    for (const viewer of [P1, DISPLAY]) {
      assert.equal(stableStringify(projectState(state, viewer, ON_S1)), stableStringify(projectState(twin, viewer, ON_S1)), viewer.memberId);
      for (const key of ENTITY_KEYS) {
        assert.equal(stableStringify(projectEntity(key, state, viewer, ON_S1)), stableStringify(projectEntity(key, twin, viewer, ON_S1)), `${viewer.memberId} ${key}`);
      }
      assert.deepEqual(sorted(visibleAssetIds(state, viewer, ON_S1)), sorted(visibleAssetIds(twin, viewer, ON_S1)), viewer.memberId);
      const text = JSON.stringify(projectState(state, viewer, ON_S1));
      for (const id of SECRET_SHEETS) {
        assert.equal(text.includes(id), false, `${viewer.memberId}'s copy names ${id}`);
        assert.equal(visibleAssetIds(state, viewer, ON_S1).has(id), false, `${viewer.memberId} may read ${id}`);
      }
    }
  });

  test("the image a player sees brings its model, as data and as a readable sheet", () => {
    for (const viewer of [P1, P2, DISPLAY]) {
      const state = withModels();
      assert.deepEqual(projectState(state, viewer, ON_S1).tokens.shown?.image, upload("shownFace", "shownSheet"), viewer.memberId);
      const visible = visibleAssetIds(state, viewer, ON_S1);
      assert.ok(visible.has("shownFace") && visible.has("shownSheet"), viewer.memberId);
    }
  });

  test("the disguise's owner and the companion blocks' player hold their models, and the twins differ for them only there", () => {
    const state = withModels();
    const twin = withoutSecretModels(state);
    const mine = visibleAssetIds(state, P2, ON_S1);
    for (const id of ["trueFaceSheet", "trueIconSheet", "blockSheet", "blockIconSheet"]) assert.ok(mine.has(id), id);
    for (const id of ["hiddenSheet", "fogSheet", "elsewhereSheet", "monsterSheet", "srdSheet"]) assert.equal(mine.has(id), false, id);
    const theirs = visibleAssetIds(twin, P2, ON_S1);
    assert.deepEqual(sorted(mine).filter((id) => !theirs.has(id)), ["blockIconSheet", "blockSheet", "trueFaceSheet", "trueIconSheet"]);
    assert.deepEqual(projectState(state, P2, ON_S1).tokens.disguised?.altImages, state.tokens.disguised!.altImages);
  });

  test("the DM may read every sheet the room names", () => {
    const visible = visibleAssetIds(withModels(), DM, ON_S1);
    for (const id of ["shownSheet", ...SECRET_SHEETS]) assert.ok(visible.has(id), id);
  });

  test("a hidden creature revealed brings its model, and hidden again takes it away", () => {
    const state = withModels();
    state.tokens.hidden = { ...state.tokens.hidden!, visibility: "all" };
    assert.ok(visibleAssetIds(state, P1, ON_S1).has("hiddenSheet"));
    assert.deepEqual(projectState(state, P1, ON_S1).tokens.hidden?.image, upload("hiddenFace", "hiddenSheet"));
    state.tokens.hidden = { ...state.tokens.hidden, visibility: "dm" };
    assert.equal(visibleAssetIds(state, P1, ON_S1).has("hiddenSheet"), false);
  });
});
