import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { targetKey } from "./logic.ts";
import { focusRollHeader, rollArrival } from "./rollFocus.ts";

type FocusNode = { isConnected: boolean; dataset?: { rollAnswerRow: string }; closest(selector?: string): FocusNode | null; contains(node: unknown): boolean };
function probe() {
  const card: FocusNode = { isConnected: true, closest: () => null, contains: (node) => node === card || node === thorn || node === ash };
  const row = (key: string): FocusNode => ({ isConnected: true, dataset: { rollAnswerRow: key }, closest() { return this; }, contains: () => false });
  const thorn: FocusNode = { isConnected: true, closest: (selector) => selector === "[data-roll-answer-row]" ? row("c:thorn") : null, contains: () => false };
  const ash: FocusNode = { isConnected: true, closest: (selector) => selector === "[data-roll-answer-row]" ? row("c:ash") : null, contains: () => false };
  const page: FocusNode = { isConnected: true, closest: () => null, contains: () => false };
  const document = { body: page, activeElement: thorn as FocusNode | null };
  let focuses = 0;
  let engaged = 0;
  let news = "";
  let rolled = new Set<string>();
  const focusedAnswer: { current: { key: string; node: FocusNode } | null } = { current: null };
  const seen = { current: null as Map<string, string | undefined> | null };
  const request: RollRequest = { id: "ask", rev: 0, at: "", dcShown: false, resultShown: false, test: { kind: "save", choices: [{ ability: "dex" }] }, targets: [{ characterId: "thorn" }, { characterId: "ash" }] };
  const render = () => {
    const before = seen.current;
    seen.current = new Map(request.targets.map((t) => [targetKey(t), t.tag]));
    const arrival = rollArrival(before, request.targets, "Thorn|Ash", { card, active: document.activeElement, body: page, prior: focusedAnswer.current });
    if (!arrival) return;
    rolled = new Set([...rolled, ...arrival.keys]);
    news = arrival.news;
    engaged++;
    if (arrival.focusHeader) focuses++;
  };
  const focus = (node: FocusNode) => {
    document.activeElement = node;
    const key = node.closest("[data-roll-answer-row]")?.dataset?.rollAnswerRow;
    if (key) focusedAnswer.current = { key, node };
  };
  const land = (id: string) => {
    request.targets = request.targets.map((t): RollTarget => t.characterId === id ? { ...t, tag: `${id}-roll`, total: 12, dice: { formula: "1d20", faces: [12], total: 12 } } : t);
    render();
  };
  render();
  return { thorn, ash, card, document, focusedAnswer, focus, land, get focuses() { return focuses; }, get engaged() { return engaged; }, get news() { return news; }, get rolled() { return rolled; } };
}

test("a sibling's result leaves focus on the unchanged row and still announces the result", () => {
  const p = probe(); p.focus(p.thorn); p.land("ash");
  assert.equal(p.focuses, 0);
  assert.equal(p.engaged, 1);
  assert.equal(p.news, "Ash rolled 12.");
  assert.deepEqual([...p.rolled], ["c:ash"]);
});

test("focus from a removed answer row goes to the header after that row lands", () => {
  const p = probe(); p.focus(p.thorn); p.thorn.isConnected = false;
  p.document.activeElement = p.card;
  p.land("thorn");
  assert.equal(p.focuses, 1);
});

test("a still-present control in a landed row keeps focus", () => {
  const p = probe(); p.focus(p.thorn); p.land("thorn");
  assert.equal(p.focuses, 0);
});

test("a sibling landing does not move card focus left by another removed row", () => {
  const p = probe(); p.focus(p.thorn); p.thorn.isConnected = false;
  p.document.activeElement = p.card;
  p.land("ash");
  assert.equal(p.focuses, 0);
});

test("a landed row whose focus fell to the body returns to the header", () => {
  const p = probe(); p.focus(p.thorn); p.thorn.isConnected = false;
  p.document.activeElement = p.document.body;
  p.land("thorn");
  assert.equal(p.focuses, 1);
});

test("a control outside the card keeps focus when a previously focused row lands", () => {
  const p = probe(); p.focus(p.thorn); p.thorn.isConnected = false;
  p.document.activeElement = { isConnected: true, closest: () => null, contains: () => false };
  p.land("thorn");
  assert.equal(p.focuses, 0);
});

test("opening on an existing result or seeing no new answer neither announces nor engages", () => {
  const node = { isConnected: true };
  const focus = { card: node, active: node, body: node, prior: null };
  const target: RollTarget = { characterId: "thorn", tag: "rolled", total: 12, dice: { formula: "1d20", faces: [12], total: 12 } };
  assert.equal(rollArrival(null, [target], "Thorn", focus), null);
  assert.equal(rollArrival(new Map([["c:thorn", "rolled"]]), [target], "Thorn", focus), null);
  assert.equal(rollArrival(new Map(), [target], "Thorn", focus), null);
  assert.equal(rollArrival(new Map([["c:thorn", undefined]]), [{ characterId: "thorn" }], "Thorn", focus), null);
});

test("lost page focus recovers to the card, including a removed control still reported as active", () => {
  const card = { isConnected: true };
  const body = { isConnected: true };
  const removed = { isConnected: false };
  const focus = { card, active: removed, body, prior: { key: "c:thorn", node: removed } };
  assert.equal(focusRollHeader(["c:thorn"], focus), true);
  assert.equal(focusRollHeader(["c:ash"], focus), false);
  assert.equal(focusRollHeader(["c:thorn"], { ...focus, active: null }), true);
  assert.equal(focusRollHeader(["c:thorn"], { ...focus, card: null, active: null }), false);
});

test("each rendered answer row exposes its own focus identity", async () => {
  const { createElement, createRef } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createStore } = await import("zustand/vanilla");
  const { RoomProvider } = await import("../../state/view.ts");
  const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
  const { RollCard } = await import("./PlayerRolls.tsx");
  const { character, DM, room } = await import("#shared/testutil.ts");
  const state = room({ characters: { thorn: character("thorn"), ash: character("ash") } });
  const request: RollRequest = { id: "ask", rev: 0, at: "", dcShown: false, resultShown: false, test: { kind: "save", choices: [{ ability: "dex" }] }, targets: [{ characterId: "thorn" }, { characterId: "ash" }] };
  const store = createStore(() => ({ view: state, you: DM, roomId: "r1", sceneId: "s1", connection: "open", local: { selectedIds: [], multi: false } }));
  const card = createElement(RollCard, { request, cardRef: createRef<HTMLElement>(), drafts: new Map(), sheet: false, hidden: false, stand: "toolbar", stickyHeader: false, whole: 0, onMeasure() {}, onFold() {}, onEngage() {}, onFocusWithin() {} });
  const html = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets: { url: () => "" } as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: card }) }));
  assert.deepEqual([...html.matchAll(/data-roll-answer-row="([^"]+)"/g)].map((m) => m[1]), ["c:thorn", "c:ash"]);
});
