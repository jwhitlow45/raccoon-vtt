import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ABILITY_KEYS, type PcStats } from "#shared/model.ts";
import { numbersFromStatBlock, proficiencyFor } from "#shared/rules/proficiency.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { splitAbilityTable } from "./abilityTable.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PcStatsView } = await import("../pcstats/PcStatsView.tsx");
const { StatBlockView } = await import("./StatBlockView.tsx");
const { Markdown } = await import("../../components/Markdown.tsx");
const { AbilityGrid } = await import("./AbilityGrid.tsx");
const { SavesLine } = await import("../tokens/StatSummary.tsx");

/** Every roll mark the markup holds: a frame, a tint, a name's tooltip or its unseen picture. */
function hasMarks(markup: string): boolean {
  return /data-proficiency/.test(markup);
}

/** The text of each paragraph the markup holds. */
function paragraphs(markup: string): string[] {
  return [...markup.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ""));
}

/** The abilities, "DEX", whose box in the six-ability grid is outlined. */
function outlined(markup: string): string[] {
  return [...markup.matchAll(/<div data-save-proficient=""[^>]*><dt[^>]*><abbr[^>]*>(\w+)<\/abbr>/g)].map((m) => m[1]!);
}

/** FL-13's two lines, which FL-15 takes out everywhere (D-261030-588). */
const LISTED = /^(Proficiencies|Expertise)\b/;

test("fl15: the PC sheet lists no proficiencies, keeps no \"(expertise)\", and outlines its proficient saves' boxes", () => {
  const stats: PcStats = {
    abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
    saves: ["dex"], skills: { perception: "expert", stealth: "prof" }, jack: true,
    adjust: { skills: { investigation: 9 } }, defenses: {}, rolls: [],
  };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  assert.equal(hasMarks(markup), false, "no roll mark in the sheet");
  const lines = paragraphs(markup);
  assert.equal(lines.some((l) => LISTED.test(l)), false);
  const at = lines.indexOf("Skills Investigation +10, Perception +8, Stealth +6");
  assert.ok(at >= 0, "the Skills line has no '(expertise)': its bonus shows it");
  assert.equal(lines[at + 1], "Jack of All Trades +1 to skills with neither", "nothing stands between Skills and the next line");
  assert.deepEqual(outlined(markup), ["DEX"]);
  assert.match(markup, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/, "the ability grid stays three across");
});

test("fl15: a PC with saves and no skills gets no line where a Skills line would stand", () => {
  const stats: PcStats = { abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, saves: ["dex", "wis"], skills: {}, adjust: {}, defenses: {}, rolls: [] };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  assert.deepEqual(paragraphs(markup).slice(0, 2), ["Level 5, PB +3", "Initiative +3, Passive Perception 12"]);
  assert.deepEqual(outlined(markup), ["DEX", "WIS"]);
  assert.deepEqual(outlined(renderToStaticMarkup(createElement(PcStatsView, { character: { stats: { ...stats, saves: [] }, level: 5 } }))), []);
});

test("fl15: a block lists no proficiencies and outlines the box of each save that is not its bare modifier", () => {
  const block = statBlockOf(customMonster("scout"));
  block.cr = "1";
  block.abilities.wis = { score: 14, save: 4 };
  block.abilities.dex = { score: 16, save: 3 };
  // One more than its modifier, as a typed block may print it: the Dice panel reads it as proficient, so the grid does too.
  block.abilities.con = { score: 12, save: 2 };
  block.skills = "Perception +6, Stealth +5, Acrobatics +3";
  const view = monsterView(block);
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }));
  assert.equal(hasMarks(markup), false);
  const lines = paragraphs(markup);
  assert.equal(lines.some((l) => LISTED.test(l)), false);
  const at = lines.findIndex((l) => l.startsWith("Skills"));
  assert.ok(lines[at + 1]!.startsWith("Senses"), "the Skills line is followed by the block's own next line");
  assert.deepEqual(outlined(markup), ["CON", "WIS"], "a save equal to its modifier is not outlined");
  assert.equal(proficiencyFor({ kind: "save", ability: "con" }, { monster: { numbers: numbersFromStatBlock(view)!, cr: view.cr } }), "prof");
});

test("fl15: a creature with no Skills line and no proficient save gets nothing added", () => {
  const plain = statBlockOf(customMonster("plain"));
  plain.skills = "";
  for (const key of ABILITY_KEYS) plain.abilities[key] = { score: 10, save: 0 };
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(plain), source: "room" }));
  assert.equal(paragraphs(markup).some((l) => LISTED.test(l)), false);
  assert.deepEqual(outlined(markup), []);
});

