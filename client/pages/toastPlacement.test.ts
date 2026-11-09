import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import * as React from "react";
import { dockedBarEdge, keptMapFoot, mapToastBox, measureMapToasts, lowerFloor, noticesBesideBar, noticesDock, phoneToastRoom, placeRoomToasts, putToastHosts, sheetToastFloor, sheetToastsToDismiss, toastStartTop } from "./toastPlacement.ts";
import { columnFacts, columnTop, EDGE, nextToastPlaces, NO_TOAST_PLACES, raisedRow, SHADOW_ROOM, SUMMARY_ROW, toastTop, type ColumnFacts } from "../canvas/barDock.ts";
import { pageHeightOf } from "../components/sheetCap.ts";
import { theme } from "../lib/theme.ts";

const { toastStacks } = await import("./ToastParts.tsx");
const { deskDrawnIds } = await import("../features/rolls/DmDesk.tsx");
const { playerDrawnIds } = await import("../features/rolls/PlayerRolls.tsx");
const { drawnIdsKey } = await import("../components/sheetFocus.ts");
const { alertColumnTop, columnMeasure, firstCardHeight, heldAfter, measureCards, summaryRowRules } = await import("../features/encounter/InitiativeStrip.tsx");
type HeldTop = Parameters<typeof alertColumnTop>[0]["held"];

test("FU40-B pl2-b: three unfolded cards end at 497, so the toast starts at 505, not 240", () => {
  // Browser capture at 390 x 844: the first card ends at 232, the column
  // starts at 108, and its three cards end at 497. No summary row stands in.
  const cards = { getBoundingClientRect: () => ({ height: 389 }) };
  const measured = measureCards(cards as never, 1, () => true, () => 124);
  const column = columnFacts(null, { top: 108, measured });
  assert.ok(column);
  assert.equal(column.first, 124, "folding still measures only the first card");
  const phone = { spanning: true, column, cards: true, optionsTop: 784 };
  assert.equal(toastTop(phone), 505, "the 8 px gap belongs below all three drawn cards");
  assert.equal(toastTop({ ...phone, optionsTop: 505 + 44 }), 505);
  assert.equal(toastTop({ ...phone, optionsTop: 505 + 44 - 1 }), null, "without a full toast row it stays above the column");
  assert.equal(toastTop({ ...phone, cards: false }), null, "a folded column places no toast underneath its hidden cards");
  const single = columnFacts(null, { top: 108, measured: measureCards({ getBoundingClientRect: () => ({ height: 124 }) } as never, 1, () => true, () => 124) });
  assert.equal(toastTop({ ...phone, column: single }), 240, "one drawn card keeps the original 8 px gap");
});

