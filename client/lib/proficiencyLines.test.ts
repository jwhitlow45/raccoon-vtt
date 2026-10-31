import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { proficiencyFor } from "#shared/rules/proficiency.ts";
import { proficiencyLines, withProficiencyLines } from "./proficiencyLines.ts";

describe("the Proficiencies and Expertise lines (D-261030-539)", () => {
  test("saves come first as 'Dexterity saves', then skills, with expertise on its own line", () => {
    const lines = proficiencyLines({
      saves: [
        { ability: "str", level: "none" },
        { ability: "dex", level: "prof" },
        { ability: "con", level: "prof" },
      ],
      skills: [
        { skill: "perception", level: "expert" },
        { skill: "stealth", level: "prof" },
        { skill: "acrobatics", level: "none" },
        { skill: "history", level: "expert" },
      ],
    });
    assert.deepEqual(lines, [
      { label: "Proficiencies", names: ["Dexterity saves", "Constitution saves", "Stealth"] },
      { label: "Expertise", names: ["Perception", "History"] },
    ]);
  });

  test("an empty line is left out, and none at all gives no lines", () => {
    assert.deepEqual(proficiencyLines({ saves: [{ ability: "dex", level: "prof" }], skills: [] }), [{ label: "Proficiencies", names: ["Dexterity saves"] }]);
    assert.deepEqual(proficiencyLines({ saves: [], skills: [{ skill: "arcana", level: "expert" }] }), [{ label: "Expertise", names: ["Arcana"] }]);
    assert.deepEqual(proficiencyLines({ saves: [{ ability: "dex", level: "none" }], skills: [{ skill: "arcana", level: "none" }] }), []);
  });

  test("a skill with expertise is not repeated under Proficiencies", () => {
    const [prof, expert] = proficiencyLines({ saves: [], skills: [{ skill: "arcana", level: "expert" }, { skill: "history", level: "prof" }] });
    assert.deepEqual(prof?.names, ["History"]);
    assert.deepEqual(expert?.names, ["Arcana"]);
  });

  test("a Wild Shape keeps the druid's flags beside the beast's, so either side can list a test", () => {
    const stats = { abilities: { str: 8, dex: 14, con: 12, int: 10, wis: 16, cha: 10 }, saves: ["wis"], skills: { perception: "expert" }, adjust: {}, defenses: {}, rolls: [] } as never;
    const numbers = {
      abilities: { str: { mod: 2, save: 2 }, dex: { mod: 2, save: 2 }, con: { mod: 1, save: 1 }, int: { mod: -4, save: -4 }, wis: { mod: 1, save: 1 }, cha: { mod: -2, save: -2 } },
      skills: { stealth: 4 },
    };
    const source = { stats, monster: { numbers, cr: "1/4" }, wildShape: true };
    const lines = proficiencyLines({
      saves: (["wis", "dex"] as const).map((ability) => ({ ability, level: proficiencyFor({ kind: "save", ability }, source) })),
      skills: (["perception", "stealth"] as const).map((skill) => ({ skill, level: proficiencyFor({ kind: "check", ability: skill === "stealth" ? "dex" : "wis", skill }, source) })),
    });
    assert.deepEqual(lines, [
      { label: "Proficiencies", names: ["Wisdom saves", "Stealth"] },
      { label: "Expertise", names: ["Perception"] },
    ]);
  });
});

describe("where the lines go in a block's Markdown", () => {
  const lines = [{ label: "Proficiencies" as const, names: ["Dexterity saves"] }, { label: "Expertise" as const, names: ["Perception"] }];

  test("after the Skills line", () => {
    const out = withProficiencyLines("| Wis | 12 | +1 | +6 |\n\n**Skills** Perception +11\n\n**Immunities** Cold", lines);
    assert.equal(out, "| Wis | 12 | +1 | +6 |\n\n**Skills** Perception +11\n\n**Proficiencies** Dexterity saves\n\n**Expertise** Perception\n\n**Immunities** Cold");
  });

  test("a block with no Skills line takes them where one would stand, before the lines that follow it", () => {
    const out = withProficiencyLines("| Wis | 12 | +1 | +6 |\n\n**Resistances** Fire\n\n**Senses** Darkvision 60 ft.", lines);
    assert.equal(out, "| Wis | 12 | +1 | +6 |\n\n**Proficiencies** Dexterity saves\n\n**Expertise** Perception\n\n**Resistances** Fire\n\n**Senses** Darkvision 60 ft.");
  });

  test("a block with neither takes them under its table, and no lines changes nothing", () => {
    const text = "| Wis | 12 | +1 | +6 |\n\n### Traits";
    assert.equal(withProficiencyLines(text, lines), "| Wis | 12 | +1 | +6 |\n\n**Proficiencies** Dexterity saves\n\n**Expertise** Perception\n\n### Traits");
    assert.equal(withProficiencyLines(text, []), text);
  });

  test("a legacy block with no Skills line takes them after Saving Throws, and its Damage and Condition lines count as the lines that follow", () => {
    const legacy = "| STR |\n| 10 (+0) |\n\n**Saving Throws** Dex +5\n\n**Damage Immunities** Fire\n\n**Senses** Darkvision";
    assert.equal(withProficiencyLines(legacy, lines), "| STR |\n| 10 (+0) |\n\n**Saving Throws** Dex +5\n\n**Proficiencies** Dexterity saves\n\n**Expertise** Perception\n\n**Damage Immunities** Fire\n\n**Senses** Darkvision");
    const noSaves = "| STR |\n\n**Condition Immunities** Charmed\n\n**Senses** Darkvision";
    assert.equal(withProficiencyLines(noSaves, lines), "| STR |\n\n**Proficiencies** Dexterity saves\n\n**Expertise** Perception\n\n**Condition Immunities** Charmed\n\n**Senses** Darkvision");
  });
});