test("fl15: a block in the older six-column layout draws as written, its Saving Throws line naming its saves", () => {
  const view = monsterView(statBlockOf(customMonster("legacy")));
  view.cr = "1";
  view.statBlock = [
    "## Legacy scout", "", "| STR | DEX | CON | INT | WIS | CHA |",
    "| --- | --- | --- | --- | --- | --- |", "| 10 (+0) | 16 (+3) | 12 (+1) | 10 (+0) | 14 (+2) | 10 (+0) |", "",
    "**Saving Throws** Dex +5", "", "**Skills** Perception +6, Stealth +3", "", "**Senses** Passive Perception 16",
  ].join("\n");
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }));
  assert.equal(markup, renderToStaticMarkup(createElement("div", { style: { display: "grid", gap: theme.space(2) } }, createElement(Markdown, { text: view.statBlock }))));
  assert.deepEqual(paragraphs(markup), ["Saving Throws Dex +5", "Skills Perception +6, Stealth +3", "Senses Passive Perception 16"]);
});

test("fl15: a block whose numbers cannot be read draws as written", () => {
  const view = monsterView(statBlockOf(customMonster("odd")));
  view.statBlock = "## Odd\n\n**Skills** Perception +9\n\nNo table here.";
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }));
  assert.equal(hasMarks(markup), false);
  assert.deepEqual(paragraphs(markup), ["Skills Perception +9", "No table here."]);
});

test("fl13: a summary save marks nothing", () => {
  const markup = renderToStaticMarkup(createElement(SavesLine, { block: { kind: "numbers", saves: { str: 9, dex: 6, con: 1, int: 0, wis: 2, cha: 0 }, defenses: [] } }));
  assert.equal(hasMarks(markup), false);
  assert.match(markup, /DEX <\/span><span[^>]*>\+6/);
  assert.doesNotMatch(markup, /data-saves-triple/, "the saves keep their two parts");
});

test("fl15: the grid outlines a proficient save's whole box in the text's color, in place of bold, taking no room", () => {
  const markup = renderToStaticMarkup(createElement(AbilityGrid, {
    abilities: [
      { key: "str", score: "10", mod: "+0", save: "+0", proficient: false },
      { key: "dex", score: "10", mod: "+0", save: "+4", proficient: true },
    ],
  }));
  assert.equal(hasMarks(markup), false, "no roll mark");
  const [str, dex] = [...markup.matchAll(/<div( data-save-proficient="")? style="([^"]*)">(.*?)<\/div>/g)].map((m) => ({ marked: m[1] !== undefined, style: m[2]!, inner: m[3]! }));
  assert.ok(str && dex);
  assert.equal(dex.marked, true);
  assert.equal(str.marked, false);
  assert.match(dex.style, /box-shadow:inset 0 0 0 1px currentColor/, "a 1 px line inside the box, in the text's own color");
  assert.doesNotMatch(dex.style, /accent/, "never the accent");
  assert.doesNotMatch(str.style, /box-shadow/);
  assert.equal(dex.style.replace(/;box-shadow:[^;]*/, ""), str.style, "the outline is the only style it adds, so the box keeps its size, padding and radius");
  assert.match(dex.style, new RegExp(`border-radius:${theme.radius.sm}px`), "rounded as the box is");
  assert.doesNotMatch(markup, /font-weight:(700|600)[^>]*><span[^>]*>Save/, "no save number is bold");
  assert.match(dex.inner, /<span[^>]*>Save <\/span>\+4<span[^>]*>, proficient<\/span><\/dd>$/, "a screen reader still hears it as proficient");
  assert.doesNotMatch(str.inner, /proficient/);
});

test("fl15: every SRD stat block draws its own Markdown and outlines the saves the dice read as proficient", async () => {
  for (const monster of await loadMonsters()) {
    const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monster, source: "srd" }));
    assert.equal(hasMarks(markup), false, monster.srdId);
    const split = splitAbilityTable(monster.statBlock);
    assert.ok(split, monster.srdId);
    const drawn = renderToStaticMarkup(
      createElement("div", { style: { display: "grid", gap: theme.space(2) } },
        createElement("div", null, createElement(Markdown, { text: split.before }), createElement("div", { style: { margin: `${theme.space(2)}px 0` } }, createElement(AbilityGrid, { abilities: split.abilities })), createElement(Markdown, { text: split.after }))),
    );
    assert.equal(markup, drawn, `${monster.srdId}: nothing is added to the block`);
    // The outline and the Dice panel's save buttons read the same block, so they agree on every save.
    const numbers = numbersFromStatBlock(monster)!;
    const rolled = ABILITY_KEYS.filter((ability) => proficiencyFor({ kind: "save", ability }, { monster: { numbers, cr: monster.cr } }) !== "none").map((a) => a.toUpperCase());
    assert.deepEqual(outlined(markup), rolled, monster.srdId);
    if (monster.srdId === "adult-white-dragon") assert.deepEqual(outlined(markup), ["DEX", "WIS"]);
  }
});