test("ALERTS-FIRSTCARD: a 359 px desk measures its first trap card, not the whole stack", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { room, trap } = await import("#shared/testutil.ts");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RoomProvider } = await import("../state/view.ts");
  const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
  const { DmDesk } = await import("../features/rolls/DmDesk.tsx");
  class Element {
    height: number;
    children: Element[];
    dataset: { alert?: string; alertStack?: string };
    display: string;
    constructor(height: number, children: Element[] = [], dataset: { alert?: string; alertStack?: string } = {}, display = "block") {
      this.height = height;
      this.children = children;
      this.dataset = dataset;
      this.display = display;
    }
    getBoundingClientRect() { return { height: this.height }; }
  }
  // firstCard tells a card from a wrapper by `instanceof HTMLElement` and its computed display.
  const fakes = { window: { innerWidth: 320 / 1.3, innerHeight: 568 / 1.3 }, HTMLElement: Element, getComputedStyle: (e: Element) => ({ display: e.display }) };
  const olds = Object.entries(fakes).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const firstHeight = (el: Element) => firstCardHeight(el as never);
  try {
    for (const [name, value] of Object.entries(fakes)) Object.defineProperty(globalThis, name, { configurable: true, value });
    const traps = Object.fromEntries(Array.from({ length: 7 }, (_, i) => {
      const t = trap(`trap${i}`);
      return [t.id, { ...t, rig: { ...t.rig!, due: [{ id: `due${i}`, at: "2026-10-30T00:00:00Z", how: "enter" as const, by: [], hits: [] }] } }];
    }));
    const store = createStore(() => ({ view: room({ traps }), roomId: "r1", sceneId: "s1", you: { memberId: "dm1", role: "dm" }, connection: "open", pending: [], local: { panel: null, panelList: false, sheetHidden: false } }));
    const html = renderToStaticMarkup(React.createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: React.createElement(RoomScopeProvider, { scope: new RoomScope(), children: React.createElement(DmDesk) }) }));
    const outer = /^<div\b([^>]*)>/.exec(html);
    assert.ok(outer, "the desk renders its stack");
    const stack = new Element(359, [new Element(62), new Element(237), new Element(44)], /data-alert-stack=""/.test(outer[1]!) ? { alertStack: "" } : {}, "grid");
    const cards = new Element(359, [new Element(0, [stack], { alert: "rolls" }, "contents")]);
    assert.equal(firstHeight(cards), 62, "the 359 px desk must not become the first card");
    const zoom = 1.3;
    const first = firstHeight(cards) / zoom;
    const measured = measureCards(cards as never, zoom, () => true, firstHeight as never);
    const facts = columnFacts(null, { top: 120, measured });
    assert.ok(facts);
    assert.equal(200 < EDGE + first, false, "the 200 px lane can keep the first card without folding");
    assert.equal(toastTop({ spanning: true, column: facts, cards: true, optionsTop: 500 }), 120 + 359 / zoom + EDGE, "a waiting toast clears every card in the desk, not only the first");
    assert.equal(toastTop({ spanning: true, column: facts, cards: true, optionsTop: 400 }), null, "with no room under the stack, a toast cannot cover its later cards");
    const hidden = new Element(0);
    const turn = new Element(44, [], { alert: "turn" });
    assert.equal(firstHeight(new Element(44, [hidden, turn])), 0, "a lone turn card still cannot force a fold");
    assert.equal(measureCards(new Element(44, [hidden, turn]) as never, 1, () => true, firstHeight as never)!.cover, 44, "toasts still clear a lone turn card");
    const wholeCard = new Element(150, [new Element(44)], {}, "grid");
    assert.equal(firstHeight(new Element(150, [wholeCard])), 150, "a card's own grid must not be reduced to its header");
  } finally {
    for (const [name, old] of olds) {
      if (old) Object.defineProperty(globalThis, name, old);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

/** A portal host move blurs its descendant, as insertBefore does in the browser. */
function page() {
  const doc = { activeElement: null as Host | null };
  class Host {
    children: Host[] = [];
    parent: Host | null = null;
    focusCalls = 0;
    options: FocusOptions | undefined;
    ownerDocument = doc;
    get firstChild(): Host | null { return this.children[0] ?? null; }
    get nextSibling(): Host | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
    contains(node: Host | null): boolean { return node === this || this.children.some((c) => c.contains(node)); }
    insertBefore(node: Host, before: Host | null) {
      if (node.parent) {
        node.parent.children.splice(node.parent.children.indexOf(node), 1);
        if (node.contains(doc.activeElement)) doc.activeElement = null;
      }
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
      node.parent = this;
    }
    remove() {
      if (this.contains(doc.activeElement)) doc.activeElement = null;
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    focus(options?: FocusOptions) { doc.activeElement = this; this.options = options; this.focusCalls++; }
  }
  const stack = new Host();
  const other = new Host();
  const first = new Host();
  const moved = new Host();
  const action = new Host();
  const root = new Host();
  root.insertBefore(stack, null);
  root.insertBefore(other, null);
  stack.insertBefore(first, null);
  other.insertBefore(moved, null);
  moved.insertBefore(action, null);
  return { doc, stack, other, first, moved, action, place: (hosts: Host[]) => putToastHosts(stack as unknown as HTMLElement, hosts as unknown as HTMLElement[]) };
}

// The fake commit removes omitted stacks before the real placement helper
// runs, matching React's mutation/layout order.
type Rendered = { props: { children?: React.ReactNode; stack?: unknown } };
function keptStacks(rendered: Rendered): unknown[] {
  return React.Children.toArray(rendered.props.children).flatMap((node) => {
    const element = isElement(node) ? node : isElement((node as { children?: unknown }).children) ? ((node as { children: Rendered }).children) : null;
    return element ? [element.props.stack] : [];
  });
}
function isElement(node: unknown): node is Rendered {
  return React.isValidElement(node);
}

for (const direction of ["notices to layer", "layer to notices"] as const) test(`FU39-ASTRA-01: a focused sole toast survives ${direction} through the commit`, () => {
  const p = page();
  p.first.remove();
  const toLayer = direction === "notices to layer";
  const source = toLayer ? p.stack : p.other;
  const target = toLayer ? p.other : p.stack;
  source.insertBefore(p.moved, null);
  p.action.focus();
  const rendered = toastStacks({ layer: { nodeType: 1 } as unknown as HTMLElement, lowAt: toLayer ? { top: 100, edges: null } : null, stacks: { notices: p.stack, layer: p.other } as never }) as Rendered;
  const kept = keptStacks(rendered);
  for (const stack of [p.stack, p.other]) if (!kept.includes(stack)) stack.remove();
  putToastHosts(target as unknown as HTMLElement, [p.moved as unknown as HTMLElement]);
  assert.equal(p.doc.activeElement, p.action, "the source stack must stay connected until its focused toast moves");
  assert.equal(source.children.length, 0);
  assert.deepEqual(target.children, [p.moved]);
});

test("FU39-B: a focused toast action keeps focus when its host moves between stacks", () => {
  const p = page();
  p.action.focus();
  p.place([p.first, p.moved]);
  assert.equal(p.doc.activeElement, p.action);
  assert.deepEqual(p.action.options, { preventScroll: true });
  assert.deepEqual(p.stack.children, [p.first, p.moved]);
});

test("FU39-B: reorder restores only the focus that moved, and a stable stack never refocuses", () => {
  const p = page();
  p.place([p.first, p.moved]);
  p.action.focus();
  p.place([p.moved, p.first]);
  assert.equal(p.doc.activeElement, p.action);
  const calls = p.action.focusCalls;
  p.place([p.moved, p.first]);
  assert.equal(p.action.focusCalls, calls);
  p.other.focus();
  p.place([p.first, p.moved]);
  assert.equal(p.doc.activeElement, p.other);
  assert.equal(p.other.focusCalls, 1);
});

test("FU39-B: the toast awaiting its own card cannot make a shorter kept map toast block it", () => {
  const input = { ids: [1, 2], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set([2]) };
  const before = nextToastPlaces(NO_TOAST_PLACES, input);
  const boxes = [{ id: 1, bottom: 112 * 1.3 }, { id: 2, bottom: 226 * 1.3 }];
  const foot = keptMapFoot(boxes, before.awaitCard, 1.3);
  assert.ok(foot !== null && Math.abs(foot - 112) < 1e-9);
  const after = nextToastPlaces(before, { ...input, low: 131, mapFoot: foot });
  assert.equal(after.places.get(1), "map");
  assert.deepEqual(after.places.get(2), { low: 131, column: true });
  assert.equal(keptMapFoot([boxes[1]!], new Set([2]), 1.3), null);
  assert.equal(keptMapFoot([], new Set(), 1), null);
  assert.equal(keptMapFoot(boxes, new Set(), 1.3), 226);
  const blocked = nextToastPlaces(before, { ...input, low: 100, mapFoot: foot });
  assert.equal(blocked.places.get(2), "map", "a kept toast that really overlaps still keeps the new one below it");
});

test("FU39-B: a first card clears an older toast while its new toast moves below the card once", () => {
  const input = { ids: [1, 2], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set([2]) };
  const before = nextToastPlaces(NO_TOAST_PLACES, input);
  for (const zoom of [1, 1.3]) {
    const kept = { id: 1, top: 68, bottom: 112 };
    const foot = keptMapFoot([{ id: 1, bottom: kept.bottom * zoom }, { id: 2, bottom: 226 * zoom }], before.awaitCard, zoom);
    const top = columnTop(60, null, foot);
    const card = { top, bottom: top + 55 };
    assert.ok(kept.bottom <= card.top, "the kept toast must not cover the first card's header");
    const low = card.bottom + 8;
    const placed = nextToastPlaces(before, { ...input, low, mapFoot: foot });
    assert.equal(placed.places.get(1), "map", "the older toast stays where it is being read");
    assert.deepEqual(placed.places.get(2), { low, column: true });
    const nextFoot = keptMapFoot([{ id: 1, bottom: kept.bottom * zoom }], placed.awaitCard, zoom);
    assert.equal(columnTop(60, null, nextFoot), top, "moving the new toast must not move its card again");
    const settled = nextToastPlaces(placed, { ...input, low, mapFoot: nextFoot, recent: new Set<number>() });
    assert.deepEqual(settled.places, placed.places, "aging out of CARD_MS must not move either toast");
  }
});

test("HF-41 R1: a kept notice followed by a trap and its card places the trap toast below the card before an observer runs", () => {
  for (const zoom of [1, 1.3]) {
    const input = { ids: [1], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set<number>() };
    let placed = nextToastPlaces(NO_TOAST_PLACES, input);
    const kept = { id: 1, top: 68 * zoom, bottom: 112 * zoom };
    const keptFoot = keptMapFoot([kept], placed.awaitCard, zoom);
    const top = columnTop(60, null, keptFoot);
    const state = { column: null as ColumnFacts | null, bar: null };
    let cardHeight = 0;
    let dependencies: readonly unknown[] | undefined;
    let cleanUp: (() => void) | undefined;
    const inputs = { rolls: null as object | null, turnFolded: false, turnHidden: false };
    const dock = { getState: () => state, setState: (patch: { column: ColumnFacts | null }) => Object.assign(state, patch) };
    const alerts: never[] = [];
    const cards = { current: { getBoundingClientRect: () => ({ height: cardHeight * zoom }) } as unknown as HTMLElement };
    // A child can publish its trap card after the empty column measured.
    // Run React's dependency check without delivering ResizeObserver yet.
    const measure = () => {
      const next = columnMeasure({
        cards, colTop: top, zoom, dock, alerts, rolls: inputs.rolls, summarized: false, folded: false, forFootCard: false, forRoom: false, overlay: false, rowLift: 0,
        turnFolded: inputs.turnFolded, turnHidden: inputs.turnHidden, isDrawn: () => true, firstHeight: () => cardHeight * zoom, setFirstHeight: () => {}, observe: () => () => {},
      });
      if (dependencies && next.deps.every((value, i) => Object.is(value, dependencies![i]))) return;
      cleanUp?.();
      dependencies = next.deps;
      cleanUp = next.effect();
    };
    measure();
    assert.equal(state.column, null, "Wait here stands above an empty column");
    const waiting = { ...input, ids: [1, 2], recent: new Set([2]), mapFoot: keptFoot };
    placed = nextToastPlaces(placed, waiting);
    assert.equal(placed.places.get(2), "map");
    assert.deepEqual([...placed.awaitCard], [2], "the trap waits for its card's first measurement");
    const map = mapToastBox([kept, { id: 2, top: 120 * zoom, bottom: 226 * zoom }], placed.awaitCard, zoom, { top: 68 * zoom, bottom: 226 * zoom });
    assert.equal(columnTop(60, null, map!.keptBottom), top, "the waiting toast must not move the card");
    cardHeight = 62;
    inputs.rolls = { text: "Stepstone went off", requests: 1 };
    measure();
    const low = toastTop({ spanning: true, column: state.column, cards: true, optionsTop: 780 });
    placed = nextToastPlaces(placed, { ...waiting, low });
    assert.deepEqual(placed.places.get(2), { low: top + cardHeight + EDGE, column: true }, "the trap toast must clear the card in its first visible frame");
    assert.equal(placed.places.get(1), "map", "the kept notice stays where it is being read");
    assert.ok(top >= kept.bottom / zoom + EDGE);
    const settled = nextToastPlaces(placed, { ...waiting, low, recent: new Set<number>() });
    assert.deepEqual(settled.places, placed.places, "the trap toast must not move again after its card wait ends");
    cardHeight = 44;
    inputs.turnFolded = true;
    measure();
    assert.equal((state.column as ColumnFacts | null)?.cover, 44, "HF41-R2-1: folding remeasures the first card before ResizeObserver runs");
    cardHeight = 0;
    inputs.turnHidden = true;
    measure();
    assert.equal(state.column, null, "HF41-R2-1: hiding remeasures the empty column in the same frame");
    cleanUp?.();
  }
});

test("HF-41 R2: over the screen the column keeps its last measures, and a summary row stands in for cards that have no room", () => {
  const state = { column: null as ColumnFacts | null, bar: null as { lane?: string } | null };
  const dock = { getState: () => state, setState: (patch: { column: ColumnFacts | null }) => Object.assign(state, patch) };
  let height = 100;
  const cards = { current: { getBoundingClientRect: () => ({ height }) } as unknown as HTMLElement };
  const base = { cards, colTop: 60, zoom: 1, dock, alerts: [], rolls: null, summarized: false, folded: false, forFootCard: false, forRoom: false, overlay: false, rowLift: 0, turnFolded: false, turnHidden: false, isDrawn: () => true, firstHeight: () => 44, setFirstHeight() {}, observe: () => () => {} };
  const run = (patch: Partial<typeof base>) => columnMeasure({ ...base, ...patch }).effect();
  run({});
  assert.deepEqual(state.column, { top: 60, content: 100, first: 44, cover: 100 });
  height = 200;
  run({ overlay: true });
  assert.equal(state.column?.content, 100, "the alerts over the screen say nothing of the column");
  run({ forRoom: true });
  assert.deepEqual(state.column, { top: 60, content: SUMMARY_ROW, first: SUMMARY_ROW }, "the row is the column's one card while the cards have no room");
  run({ forRoom: true, summarized: true, rowLift: 30 });
  assert.equal(state.column?.top, 30, "a row raised over the bars gives the bar below it the room it left");
  run({ forRoom: true, summarized: false, rowLift: 30 });
  assert.equal(state.column?.top, 60, "a row that has not risen leaves the top");
  state.bar = { lane: "summary" };
  run({ forRoom: true });
  assert.equal(state.column?.content, 200, "a bar already in the summary lane measures the cards again");
});

/** Render the column's top, then commit what it keeps for the render after. */
function alertColumnRender() {
  let held: HeldTop = null;
  const inputs = {
    chrome: { top: 52, bottom: 60 } as { top: number; bottom: number } | null,
    alerts: [{ id: "turn:1", kind: "turn" }] as { id: string; kind: string; says?: string }[],
    turnHidden: false, folded: false, rolls: null as { drawnIds: string[] } | null,
    forFootCard: false, forPane: false, overlay: false, laneRow: null as string | null, barSummary: null as object | null,
    asked: null as string | null, roomSummary: {} as object | null, firstHeight: 80, height: 844,
    noticesSpanning: true, zoom: 1, lasting: null as number | null,
    mapToasts: null as { keptBottom: number | null } | null,
  };
  return (patch: Partial<typeof inputs> = {}) => {
    Object.assign(inputs, patch);
    const column = alertColumnTop({ ...inputs, held });
    held = heldAfter(column);
    return column.colTop;
  };
}

test("FU40B-OPUS-2: the drawn card set and layout release a pushed top in the same render", () => {
  const changes = [
    { name: "next turn", patch: { alerts: [{ id: "turn:2", kind: "turn" }] }, top: 60 },
    { name: "another alert arrives", patch: { alerts: [{ id: "turn:1", kind: "turn" }, { id: "check:1", kind: "concentration" }] }, top: 60 },
    { name: "turn card is hidden", patch: { turnHidden: true }, top: 60 },
    { name: "column empties", patch: { alerts: [] }, top: 60 },
    { name: "column folds under a sheet", patch: { folded: true }, top: 60 },
    { name: "rotation puts notices beside the lane", patch: { noticesSpanning: false }, top: 60 },
    { name: "lane top moves", patch: { chrome: { top: 64, bottom: 60 } }, top: 72 },
    { name: "pane summary hides the cards", patch: { forPane: true }, top: 60 },
    { name: "bar summary hides the cards", patch: { laneRow: "bar", barSummary: {} }, top: 60 },
    { name: "foot-card summary hides the cards", patch: { forFootCard: true }, top: 60 },
    { name: "cards move to the overlay", patch: { overlay: true }, top: 60 },
    { name: "shorter room would hide the latched cards", patch: { height: 220 }, top: 60 },
    { name: "interface zoom changes", patch: { zoom: 1.3 }, top: 60 },
  ];
  for (const change of changes) {
    const render = alertColumnRender();
    assert.equal(render({ mapToasts: { keptBottom: 112 } }), 120);
    assert.equal(render({ mapToasts: null }), 120, `${change.name}: toast expiry alone must not move a live button`);
    assert.equal(render(change.patch), change.top, `${change.name}: the release cannot wait for another render`);
    assert.equal(render(), change.top, `${change.name}: the next render cannot restore the stale push`);
  }
  const render = alertColumnRender();
  const a = { id: "a", kind: "notice", says: "First words" };
  const b = { id: "b", kind: "notice", says: "Second words" };
  assert.equal(render({ alerts: [a, b], mapToasts: { keptBottom: 112 } }), 120);
  assert.equal(render({ alerts: [{ ...b, says: "Changed words" }, a], mapToasts: null }), 120, "reordering the same IDs or changing their words preserves the latch");
  assert.equal(render({ alerts: [a] }), 60, "removing a drawn card releases it");
  assert.equal(render({ alerts: [], rolls: { drawnIds: ["roll:r1"] }, mapToasts: { keptBottom: 112 } }), 120);
  assert.equal(render({ mapToasts: null }), 120);
  assert.equal(render({ rolls: { drawnIds: ["roll:r2"] } }), 60, "same-count roll replacements have distinct identity");
  let seed = 502;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let sequence = 0; sequence < 100; sequence++) {
    const draw = alertColumnRender();
    const foot = 90 + Math.floor(random() * 100);
    assert.equal(draw({ mapToasts: { keptBottom: foot } }), foot + EDGE);
    for (let frame = 0, count = 1 + Math.floor(random() * 5); frame < count; frame++) {
      assert.equal(draw({ mapToasts: null }), foot + EDGE, "toast-only renders preserve the pushed top");
    }
    const change = changes[Math.floor(random() * changes.length)]!;
    assert.equal(draw(change.patch), change.top, "an identity or layout change releases independently of the toast's age");
  }
});

test("FU40B-OPUS-2: a latch that would hide the cards is not kept for the render after", () => {
  const render = alertColumnRender();
  assert.equal(render({ mapToasts: { keptBottom: 112 } }), 120);
  // Too short for the cards under the pushed top: the push stays for the toast still there, but is no longer the cards' to keep.
  assert.equal(render({ height: 220 }), 120);
  assert.equal(render({ height: 844, mapToasts: null }), 60, "the toast leaving after a cramped render releases the cards");
});

test("FU40B-OPUS-2: roll publications track the IDs drawn, including same-count replacements", () => {
  assert.deepEqual(deskDrawnIds({ traps: [{ due: { id: "spring1" } }], asks: [{ id: "ask1" }], cards: [{ id: "request1" }], button: true }), ["trap:spring1", "cast:ask1", "roll:request1", "rolls:summary"]);
  assert.deepEqual(deskDrawnIds({ traps: [], asks: [], cards: [], button: true }), ["rolls:summary"]);
  assert.deepEqual(playerDrawnIds({ shown: { id: "r1" }, cardDrawn: true, chips: [{ id: "r2" }], button: true }), ["roll:r1", "chip:r2", "rolls:summary"]);
  assert.deepEqual(playerDrawnIds({ shown: { id: "r1" }, cardDrawn: false, chips: [], button: false }), [], "a hidden or foot card is not in the column");
  assert.equal(drawnIdsKey(["roll:a", "roll:b"]), drawnIdsKey(["roll:b", "roll:a"]), "reordering identical IDs does not publish a new set");
  assert.notEqual(drawnIdsKey(["roll:a", "roll:b"]), drawnIdsKey(["roll:c", "roll:b"]), "same words and count still publish a replacement card");
  assert.equal(drawnIdsKey(undefined), drawnIdsKey([]));
});

test("FU40B-OPUS-2: a rotation publishes beside-lane placement even with no lasting notice", () => {
  assert.equal(noticesDock(true, null).noticesSpanning, false);
  assert.equal(noticesDock(false, null).noticesSpanning, true);
  assert.deepEqual(noticesDock(true, 90), { notices: null, lasting: 90, noticesSpanning: false }, "beside the lane the notices leave the column be, but the bar still keeps clear");
  assert.deepEqual(noticesDock(false, 90), { notices: 90, lasting: 90, noticesSpanning: true });
});

test("FU39-ASTRA-04 and FU39-S-2: a turn keeps its pushed top after the aged toast moves or expires", () => {
  const input = { ids: [1], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set<number>() };
  const before = nextToastPlaces(NO_TOAST_PLACES, input);
  const top = columnTop(60, null, 112);
  assert.equal(top, 120);
  const moved = nextToastPlaces(before, { ...input, low: top + 55 + EDGE, turnStarted: true });
  assert.deepEqual(moved.places.get(1), { low: 183, column: true });
  const released = columnTop(60, null, null, top);
  const toast = moved.places.get(1);
  assert.ok(typeof toast === "object");
  assert.equal(toast.low - (released + 55), 8, "reservation release must leave 8 px, not 68 px");
  assert.equal(columnTop(60, null, null, top), top, "an older toast timing out cannot move a live card");
  assert.equal(columnTop(60, null, 140, top), 148, "a taller kept toast still clears the card");
  assert.equal(columnTop(60, null, null, null), 60, "an empty column releases the held top");
});

test("FU39-B: the room publishes visible spanning toasts and the column uses only the kept foot", () => {
  for (const zoom of [1, 1.3]) {
    const kept = { id: 1, top: 68 * zoom, bottom: 112 * zoom };
    const waiting = { id: 2, top: 120 * zoom, bottom: 226 * zoom };
    const state: { mapToasts: ReturnType<typeof mapToastBox> } = { mapToasts: null };
    const props = { spanning: true };
    const overMap = [kept, waiting];
    const measure = () => {
      const now = measureMapToasts({ notices: { getBoundingClientRect: () => ({ top: 68 * zoom, bottom: 226 * zoom }) }, overMap, boxOf: (id) => overMap.find((b) => b.id === id), awaitCard: new Set([2]), zoom, spanning: props.spanning, wasMap: state.mapToasts });
      if (now.changed) state.mapToasts = now.mapBox;
    };
    measure();
    assert.ok(state.mapToasts, "the room must publish clearance before the first card is placed");
    const placeColumn = alertColumnRender();
    const top = placeColumn({ mapToasts: state.mapToasts });
    assert.equal(placeColumn({ mapToasts: null }), top, "the mounted column keeps its latched top when the toast leaves");
    assert.equal(placeColumn({ alerts: [] }), 60, "an empty column ignores the latch");
    assert.ok(top !== null && Math.abs(top - 120) < 1e-9, "the real column must clear the kept toast without reserving the waiting toast");
    const rules = summaryRowRules({
      usual: { left: 12, right: 378, top: 160 * zoom, height: 44 * zoom },
      chrome: { safe: { left: 0 }, top: 60, controls: 60 }, zoom, height: 844, ceiling: 0,
      lasting: null, mapToasts: state.mapToasts, toastRow: null, controls: [],
    });
    const summary = raisedRow(rules);
    assert.ok(summary && summary.top + rules.row.height <= kept.top, "a raised summary must clear even the waiting map toast");
    props.spanning = false;
    measure();
    assert.equal(state.mapToasts, null, "toasts beside the lane do not push its cards");
    props.spanning = true;
    measure();
    overMap.length = 0;
    measure();
    assert.equal(state.mapToasts, null, "an empty map stack releases its clearance");
  }
});

/** The Room's frames for the toasts over the map: places in render, then the boxes read after the hosts are placed. */
function roomToasts(zoom: number, ids: number[], overMap: { id: number; top: number; bottom: number }[]) {
  const state = {
    placed: NO_TOAST_PLACES, floorWas: null as number | null, measured: null as ReturnType<typeof measureMapToasts>["measured"], mapFoot: null as number | null,
    mapToasts: null as ReturnType<typeof mapToastBox>, recent: new Set<number>(),
  };
  const frame = (props: { low: number | null; columnTop: number | null }) => {
    state.placed = placeRoomToasts({
      was: state.placed, ids, recent: state.recent, spanning: true, restFloor: null, floorWas: state.floorWas, layerFoot: null, shown: new Set<number>(), measured: state.measured, zoom,
      pane: null, paneStands: false, low: props.low, columnTop: props.columnTop, layer: true, slot: false, turned: false, mapFoot: state.mapFoot, overBar: undefined, turnStarted: false,
    });
    state.floorWas = null;
    const now = measureMapToasts({ notices: { getBoundingClientRect: () => overMap[0]! }, overMap, boxOf: (id) => overMap.find((b) => b.id === id), awaitCard: state.placed.awaitCard, zoom, spanning: true, wasMap: state.mapToasts });
    state.mapFoot = now.mapFoot;
    state.measured = now.measured;
    if (now.changed) state.mapToasts = now.mapBox;
  };
  return { state, frame };
}

test("FU40-B pl2-b: a toast above a full measured column reserves space immediately", () => {
  let seed = 320568;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let sequence = 0; sequence < 100; sequence++) {
    const zoom = sequence % 2 ? 1.3 : 1;
    const unmeasured = sequence % 4 < 2;
    // The 320 x 568 capture: cards start at 108 and end at 497, while
    // the fallback toast occupies 116..160 and covers the first title.
    const toast = { id: 1, top: 116 * zoom, bottom: 160 * zoom };
    const facts = { top: 108, content: 389, cover: 389, first: 124 };
    const low = toastTop({ spanning: true, column: facts, cards: true, optionsTop: 508 });
    assert.equal(low, null, "the full column leaves under 44 px below it");
    const props = { low, columnTop: unmeasured ? null : 108 };
    const room = roomToasts(zoom, [1], [toast]);
    room.state.recent = new Set([1]);
    const frame = () => room.frame(props);
    if (unmeasured) {
      for (let i = 0, count = 1 + Math.floor(random() * 4); i < count; i++) {
        frame();
        assert.equal(room.state.mapToasts?.keptBottom, null, "an unmeasured card must not be pushed by its waiting toast");
        assert.ok(room.state.placed.awaitCard.has(1));
      }
      props.columnTop = 108;
    }
    frame();
    const top = columnTop(108, null, room.state.mapToasts?.keptBottom ?? null, 108);
    assert.equal(top, 168, "a measured full column must clear the fallback toast before it ages out");
    assert.equal(top - toast.bottom / zoom, EDGE, "the first card stands exactly 8 px below the toast");
    assert.equal(room.state.placed.awaitCard.size, 0, "no room under a measured card ends the provisional exclusion");
    props.columnTop = top;
    for (let i = 0, count = 1 + Math.floor(random() * 4); i < count; i++) {
      if (random() < 0.5) room.state.recent.clear();
      frame();
      assert.equal(columnTop(108, null, room.state.mapToasts?.keptBottom ?? null, top), top, "repeated measurement and aging must not push the cards again");
      assert.equal(room.state.placed.places.get(1), "map", "the fallback toast stays where it was read");
    }
  }
});

test("FU39-B: only the visible part of a scrolling toast reserves column space", () => {
  const boxes = [{ id: 1, top: 10, bottom: 90 }, { id: 2, top: 98, bottom: 300 }];
  assert.deepEqual(mapToastBox(boxes, new Set([2]), 1, { top: 50, bottom: 150 }), { top: 50, bottom: 150, keptBottom: 90 });
  assert.deepEqual(mapToastBox(boxes, new Set([2]), 1, { top: 100, bottom: 150 }), { top: 100, bottom: 150, keptBottom: null });
  assert.equal(mapToastBox(boxes, new Set(), 1, { top: 310, bottom: 400 }), null);
});

test("FU39-B: an older toast that ages out as the card arrives waits for the column's corrected top", () => {
  let seed = 359;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let sequence = 0; sequence < 200; sequence++) {
    const zoom = sequence % 2 ? 1.3 : 1;
    const keptBottom = 100 + Math.floor(random() * 120);
    const cardHeight = 44 + Math.floor(random() * 100);
    const input = { ids: [1, 2], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set([1, 2]) };
    let placed = nextToastPlaces(NO_TOAST_PLACES, input);
    const props = { low: 60 + cardHeight + EDGE, columnTop: 60 };
    const recent = new Set([2]);
    const measured = { boxes: [{ id: 1, top: 68 * zoom, bottom: keptBottom * zoom }], clip: { top: 68 * zoom, bottom: keptBottom * zoom } };
    const run = () => {
      placed = placeRoomToasts({
        was: placed, ids: [1, 2], recent, spanning: true, restFloor: null, floorWas: null, layerFoot: null, shown: new Set<number>(), measured, zoom,
        pane: null, paneStands: false, low: props.low, columnTop: props.columnTop, layer: true, slot: false, turned: false, mapFoot: null, overBar: undefined, turnStarted: false,
      });
    };
    for (let pending = 0, count = 1 + Math.floor(random() * 4); pending < count; pending++) {
      run();
      assert.equal(placed.places.get(2), "map", `sequence ${sequence}: the new toast cannot commit to the card's stale top`);
    }
    props.columnTop = keptBottom + EDGE;
    props.low = props.columnTop + cardHeight + EDGE;
    run();
    assert.equal(placed.places.get(1), "map", "the toast being read stays put");
    const settled = { low: props.low, column: true };
    assert.deepEqual(placed.places.get(2), settled);
    recent.clear();
    run();
    assert.deepEqual(placed.places.get(2), settled, "the new toast moves only once across delayed measurements and aging");
  }
});

