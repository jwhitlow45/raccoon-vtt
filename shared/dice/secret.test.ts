import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, room, token } from "../testutil.ts";
import { startsSecret } from "./secret.ts";

/** docs/design-v1-dice.md 17: only a DM's roll for a monster starts hidden from players. */
describe("which rolls start secret", () => {
  const state = room({
    characters: { thorn: character("thorn", { ownerIds: ["p1"] }), npc: character("npc", { ownerIds: ["dm1"] }), guard: character("guard", { ownerIds: ["dm1"] }) },
    tokens: {
      goblin: token("goblin"),
      thornToken: token("thornToken", { kind: "pc", actor: { ref: "thorn" } }),
      wolf: token("wolf", { ownerIds: ["p1"] }),
      lent: token("lent", { kind: "npc", actor: { ref: "npc" }, ownerIds: ["p2"] }),
      dmOwned: token("dmOwned", { ownerIds: ["dm1"] }),
    },
  });

  test("a DM's free formula starts in the open", () => {
    assert.equal(startsSecret(state, true, []), false);
  });

  test("a DM's roll for a monster starts hidden, a DM's own token included", () => {
    assert.equal(startsSecret(state, true, [{ tokenId: "goblin" }]), true);
    assert.equal(startsSecret(state, true, [{ tokenId: "dmOwned" }]), true);
    assert.equal(startsSecret(state, true, [{ characterId: "guard" }]), true, "a character no player plays is a monster here");
  });

  test("a DM's roll for a creature a player plays starts in the open", () => {
    assert.equal(startsSecret(state, true, [{ characterId: "thorn" }]), false);
    assert.equal(startsSecret(state, true, [{ tokenId: "thornToken" }]), false);
    assert.equal(startsSecret(state, true, [{ tokenId: "wolf" }]), false, "a companion its player owns");
    assert.equal(startsSecret(state, true, [{ tokenId: "lent" }]), false, "the DM's NPC lent to a player");
    assert.equal(startsSecret(state, true, [{ characterId: "npc" }]), false, "and that NPC itself, which its player's token plays");
  });

  test("several creatures start hidden when any is a monster, and a creature that is gone counts as one", () => {
    assert.equal(startsSecret(state, true, [{ characterId: "thorn" }, { tokenId: "goblin" }]), true);
    assert.equal(startsSecret(state, true, [{ characterId: "thorn" }, { tokenId: "wolf" }]), false);
    assert.equal(startsSecret(state, true, [{ tokenId: "gone" }]), true);
  });

  test("a player's roll always starts in the open", () => {
    assert.equal(startsSecret(state, false, [{ tokenId: "goblin" }]), false);
    assert.equal(startsSecret(state, false, []), false);
  });
});
