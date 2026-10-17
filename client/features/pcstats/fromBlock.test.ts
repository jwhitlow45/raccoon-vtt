import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StatBlock } from "#shared/model.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { statBlockFromSrd } from "#shared/statBlock.ts";
import { blockOf, customMonster } from "#shared/testutil.ts";
import { parseStatBlockText } from "../monsters/parse.ts";
import { pdfText, text2014, webText } from "../monsters/testing.ts";
import { statsFromBlock } from "./fromBlock.ts";

/** Pasted text read into a character's stat block (docs/design-v1-pc-stats.md 6.2). */

function ids(): () => string {
  let n = 0;
  return () => `r${++n}`;
}

/** An invented knight at level 5 (proficiency +3): Str 16, Dex 14, Con 14, Wis 14, proficient Str and Con saves, Stealth with expertise. */
const KNIGHT: StatBlock = blockOf(
  customMonster("knight", {
    name: "Ser Tamsin",
    size: "medium",
    type: "Humanoid",
    alignment: "Lawful Good",
    ac: 18,
    initiative: 2,
    hp: { average: 44, formula: "" },
    speed: "30 ft.",
    abilities: {
      str: { score: 16, save: 6 },
      dex: { score: 14, save: 2 },
      con: { score: 14, save: 5 },
      int: { score: 10, save: 0 },
      wis: { score: 14, save: 2 },
      cha: { score: 8, save: -1 },
    },
    skills: "Stealth +8, Perception +5",
    resistances: "Fire",
    senses: "Darkvision 60 ft.",
    passivePerception: 15,
    traits: [
      { name: "Evasion", text: "When it is subjected to an effect that allows it to make a Dexterity saving throw to take only half damage, it instead takes no damage on a success." },
      { name: "Spellcasting", text: "The knight casts one of the following spells, using Wisdom as the spellcasting ability (spell save DC 13, +5 to hit with spell attacks)." },
    ],
    actions: [
      { name: "Longsword", text: "Melee Attack Roll: +6, reach 5 ft. Hit: 7 (1d8 + 3) Slashing damage, plus 3 (1d6) Radiant damage if it is Bloodied." },
      { name: "Longbow", text: "Ranged Attack Roll: +5, range 150/600 ft. Hit: 6 (1d8 + 2) Piercing damage." },
      { name: "Fire Breath (Recharge 5–6)", text: "Dexterity Saving Throw: DC 13, each creature in a 15-foot Cone. Failure: 10 (3d6) Fire damage. Success: Half damage." },
      { name: "Mighty Swing", text: "Melee Attack Roll: +9, reach 5 ft. Hit: 12 (2d8 + 3) Slashing damage." },
    ],
  }),
);

