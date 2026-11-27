import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keepModel, withoutModel } from "./imageRef.ts";
import type { ImageRef, ModelRef, RoomState, Viewer } from "./model.ts";
import { canApply, type AssetKind, type PermissionDeps } from "./permissions.ts";
import { onPlayerUndoStack, type Op, type RestoreEntry } from "./protocol.ts";
import { DM, P1, P2, character, companionBlock, customMonster, imageRef, room, token } from "./testutil.ts";

/**
 * Who may put a 3D model on an image, and what it may name
 * (docs/design/design-v1-token-models.md 3.3 and 4.2). Who may set an image
 * is unchanged: the DM anywhere, a player on the tokens and characters they
 * own. What is new is the model's sheet: it must be an asset of kind
 * `model` the actor may use, on every op that carries an image, so a
 * picture never names a sheet nor a model a picture. A restore puts a model
 * back only while its sheet is still a `model` row of the room.
 */

const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, () => [20, 10, 80, 95]);
const model = (assetId = "sheet"): ModelRef => ({ assetId, side: 1.4, anchorY: 0.82, boxes: BOXES.map((b) => [...b]) });
const withModel = (assetId: string, sheet = "sheet"): ImageRef => ({ ...imageRef(assetId), model: model(sheet) });
const iconWith = (sheet = "sheet"): ImageRef => ({ icon: "lorc/wolf-head", color: "#336699", model: model(sheet) });

/** The room's rows by kind. Any other id is another room's asset, or none. */
const ROWS: Record<string, AssetKind> = { face: "token", art: "token", sheet: "model", other: "model", crypt: "map" };
const byKind: PermissionDeps = { canUseAsset: (_member, assetId, kind) => ROWS[assetId] === kind };

function setup(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], defaultImage: imageRef("face") });
  state.tokens.mine = token("mine", { kind: "pc", ownerIds: ["p1"], image: withModel("face") });
  state.tokens.goblin = token("goblin", { image: imageRef("face") });
  state.monsters.m1 = customMonster("m1");
  state.companionBlocks.b1 = companionBlock("b1", "c1");
  return state;
}

function code(op: Op, who: Viewer = DM, deps: PermissionDeps = byKind, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : d.code;
}

const newToken = (image: ImageRef) => {
  const { id, sceneId, kind, name, size, x, y, actor } = token("new");
  return { id, sceneId, kind, name, size, x, y, actor, image };
};
const { id: _id, rev: _rev, ...block } = companionBlock("b2", "c1");
const { rev: _monsterRev, ...monster } = customMonster("m2");

/** Every op a DM sends that carries an image, wearing `image`. */
function dmOps(image: ImageRef): Op[] {
  return [
    { t: "token.create", token: newToken(image) },
    { t: "token.update", tokenId: "goblin", patch: { image } },
    { t: "token.update", tokenId: "goblin", patch: { altImages: [imageRef("art"), image] } },
    { t: "token.updateMany", tokenIds: ["goblin", "mine"], patch: { image } },
    { t: "character.create", character: { id: "c2", name: "Bree", size: "medium", ownerIds: [], actor: character("x").actor, defaultImage: image } },
    { t: "character.update", characterId: "c1", patch: { defaultImage: image } },
    { t: "monster.create", monster: { ...monster, defaultImage: image } },
    { t: "monster.update", monsterId: "m1", patch: { defaultImage: image } },
    { t: "monster.setSrdImage", srdId: "goblin-warrior", image },
    { t: "companionBlock.create", block: { ...block, id: "b2", defaultImage: image } },
    { t: "companionBlock.update", blockId: "b1", patch: { defaultImage: image } },
  ] as Op[];
}

/** Every op an owner sends that carries an image, on what P1 owns, wearing `image`. */
function ownerOps(image: ImageRef): Op[] {
  return [
    { t: "token.update", tokenId: "mine", patch: { image } },
    { t: "token.update", tokenId: "mine", patch: { altImages: [image] } },
    { t: "token.updateMany", tokenIds: ["mine"], patch: { image } },
    { t: "character.update", characterId: "c1", patch: { defaultImage: image } },
    { t: "companionBlock.update", blockId: "b1", patch: { defaultImage: image } },
  ] as Op[];
}

