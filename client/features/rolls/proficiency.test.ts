import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { testShortText } from "#shared/rules/skills.ts";
import { character, DM, room } from "#shared/testutil.ts";
import { askLine, chipLine, chipName, dmAnswerText, tallyText } from "./logic.ts";

const { createElement, createRef } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RollCard, RollChip } = await import("./PlayerRolls.tsx");
const { DmCard } = await import("./DmDesk.tsx");

/*
 * FL-7 rework (D-261030-436 to 438): a roll card, chip and desk card keep
 * their words, and only the names of the tests in them gain a mark.
 */

function render(body: ReactNode): string {
  const state = room({ characters: {
    hero: character("hero", { name: "Hero", level: 5, stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["dex"], skills: { stealth: "expert", perception: "prof" } } }),
    other: character("other", { name: "Other", level: 5, stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["str"] } }),
  } });
  const store = createStore(() => ({ view: state, you: DM, sceneId: "s1", roomId: "r1", connection: "open", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: body }),
  }));
}

function request(targets: RollTarget[] = [{ characterId: "hero" }]): RollRequest {
  return {
    id: "ask", rev: 1, at: "", dcShown: true, resultShown: true,
    test: { kind: "check", choices: [{ ability: "dex", skill: "stealth" }, { ability: "wis", skill: "perception" }] },
    targets,
  };
}

/** Each marked span: its level and its words. */
function marks(html: string): { level: string; words: string }[] {
  return [...html.matchAll(/<span data-proficiency-label="" data-proficiency-level="(\w+)"[^>]*>(.*?)<\/span>/g)].map((m) => ({ level: m[1]!, words: m[2]!.replace(/<[^>]*>/g, "") }));
}

const text = (html: string) => html.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'");

const card = (ask: RollRequest) =>
  render(createElement(RollCard, {
    request: ask, cardRef: createRef<HTMLElement>(), drafts: new Map(), sheet: false, hidden: false,
    stand: "toolbar", stickyHeader: false, whole: 0, onMeasure() {}, onFold() {}, onEngage() {}, onFocusWithin() {},
  }));

test("fl7: a waiting chip keeps its line and marks each choice with the creature's own level, and its name says so", () => {
  const ask = request();
  const html = render(createElement(RollChip, { request: ask, onOpen() {} }));
  assert.deepEqual(marks(html), [{ level: "expert", words: "DEX (Stealth)" }, { level: "prof", words: "WIS (Perception)" }]);
  assert.equal(text(html), chipLine(ask, ask.targets[0]!), "the words are the chip's own");
  const name = /aria-label="([^"]*)"/.exec(html)?.[1];
  assert.equal(name, chipName(ask, ["DEX (Stealth), expertise or WIS (Perception), proficient check: waiting for your roll."]));
});

test("fl7: a chip for several creatures marks each creature's line with its own level", () => {
  const ask = request([{ characterId: "hero", choice: 1, total: 17 }, { characterId: "other" }]);
  ask.test = { kind: "save", choices: [{ ability: "dex" }] };
  const html = render(createElement(RollChip, { request: ask, onOpen() {} }));
  assert.deepEqual(marks(html).map((m) => m.level), ["prof", "none"]);
  assert.equal(marks(html)[0]!.words, "DEX save");
});

