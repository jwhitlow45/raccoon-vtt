import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RollRequest } from "../model.ts";
import { actor, character, companionBlock, customMonster, room, token } from "../testutil.ts";
import { abilityOf, blockRollNumbers, bonusFor, creatureBonus, creatureNumbers, isCheck, isSave, testOf, type RollNumbers, type RollSources } from "./bonus.ts";

/** A creature's numbers and the d20 rolls they feed (docs/design-v1-dice.md 6.1). */
const NUMBERS: RollNumbers = {
  abilities: {
    str: { mod: 2, save: 5 },
    dex: { mod: 3, save: 3, check: 4 },
    con: { mod: 1, save: 1 },
    int: { mod: -1, save: -1 },
    wis: { mod: 0, save: 2 },
    cha: { mod: 1, save: 1 },
  },
  skills: { stealth: 7, athletics: 6 },
  deathSave: 1,
};

describe("bonusFor (docs/design-v1-dice.md 6.1)", () => {
  test("each kind of test reads its own number", () => {
    assert.equal(bonusFor(NUMBERS, { kind: "save", ability: "str" }), 5);
    assert.equal(bonusFor(NUMBERS, { kind: "save", ability: "con", cause: "concentration" }), 1, "a concentration save is a Constitution save");
    assert.equal(bonusFor(NUMBERS, { kind: "save", ability: "dex", cause: "saveEnds", spell: true }), 3);
    assert.equal(bonusFor(NUMBERS, { kind: "deathSave" }), 1);
    assert.equal(bonusFor({ ...NUMBERS, deathSave: undefined }, { kind: "deathSave" }), 0, "no death save bonus is 0");
    assert.equal(bonusFor(NUMBERS, { kind: "check", ability: "str" }), 2, "a check reads the modifier");
    assert.equal(bonusFor(NUMBERS, { kind: "check", ability: "dex" }), 4, "or a check bonus where it differs");
    assert.equal(bonusFor(NUMBERS, { kind: "initiative" }), null);
    assert.equal(bonusFor(NUMBERS, { kind: "attack" }), null);
  });

  test("a skill reads its whole bonus, carries what it adds to another ability, and an unlisted one reads as a check", () => {
    assert.equal(bonusFor(NUMBERS, { kind: "check", ability: "dex", skill: "stealth" }), 7);
    assert.equal(bonusFor(NUMBERS, { kind: "check", ability: "str", skill: "stealth" }), 2 + 7 - 3, "Strength (Stealth)");
    assert.equal(bonusFor(NUMBERS, { kind: "check", ability: "dex", skill: "acrobatics" }), 4);
  });

  test("saves and checks are told apart, and each test names its ability", () => {
    assert.equal(isSave({ kind: "deathSave" }), true);
    assert.equal(isSave({ kind: "save", ability: "wis" }), true);
    assert.equal(isSave({ kind: "check", ability: "wis" }), false);
    assert.equal(isCheck({ kind: "initiative" }), true);
    assert.equal(isCheck({ kind: "attack" }), false);
    assert.equal(abilityOf({ kind: "initiative" }), "dex");
    assert.equal(abilityOf({ kind: "save", ability: "wis" }), "wis");
    assert.equal(abilityOf({ kind: "deathSave" }), undefined);
    assert.equal(abilityOf({ kind: "attack", range: "melee" }), undefined);
  });
});

describe("a stat block's numbers", () => {
  test("modifiers from scores, saves as printed, skills by name in any case, and the Spellcasting entry's DC and attack", () => {
    const monster = customMonster("m", {
      skills: "perception +5, Sleight of Hand +4, Stealth −1, Juggling +9",
      traits: [{ name: "Spellcasting", text: "The lurker casts spells, using Wisdom as the spellcasting ability (spell save DC 13, +5 to hit with spell attacks)." }],
    });
    const numbers = blockRollNumbers(monster);
    assert.deepEqual(numbers.abilities.str, { mod: 2, save: 2 });
    assert.deepEqual(numbers.abilities.int, { mod: -4, save: -4 });
    assert.deepEqual(numbers.skills, { perception: 5, "sleight-of-hand": 4, stealth: -1 });
    assert.equal(numbers.spellDc, 13);
    assert.equal(numbers.spellAttack, 5);
    assert.equal(blockRollNumbers(customMonster("plain")).spellDc, undefined);
  });
});