describe("statsFromBlock", () => {
  test("Appendix C: proficient saves and expertise by the nearest derivation, the rest as adjustments", () => {
    const fill = statsFromBlock(KNIGHT, 5, ids());
    assert.deepEqual(fill.stats.abilities, { str: 16, dex: 14, con: 14, int: 10, wis: 14, cha: 8 });
    assert.deepEqual(fill.stats.saves, ["str", "con"], "Str 3 + 3 = 6, Con 2 + 3 = 5");
    assert.deepEqual(fill.stats.skills, { stealth: "expert", perception: "prof" }, "Stealth 2 + 6 = 8, Perception 2 + 3 = 5");
    assert.deepEqual(fill.stats.adjust, {}, "nothing left over, initiative and Passive Perception included");
    assert.equal(fill.stats.spellAbility, "wis");
    assert.equal(fill.stats.evasion, true);
    assert.deepEqual(fill.stats.defenses, { fire: "resistant" });
    assert.deepEqual(fill.actor, { ac: 18, hpMax: 44, speeds: { walk: 30 }, senses: "Darkvision 60 ft." });
    assert.equal(fill.name, "Ser Tamsin");
    assert.equal(fill.source, "paste");
  });

  test("attacks take the ability that matches, Dex first for a ranged one, else Str with the difference, and the modifier comes off the damage", () => {
    const { rolls } = statsFromBlock(KNIGHT, 5, ids()).stats;
    const [sword, bow, breath, swing] = rolls;
    assert.deepEqual(sword, {
      id: "r1",
      name: "Longsword",
      kind: "weapon",
      ability: "str",
      attack: { prof: true, bonus: 0 },
      dice: [
        { formula: "1d8", mod: true, type: "slashing" },
        { formula: "1d6", type: "radiant", optional: true, name: "if it is Bloodied" },
      ],
    });
    assert.equal(bow?.ability, "dex");
    assert.deepEqual(bow?.dice, [{ formula: "1d8", mod: true, type: "piercing" }]);
    // DC 13 is 8 + 2 + 3 for Dex and Con alike: the first in the abilities' order gives it.
    assert.deepEqual(breath, { id: "r3", name: "Fire Breath", kind: "other", ability: "dex", save: { ability: "dex", onPass: "half" }, dice: [{ formula: "3d6", type: "fire" }] });
    assert.deepEqual(swing?.attack, { prof: true, bonus: 3 }, "no ability gives +9, so Str with +3 more");
    assert.deepEqual(swing?.dice, [{ formula: "2d8", mod: true, type: "slashing" }]);
  });

  test("a save DC no ability gives stays fixed, and an unset level reads at +2", () => {
    const odd = blockOf(customMonster("odd", { actions: [{ name: "Gaze", text: "Wisdom Saving Throw: DC 17, one creature it can see. Failure: 9 (2d8) Psychic damage." }] }));
    const [gaze] = statsFromBlock(odd, 5, ids()).stats.rolls;
    assert.deepEqual(gaze?.save, { ability: "wis", dc: 17, onPass: "none" }, "the text reads no half, so none is read, not unknown");
    assert.equal(gaze?.ability, undefined);
    // At +2, Str 16's printed +6 is nearer 3 + 2 than 3, with 1 left over.
    const unset = statsFromBlock(KNIGHT, undefined, ids());
    assert.ok(unset.stats.saves?.includes("str"));
    assert.equal(unset.stats.adjust?.saves?.str, 1);
  });

  test("a tie between two derivations goes to the lower", () => {
    // Dex 10 at proficiency +4: a printed +2 is as near +0 as +4, so not proficient, with +2 kept.
    const tie = blockOf(customMonster("tie", { abilities: { ...KNIGHT.abilities, dex: { score: 10, save: 2 } }, skills: "Acrobatics +6" }));
    const fill = statsFromBlock(tie, 9, ids());
    assert.equal(fill.stats.saves?.includes("dex"), false);
    assert.equal(fill.stats.adjust?.saves?.dex, 2);
    assert.equal(fill.stats.skills?.acrobatics, "prof", "+6 is between +4 and +8: a tie to the lower");
    assert.equal(fill.stats.adjust?.skills?.acrobatics, 2);
  });

  test("a qualified defense is named, not taken", () => {
    const old = blockOf(customMonster("old", { resistances: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks; Cold" }));
    const fill = statsFromBlock(old, 5, ids());
    assert.deepEqual(fill.stats.defenses, { cold: "resistant" });
    assert.equal(fill.warnings.filter((w) => /from nonmagical attacks was left out/i.test(w)).length, 3);
  });

  test("the same block pasted as a web page, a PDF and 2014 text reads the same numbers", () => {
    const read = (text: string) => statsFromBlock(parseStatBlockText(text).block, 5, ids()).stats;
    const web = read(webText(KNIGHT));
    assert.deepEqual(web.saves, ["str", "con"]);
    assert.deepEqual(web.skills, { stealth: "expert", perception: "prof" });
    assert.equal(web.rolls.length, 4);
    const pdf = read(pdfText(KNIGHT));
    assert.deepEqual(pdf.saves, web.saves);
    assert.deepEqual(pdf.rolls.map((r) => r.name), web.rolls.map((r) => r.name));
    const old = read(text2014(KNIGHT));
    assert.deepEqual(old.saves, web.saves);
    assert.deepEqual(old.skills, web.skills);
    assert.equal(old.spellAbility, "wis");
  });

  test("a 2014 attack, \"Melee Weapon Attack: +5 to hit\", reads as an attack", () => {
    const old = blockOf(customMonster("old", { actions: [{ name: "Scimitar", text: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage." }] }));
    const [scimitar] = statsFromBlock(old, 1, ids()).stats.rolls;
    // Dex 14 at +2 gives +4, and Str 15 gives +4 too: a melee attack takes Str first.
    assert.equal(scimitar?.ability, "str");
    assert.deepEqual(scimitar?.dice, [{ formula: "1d6", mod: true, type: "slashing" }]);
  });

  test("every SRD block reads without throwing, every roll within the block's bounds", async () => {
    const monsters = await loadMonsters();
    for (const m of monsters) {
      const fill = statsFromBlock(statBlockFromSrd(m), 5, ids());
      for (const roll of fill.stats.rolls) {
        assert.ok(roll.name.length >= 1 && roll.name.length <= 60, `${m.name}: ${roll.name}`);
        assert.ok(roll.dice.length <= 4);
        assert.ok(roll.attack !== undefined || roll.save !== undefined || roll.dice.length > 0);
        for (const part of roll.dice) assert.ok(part.name === undefined || part.name.length <= 30);
      }
    }
  });
});
