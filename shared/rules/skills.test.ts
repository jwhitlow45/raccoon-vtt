import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SKILL_KEYS } from "../model.ts";
import { SKILLS, skillAbility, skillsOf, testShortText, testText, TYPICAL_DCS } from "./skills.ts";

/**
 * The Skills table of SRD 5.2.1, page 9, transcribed by ability as the PDF
 * lists it (the PDF whose SHA-256 scripts/srd-import.ts pins). Constitution
 * has no skill.
 */
const PAGE_9: Record<string, string[]> = {
  Strength: ["Athletics"],
  Dexterity: ["Acrobatics", "Sleight of Hand", "Stealth"],
  Intelligence: ["Arcana", "History", "Investigation", "Nature", "Religion"],
  Wisdom: ["Animal Handling", "Insight", "Medicine", "Perception", "Survival"],
  Charisma: ["Deception", "Intimidation", "Performance", "Persuasion"],
};

describe("skills (docs/design-v1-dm-tools.md 3.3)", () => {
  test("each of the 18 skills fills in its ability from the table on page 9", () => {
    const abilityNames = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" } as const;
    const listed = Object.values(PAGE_9).flat();
    assert.equal(SKILL_KEYS.length, 18);
    assert.equal(listed.length, 18);
    for (const key of SKILL_KEYS) {
      const { name } = SKILLS[key];
      const ability = abilityNames[skillAbility(key)];
      assert.ok(PAGE_9[ability]?.includes(name), `${name} is a ${ability} skill`);
    }
    assert.deepEqual(skillsOf("con"), []);
    assert.deepEqual(skillsOf("dex"), ["acrobatics", "sleight-of-hand", "stealth"]);
  });

  test("a test reads as the SRD writes it", () => {
    assert.equal(testText({ kind: "save", choices: [{ ability: "dex" }] }), "a Dexterity saving throw");
    assert.equal(testText({ kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] }), "a Strength or Dexterity saving throw");
    assert.equal(testText({ kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] }), "a Strength (Athletics) or Dexterity (Acrobatics) check");
    assert.equal(testText({ kind: "check", choices: [{ ability: "int", skill: "arcana" }] }), "an Intelligence (Arcana) check");
    assert.equal(testShortText({ kind: "save", choices: [{ ability: "dex" }] }), "DEX save");
  });

  test("the typical DCs are page 6's six", () => {
    assert.deepEqual(TYPICAL_DCS.map((d) => d.dc), [5, 10, 15, 20, 25, 30]);
    assert.deepEqual(TYPICAL_DCS.map((d) => d.name), ["Very easy", "Easy", "Medium", "Hard", "Very hard", "Nearly impossible"]);
  });
});