test("fl7: the desk's title marks one creature's choices and keeps its words, and with several it stays neutral", () => {
  const ask = request();
  const one = render(createElement(DmCard, { request: ask, open: false, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.deepEqual(marks(one), [{ level: "expert", words: "DEX (Stealth)" }, { level: "prof", words: "WIS (Perception)" }]);
  const button = /<button[^>]*aria-expanded="false"[^>]*>(.*?)<\/button>/.exec(one)?.[1];
  assert.ok(button);
  assert.equal(text(button), `${testShortText(ask.test)}${tallyText(ask).answered}`, "the toggle's words are as before");
  assert.match(button, /role="img" aria-label="Expertise"/, "its name from its words holds the mark");
  const several = render(createElement(DmCard, { request: request([{ characterId: "hero" }, { characterId: "other" }]), open: false, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.deepEqual(marks(several), [], "a title for two creatures has no one level");
});

test("fl7: with several creatures each desk row's name carries its own save, and the line under it keeps its words", () => {
  const ask = request([{ characterId: "hero", total: 12 }, { characterId: "other" }]);
  ask.test = { kind: "save", choices: [{ ability: "str" }] };
  const html = render(createElement(DmCard, { request: ask, open: true, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.deepEqual(marks(html), [{ level: "none", words: "Hero" }, { level: "prof", words: "Other" }]);
  for (const target of ask.targets) assert.ok(text(html).includes(dmAnswerText(target, ask.test)));
});

test("fl7: a desk row marks the choice its answer recorded where the answer names it", () => {
  const ask = request([{ characterId: "hero", choice: 1, total: 17 }]);
  const html = render(createElement(DmCard, { request: ask, open: true, toggleRef() {}, onClose() {}, onToggle() {} }));
  const answer = dmAnswerText(ask.targets[0]!, ask.test);
  assert.equal(answer, "WIS (Perception): typed 17");
  assert.ok(text(html).includes(answer));
  assert.deepEqual(marks(html).slice(2), [{ level: "prof", words: "WIS (Perception)" }]);
});

test("fl7: a reopened desk row marks the choice its earlier answer recorded (FL7-SOL-02)", () => {
  const ask = request([{ characterId: "hero", previous: { choice: 1, total: 17 } }]);
  const html = render(createElement(DmCard, { request: ask, open: true, toggleRef() {}, onClose() {}, onToggle() {} }));
  const answer = dmAnswerText(ask.targets[0]!, ask.test);
  assert.equal(answer, "waiting again, was WIS (Perception): typed 17");
  assert.ok(text(html).includes(answer));
  assert.deepEqual(marks(html).slice(2), [{ level: "prof", words: "WIS (Perception)" }]);
});

test("fl7: a replaced answer marks its own choice and the one it replaced, each at its own level (FL7-SOL-02)", () => {
  const ask = request([{ characterId: "hero", choice: 0, total: 15, previous: { choice: 1, total: 9 } }]);
  const html = render(createElement(DmCard, { request: ask, open: true, toggleRef() {}, onClose() {}, onToggle() {} }));
  const answer = dmAnswerText(ask.targets[0]!, ask.test);
  assert.equal(answer, "DEX (Stealth): typed 15, changed from WIS (Perception): typed 9");
  assert.ok(text(html).includes(answer));
  assert.deepEqual(marks(html).slice(2), [{ level: "expert", words: "DEX (Stealth)" }, { level: "prof", words: "WIS (Perception)" }]);
});

test("fl7: the player card's question keeps its words and size, and marks the save for its one creature", () => {
  const ask = request();
  ask.test = { kind: "save", choices: [{ ability: "dex" }] };
  ask.dc = 14;
  const html = card(ask);
  const question = new RegExp(`<div style="font-size:16px;font-weight:700;line-height:1.2">(.*?)</div>`).exec(html)?.[1];
  assert.ok(question, "the question keeps its 16 px bold line");
  assert.equal(text(question), askLine(ask));
  assert.deepEqual(marks(question), [{ level: "prof", words: "Dexterity saving throw" }]);
  assert.doesNotMatch(html, /data-request-heading|data-request-tests/, "no added heading or test line");
});

test("fl7: a sent answer's line keeps its words, its test marked for the creature", () => {
  const ask = request([{ characterId: "hero", choice: 0, total: 17, result: "pass" }]);
  const html = card(ask);
  assert.ok(text(html).endsWith(chipLine(ask, ask.targets[0]!)));
  assert.deepEqual(marks(html).slice(-2), [{ level: "expert", words: "DEX (Stealth)" }, { level: "prof", words: "WIS (Perception)" }]);
});

test("fl7: two choices are marked in the picker, which names each one's level", () => {
  const html = card(request());
  assert.match(html, /aria-label="Dexterity \(Stealth\) \+6, expertise"/);
  assert.match(html, /aria-label="Wisdom \(Perception\) \+3, proficient"/);
  assert.ok(marks(html).some((m) => m.level === "expert" && m.words === "Dexterity (Stealth)"));
});

test("fl7: a rolled answer adds no test line and keeps Rolled with its total", () => {
  const ask = request([{ characterId: "hero", choice: 1, total: 17, result: "pass", dice: { formula: "1d20+3", faces: [14], total: 17 } }]);
  const visible = text(card(ask));
  assert.match(visible, /Rolled 17 \(1d20\+3: 14\)/);
  assert.equal(visible.match(/\b17\b/g)?.length, 1, "the total once, on the rolled line");
  assert.doesNotMatch(visible, /Perception 17/, "no test line beside the total");
});
