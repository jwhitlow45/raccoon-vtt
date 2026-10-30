import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import { character, DM, room, token } from "#shared/testutil.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { DiceRoll, LogEvent, RoomState } from "#shared/model.ts";
import { creatureRolls, type DiceView } from "./creature.ts";
import { DICE_FOLD_KEYS, diceFoldsSlot } from "./diceFolds.ts";
import { foldSummary } from "./options.ts";
import { toastMarks } from "./proficiencyPresentation.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { OptionsList } = await import("./RollOptions.tsx");
const { RecentRolls } = await import("./RecentRolls.tsx");
const { ProficientEvent, eventMarks } = await import("./ProficientEvent.tsx");

/*
 * FL-7 rework (D-261030-436 to 438): the Dice panel, Recent rolls, the Log
 * and toasts keep their words and layout, and only a test's name gains its
 * underline.
 */

function state(): RoomState {
  const s = room({ characters: { hero: character("hero", { name: "Hero", level: 5, stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["dex"], skills: { stealth: "expert", perception: "prof" } } }) } });
  s.tokens.hero = token("hero", { kind: "pc", actor: { ref: "hero" } });
  return s;
}

function namesOf(s: RoomState): LogNames {
  return { characters: s.characters, tokens: s.tokens, members: s.members, handouts: s.handouts, encounter: s.encounter };
}

function render(s: RoomState, body: ReactNode, folded: readonly string[] = []): string {
  const scope = new RoomScope();
  for (const key of DICE_FOLD_KEYS) scope.get(diceFoldsSlot).tap(key, !folded.includes(key), false);
  const store = createStore(() => ({ view: s, you: DM, sceneId: "s1", roomId: "r1", connection: "open", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never, children: createElement(RoomScopeProvider, { scope, children: body }) }));
}

function options(s: RoomState, folded: readonly string[] = []): string {
  const dice: DiceView = { you: DM, view: s, srd: { monsters: null, rolls: null } };
  const creature = { characterId: "hero" };
  return render(s, createElement(OptionsList, { dice, creature, tokenId: undefined, rolls: creatureRolls(dice, creature)!, name: "Hero" }), folded);
}

const marks = (html: string) => [...html.matchAll(/<span data-proficiency-label="" data-proficiency-level="(\w+)"[^>]*>(.*?)<\/span>/g)].map((m) => `${m[1]}:${m[2]!.replace(/<[^>]*>/g, "")}`);
const text = (html: string) => html.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'");
const levelOf = (s: RoomState) => (creature: { characterId?: string; tokenId?: string }, test: { kind: string; ability?: string; skill?: string }) =>
  "characterId" in creature && creature.characterId === "hero" && s.characters.hero ? (test.kind === "save" ? (test.ability === "dex" ? "prof" : "none") : test.skill === "stealth" ? "expert" : test.skill === "perception" ? "prof" : "none") : "none";