describe("a model's sheet is an asset of kind model, on every op that carries an image", () => {
  test("the DM may set a model on an upload or an icon, and one naming a picture, a map or no row is gone", () => {
    for (const good of [withModel("face"), iconWith(), withModel("art", "other")]) {
      for (const op of dmOps(good)) assert.equal(code(op), "ok", `${op.t} ${JSON.stringify(good)}`);
    }
    for (const bad of [withModel("face", "art"), iconWith("face"), withModel("face", "crypt"), withModel("face", "elsewhere")]) {
      for (const op of dmOps(bad)) assert.equal(code(op), "gone", `${op.t} ${JSON.stringify(bad)}`);
    }
  });

  test("a picture naming a model sheet is gone, so a sheet never shows as a token's picture", () => {
    for (const op of dmOps(imageRef("sheet"))) assert.equal(code(op), "gone", op.t);
    for (const op of dmOps({ ...imageRef("sheet"), model: model() })) assert.equal(code(op), "gone", op.t);
    for (const op of ownerOps(imageRef("sheet"))) assert.equal(code(op, P1), "gone", op.t);
  });

  test("an owner may set and change a model on what they own, held to the same kinds", () => {
    for (const op of ownerOps(withModel("face"))) assert.equal(code(op, P1), "ok", op.t);
    for (const op of ownerOps(iconWith("other"))) assert.equal(code(op, P1), "ok", op.t);
    for (const op of ownerOps(withModel("face", "face"))) assert.equal(code(op, P1), "gone", op.t);
    for (const op of ownerOps(iconWith("elsewhere"))) assert.equal(code(op, P1), "gone", op.t);
  });

  test("a model the actor may not use is gone, whatever its kind", () => {
    const own: PermissionDeps = { canUseAsset: (_member, assetId, kind) => ROWS[assetId] === kind && assetId !== "other" };
    assert.equal(code({ t: "token.update", tokenId: "mine", patch: { image: withModel("face", "other") } }, P1, own), "gone");
    assert.equal(code({ t: "token.update", tokenId: "mine", patch: { image: withModel("face", "sheet") } }, P1, own), "ok");
  });
});

describe("who may set a model is who may set the image", () => {
  test("a player sets a model on a monster, another's token, a monster's default or an SRD image: forbidden", () => {
    for (const op of [
      { t: "token.update", tokenId: "goblin", patch: { image: withModel("face") } },
      { t: "token.updateMany", tokenIds: ["goblin"], patch: { image: withModel("face") } },
      { t: "monster.update", monsterId: "m1", patch: { defaultImage: withModel("face") } },
      { t: "monster.setSrdImage", srdId: "goblin-warrior", image: withModel("face") },
    ] as Op[]) {
      assert.equal(code(op, P1), "forbidden", op.t);
    }
    assert.notEqual(code({ t: "token.update", tokenId: "mine", patch: { image: withModel("face") } }, P2), "ok", "another player's token");
    assert.notEqual(code({ t: "character.update", characterId: "c1", patch: { defaultImage: withModel("face") } }, P2), "ok", "another player's character");
  });
});

describe("removing a model", () => {
  test("the owner and the DM may each remove one, and a player's removal goes on no undo stack of theirs", () => {
    const state = setup();
    const removal: Op = { t: "token.update", tokenId: "mine", patch: { image: withoutModel(state.tokens.mine!.image!) } };
    assert.equal(code(removal, P1, byKind, state), "ok");
    assert.equal(code(removal, DM, byKind, state), "ok");
    assert.equal(onPlayerUndoStack(removal), false, "a player has no Undo for it, so the sheet asks twice");
    // A new picture keeps the model, and is checked as a model too.
    assert.equal(code({ t: "token.update", tokenId: "mine", patch: { image: keepModel(imageRef("art"), state.tokens.mine!.image) } }, P1, byKind, state), "ok");
  });

  test("the DM's undo puts a model back while its sheet is a model row of the room, and is refused once it was deleted", () => {
    const state = setup();
    state.tokens.mine = token("mine", { kind: "pc", ownerIds: ["p1"], image: imageRef("face") });
    const restore = (entries: RestoreEntry[], rows: Record<string, AssetKind>): string => {
      const deps: PermissionDeps = { ...byKind, restoredAssetUsable: (assetId, kind) => rows[assetId] === kind };
      const d = canApply({ t: "sys.restore", entries, from: "undo", deps: true }, DM, state, deps);
      return d.ok ? "ok" : `${d.code}: ${d.message}`;
    };
    const back = (image: ImageRef): RestoreEntry[] => [{ key: "token:mine", value: { ...state.tokens.mine!, image }, expectRev: null }];
    assert.equal(restore(back(withModel("face")), ROWS), "ok");
    const deleted = { ...ROWS };
    delete deleted.sheet;
    assert.equal(restore(back(withModel("face")), deleted), "gone: its image was deleted since");
    assert.equal(restore(back(withModel("face", "art")), ROWS), "gone: its image was deleted since", "a picture row is no sheet");
    assert.equal(restore(back(iconWith()), deleted), "gone: its image was deleted since", "an icon's model too");
    const defaults: RestoreEntry[] = [{ key: "character:c1", value: { ...state.characters.c1!, defaultImage: withModel("face") }, expectRev: null }];
    assert.equal(restore(defaults, deleted), "gone: its image was deleted since");
    assert.equal(restore(defaults, ROWS), "ok");
  });
});
