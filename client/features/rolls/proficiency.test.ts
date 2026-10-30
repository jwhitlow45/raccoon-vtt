import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { character, DM, room } from "#shared/testutil.ts";

const { createElement, createRef } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RollCard, RollChip } = await import("./PlayerRolls.tsx");
const { DmCard } = await import("./DmDesk.tsx");

function render(body: ReactNode): string {
  const state = room({ characters: { hero: character("hero", {
    name: "Hero", level: 5,
    stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["dex"], skills: { stealth: "expert", perception: "prof" } },
  }) } });
  const store = createStore(() => ({ view: state, you: DM, sceneId: "s1", roomId: "r1", connection: "open", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: body }),
  }));
}

function request(target: RollTarget = { characterId: "hero" }): RollRequest {
  return {
    id: "ask", rev: 1, at: "", dcShown: true, resultShown: true,
    test: { kind: "check", choices: [{ ability: "dex", skill: "stealth" }, { ability: "wis", skill: "perception" }] },
    targets: [target],
  };
}

function labels(html: string): string[] {
  return html.split('data-proficiency-label=""').slice(1);
}

test("fl7: an awaiting player chip shows both choices with their own proficiency", () => {
  const html = render(createElement(RollChip, { request: request(), onOpen() {} }));
  const parts = labels(html);
  assert.equal(parts.length, 2);
  assert.match(parts[0]!, /data-proficiency-marker="expert"/);
  assert.match(parts[0]!, />Stealth</);
  assert.match(parts[1]!, /data-proficiency-marker="prof"/);
  assert.match(parts[1]!, />Perception</);
});

test("fl7: the DM's one-creature heading marks both choices before an answer", () => {
  const html = render(createElement(DmCard, { request: request(), open: false, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.equal(labels(html).length, 2);
  assert.match(labels(html)[0]!, /data-proficiency-marker="expert"/);
  assert.match(labels(html)[1]!, /data-proficiency-marker="prof"/);
});

test("fl7: a chosen chip marks only the chosen skill and keeps its total beside it once", () => {
  const html = render(createElement(RollChip, { request: request({ characterId: "hero", choice: 1, total: 17 }), onOpen() {} }));
  assert.equal(labels(html).length, 1);
  assert.match(labels(html)[0]!, /data-proficiency-marker="prof"/);
  assert.match(html, /data-proficiency-name=""[^>]*>Perception 17</);
  const visible = html.replace(/<[^>]*>/g, "");
  assert.equal(visible.match(/\b17\b/g)?.length, 1);
});

test("fl7: a multi-creature heading keeps neutral skill names atomic and preserves alternate abilities", () => {
  const ask = request();
  ask.test.choices[0] = { ability: "str", skill: "stealth" };
  ask.targets.push({ characterId: "other" });
  const html = render(createElement(DmCard, { request: ask, open: false, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.equal(labels(html).length, 0, "a mixed group has no one proficiency");
  assert.match(html, /data-request-test-choice="0"[^>]*white-space:nowrap[^>]*>Stealth \(STR\)</);
  assert.match(html, /data-request-test-choice="1"[^>]*white-space:nowrap[^>]*>Perception</);
});

test("fl7: the player card's heading shows the creature's save proficiency before Later", () => {
  const ask = request();
  ask.test = { kind: "save", choices: [{ ability: "dex" }] };
  const html = render(createElement(RollCard, {
    request: ask, cardRef: createRef<HTMLElement>(), drafts: new Map(), sheet: false, hidden: false,
    stand: "toolbar", stickyHeader: false, whole: 0, onMeasure() {}, onFold() {}, onEngage() {}, onFocusWithin() {},
  }));
  const header = html.slice(0, html.indexOf('aria-label="Fold it into a chip'));
  assert.match(header, /data-proficiency-marker="prof"/);
  assert.match(header, /data-proficiency-name=""[^>]*>DEX save</);
});

test("fl7: a rolled answer keeps the selected label and total together without a duplicate result", () => {
  const ask = request({ characterId: "hero", choice: 1, total: 17, result: "pass", dice: { formula: "1d20+3", faces: [14], total: 17 } });
  const html = render(createElement(RollCard, {
    request: ask, cardRef: createRef<HTMLElement>(), drafts: new Map(), sheet: false, hidden: false,
    stand: "toolbar", stickyHeader: false, whole: 0, onMeasure() {}, onFold() {}, onEngage() {}, onFocusWithin() {},
  }));
  assert.match(html, /data-proficiency-name=""[^>]*>Perception 17</);
  const visible = html.replace(/<[^>]*>/g, "");
  assert.equal(visible.match(/\b17\b/g)?.length, 1);
  assert.match(visible, /Pass\. Final\./);
});

test("fl7: a reopened DM row retains both available choices and the previous answer's own choice", () => {
  const ask = request({ characterId: "hero", previous: { choice: 1, total: 17 } });
  const html = render(createElement(DmCard, { request: ask, open: true, toggleRef() {}, onClose() {}, onToggle() {} }));
  assert.equal(labels(html).length, 5, "two header choices, two waiting choices, one previous answer");
  assert.match(html, /data-proficiency-name=""[^>]*>Perception 17</);
  assert.match(html.replace(/<[^>]*>/g, ""), /waiting again, was typed Perception 17/);
});