test("fl7: each save and skill button marks only its name, keeps its words and grid, and its name says the level", () => {
  const html = options(state());
  const saves = html.slice(html.indexOf('aria-label="Saves"'), html.indexOf('aria-label="Checks"'));
  assert.match(saves, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/, "three save columns, as before FL-7");
  assert.deepEqual(marks(saves), ["none:STR", "prof:DEX", "none:CON", "none:INT", "none:WIS", "none:CHA"]);
  assert.match(saves, /aria-label="Dexterity save, proficient/);
  assert.match(text(saves), /DEX \+3/);
  const all = marks(html);
  assert.ok(all.includes("expert:Stealth") && all.includes("prof:Perception") && all.includes("none:Acrobatics"));
  assert.equal(all.length, 6 + 18, "plain checks take no mark");
  assert.match(html, /aria-label="Stealth check, expertise/);
  assert.doesNotMatch(html, /padding:0 6px/, "the cells keep their 12 px sides");
});

test("fl7: folded save and skill lines keep foldSummary's words, cut only between parts, each name marked", () => {
  const html = options(state(), ["pc.saves", "pc.skills"]);
  assert.ok(html.includes("data-summary-part"), "the lines are made of whole parts");
  assert.ok(text(html).includes(foldSummary({ group: "saves", note: "", saves: { str: 0, dex: 3, con: 0, int: 0, wis: 0, cha: 0 } })));
  assert.ok(text(html).includes(foldSummary({ group: "skills", skills: [{ name: "Perception", bonus: 3, check: 0 }, { name: "Stealth", bonus: 6, check: 0 }] })));
  const all = marks(html);
  assert.ok(all.includes("prof:Dex") && all.includes("expert:Stealth") && all.includes("prof:Perception"));
});

test("fl7: Recent rolls marks the label after the creature, and never says a player's own character twice (FL7-R1-11)", () => {
  const s = state();
  s.members.p1 = { ...s.members.dm1!, id: "p1", name: "Hero", role: "player" } as never;
  const roll: DiceRoll = { characterId: "hero", label: "Stealth check", formula: "1d20+7", faces: [9], total: 16 };
  s.log = [{ id: "1:0", at: "", kind: "event", data: { type: "dice", by: "p1", to: "all", rolls: [roll] } }];
  const html = render(s, createElement(RecentRolls, { names: namesOf(s), me: "dm1", open: null, again() {} }));
  assert.ok(marks(html).includes("expert:Stealth check"));
  assert.doesNotMatch(text(html), /Hero\s*16\s*Hero/, "no Thorn 9 Thorn");
  const folded = render(s, createElement(RecentRolls, { names: namesOf(s), me: "dm1", open: null, again() {} }), ["recent"]);
  const summary = /id="[^"]+-summary"[^>]*>(.*?)<\/span>(?=<\/span>)/.exec(folded)?.[1] ?? "";
  assert.ok(summary.includes("Hero 16 "), "the folded line keeps its words");
  assert.ok(marks(folded).includes("expert:Stealth check"));
  assert.doesNotMatch(folded, /data-summary-wrap|white-space:normal/, "the folded line stays one line");
});

test("fl7: two choices that name one skill each mark their own words, and the line is describeEvent's (FL7-SOL-01)", () => {
  const s = state();
  const event: Extract<LogEvent, { type: "roll" }> = { type: "roll", characterId: "hero", test: { kind: "check", choices: [{ ability: "str", skill: "stealth" }, { ability: "dex", skill: "stealth" }] }, result: "pass" };
  const html = render(s, createElement(ProficientEvent, { data: event, names: namesOf(s), dm: true, levelOf: levelOf(s) as never }));
  assert.equal(text(html), describeEvent(event, namesOf(s), true));
  assert.deepEqual(marks(html), ["expert:Strength (Stealth)", "expert:Dexterity (Stealth)"]);
});

test("fl7: a bare ability before the same ability with a skill marks the skill's own words (FL7-R1-18)", () => {
  const s = state();
  const event: Extract<LogEvent, { type: "roll" }> = { type: "roll", characterId: "hero", test: { kind: "check", choices: [{ ability: "str" }, { ability: "str", skill: "athletics" }] } };
  const { text: words, marks: found } = eventMarks(event, namesOf(s), true, levelOf(s) as never);
  assert.equal(words, describeEvent(event, namesOf(s), true));
  assert.deepEqual(found.map((m) => words.slice(m.at, m.at + m.length)), ["Strength (Athletics)"]);
  assert.ok(found[0]!.at > words.indexOf("Strength or "), "not the bare Strength");
});

test("fl7: a creature named like a skill is never marked, a save-ends line marks its save, not its DC (FL7-R1-13)", () => {
  const s = state();
  s.characters.hero!.name = "Stealth check";
  const dice: LogEvent = { type: "dice", by: "dm1", to: "all", rolls: [{ characterId: "hero", label: "Stealth check", formula: "1d20+7", faces: [9], total: 16 }] };
  const one = eventMarks(dice, namesOf(s), true, levelOf(s) as never);
  assert.deepEqual(one.marks.map((m) => m.at), [one.text.indexOf(", Stealth check:") + 2]);
  const ends: LogEvent = { type: "saveEnds", characterId: "hero", key: "frightened", ability: "dex", dc: 15 } as never;
  const two = eventMarks(ends, namesOf(s), true, levelOf(s) as never);
  assert.deepEqual(two.marks.map((m) => two.text.slice(m.at, m.at + m.length)), ["Dexterity save"]);
});

test("fl7: a toast keeps its words and marks the label only for one creature's rolls", () => {
  const s = state();
  const roll: DiceRoll = { characterId: "hero", label: "Stealth check", formula: "1d20+7", faces: [9], total: 16 };
  const one = toastMarks("Pat rolled 16 for Hero, Stealth check.", [roll], levelOf(s) as never);
  assert.deepEqual(one, [{ at: 24, length: 13, level: "expert" }]);
  assert.equal(toastMarks("Pat rolled 2 Stealth checks.", [roll, { ...roll, total: 4 }], levelOf(s) as never).length, 1, "one creature twice");
  assert.deepEqual(toastMarks("Pat rolled 2 Stealth checks.", [roll, { ...roll, characterId: "other" }], levelOf(s) as never), [], "two creatures stay neutral");
  assert.deepEqual(toastMarks("Pat rolled 16 for Hero, Stealth damage.", [{ ...roll, label: "Stealth damage" }], levelOf(s) as never), []);
});
