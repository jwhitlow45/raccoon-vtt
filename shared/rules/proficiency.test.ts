import assert from "node:assert/strict";
import { test } from "node:test";
import { listedProficiency, numbersFromStatBlock, proficiencyFor } from "./proficiency.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";
import type { PcStats } from "../model.ts";

const emptyPcStats = (): PcStats => structuredClone(EMPTY_PC_STATS);

test("fl7: listed bonuses distinguish neither, proficiency and the exact expertise threshold", () => {
  assert.equal(listedProficiency(undefined, 2, 3, true), "none");
  assert.equal(listedProficiency(2, 2, 3, true), "none");
  assert.equal(listedProficiency(2, 2, 3, false), "none");
  assert.equal(listedProficiency(5, 2, 3, true), "prof");
  assert.equal(listedProficiency(7, 2, 3, true), "prof");
  assert.equal(listedProficiency(8, 2, 3, true), "expert");
  assert.equal(listedProficiency(9, 2, 3, true), "expert");
  assert.equal(listedProficiency(8, 2, 3, false), "prof");
});

test("fl7: PC flags survive adjustments, Jack of All Trades is neither", () => {
  const stats = emptyPcStats();
  stats.saves = ["dex"];
  stats.skills = { stealth: "expert", perception: "prof" };
  stats.adjust = { allSaves: 5, skills: { athletics: 10 } };
  stats.jack = true;
  assert.equal(proficiencyFor({ kind: "save", ability: "dex" }, { stats }), "prof");
  assert.equal(proficiencyFor({ kind: "save", ability: "str" }, { stats }), "none");
  assert.equal(proficiencyFor({ kind: "check", ability: "str", skill: "stealth" }, { stats }), "expert");
  assert.equal(proficiencyFor({ kind: "check", ability: "wis", skill: "perception" }, { stats }), "prof");
  assert.equal(proficiencyFor({ kind: "check", ability: "str", skill: "athletics" }, { stats }), "none");
  assert.equal(proficiencyFor({ kind: "check", ability: "int", skill: "arcana" }, { stats }), "none");
  assert.equal(proficiencyFor({ kind: "deathSave" }, { stats }), "none");
  assert.equal(proficiencyFor({ kind: "save", ability: "dex" }, {}), "none");
});

const legacy = `## Scout
| STR | DEX | CON | INT | WIS | CHA |
| --- | --- | --- | --- | --- | --- |
| 11 (+0) | 14 (+2) | 12 (+1) | 11 (+0) | 13 (+1) | 11 (+0) |
**Saving Throws** Dex +4, Wis +1
**Skills** Nature +4, Perception +5, Stealth +4, Survival +1`;

test("fl7: 2014 blocks, listed bare modifiers, alternate abilities and CR proficiency", () => {
  const numbers = numbersFromStatBlock({ statBlock: legacy });
  assert.ok(numbers);
  const monster = { numbers, cr: "1/2" };
  assert.equal(proficiencyFor({ kind: "save", ability: "dex" }, { monster }), "prof");
  assert.equal(proficiencyFor({ kind: "save", ability: "wis" }, { monster }), "none");
  assert.equal(proficiencyFor({ kind: "check", ability: "wis", skill: "perception" }, { monster }), "expert");
  assert.equal(proficiencyFor({ kind: "check", ability: "str", skill: "stealth" }, { monster }), "prof");
  assert.equal(proficiencyFor({ kind: "check", ability: "wis", skill: "survival" }, { monster }), "none");
  assert.equal(proficiencyFor({ kind: "check", ability: "int", skill: "nature" }, { monster: { numbers, cr: "5" } }), "prof");
});

test("fl7: spaces after printed signs preserve listed bonuses", () => {
  const compact = numbersFromStatBlock({ statBlock: legacy });
  const spaced = numbersFromStatBlock({ statBlock: legacy.replace(/\+(\d+)/g, "+ $1") });
  assert.deepEqual(spaced, compact);
});

test("fl7: 2024 grid and Wild Shape retain proficiencies, Polymorph takes the beast", () => {
  const numbers = numbersFromStatBlock({ statBlock: `| | Score | Mod | Save |
| --- | --- | --- | --- |
| Str | 10 | +0 | +0 |
| Dex | 14 | +2 | +4 |
| Con | 12 | +1 | +1 |
| Int | 10 | +0 | +0 |
| Wis | 12 | +1 | +1 |
| Cha | 10 | +0 | +0 |
**Skills** Perception +5, Stealth +4` });
  assert.ok(numbers);
  const stats = emptyPcStats();
  stats.skills.stealth = "expert";
  const source = { stats, monster: { numbers, cr: "1/2" } };
  const test = { kind: "check", ability: "dex", skill: "stealth" } as const;
  assert.equal(proficiencyFor(test, source), "prof");
  assert.equal(proficiencyFor(test, { ...source, wildShape: true }), "expert");
  assert.equal(proficiencyFor({ kind: "save", ability: "dex" }, { ...source, wildShape: true }), "prof");
  assert.equal(numbersFromStatBlock({ statBlock: "no stat block" }), null);
});
