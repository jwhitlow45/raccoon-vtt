import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "../model.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { actor, character, token } from "../testutil.ts";
import { bonusFor, creatureBonus, creatureNumbers, pcRollNumbers, type RollSources } from "./bonus.ts";

/** A character's numbers from its stat block through doc 1's bonus (docs/design-v1-pc-stats.md 5). */
const BLOCK: PcStats = {
  ...structuredClone(EMPTY_PC_STATS as PcStats),
  abilities: { str: 8, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
  saves: ["dex", "int"],
  skills: { stealth: "expert", perception: "prof" },
  spellAbility: "wis",
  adjust: { allSaves: 1 },
};

describe("pcRollNumbers", () => {
  test("null without a block", () => {
    assert.equal(pcRollNumbers(character("c")), null);
  });

  test("every skill with its whole bonus, saves, spell numbers and the death save's bonus from every save's", () => {
    const n = pcRollNumbers(character("bree", { level: 5, stats: BLOCK }))!;
    assert.deepEqual(n.abilities.dex, { mod: 3, save: 3 + 3 + 1 });
    assert.deepEqual(n.abilities.str, { mod: -1, save: 0 });
    assert.equal(n.skills.stealth, 3 + 6);
    assert.equal(n.skills.perception, 2 + 3);
    assert.equal(n.skills.athletics, -1, "an untrained skill is listed with its modifier");
    assert.equal(Object.keys(n.skills).length, 18);
    assert.equal(n.spellDc, 8 + 2 + 3);
    assert.equal(n.spellAttack, 2 + 3);
    assert.equal(n.deathSave, 1);
  });

  test("a check differs from the modifier only with the checks bonus, and there are no spell numbers without a spellcasting ability", () => {
    const plain = pcRollNumbers(character("bree", { level: 5, stats: { ...BLOCK, spellAbility: undefined, adjust: {} } }))!;
    assert.equal(plain.abilities.dex.check, undefined);
    assert.equal(plain.spellDc, undefined);
    assert.equal(plain.spellAttack, undefined);
    assert.equal(plain.deathSave, undefined);
    const checks = pcRollNumbers(character("bree", { level: 5, stats: { ...BLOCK, adjust: { allChecks: 2 } } }))!;
    assert.equal(checks.abilities.dex.check, 5);
    assert.equal(checks.skills.stealth, 3 + 6 + 2);
  });

  test("through bonusFor: saves, a death save, a skill with its own ability and with another", () => {
    const n = pcRollNumbers(character("bree", { level: 5, stats: BLOCK }))!;
    assert.equal(bonusFor(n, { kind: "save", ability: "dex" }), 7);
    assert.equal(bonusFor(n, { kind: "save", ability: "con", cause: "concentration" }), 2);
    assert.equal(bonusFor(n, { kind: "deathSave" }), 1, "a cloak's bonus to every save reaches a death save");
    assert.equal(bonusFor(n, { kind: "check", ability: "dex", skill: "stealth" }), 9);
    assert.equal(bonusFor(n, { kind: "check", ability: "int", skill: "stealth" }), 0 + 9 - 3, "Intelligence (Stealth) keeps the expertise");
    assert.equal(bonusFor(n, { kind: "check", ability: "wis" }), 2);
  });

  test("creatureNumbers and creatureBonus read a character's block directly and through its token", () => {
    const bree = character("bree", { level: 5, stats: BLOCK, actor: actor({ initBonus: 3 }) });
    const s: RollSources = { tokens: { t: token("t", { kind: "pc", actor: { ref: "bree" } }) }, characters: { bree }, companionBlocks: {} };
    assert.equal(creatureBonus(s, { characterId: "bree" }, { kind: "save", ability: "dex" }), 7);
    assert.equal(creatureBonus(s, { tokenId: "t" }, { kind: "check", ability: "dex", skill: "stealth" }), 9);
    assert.equal(creatureBonus(s, { tokenId: "t" }, { kind: "initiative" }), 3, "initiative is the actor's, which the reducer derives");
    assert.deepEqual(creatureNumbers(s, { tokenId: "t" }), pcRollNumbers(bree));
  });
});
