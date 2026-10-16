import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor, character, room, token } from "#shared/testutil.ts";
import { panelsFor } from "../panels.ts";
import { hpLine, lifeWord, partyEntries, PARTY_CHIPS } from "./party.ts";

function setup() {
  const state = room({
    characters: {
      ayla: character("ayla", {
        name: "Ayla",
        ownerIds: ["p1"],
        actor: actor({
          hp: { cur: 18, max: 24, temp: 5 },
          ac: 16,
          passivePerception: 14,
          effects: [
            { id: "e1", key: "blinded" },
            { id: "e2", key: "prone" },
            { id: "e3", key: "poisoned" },
            { id: "e4", key: "hasted" },
            { id: "e5", key: "blessed" },
          ],
        }),
      }),
      bram: character("bram", { name: "Bram", ownerIds: ["p2"], actor: actor({ hp: { cur: 0, max: 21, temp: 0 }, life: "dying" }) }),
      npc: character("npc", { name: "Captain", ownerIds: ["dm1"] }),
      nobody: character("nobody", { name: "Spare", ownerIds: [] }),
    },
    tokens: {
      a1: token("a1", { kind: "pc", sceneId: "s1", actor: { ref: "ayla" } }),
      b1: token("b1", { kind: "pc", sceneId: "s2", actor: { ref: "bram" } }),
    },
  });
  state.members.p1!.name = "Pat";
  state.members.p2!.name = "Alex";
  return state;
}

describe("the party bar", () => {
  test("its party is every character a player owns, in roster order, the DM's NPC and the unowned left out", () => {
    assert.deepEqual(partyEntries(setup(), "s1").map((e) => e.character.name), ["Bram", "Ayla"]);
  });

  test("an entry's numbers and states", () => {
    const [bram, ayla] = partyEntries(setup(), "s1");
    assert.ok(ayla && bram);
    assert.equal(hpLine(ayla.hp), "18/24 +5");
    assert.equal(ayla.label, "Healthy");
    assert.equal(ayla.fraction, 0.75);
    assert.deepEqual([ayla.ac, ayla.passivePerception], [16, 14]);
    assert.equal(ayla.chips.length, PARTY_CHIPS);
    assert.equal(ayla.more, 2);
    assert.equal(lifeWord(bram.life), "Dying", "Dying takes the bar's place");
    assert.equal(lifeWord(ayla.life), null);
  });

  test("an entry's shield shows its AC, and none for the dead, for a character with no HP to show or for an AC of 0", () => {
    const state = setup();
    const shield = (over: Parameters<typeof actor>[0]) => {
      state.characters.ayla = { ...state.characters.ayla!, actor: actor({ ac: 16, hp: { cur: 18, max: 24, temp: 0 }, ...over }) };
      return partyEntries(state, "s1").find((e) => e.character.id === "ayla")!.shield;
    };
    assert.equal(shield({}), 16);
    assert.equal(shield({ life: "dead", hp: { cur: 0, max: 24, temp: 0 } }), null, "dead");
    // Drawn alive (shownLife), yet with no HP to show it has no AC to answer either.
    assert.equal(shield({ life: "dead", hp: { cur: 0, max: 0, temp: 0 } }), null, "max HP 0, stored dead");
    assert.equal(shield({ hp: { cur: 0, max: 0, temp: 0 } }), null, "max HP 0, alive");
    assert.equal(shield({ ac: 0 }), null, "AC 0");
  });

  test("a tap frames the token on the scene in view, and one with no token there has none to frame", () => {
    const state = setup();
    const onS1 = partyEntries(state, "s1");
    assert.deepEqual(onS1.map((e) => e.tokenId), [null, "a1"]);
    assert.deepEqual(partyEntries(state, "s2").map((e) => e.tokenId), ["b1", null]);
  });

  test("on a phone it is a DM's panel, and from 900 px up it leaves the tabs for the top of the side panel", () => {
    assert.ok(panelsFor("dm").some((p) => p.id === "party"));
    assert.ok(!panelsFor("dm", true).some((p) => p.id === "party"));
    assert.ok(!panelsFor("player").some((p) => p.id === "party"), "players do not receive other characters' AC and Passive Perception");
  });
});
