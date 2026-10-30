import "../../components/testing/register.ts";
import { withoutFrames } from "../../components/testing/proficiencyMarkup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PcStats } from "#shared/model.ts";
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

/** Each marked name: its level and its words. */
function marks(markup: string): string[] {
  return [...withoutFrames(markup).matchAll(/<span data-proficiency-label="" data-proficiency-level="(\w+)"[^>]*>([^<]*)/g)].map((m) => `${m[1]}:${m[2]}`);
}

/** The markup with every mark taken out, as it was before FL-7. */
function unmarked(markup: string): string {
  return withoutFrames(markup).replace(/<span data-proficiency-marker="\w+"[^>]*><\/span>/g, "").replace(/<span data-proficiency-label="" data-proficiency-level="\w+"[^>]*>([^<]*)<\/span>/g, "$1");
}

test("fl7: the PC sheet marks explicit proficiencies, keeps \"(expertise)\" and leaves an adjusted skill neither", () => {
  const stats: PcStats = {
    abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
    saves: ["dex"], skills: { perception: "expert", stealth: "prof" }, jack: true,
    adjust: { skills: { investigation: 9 } }, defenses: {}, rolls: [],
  };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  assert.deepEqual(marks(markup), ["none:Save", "prof:Save", "none:Save", "none:Save", "none:Save", "none:Save", "none:Investigation", "expert:Perception", "prof:Stealth"]);
  assert.match(unmarked(markup).replace(/<[^>]*>/g, ""), /Investigation \+10, Perception \+8 \(expertise\), Stealth \+6/);
  assert.match(markup, /Jack of All Trades/);
  assert.match(markup, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/, "the ability grid stays three across");
});

test("fl7: stat blocks mark listed skills by name only, including an equal-modifier nonproficiency", () => {
  const block = statBlockOf(customMonster("scout"));
  block.cr = "1";
  block.abilities.wis = { score: 14, save: 4 };
  block.abilities.dex = { score: 16, save: 3 };
  block.skills = "Perception +6, Stealth +5, Acrobatics +3";
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monsterView(block), source: "room" }));
  assert.deepEqual(marks(markup).filter((m) => !m.endsWith(":Save")), ["expert:Perception", "prof:Stealth", "none:Acrobatics"]);
});

test("fl7: a summary save marks its abbreviation from its explicit proficiency map", () => {
  const markup = renderToStaticMarkup(createElement(SavesLine, { block: {
    kind: "numbers", saves: { str: 9, dex: 6, con: 1, int: 0, wis: 2, cha: 0 }, defenses: [],
    proficiency: { str: "none", dex: "prof", con: "none", int: "none", wis: "none", cha: "none" },
  } }));
  assert.deepEqual(marks(markup), ["none:STR", "prof:DEX", "none:CON", "none:INT", "none:WIS", "none:CHA"]);
  assert.doesNotMatch(markup, /data-saves-triple/, "the saves keep their two parts as before FL-7");
});

test("fl7: legacy stat block skills and saving throws mark their names", () => {
  const view = monsterView(statBlockOf(customMonster("legacy")));
  view.cr = "1";
  view.statBlock = [
    "## Legacy scout", "", "| STR | DEX | CON | INT | WIS | CHA |",
    "| --- | --- | --- | --- | --- | --- |", "| 10 (+0) | 16 (+3) | 12 (+1) | 10 (+0) | 14 (+2) | 10 (+0) |", "",
    "**Saving Throws** Dex +5", "", "**Skills** Perception +6, Stealth +3", "", "**Senses** Passive Perception 16",
  ].join("\n");
  const markup = renderToStaticMarkup(createElement(StatBlockView, { view, source: "room" }));
  assert.deepEqual(marks(markup), ["prof:Dex", "expert:Perception", "none:Stealth"], "Passive Perception is no skill");
});

test("fl7: every SRD stat block draws the markup it drew before FL-7, marks aside", async () => {
  for (const monster of await loadMonsters()) {
    const markup = renderToStaticMarkup(createElement(StatBlockView, { view: monster, source: "srd" }));
    const split = splitAbilityTable(monster.statBlock);
    const before = renderToStaticMarkup(
      createElement("div", { style: { display: "grid", gap: theme.space(2) } }, split
        ? createElement("div", null, createElement(Markdown, { text: split.before }), createElement("div", { style: { margin: `${theme.space(2)}px 0` } }, createElement(AbilityGrid, { abilities: split.abilities })), createElement(Markdown, { text: split.after }))
        : createElement(Markdown, { text: monster.statBlock })),
    );
    assert.equal(unmarked(markup), unmarked(before), monster.srdId);
    if (monster.srdId === "adult-white-dragon") assert.deepEqual(marks(markup).filter((m) => !m.endsWith(":Save")), ["expert:Perception", "prof:Stealth"]);
  }
});