test("FU39-B: the room hands a resting strip and a turn's start on to the placement", () => {
  const base = { was: NO_TOAST_PLACES, ids: [1], recent: new Set<number>(), spanning: true, restFloor: null, floorWas: null, layerFoot: null, shown: new Set<number>(), measured: null, zoom: 1, pane: null, paneStands: false, low: null, columnTop: null, layer: true, slot: false, turned: false, mapFoot: null, overBar: undefined, turnStarted: false };
  const low = placeRoomToasts({ ...base, recent: new Set([1]), low: 150 });
  assert.deepEqual(low.places.get(1), { low: 150, column: true });
  // As resting begins, a stack drawn lower than the room's new foot takes its place anew, and one drawn above it stays.
  const lower = placeRoomToasts({ ...base, was: low, restFloor: 400, layerFoot: 500 });
  assert.equal(lower.places.get(1), "map");
  assert.deepEqual(placeRoomToasts({ ...base, was: low, restFloor: 400, layerFoot: 300 }).places.get(1), { low: 150, column: true });
  assert.deepEqual(placeRoomToasts({ ...base, was: low, restFloor: 400, floorWas: 400, layerFoot: 500 }).places.get(1), { low: 150, column: true }, "a floor that did not rise places nothing anew");
  // A turn's first card takes an aged toast under it, which a card that comes at another time does not.
  const aged = placeRoomToasts({ ...base });
  assert.equal(aged.places.get(1), "map");
  assert.deepEqual(placeRoomToasts({ ...base, was: aged, low: 183, turnStarted: true }).places.get(1), { low: 183, column: true });
  assert.equal(placeRoomToasts({ ...base, was: aged, low: 183 }).places.get(1), "map");
});

