import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ABILITY_KEYS, type PcStats } from "#shared/model.ts";
import { numbersFromStatBlock, proficiencyFor } from "#shared/rules/proficiency.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";
import { projectState } from "#shared/project.ts";
import { castTable, DM, room } from "#shared/testutil.ts";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { tokenPattern } from "../../components/testing/tokenPattern.ts";
import { splitAbilityTable } from "./abilityTable.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PcStatsView } = await import("../pcstats/PcStatsView.tsx");
const { StatBlockView } = await import("./StatBlockView.tsx");
const { Markdown } = await import("../../components/Markdown.tsx");
const { AbilityGrid } = await import("./AbilityGrid.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
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

/*
 * The grid while its boxes roll (docs/design/design-v1-stat-block-rolls.md 3): a
 * group of six buttons that look as the text boxes do. A grid with no
 * creature to roll for stays the `<dl>` FL-15 drew.
 */

const BOXES = [
  { key: "str", score: "16", mod: "+3", save: "+6", proficient: true },
  { key: "dex", score: "8", mod: "−1", save: "−1", proficient: false },
  { key: "con", score: "12", mod: "+1", save: "+1", proficient: false },
  { key: "int", score: "10", mod: "+0", save: "+0", proficient: false },
  { key: "wis", score: "14", mod: "+2", save: "+5", proficient: true },
  { key: "cha", score: "9", mod: "−1", save: "−1", proficient: false },
] as const;
const ROLLER = { creature: { tokenId: "t1" }, tokenId: "t1", name: "Thorn", played: true };

/** A rolling box reads the room (connection, rolls), so it renders inside a room as it does in the app. */
function inRoom(child: unknown): string {
  const view = projectState(room(), DM, { sceneId: "s1" }) as unknown as RoomState;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child as never }),
    }),
  );
}

function rolling(abilities: readonly (typeof BOXES)[number][] = BOXES): string {
  return inRoom(createElement(AbilityGrid, { abilities: abilities as never, roll: ROLLER }));
}

/** Each button's opening tag and its inside, in order. */
function buttonsOf(markup: string): { tag: string; inner: string }[] {
  return [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => ({ tag: m[1]!, inner: m[2]! }));
}

test("sbr: a grid with no creature to roll for is byte for byte the list FL-15 drew", () => {
  const text = renderToStaticMarkup(createElement(AbilityGrid, { abilities: BOXES.slice(0, 2) as never }));
  const c = theme.color;
  const hidden = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
  const dt = `<dt style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${c.textMuted}">`;
  const box = (extra: string) => `style="padding:4px 8px;border-radius:6px;background:${c.surfaceRaised};line-height:1.2${extra}"`;
  const expected =
    `<dl data-ability-grid="" style="margin:0;display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:4px">` +
    `<div data-save-proficient="" ${box(";box-shadow:inset 0 0 0 1px currentColor")}>${dt}<abbr title="Strength" style="text-decoration:none">STR</abbr></dt><dd style="margin:0;white-space:nowrap"><strong style="font-size:16px">16</strong> <span style="color:${c.textMuted}">+3</span></dd><dd style="margin:0;font-size:13px;white-space:nowrap"><span style="color:${c.textMuted}">Save </span>+6<span style="${hidden}">, proficient</span></dd></div>` +
    `<div ${box("")}>${dt}<abbr title="Dexterity" style="text-decoration:none">DEX</abbr></dt><dd style="margin:0;white-space:nowrap"><strong style="font-size:16px">8</strong> <span style="color:${c.textMuted}">−1</span></dd><dd style="margin:0;font-size:13px;white-space:nowrap"><span style="color:${c.textMuted}">Save </span>−1</dd></div></dl>`;
  assert.equal(text, expected);
  assert.equal(renderToStaticMarkup(createElement(AbilityGrid, { abilities: BOXES.slice(0, 2) as never, roll: null })), expected, "a null roller is no roller");
});

test("sbr: a rolling grid is a group of six buttons, one box each, with no list inside it", () => {
  const markup = rolling();
  assert.match(markup, /^<div data-ability-grid="" role="group" aria-label="Abilities" style="margin:0;display:grid;grid-template-columns:repeat\(3, minmax\(0, 1fr\)\);gap:4px">/);
  assert.doesNotMatch(markup, /<dl|<dt|<dd/);
  assert.equal(buttonsOf(markup).length, 6);
  assert.deepEqual(
    buttonsOf(markup).map((b) => /data-ability-abbr=""[^>]*>(\w+)</.exec(b.inner)![1]),
    ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
  );
});

test("sbr: each box keeps the text box's look and puts its three lines in marked spans", () => {
  const [str, dex] = buttonsOf(rolling());
  const c = theme.color;
  for (const b of [str!, dex!]) {
    assert.match(b.tag, /type="button"/);
    assert.match(b.tag, new RegExp(`padding:4px 8px;border-radius:${theme.radius.sm}px;background:${tokenPattern(c.surfaceRaised)};line-height:1.2`), "FL-15's padding, radius, fill and leading");
    assert.match(b.tag, /display:block/);
    assert.match(b.tag, /width:100%/);
    assert.match(b.tag, /text-align:left/);
    assert.match(b.tag, /font:inherit/);
    assert.match(b.tag, /cursor:pointer/);
    assert.match(b.tag, /border:0/);
    assert.match(b.inner, /data-ability-abbr=""[^>]*>\w+<\/span><span data-ability-score=""[^>]*><strong style="font-size:16px">\d+<\/strong> <span[^>]*>[+−]\d+<\/span><\/span><span data-ability-save=""[^>]*><span[^>]*>Save <\/span>[+−]\d+<\/span>/);
  }
  assert.match(str!.tag, /box-shadow:inset 0 0 0 1px currentColor/, "the proficient save's outline is the box's own shadow");
  assert.match(str!.tag, /data-save-proficient=""/);
  assert.doesNotMatch(dex!.tag, /data-save-proficient|box-shadow/);
});