describe("a creature's numbers and bonus", () => {
  function sources(): RollSources {
    const state = room({
      characters: { bree: character("bree", { actor: actor({ initBonus: 3 }) }), owl: character("owl", { actor: actor({ srdId: "owl" }) }) },
      companionBlocks: { b1: companionBlock("b1", "bree") },
      monsters: { m1: customMonster("m1") },
      tokens: {
        moth: token("moth", { actor: { inline: actor({ blockId: "b1" }) } }),
        lurker: token("lurker", { actor: { inline: actor({ monsterId: "m1", initBonus: 5 }) } }),
        goblin: token("goblin", { actor: { inline: actor({ srdId: "goblin" }) } }),
        plain: token("plain"),
        breeToken: token("breeToken", { kind: "pc", actor: { ref: "bree" } }),
      },
    });
    return { ...state, srd: { goblin: NUMBERS, owl: { ...NUMBERS, skills: { perception: 3 } } } };
  }

  test("a token's own actor follows the block it links, a companion's, a room monster or an SRD creature", () => {
    const s = sources();
    assert.equal(creatureNumbers(s, { tokenId: "moth" })?.abilities.dex.save, 2);
    assert.equal(creatureBonus(s, { tokenId: "lurker" }, { kind: "check", ability: "dex", skill: "stealth" }), 6);
    assert.equal(creatureBonus(s, { tokenId: "goblin" }, { kind: "save", ability: "str" }), 5);
    assert.equal(creatureNumbers({ ...s, srd: null }, { tokenId: "goblin" }), null, "an SRD creature without the table");
    assert.equal(creatureNumbers({ ...s, monsters: undefined }, { tokenId: "lurker" }), null, "a player's view lacks the room's monsters");
    assert.equal(creatureNumbers(s, { tokenId: "plain" }), null);
    assert.equal(creatureNumbers(s, { tokenId: "missing" }), null);
  });

  test("a character in another shape takes its creature's numbers, and has none without a shape until doc 2's stat blocks", () => {
    const s = sources();
    assert.equal(creatureBonus(s, { characterId: "owl" }, { kind: "check", ability: "wis", skill: "perception" }), 3);
    assert.equal(creatureNumbers(s, { characterId: "bree" }), null);
    assert.equal(creatureNumbers(s, { tokenId: "breeToken" }), null);
  });

  test("initiative is the actor's own bonus, through a token of a character too, and an attack has none here", () => {
    const s = sources();
    assert.equal(creatureBonus(s, { tokenId: "lurker" }, { kind: "initiative" }), 5);
    assert.equal(creatureBonus(s, { tokenId: "breeToken" }, { kind: "initiative" }), 3);
    assert.equal(creatureBonus(s, { characterId: "bree" }, { kind: "initiative" }), 3);
    assert.equal(creatureBonus(s, { tokenId: "lurker" }, { kind: "attack" }), null);
  });
});

describe("testOf", () => {
  const save: Pick<RollRequest, "test"> = { test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] } };
  test("a request's choice as a test, with its spell and its save-ends cause", () => {
    assert.deepEqual(testOf(save, 0), { kind: "save", ability: "dex" });
    assert.deepEqual(testOf(save, 1), { kind: "save", ability: "str" });
    assert.deepEqual(testOf({ ...save, spell: true, cause: "saveEnds" }, 0), { kind: "save", ability: "dex", cause: "saveEnds", spell: true });
    assert.deepEqual(testOf({ test: { kind: "check", choices: [{ ability: "dex", skill: "stealth" }] } }), { kind: "check", ability: "dex", skill: "stealth" });
    assert.deepEqual(testOf({ test: { kind: "check", choices: [{ ability: "wis" }] } }, 1), { kind: "check", ability: "wis" }, "a choice the test lacks reads as its first");
  });
});