// UNDOB-FIN-2: 320 x 568 at 130% is 246 x 437 in the chrome's own px, the toolbar 60.
test("a phone's open sheet sets the toasts' floor as a resting strip would, and only the toasts'", () => {
  const at = (mode: "none" | "bottom" | "side" | "full", toolbar: number | null = 60, sheetHeight = 280, keyboard: number | null = null) => sheetToastFloor({ mode, height: 437, toolbar, sheetHeight, keyboard });
  assert.equal(at("bottom"), 437 - 60 - 280 - EDGE - 44 - EDGE, "a bottom sheet: 60 px above its top, which sits on the toolbar");
  assert.equal(at("side"), 0, "beside a sideways sheet no room, so the one row");
  assert.equal(at("full"), null, "a full sheet holds its own toasts");
  assert.equal(at("none"), null, "no sheet, or a wide screen's side panel");
  assert.equal(at("bottom", null), null, "the toolbar not measured yet");
  assert.equal(at("bottom", 60, 0), null, "the sheet not measured yet");
});

// LOOK1-SOL-001: Sheet stands its foot on the keyboard where that reaches higher than the toolbar (sheetCap.ts sheetFoot).
test("with the on-screen keyboard open the sheet's floor follows the sheet's real top", () => {
  const floor = (keyboard: number | null, toolbar = 60) => sheetToastFloor({ mode: "bottom", height: 844, toolbar, sheetHeight: 468, keyboard });
  assert.equal(floor(300), 16, "the sheet starts at 76 on the keyboard, so the floor is 60 above that, not 256");
  assert.equal(floor(null), 844 - 60 - 468 - 60, "no keyboard: on the toolbar");
  assert.equal(floor(40), floor(null), "a keyboard under the toolbar's top changes nothing");
  assert.equal(floor(60), floor(null));
  assert.equal(floor(300, null as unknown as number), null, "the toolbar not measured yet");
});

