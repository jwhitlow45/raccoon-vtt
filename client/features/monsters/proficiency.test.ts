import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";
import { withProficiencyLines } from "../../lib/proficiencyLines.ts";
import { theme } from "../../lib/theme.ts";
import { splitAbilityTable } from "./abilityTable.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PcStatsView } = await import("../pcstats/PcStatsView.tsx");
const { StatBlockView, monsterProficiencyLines } = await import("./StatBlockView.tsx");
const { Markdown } = await import("../../components/Markdown.tsx");
const { AbilityGrid } = await import("./AbilityGrid.tsx");
const { SavesLine } = await import("../tokens/StatSummary.tsx");

/** Every mark the markup holds: a frame, a tint, a name's tooltip or its unseen picture. */
function hasMarks(markup: string): boolean {
  return /data-proficiency/.test(markup);
}

/** The text of each paragraph the markup holds. */
function paragraphs(markup: string): string[] {
  return [...markup.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ""));
}

test("fl13: the PC sheet lists proficiencies under Skills, keeps no \"(expertise)\" and marks nothing", () => {
  const stats: PcStats = {
    abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
    saves: ["dex"], skills: { perception: "expert", stealth: "prof" }, jack: true,
    adjust: { skills: { investigation: 9 } }, defenses: {}, rolls: [],
  };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  assert.equal(hasMarks(markup), false);
  const lines = paragraphs(markup);
  const at = lines.indexOf("Skills Investigation +10, Perception +8, Stealth +6");
  assert.ok(at >= 0, "the Skills line has no '(expertise)'");
  assert.deepEqual(lines.slice(at + 1, at + 4), ["Proficiencies Dexterity saves, Stealth", "Expertise Perception", "Jack of All Trades +1 to skills with neither"], "an adjusted skill is neither, and Jack stays as worded");
  assert.match(markup, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/, "the ability grid stays three across");
});

test("fl13: a PC with saves but no skills still gets the line where a Skills line would stand", () => {
  const stats: PcStats = { abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, saves: ["dex", "wis"], skills: {}, adjust: {}, defenses: {}, rolls: [] };
  const lines = paragraphs(renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } })));
  assert.equal(lines.some((l) => l.startsWith("Skills")), false);
  assert.equal(lines[1], "Proficiencies Dexterity saves, Wisdom saves");
  assert.equal(lines.some((l) => l.startsWith("Expertise")), false, "an empty line is left out");
  const none = paragraphs(renderToStaticMarkup(createElement(PcStatsView, { character: { stats: { ...stats, saves: [] }, level: 5 } })));
  assert.equal(none.some((l) => /^(Proficiencies|Expertise)/.test(l)), false);
});

test("fl13: a block lists its listed skills and saves in two lines, expertise apart, and marks nothing", () => {
  const block = statBlockOf(customMonster("scout"));
  block.cr = "1";
  block.abilities.wis = { score: 14, save: 4 };
  block.abilities.dex = { score: 16, save: 3 };
  block.skills = "Perception +6, Stealth +5, Acrobatics +3";
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(block), source: "room" }));
  assert.equal(hasMarks(markup), false);
  const lines = paragraphs(markup);
  const at = lines.findIndex((l) => l.startsWith("Skills"));
  assert.deepEqual(lines.slice(at, at + 3), ["Skills Perception +6, Stealth +5, Acrobatics +3", "Proficiencies Wisdom saves, Stealth", "Expertise Perception"], "an equal-modifier skill is no proficiency");
});

test("fl13: a creature with no Skills line gets its lines where one would stand, and one with nothing to list gets none", () => {
  const block = statBlockOf(customMonster("brute"));
  block.cr = "1";
  block.skills = "";
  for (const key of ["dex", "con", "int", "wis", "cha"] as const) block.abilities[key] = { score: 10, save: 0 };
  block.abilities.str = { score: 16, save: 5 };
  block.resistances = "Fire";
  const lines = paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(block), source: "room" })));
  const at = lines.findIndex((l) => l.startsWith("Proficiencies"));
  assert.ok(at > 0, "Proficiencies appears");
  assert.equal(lines[at], "Proficiencies Strength saves");
  assert.ok(lines[at + 1]!.startsWith("Resistances"), "before the lines that follow a Skills line");
  assert.equal(lines.some((l) => l.startsWith("Skills") || l.startsWith("Expertise")), false);
  const plain = statBlockOf(customMonster("plain"));
  plain.skills = "";
  for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) plain.abilities[key] = { score: 10, save: 0 };
  assert.equal(paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(plain), source: "room" }))).some((l) => /^(Proficiencies|Expertise)/.test(l)), false);
});

