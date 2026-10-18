import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS, pcDerived } from "#shared/rules/pcStats.ts";
import { actor, character } from "#shared/testutil.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import { saveUnitsOf } from "../tokens/statSummary.ts";
import { defenseLinesOf, partsText, pcDefenseLines } from "./reading.ts";

/** Where a player character's stat block shows (docs/design-v1-pc-stats.md 7.3 and 7.4). */

const BLOCK: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), defenses: { poison: "immune", fire: "resistant", cold: "resistant", radiant: "vulnerable" } };

describe("the stat block section on a player character's token", () => {
  test("the DM and the character's players read it, block or not, and no one else", () => {
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "pc", actor: {}, character: true }), true);
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "pc", actor: {}, character: true }), true);
    assert.equal(statBlockShown({ dm: false, owner: false, kind: "pc", actor: {}, character: true }), false);
    // A token of its own, kind PC but no character, keeps the old rule.
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "pc", actor: {} }), false);
  });

  test("a player who owns only the token, a character lent to them, gets no section, since the block never reaches them (LP7-PC-3)", () => {
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "pc", actor: {}, character: true, ownsCharacter: false }), false);
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "pc", actor: {}, character: true, ownsCharacter: true }), true);
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "pc", actor: {}, character: true, ownsCharacter: false }), true);
  });
});

describe("the bar's saves and defense lines from a block", () => {
  test("six saves in the block's minus sign", () => {
    assert.deepEqual(saveUnitsOf({ str: 4, dex: -1, con: 3, int: 0, wis: 5, cha: 7 }), ["STR +4", "DEX −1", "CON +3", "INT +0", "WIS +5", "CHA +7"]);
  });

  test("defenses in the 2024 block's words and order, and none in another shape", () => {
    const bree = character("bree", { stats: BLOCK });
    assert.deepEqual(pcDefenseLines(bree), [
      { label: "Vulnerabilities", text: "Radiant" },
      { label: "Resistances", text: "Cold, Fire" },
      { label: "Immunities", text: "Poison" },
    ]);
    assert.deepEqual(pcDefenseLines(character("bear", { stats: BLOCK, actor: actor({ srdId: "brown-bear" }) })), []);
    assert.deepEqual(defenseLinesOf([]), []);
  });

  test("a number's parts as the editor's hint lists them", () => {
    const d = pcDerived({ ...BLOCK, abilities: { ...BLOCK.abilities, wis: 14 }, skills: { perception: "prof" }, spellAbility: "wis", adjust: { passive: 1 } }, 5);
    assert.equal(partsText(d.skills.perception), "WIS +2, proficiency +3");
    assert.equal(partsText(d.passive), "10, Perception +5, other +1");
    assert.equal(partsText(d.spell!.dc), "8, WIS +2, proficiency +3");
  });
});