// LOOK1-SOL-001, LOOK1-OPUS-06: a browser that shrinks the layout for its keyboard reports a view of the short page with nothing hidden (keyboardInset.ts readKeyboardView), and Sheet lays out in that page, not in the room's kept steady height.
test("a page held short for the keyboard sets the sheet's floor from the short page", () => {
  const view = { top: 0, height: 544, inset: 0 };
  assert.equal(pageHeightOf(view, 1, 844), 544, "the short page, not the steady 844");
  assert.equal(pageHeightOf(null, 1, 844), 844, "no view: the room's own height");
  assert.equal(pageHeightOf({ top: 0, height: 544, inset: 300 }, 1, 844), 844, "a visual-viewport keyboard adds up to the layout's height");
  assert.equal(pageHeightOf({ top: 0, height: 408, inset: 0 }, 1.3, 844), 408 / 1.3, "in the chrome's own px at 130%");
  const sheetHeight = 326.4;
  const floor = sheetToastFloor({ mode: "bottom", height: pageHeightOf(view, 1, 844), toolbar: 60, sheetHeight, keyboard: null });
  assert.ok(Math.abs((floor ?? NaN) - 97.6) < 1e-9, `the sheet starts at 157.6 on the short page, so the floor is 97.6, not ${floor}`);
  assert.equal(sheetToastFloor({ mode: "bottom", height: 844, toolbar: 60, sheetHeight, keyboard: null }), 844 - 60 - sheetHeight - 60, "the steady height would put it 300 px too low");
  // Room reads the page's height, the keyboard's inset and the combined floor, as the tests above assume.
  const room = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
  assert.match(room, /phoneToastRoom\(\{[^}]*height: pageHeight,[^}]*keyboard: sheetKeys\?\.inset \?\? null/);
  assert.match(room, /const pageHeight = pageHeightOf\(keyboard, zoom, height\);/);
  assert.match(room, /placeRoomToasts\(\{[\s\S]{0,200}restFloor: floor, floorWas: floorWas\.current/);
});

// LP29-A-TOAST-1 to 4, at 844 x 390 at 130%: 649.2 x 300 in the chrome's own px, the toolbar 60, a 216 px keyboard 166.2.
describe("phoneToastRoom: every sheet shape and none keep the toasts in view while the keyboard is up", () => {
  type Input = Parameters<typeof phoneToastRoom>[0];
  const sideways: Input = { mode: "none", height: 300, toolbar: 60, controls: 60, sheetHeight: 0, tall: false, keyboard: null, safeTop: 0, sideWidth: 340, mapWidth: 649.2, bar: null };
  const room = (patch: Partial<Input>) => phoneToastRoom({ ...sideways, ...patch });

  test("with no sheet the keyboard's top bounds the toasts, above the tool's controls standing on it (TOAST-3)", () => {
    assert.deepEqual(room({}), { floor: null, row: { right: 0 } }, "no keyboard, no sheet: nothing changes");
    assert.equal(room({ keyboard: 166 }).floor, 300 - 166 - EDGE, "8 px above the keyboard, which hides the toolbar");
    assert.equal(room({ keyboard: 166, controls: 104 }).floor, 300 - 166 - 44 - EDGE, "the tool's 44 px of options stand on the keyboard");
    assert.equal(room({ keyboard: 40 }).floor, 300 - 60 - EDGE, "a keyboard under the toolbar's top: above the toolbar");
    assert.equal(room({ keyboard: 0, height: 268 / 1.3 }).floor, 268 / 1.3 - 60 - EDGE, "a page the browser held short: above its own foot's toolbar");
    assert.equal(room({ keyboard: 166, controls: null }).floor, null, "the controls not measured yet");
    assert.deepEqual(room({ keyboard: 166 }).row, { right: 0 }, "the row over the top bar shows");
  });

  test("beside a sideways sheet the keyboard lifted over the bars, the row keeps left of it (TOAST-1)", () => {
    assert.deepEqual(room({ mode: "side", keyboard: 166, tall: true }), { floor: 0, row: { right: 340 } });
    assert.deepEqual(room({ mode: "side", keyboard: 166 }), { floor: 0, row: { right: 0 } }, "standing under the bars, it leaves the row whole");
    assert.deepEqual(room({ mode: "side" }), { floor: 0, row: { right: 0 } });
  });

  test("a bottom sheet over the row's place leaves the toasts waiting undrawn (TOAST-1)", () => {
    // 320 x 568 at 130% on a page held short at 268 px: 206.2 tall, the sheet at least 120.
    const short = { mode: "bottom" as const, height: 268 / 1.3, mapWidth: 246, keyboard: 0 };
    assert.equal(room({ ...short, sheetHeight: 120 }).row, null, "the sheet's top at 26, above the row's foot at 48");
    assert.equal(room({ ...short, sheetHeight: 268 / 1.3, tall: true }).row, null, "a sheet that took the visible area's height");
    assert.deepEqual(room({ ...short, sheetHeight: 98 }).row, { right: 0 }, "a sheet whose top stands at the row's foot leaves it");
    assert.deepEqual(room({ ...short, sheetHeight: 98, safeTop: 1 }).row, null, "a notch moves the row down onto it");
    assert.deepEqual(room({ mode: "bottom", height: 437, sheetHeight: 280, mapWidth: 246 }).row, { right: 0 }, "no keyboard: the sheet stands under the bars");
    assert.deepEqual(room({ mode: "bottom", height: 437, sheetHeight: 0, keyboard: 166 }).row, { right: 0 }, "the sheet not measured yet");
  });

  test("the very short sheet's own row waits while the keyboard is up, so it never pushes the field (TOAST-2)", () => {
    assert.deepEqual(room({ mode: "full" }).row, { right: 0 });
    assert.equal(room({ mode: "full", keyboard: 80 }).row, null);
    assert.equal(room({ mode: "full", keyboard: 0, height: 104 / 1.3 }).row, null, "a page held short for the keyboard too");
  });

  test("a docked token bar over the top bar's row keeps the row 12 px left of it (TOAST-3 and 4)", () => {
    assert.deepEqual(room({ keyboard: 166, bar: { left: 326, top: 8 } }).row, { right: 649.2 - 326 });
    assert.deepEqual(room({ bar: { left: 326, top: 61 } }).row, { right: 0 }, "standing under the top bar, it leaves the row whole");
    assert.deepEqual(room({ mode: "side", tall: true, keyboard: 166, bar: { left: 400, top: 8 } }).row, { right: 340 }, "the farther in of the bar and a risen sheet");
  });

  test("the notices end 8 px left of a docked bar that reaches into their room, and a wide screen's stack keeps its center (TOAST-4)", () => {
    // 844 x 390 at 100%: the room left of the lane runs 8 to 524, and a bar 317 px wide docks at 519.
    assert.deepEqual(noticesBesideBar({ left: 8, width: 516 }, 519), { left: 8, width: 503 }, "the toasts end at 511");
    assert.deepEqual(noticesBesideBar({ left: 8, width: 516 }, 532), { left: 8, width: 516 }, "a bar inside its lane leaves the room");
    assert.deepEqual(noticesBesideBar({ left: 8, width: 516 }, null), { left: 8, width: 516 }, "no bar docked");
    assert.equal(noticesBesideBar(null, 519), null, "notices spanning the map");
    // A computer's map 1064 px wide: the stack, 520 px at most, centered in 752, ends 116 px short of the room's edge.
    assert.deepEqual(noticesBesideBar({ left: 8, width: 752 }, 747), { left: 8, width: 752 }, "the centered stack stays clear, so it does not move");
    assert.deepEqual(noticesBesideBar({ left: 8, width: 752 }, 600), { left: 8, width: 584 }, "a bar made wide enough to meet the stack");
  });

  test("dockedBarEdge reads a bar docked on the right as barCover does, and no other", () => {
    const facts = { box: { left: 519, top: 61, width: 317, height: 261 }, mode: "dock" as const, laneLeft: 524, freeRight: 836 };
    assert.deepEqual(dockedBarEdge(facts), { left: 519, top: 61 }, "a bar wider than the lane, against the right");
    assert.deepEqual(dockedBarEdge({ ...facts, box: { ...facts.box, left: 524, width: 304 } }), { left: 524, top: 61 }, "a bar inside its lane");
    assert.equal(dockedBarEdge({ ...facts, box: { ...facts.box, left: 120 } }), null, "a window moved off the right");
    assert.equal(dockedBarEdge({ ...facts, mode: "span" }), null, "an upright phone's strip");
    assert.equal(dockedBarEdge({ ...facts, laneLeft: 0 }), null, "no lane fits");
    assert.equal(dockedBarEdge(null), null);
  });
});

// LOOK1-SOL-002: Room hands placement the combined floor, so a stack drawn below the alert cards when a sheet opens takes its place anew.
test("a toast placed below the alert cards takes its place anew as a sheet opens over it", () => {
  const base = { was: NO_TOAST_PLACES, ids: [1], recent: new Set<number>(), spanning: true, restFloor: null as number | null, floorWas: null as number | null, layerFoot: null as number | null, shown: new Set([1]), measured: null, zoom: 1, pane: null, paneStands: false, low: null as number | null, columnTop: null, layer: true, slot: false, turned: false, mapFoot: null, overBar: undefined, turnStarted: false };
  const below = placeRoomToasts({ ...base, recent: new Set([1]), low: 240 });
  assert.deepEqual(below.places.get(1), { low: 240, column: true });
  // The sheet's floor is 217, and the toast, drawn from 240 and 44 tall at least, ends at 284.
  const sheet = sheetToastFloor({ mode: "bottom", height: 437, toolbar: 60, sheetHeight: 100, keyboard: null });
  assert.equal(sheet, 217);
  const open = lowerFloor(null, sheet);
  const column = { top: 60, content: 150, first: 150 };
  assert.equal(toastStartTop({ spanning: true, column, cards: true, optionsTop: 400, sheetFloor: sheet }), null, "no whole toast fits below the cards above the sheet, so a new one stays above them");
  const after = placeRoomToasts({ ...base, was: below, restFloor: open, floorWas: lowerFloor(null, null), layerFoot: 284, low: null });
  assert.equal(after.places.get(1), "map", "the stack drawn past the floor is placed again, above the cards");
  assert.deepEqual(placeRoomToasts({ ...base, was: below, restFloor: open, floorWas: open, layerFoot: 284 }).places.get(1), { low: 240, column: true }, "a floor that did not rise places nothing anew");
  // The strip's own floor, when it is the lower, still rules.
  assert.equal(lowerFloor(200, sheet), 200);
  assert.equal(lowerFloor(300, sheet), sheet);
  assert.equal(lowerFloor(null, null), null);
});

// LOOK1-OPUS-01 (D-261101-390): the very short sheet draws one toast and the older ones wait with the sheet's place.
test("toasts that waited undrawn in the very short sheet outlive it and are placed as new, and only the drawn one goes", () => {
  const base = { was: NO_TOAST_PLACES, ids: [1, 2, 3], recent: new Set<number>(), spanning: true, restFloor: null, floorWas: null, layerFoot: null, measured: null, zoom: 1, pane: null, paneStands: false, low: null, columnTop: null, layer: true, slot: true, turned: false, mapFoot: null, overBar: undefined, turnStarted: false };
  const inSlot = placeRoomToasts({ ...base, shown: new Set([3]) });
  assert.deepEqual([...inSlot.places.values()], ["sheet", "sheet", "sheet"]);
  assert.deepEqual(sheetToastsToDismiss(true, inSlot.places, new Set([3])), [], "an open slot dismisses nothing");
  const closed = placeRoomToasts({ ...base, was: inSlot, slot: false, shown: new Set([3]) });
  assert.equal(closed.places.get(3), "sheet", "the drawn toast keeps the sheet's place until the room dismisses it");
  assert.equal(closed.places.get(1), "map", "a toast never drawn is placed over the map as new");
  assert.equal(closed.places.get(2), "map");
  assert.deepEqual(sheetToastsToDismiss(false, closed.places, new Set([3])), [3]);
  // The sheet closing for a toast with a button: it waits behind a whisper and is never lost.
  assert.deepEqual(sheetToastsToDismiss(false, new Map([[1, "sheet"], [2, "sheet"]]), new Set()), [], "nothing drawn, nothing dismissed");
});

test("the alerts' summary row rises over the room's name on a phone held sideways at 130%, its shadow held by the notch's inset rather than past it", () => {
  // 480 x 320 at 130% with a 47 px notch, reconnecting, as reach-player-130 measured it in screen px: the player's chip showing its name starts at 151 px.
  const zoom = 1.3;
  const header = [
    { left: 151.05, right: 242.16 },
    { left: 247.34, right: 304.53 },
    { left: 307.13, right: 364.31 },
    { left: 356.52, right: 413.7 },
  ].map((b) => ({ ...b, top: 5.2, bottom: 62.39 }));
  const rules = summaryRowRules({
    usual: { left: 71.49, right: 408.5, top: 156.95, height: 57.19 },
    chrome: { safe: { left: 47 }, top: 52.76, controls: 129.46 },
    zoom, height: 246.15, ceiling: 0,
    lasting: 113.51, mapToasts: null, toastRow: null, controls: header,
  });
  assert.equal(rules.minLeft, 47 * zoom, "the row keeps out of the notch, which already gives its shadow room");
  const spot = raisedRow(rules);
  assert.ok(spot, "a spot over the room's name");
  assert.ok(spot.top + rules.row.height <= 52.76 * zoom, `over the top bar's row, clear of the Reconnecting notice: ${JSON.stringify(spot)}`);
  assert.ok(spot.right <= 151.05 - EDGE * zoom && spot.left >= 47 * zoom && spot.right - spot.left >= theme.touch * zoom);
  // Where the window has no inset, the shadow keeps its own room from the edge.
  assert.equal(summaryRowRules({ usual: rules.row, chrome: { safe: { left: 0 }, top: 52.76, controls: 60 }, zoom, height: 246.15, ceiling: 0, lasting: null, mapToasts: null, toastRow: null, controls: [] }).minLeft, SHADOW_ROOM * zoom);
});