test("fl13: legacy stat block skills and saving throws are listed in the same two lines", () => {
  const view = monsterView(statBlockOf(customMonster("legacy")));
  view.cr = "1";
  view.statBlock = [
    "## Legacy scout", "", "| STR | DEX | CON | INT | WIS | CHA |",
    "| --- | --- | --- | --- | --- | --- |", "| 10 (+0) | 16 (+3) | 12 (+1) | 10 (+0) | 14 (+2) | 10 (+0) |", "",
    "**Saving Throws** Dex +5", "", "**Skills** Perception +6, Stealth +3", "", "**Senses** Passive Perception 16",
  ].join("\n");
  const lines = paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" })));
  assert.ok(lines.includes("Proficiencies Dexterity saves"));
  assert.ok(lines.includes("Expertise Perception"), "Passive Perception is no skill");
});

test("fl13: a block whose numbers cannot be read gets no lines, never a guess", () => {
  const view = monsterView(statBlockOf(customMonster("odd")));
  view.statBlock = "## Odd\n\n**Skills** Perception +9\n\nNo table here.";
  assert.deepEqual(monsterProficiencyLines(view), []);
  assert.equal(hasMarks(renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }))), false);
  assert.equal(paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }))).some((l) => /^(Proficiencies|Expertise)/.test(l)), false);
});

test("fl13: a summary save marks nothing", () => {
  const markup = renderToStaticMarkup(createElement(SavesLine, { block: { kind: "numbers", saves: { str: 9, dex: 6, con: 1, int: 0, wis: 2, cha: 0 }, defenses: [] } }));
  assert.equal(hasMarks(markup), false);
  assert.match(markup, /DEX <\/span><span[^>]*>\+6/);
  assert.doesNotMatch(markup, /data-saves-triple/, "the saves keep their two parts");
});

test("fl13: the ability grid marks nothing and keeps a proficient save bold", () => {
  const markup = renderToStaticMarkup(createElement(AbilityGrid, { abilities: [{ key: "dex", score: "10", mod: "+0", save: "+4", proficient: true }] }));
  assert.equal(hasMarks(markup), false);
  assert.match(markup, /font-weight:\d+[^>]*><span[^>]*>Save <\/span>\+4<span[^>]*>, proficient<\/span>/);
});

test("fl13: every SRD stat block draws its Markdown with only the two lines added", async () => {
  for (const monster of await loadMonsters()) {
    const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monster, source: "srd" }));
    assert.equal(hasMarks(markup), false, monster.srdId);
    const lines = monsterProficiencyLines(monster);
    const text = withProficiencyLines(monster.statBlock, lines);
    const split = splitAbilityTable(text);
    const before = renderToStaticMarkup(
      createElement("div", { style: { display: "grid", gap: theme.space(2) } }, split
        ? createElement("div", null, createElement(Markdown, { text: split.before }), createElement("div", { style: { margin: `${theme.space(2)}px 0` } }, createElement(AbilityGrid, { abilities: split.abilities })), createElement(Markdown, { text: split.after }))
        : createElement(Markdown, { text })),
    );
    assert.equal(markup, before, monster.srdId);
    // Nothing is taken from the block: removing the added lines gives the stored text back.
    assert.equal(text.replace(/\n\n\*\*(Proficiencies|Expertise)\*\* [^\n]*/g, ""), monster.statBlock, monster.srdId);
    if (monster.srdId === "adult-white-dragon") assert.deepEqual(lines, [{ label: "Proficiencies", names: ["Dexterity saves", "Wisdom saves", "Stealth"] }, { label: "Expertise", names: ["Perception"] }]);
  }
});

test("fl13: a block inside a Wild Shape can leave its own lines out, so one pair shows (D-261030-581)", async () => {
  const dragon = (await loadMonsters()).find((m) => m.srdId === "adult-white-dragon")!;
  const own = paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view: dragon, source: "srd" })));
  const left = paragraphs(renderToStaticMarkup(createElement(StatBlockView, { view: dragon, source: "srd", leaveOutProficiency: true })));
  assert.ok(own.some((l) => l.startsWith("Proficiencies")));
  assert.equal(left.some((l) => /^(Proficiencies|Expertise)/.test(l)), false);
  assert.ok(left.some((l) => l.startsWith("Skills")), "the rest of the block is as it was");
});
