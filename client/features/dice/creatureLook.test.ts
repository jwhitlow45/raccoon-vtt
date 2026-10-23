import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IconImage, RoomState } from "#shared/model.ts";
import { actor, character, imageRef, room, token } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { kindLineText } from "../tokens/creatureKind.ts";
import { characterLook, creatureLook, DISPOSITION_RING, tokenLook } from "./creatureLook.ts";

/*
 * The creature card's picture, badge and kind line (docs/design-v1-dice-pass.md 5),
 * the same as the token panel's header shows for the token.
 */

const PORTRAIT = imageRef("thorn-portrait");
const WOLF_ICON: IconImage = { icon: "wolf", color: "#808080" };

function table(feetPerCell = 5): RoomState {
  const state = room({
    characters: {
      thorn: character("thorn", { name: "Thorn", level: 5, defaultImage: PORTRAIT }),
      big: character("big", { name: "Grog", size: "large" }),
    },
  });
  state.meta.settings.feetPerCell = feetPerCell;
  state.tokens = {
    tt: token("tt", { kind: "pc", name: "Thorn", disposition: "ally", actor: { ref: "thorn" }, image: imageRef("thorn-token") }),
    wolf: token("wolf", { kind: "monster", name: "Wolf", disposition: "ally", image: WOLF_ICON, companion: { of: "thorn", turn: "own" }, actor: { inline: actor({ cr: "1/4" }) } }),
    dragon: token("dragon", { name: "Adult Black Dragon", size: "huge", actor: { inline: actor({ cr: "14" }) } }),
    crate: token("crate", { kind: "object", name: "Crate", disposition: "neutral" }),
    cart: token("cart", { kind: "object", name: "Cart", size: "custom", w: 2, h: 1, disposition: "neutral" }),
    npc: token("npc", { kind: "npc", name: "Sildar Hallwinter", disposition: "neutral", ownerIds: ["p1"], actor: { inline: actor({ cr: "1" }) } }),
  };
  return state;
}

describe("a token's look, as the token panel's header draws it", () => {
  test("a monster: its image in its disposition's ring, its initials, its CR and size", () => {
    const look = creatureLook({ view: table(), creature: { tokenId: "dragon" }, name: "Adult Black Dragon" });
    assert.ok(look);
    assert.deepEqual(look.picture, { image: undefined, shape: "circle", aspect: 1, ring: theme.color.hostile, initials: "AB" });
    assert.equal(look.badge, null);
    assert.equal(kindLineText(look.line), "Monster, CR 14 · Huge (15 ft)");
    assert.equal(look.line.companionOf, undefined);
  });

  test("a player's character on its token: the token's own image, its level and size", () => {
    const look = creatureLook({ view: table(), creature: { characterId: "thorn" }, tokenId: "tt", name: "Thorn" });
    assert.ok(look);
    assert.deepEqual(look.picture, { image: imageRef("thorn-token"), shape: "circle", aspect: 1, ring: theme.color.ally, initials: "Th" });
    assert.equal(kindLineText(look.line), "Level 5 character · Medium (5 ft)");
  });

  test("a companion wears its character's portrait as a badge and names it in its own part of the line", () => {
    const look = creatureLook({ view: table(), creature: { tokenId: "wolf" }, name: "Wolf" });
    assert.ok(look);
    assert.deepEqual(look.badge, { image: PORTRAIT, initials: "Th" });
    assert.equal(look.picture.image, WOLF_ICON);
    assert.equal(look.picture.initials, "Wo", "the picture's own initials, the badge's are the character's");
    assert.equal(kindLineText(look.line), "Companion of Thorn · Medium (5 ft)");
    assert.equal(look.line.companionOf, "Thorn");
  });

  test("a companion whose character the viewer's copy lacks reads as its token's kind, with no badge", () => {
    const view = table();
    delete view.characters.thorn;
    const look = creatureLook({ view, creature: { tokenId: "wolf" }, name: "Wolf" });
    assert.ok(look);
    assert.equal(look.badge, null);
    assert.equal(kindLineText(look.line), "Monster, CR 1/4 · Medium (5 ft)");
  });

  test("an object is square, a custom footprint keeps its sides, and an NPC lent to a player reads as an NPC", () => {
    const crate = creatureLook({ view: table(), creature: { tokenId: "crate" }, name: "Crate" });
    assert.equal(crate?.picture.shape, "square");
    assert.equal(crate?.picture.ring, theme.color.neutral);
    assert.equal(kindLineText(crate!.line), "Object · Medium (5 ft)");
    const cart = creatureLook({ view: table(), creature: { tokenId: "cart" }, name: "Cart" });
    assert.equal(cart?.picture.aspect, 2);
    assert.equal(kindLineText(cart!.line), "Object · Custom (10 by 5 ft)");
    const npc = creatureLook({ view: table(), creature: { tokenId: "npc" }, name: "Sildar Hallwinter" });
    assert.equal(kindLineText(npc!.line), "NPC, CR 1 · Medium (5 ft)");
    assert.equal(npc?.picture.initials, "SH");
  });

  test("feet follow the room's cell", () => {
    const look = creatureLook({ view: table(10), creature: { tokenId: "dragon" }, name: "Adult Black Dragon" });
    assert.equal(look?.line.size, "Huge (30 ft)");
  });

  test("each disposition's ring, and the neutral ring for one the copy does not know", () => {
    assert.deepEqual(DISPOSITION_RING, { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile });
    const odd = tokenLook({ token: { ...token("x"), disposition: "odd" as "ally" }, name: "X", feetPerCell: 5 });
    assert.equal(odd.picture.ring, theme.color.neutral);
  });
});

describe("a character with no token in view", () => {
  test("its portrait in the party's ring, and its size in cells of the room", () => {
    const look = creatureLook({ view: table(), creature: { characterId: "thorn" }, name: "Thorn" });
    assert.ok(look);
    assert.deepEqual(look.picture, { image: PORTRAIT, shape: "circle", aspect: 1, ring: theme.color.ally, initials: "Th" });
    assert.equal(look.badge, null);
    assert.equal(kindLineText(look.line), "Level 5 character · Medium (5 ft)");
    const big = characterLook(table().characters.big!, 5);
    assert.equal(kindLineText(big.line), "Character · Large (10 ft)");
    assert.equal(big.picture.initials, "Gr");
    assert.equal(characterLook(table().characters.big!, 10).line.size, "Large (20 ft)");
  });

  test("a custom size on a character reads as one cell", () => {
    const look = characterLook(character("c", { name: "Odd", size: "custom" }), 5);
    assert.equal(look.line.size, "Custom (5 ft)");
  });

  test("a pick whose token left the scene falls back to its character", () => {
    const look = creatureLook({ view: table(), creature: { characterId: "thorn" }, tokenId: "gone", name: "Thorn" });
    assert.equal(look?.picture.image, PORTRAIT);
  });

  test("a creature the copy no longer holds has no look", () => {
    assert.equal(creatureLook({ view: table(), creature: { tokenId: "gone" }, name: "Gone" }), null);
    assert.equal(creatureLook({ view: table(), creature: { characterId: "gone" }, name: "Gone" }), null);
  });
});