test("sbr: a rolling box keeps the text box's tight line height, so the grid does not grow when it rolls", () => {
  for (const b of buttonsOf(rolling())) {
    const style = /style="([^"]*)"/.exec(b.tag)![1]!;
    // The font shorthand resets line-height, so it must come before the box look's own.
    assert.ok(style.indexOf("font:inherit") >= 0 && style.indexOf("font:inherit") < style.indexOf("line-height:1.2"), style);
  }
});

test("sbr: a box is named by its printed words, once, and says it opens a menu", () => {
  const named = buttonsOf(rolling()).map((b) => /aria-label="([^"]*)"/.exec(b.tag)![1]);
  assert.deepEqual(named, [
    "Strength 16, +3, save +6, proficient",
    "Dexterity 8, −1, save −1",
    "Constitution 12, +1, save +1",
    "Intelligence 10, +0, save +0",
    "Wisdom 14, +2, save +5, proficient",
    "Charisma 9, −1, save −1",
  ]);
  for (const b of buttonsOf(rolling())) {
    assert.match(b.tag, /aria-haspopup="menu"/);
    assert.match(b.tag, /aria-expanded="false"/);
    assert.match(b.tag, /aria-describedby=/);
    assert.doesNotMatch(b.inner, /proficient|visually/, "no hidden span inside a button: its label says it");
  }
});

test("sbr: each box has its corner mark, hidden from a reader, out of the way of a press, and 6 px in", () => {
  for (const b of buttonsOf(rolling())) {
    const mark = /<span data-ability-mark="" aria-hidden="true" style="([^"]*)"><svg[^>]*aria-hidden/.exec(b.inner);
    assert.ok(mark, "a mark in the box");
    assert.match(mark[1]!, /position:absolute;top:6px;right:6px/);
    assert.match(mark[1]!, /pointer-events:none/);
    assert.match(b.tag, /position:relative/, "the box holds the mark's position");
  }
});

test("sbr: a rolling box's words and numbers are the text box's, so the grid says the same thing either way", () => {
  const words = (m: string) => m.replace(/<span hidden[^>]*>.*?<\/span>/g, "").replace(/<[^>]*>/g, "").replace(/, proficient/g, "").replace(/\s+/g, "");
  const text = renderToStaticMarkup(createElement(AbilityGrid, { abilities: BOXES as never }));
  assert.equal(words(rolling()), words(text));
});

test("sbr: the views pass the roller to their grid, and without one stay text", () => {
  const stats: PcStats = { abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, saves: ["dex"], skills: {}, adjust: {}, defenses: {}, rolls: [] };
  const pc = (roll?: typeof ROLLER) => inRoom(createElement(PcStatsView, { character: { stats, level: 5 }, ...(roll ? { roll } : {}) }));
  assert.equal(buttonsOf(pc(ROLLER)).length, 6);
  assert.equal(buttonsOf(pc()).length, 0);
  assert.match(pc(), /<dl data-ability-grid=""/);
  const block = statBlockOf(customMonster("scout"));
  const view = monsterView(block);
  const monster = (roll?: typeof ROLLER) => inRoom(createElement(StatBlockView, { view, source: "room", ...(roll ? { roll } : {}) }));
  assert.equal(buttonsOf(monster(ROLLER)).length, 6);
  assert.equal(buttonsOf(monster()).length, 0);
  assert.equal(outlined(monster()).length, outlined(monster()).length);
});

test("sbr: the rolling grid is keyed by its creature, so one creature's result never shows under another's boxes (SBR-SOL-003)", () => {
  const keyOf = (creature: object) => (AbilityGrid({ abilities: BOXES as never, roll: { ...ROLLER, creature } as never }) as unknown as { key: string | null }).key;
  assert.notEqual(keyOf({ characterId: "a" }), keyOf({ characterId: "b" }), "another character's block starts with no result");
  assert.notEqual(keyOf({ characterId: "a" }), keyOf({ tokenId: "a" }));
  assert.equal(keyOf({ characterId: "a" }), keyOf({ characterId: "a" }), "the same creature keeps its result across renders");
});

test("sbr: a roller reads the same text across a room change that is not its own, so the block is not redrawn (SBR-OPUS-10)", async () => {
  const { blockRollerText } = await import("./AbilityGrid.tsx");
  const base = castTable();
  const view = projectState(base, DM, { sceneId: "s1" }) as unknown as RoomState;
  const state = (v: RoomState) => ({ view: v, you: DM, sceneId: "s1" });
  const from = { tokenId: "g1" };
  const before = blockRollerText(state(view), from);
  assert.notEqual(before, "null", "a real roller, so equal text means something");
  // A new view object with a new log line and an unrelated change, as every roll makes.
  const next = { ...view, log: [...view.log, { id: "9:0", at: "", kind: "event", data: { type: "dice" } } as never], meta: { ...view.meta } } as RoomState;
  assert.equal(blockRollerText(state(next), from), before);
  assert.equal(blockRollerText({ view: null, you: DM, sceneId: "s1" }, from), "null");
});
