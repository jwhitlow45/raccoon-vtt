import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PcStatsView } = await import("../pcstats/PcStatsView.tsx");
const { StatBlockView } = await import("./StatBlockView.tsx");
const { SavesLine } = await import("../tokens/StatSummary.tsx");

function marked(markup: string, level: string, name: string): void {
  const labels = markup.split('data-proficiency-label=""').slice(1);
  const label = labels.find((candidate) => candidate.includes(name));
  assert.ok(label, `${name}: structured label`);
  if (level === "none") assert.doesNotMatch(label, /data-proficiency-marker=/, `${name}: flowing untrained text has no marker slot`);
  else assert.match(label, new RegExp(`data-proficiency-marker="${level}"`), `${name}: ${level} marker`);
}

test("fl7: the PC sheet marks explicit proficiencies and keeps adjusted skills unmarked", () => {
  const stats: PcStats = {
    abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
    saves: ["dex"], skills: { perception: "expert", stealth: "prof" }, jack: true,
    adjust: { skills: { investigation: 9 } }, defenses: {}, rolls: [],
  };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  marked(markup, "expert", "Perception +8");
  marked(markup, "prof", "Stealth +6");
  marked(markup, "none", "Investigation +10");
  assert.equal(markup.match(/data-proficiency-label=/g)?.length, 9, "six saves and three skills");
  assert.match(markup, /Jack of All Trades/);
});

test("fl7: stat blocks mark listed skills, including an equal-modifier nonproficiency", () => {
  const block = statBlockOf(customMonster("scout"));
  block.cr = "1";
  block.abilities.wis = { score: 14, save: 4 };
  block.abilities.dex = { score: 16, save: 3 };
  block.skills = "Perception +6, Stealth +5, Acrobatics +3";
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(block), source: "room" }));
  marked(markup, "expert", "Perception +6");
  marked(markup, "prof", "Stealth +5");
  marked(markup, "none", "Acrobatics +3");
  assert.equal(markup.match(/data-proficiency-label=/g)?.length, 9);
});

test("fl7: a summary save uses its explicit proficiency map rather than its adjusted total", () => {
  const markup = renderToStaticMarkup(createElement(SavesLine, { block: {
    kind: "numbers", saves: { str: 9, dex: 6, con: 1, int: 0, wis: 2, cha: 0 }, defenses: [],
    proficiency: { str: "none", dex: "prof", con: "none", int: "none", wis: "none", cha: "none" },
  } }));
  marked(markup, "none", "STR");
  marked(markup, "prof", "DEX");
  assert.equal(markup.match(/data-proficiency-label=/g)?.length, 6);
});

test("fl7: legacy stat block skills and saving throws keep their names beside the marker", () => {
  const view = monsterView(statBlockOf(customMonster("legacy")));
  view.cr = "1";
  view.statBlock = [
    "## Legacy scout", "", "| STR | DEX | CON | INT | WIS | CHA |",
    "| --- | --- | --- | --- | --- | --- |", "| 10 (+0) | 16 (+3) | 12 (+1) | 10 (+0) | 14 (+2) | 10 (+0) |", "",
    "**Saving Throws** Dex +5", "", "**Skills** Perception +6, Stealth +3",
  ].join("\n");
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }));
  marked(markup, "prof", "Dex +5");
  marked(markup, "expert", "Perception +6");
  marked(markup, "none", "Stealth +3");
  assert.equal(markup.match(/data-proficiency-label=/g)?.length, 3);
});
