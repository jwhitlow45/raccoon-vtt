import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { transformWithOxc } from "vite";
import { keptMapFoot, mapToastBox, putToastHosts } from "./toastPlacement.ts";
import { columnFacts, columnTop, EDGE, nextToastPlaces, NO_TOAST_PLACES, raisedRow, SHADOW_ROOM, toastTop, type ColumnFacts } from "../canvas/barDock.ts";
import { theme } from "../lib/theme.ts";

// Read the actual measurement so a first-card-only clearance cannot pass.
const alertsSource = readFileSync(new URL("../features/encounter/InitiativeStrip.tsx", import.meta.url), "utf8");
const measureFrom = alertsSource.indexOf("const measured = drawn(cards) ?");
const measureTo = alertsSource.indexOf(";", measureFrom);
assert.ok(measureFrom > 0 && measureTo > measureFrom);
const measureCards = new Function("cards", "zoom", "drawn", "firstCardHeight", `${stripTypeScriptTypes(alertsSource.slice(measureFrom, measureTo + 1))}\nreturn measured;`);

test("FU40-B pl2-b: three unfolded cards end at 497, so the toast starts at 505, not 240", () => {
  // Browser capture at 390 x 844: the first card ends at 232, the column
  // starts at 108, and its three cards end at 497. No summary row stands in.
  const cards = { getBoundingClientRect: () => ({ height: 389 }) };
  const measured = measureCards(cards, 1, () => true, () => 124);
  const column = columnFacts(null, { top: 108, measured });
  assert.ok(column);
  assert.equal(column.first, 124, "folding still measures only the first card");
  const phone = { spanning: true, column, cards: true, optionsTop: 784 };
  assert.equal(toastTop(phone), 505, "the 8 px gap belongs below all three drawn cards");
  assert.equal(toastTop({ ...phone, optionsTop: 505 + 44 }), 505);
  assert.equal(toastTop({ ...phone, optionsTop: 505 + 44 - 1 }), null, "without a full toast row it stays above the column");
  assert.equal(toastTop({ ...phone, cards: false }), null, "a folded column places no toast underneath its hidden cards");
  const single = columnFacts(null, { top: 108, measured: measureCards({ getBoundingClientRect: () => ({ height: 124 }) }, 1, () => true, () => 124) });
  assert.equal(toastTop({ ...phone, column: single }), 240, "one drawn card keeps the original 8 px gap");
});

test("ALERTS-FIRSTCARD: a 359 px desk measures its first trap card, not the whole stack", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { room, trap } = await import("#shared/testutil.ts");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RoomProvider } = await import("../state/view.ts");
  const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
  const { DmDesk } = await import("../features/rolls/DmDesk.tsx");
  const source = readFileSync(new URL("../features/encounter/InitiativeStrip.tsx", import.meta.url), "utf8");
  const from = source.indexOf("function firstCard(");
  const to = source.indexOf("/** The alerts over the screen:", from);
  assert.ok(from > 0 && to > from);
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
  const firstHeight = new Function("HTMLElement", "getComputedStyle", `${stripTypeScriptTypes(source.slice(from, to))}\nreturn firstCardHeight;`)(Element, (e: Element) => ({ display: e.display })) as (el: Element) => number;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 320 / 1.3, innerHeight: 568 / 1.3 } });
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
    const measured = measureCards(cards, zoom, () => true, firstHeight);
    const facts = columnFacts(null, { top: 120, measured });
    assert.ok(facts);
    assert.equal(200 < EDGE + first, false, "the 200 px lane can keep the first card without folding");
    assert.equal(toastTop({ spanning: true, column: facts, cards: true, optionsTop: 500 }), 120 + 359 / zoom + EDGE, "a waiting toast clears every card in the desk, not only the first");
    assert.equal(toastTop({ spanning: true, column: facts, cards: true, optionsTop: 400 }), null, "with no room under the stack, a toast cannot cover its later cards");
    const hidden = new Element(0);
    const turn = new Element(44, [], { alert: "turn" });
    assert.equal(firstHeight(new Element(44, [hidden, turn])), 0, "a lone turn card still cannot force a fold");
    assert.equal(measureCards(new Element(44, [hidden, turn]), 1, () => true, firstHeight).cover, 44, "toasts still clear a lone turn card");
    const wholeCard = new Element(150, [new Element(44)], {}, "grid");
    assert.equal(firstHeight(new Element(150, [wholeCard])), 150, "a card's own grid must not be reduced to its header");
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
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

// Run the stack portion of Toasts' JSX. The fake commit removes omitted stacks
// before the real placement helper runs, matching React's mutation/layout order.
const room = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
const start = room.indexOf("\n", room.indexOf("<ToastVoice toasts=", room.indexOf("function Toasts(")));
const end = room.indexOf("\n      {drawn.map", start);
assert.ok(start > 0 && end > start, "Toasts must expose its stack rendering for the lifecycle check");
const { code } = await transformWithOxc(`function renderStacks(props, overMap, lowAt, stacks) { return <>${room.slice(start, end)}</>; }`, "toast-stacks.tsx", { jsx: { runtime: "classic" } });
const renderStacks = new Function("React", "createPortal", "ToastStack", "theme", `${code}\nreturn renderStacks;`)(React, (node: unknown) => node, "toast-stack", { space: (n: number) => 4 * n }) as (props: object, overMap: unknown[], lowAt: object | null, stacks: object) => React.ReactElement<{ children: React.ReactNode }>;

for (const direction of ["notices to layer", "layer to notices"] as const) test(`FU39-ASTRA-01: a focused sole toast survives ${direction} through the commit`, () => {
  const p = page();
  p.first.remove();
  const toLayer = direction === "notices to layer";
  const source = toLayer ? p.stack : p.other;
  const target = toLayer ? p.other : p.stack;
  source.insertBefore(p.moved, null);
  p.action.focus();
  const rendered = renderStacks({ layer: {} }, toLayer ? [] : [{}], toLayer ? { top: 100, edges: null } : null, { notices: p.stack, layer: p.other });
  const kept = React.Children.toArray(rendered.props.children).map((node) => (node as React.ReactElement<{ stack: typeof p.stack }>).props.stack);
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
  const alerts = readFileSync(new URL("../features/encounter/InitiativeStrip.tsx", import.meta.url), "utf8");
  const start = alerts.indexOf("  useLayoutEffect(() => {\n    const cards = cardsRef.current;");
  const end = alerts.indexOf("\n  useLayoutEffect(() => () => dock.setState({ column: null })", start);
  assert.ok(start > 0 && end > start);
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
    // A child can publish its trap card after the empty column measured.
    // Run React's dependency check without delivering ResizeObserver yet.
    const bindings = {
      useLayoutEffect: (effect: () => (() => void) | undefined, next: readonly unknown[]) => {
        if (dependencies && next.every((value, i) => Object.is(value, dependencies![i]))) return;
        cleanUp?.();
        dependencies = next;
        cleanUp = effect();
      },
      cardsRef: { current: { getBoundingClientRect: () => ({ height: cardHeight * zoom }) } },
      colTop: top, zoom, alerts: [], rolls: null as object | null,
      summarized: false, folded: false, forFootCard: false, forRoom: false, overlay: false, rowPlace: { lift: 0 },
      turnFolded: false, turnHidden: false,
      drawn: () => true, firstCardHeight: () => cardHeight * zoom, setFirstHeight: () => {},
      dock: { getState: () => state, setState: (patch: { column: ColumnFacts | null }) => Object.assign(state, patch) },
      columnFacts, SUMMARY_ROW: 44,
      ResizeObserver: class { observe() {} disconnect() {} },
    };
    const measure = new Function(...Object.keys(bindings), stripTypeScriptTypes(alerts.slice(start, end)));
    measure(...Object.values(bindings));
    assert.equal(state.column, null, "Wait here stands above an empty column");
    const waiting = { ...input, ids: [1, 2], recent: new Set([2]), mapFoot: keptFoot };
    placed = nextToastPlaces(placed, waiting);
    assert.equal(placed.places.get(2), "map");
    assert.deepEqual([...placed.awaitCard], [2], "the trap waits for its card's first measurement");
    const map = mapToastBox([kept, { id: 2, top: 120 * zoom, bottom: 226 * zoom }], placed.awaitCard, zoom, { top: 68 * zoom, bottom: 226 * zoom });
    assert.equal(columnTop(60, null, map!.keptBottom), top, "the waiting toast must not move the card");
    cardHeight = 62;
    bindings.rolls = { text: "Stepstone went off", requests: 1 };
    measure(...Object.values(bindings));
    const low = toastTop({ spanning: true, column: state.column, cards: true, optionsTop: 780 });
    placed = nextToastPlaces(placed, { ...waiting, low });
    assert.deepEqual(placed.places.get(2), { low: top + cardHeight + EDGE, column: true }, "the trap toast must clear the card in its first visible frame");
    assert.equal(placed.places.get(1), "map", "the kept notice stays where it is being read");
    assert.ok(top >= kept.bottom / zoom + EDGE);
    const settled = nextToastPlaces(placed, { ...waiting, low, recent: new Set<number>() });
    assert.deepEqual(settled.places, placed.places, "the trap toast must not move again after its card wait ends");
    cardHeight = 44;
    bindings.turnFolded = true;
    measure(...Object.values(bindings));
    assert.equal((state.column as ColumnFacts | null)?.cover, 44, "HF41-R2-1: folding remeasures the first card before ResizeObserver runs");
    cardHeight = 0;
    bindings.turnHidden = true;
    measure(...Object.values(bindings));
    assert.equal(state.column, null, "HF41-R2-1: hiding remeasures the empty column in the same frame");
    cleanUp?.();
  }
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
  const measureStart = room.indexOf("    const notices = stacks.notices.box.current;");
  const measureEnd = room.indexOf("    // The foot of the toasts over the map", measureStart);
  assert.ok(measureStart > 0 && measureEnd > measureStart);
  const alerts = readFileSync(new URL("../features/encounter/InitiativeStrip.tsx", import.meta.url), "utf8");
  const colLine = alerts.split("\n").find((line) => line.startsWith("  const colTop ="));
  assert.ok(colLine);
  const rulesStart = alerts.indexOf("    const rules = {");
  const rulesEnd = alerts.indexOf("\n    };", rulesStart);
  assert.ok(rulesStart > 0 && rulesEnd > rulesStart);
  for (const zoom of [1, 1.3]) {
    const kept = { id: 1, top: 68 * zoom, bottom: 112 * zoom };
    const waiting = { id: 2, top: 120 * zoom, bottom: 226 * zoom };
    const state: { mapToasts: ReturnType<typeof mapToastBox> } = { mapToasts: null };
    const props = { spanning: true };
    const overMap = [kept, waiting];
    const bindings = {
      props, overMap, zoom, mapToastBox, keptMapFoot,
      stacks: { notices: { box: { current: { getBoundingClientRect: () => ({ top: 68 * zoom, bottom: 226 * zoom }) } } } },
      hosts: { current: new Map(overMap.map((b) => [b.id, { firstElementChild: { getBoundingClientRect: () => b } }])) },
      placed: { current: { awaitCard: new Set([2]) } }, mapFoot: { current: null },
      mapMeasured: { current: null },
      dockStore: { getState: () => state, setState: (patch: typeof state) => Object.assign(state, patch) },
    };
    const publish = new Function(...Object.keys(bindings), stripTypeScriptTypes(room.slice(measureStart, measureEnd)));
    const measure = () => publish(...Object.values(bindings));
    measure();
    assert.ok(state.mapToasts, "the room must publish clearance before the first card is placed");
    const placeColumn: (...args: unknown[]) => number = new Function("laneTop", "lasting", "mapToasts", "columnTop", "cardsWaiting", "heldTop", `${colLine}\nreturn colTop;`) as (...args: unknown[]) => number;
    const top = placeColumn(60, null, state.mapToasts, columnTop, true, { current: null }) as number;
    assert.equal(placeColumn(60, null, null, columnTop, true, { current: 120 }), 120, "the mounted column keeps its latched top when the toast leaves");
    assert.equal(placeColumn(60, null, null, columnTop, false, { current: 120 }), 60, "an empty column ignores the latch");
    assert.ok(Math.abs(top - 120) < 1e-9, "the real column must clear the kept toast without reserving the waiting toast");
    const rulesBindings = {
      usual: { left: 12, right: 378, top: 160 * zoom, height: 44 * zoom },
      chrome: { safe: { left: 0 }, top: 60, controls: 60 }, zoom, height: 844,
      header: { firstElementChild: { getBoundingClientRect: () => ({ top: 0 }) } },
      lasting: null, mapToasts: state.mapToasts, toastRow: null, controls: [], theme, EDGE, SHADOW_ROOM,
    };
    const rules = new Function(...Object.keys(rulesBindings), `${alerts.slice(rulesStart, rulesEnd + 7)}\nreturn rules;`)(...Object.values(rulesBindings)) as Parameters<typeof raisedRow>[0];
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

test("FU40-B pl2-b: a toast above a full measured column reserves space immediately", () => {
  const placeStart = room.indexOf("  floorWas.current = props.restFloor;");
  const placeEnd = room.indexOf("  const { places } = placed.current;", placeStart);
  const publishStart = room.indexOf("    const notices = stacks.notices.box.current;");
  const publishEnd = room.indexOf("    // The foot of the toasts over the map", publishStart);
  assert.ok(placeStart > 0 && placeEnd > placeStart && publishStart > 0 && publishEnd > publishStart);
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
    const props = { restFloor: null, pane: null, paneStands: false, low, columnTop: unmeasured ? null : 108, layer: {}, spanning: true };
    const state: { mapToasts: ReturnType<typeof mapToastBox> } = { mapToasts: null };
    const bindings = {
      props, placed: { current: NO_TOAST_PLACES }, floorWas: { current: null }, ids: [1], slot: null, turned: false,
      mapFoot: { current: null }, recent: new Set([1]), overBar: undefined, anew: undefined, turnStarted: false,
      mapMeasured: { current: null }, zoom, nextToastPlaces, mapToastBox, keptMapFoot, EDGE,
      overMap: [toast],
      stacks: { notices: { box: { current: { getBoundingClientRect: () => toast } } } },
      hosts: { current: new Map([[1, { firstElementChild: { getBoundingClientRect: () => toast } }]]) },
      dockStore: { getState: () => state, setState: (patch: typeof state) => Object.assign(state, patch) },
    };
    const place = new Function(...Object.keys(bindings), stripTypeScriptTypes(room.slice(placeStart, placeEnd)));
    const publish = new Function(...Object.keys(bindings), stripTypeScriptTypes(room.slice(publishStart, publishEnd)));
    const frame = () => { place(...Object.values(bindings)); publish(...Object.values(bindings)); };
    if (unmeasured) {
      for (let i = 0, count = 1 + Math.floor(random() * 4); i < count; i++) {
        frame();
        assert.equal(state.mapToasts?.keptBottom, null, "an unmeasured card must not be pushed by its waiting toast");
        assert.ok(bindings.placed.current.awaitCard.has(1));
      }
      props.columnTop = 108;
    }
    frame();
    const top = columnTop(108, null, state.mapToasts?.keptBottom ?? null, 108);
    assert.equal(top, 168, "a measured full column must clear the fallback toast before it ages out");
    assert.equal(top - toast.bottom / zoom, EDGE, "the first card stands exactly 8 px below the toast");
    assert.equal(bindings.placed.current.awaitCard.size, 0, "no room under a measured card ends the provisional exclusion");
    props.columnTop = top;
    for (let i = 0, count = 1 + Math.floor(random() * 4); i < count; i++) {
      if (random() < 0.5) bindings.recent.clear();
      frame();
      assert.equal(columnTop(108, null, state.mapToasts?.keptBottom ?? null, top), top, "repeated measurement and aging must not push the cards again");
      assert.equal(bindings.placed.current.places.get(1), "map", "the fallback toast stays where it was read");
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
  const start = room.indexOf("  floorWas.current = props.restFloor;");
  const end = room.indexOf("  const { places } = placed.current;", start);
  assert.ok(start > 0 && end > start);
  let seed = 359;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let sequence = 0; sequence < 200; sequence++) {
    const zoom = sequence % 2 ? 1.3 : 1;
    const keptBottom = 100 + Math.floor(random() * 120);
    const cardHeight = 44 + Math.floor(random() * 100);
    const input = { ids: [1, 2], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set([1, 2]) };
    const placed = { current: nextToastPlaces(NO_TOAST_PLACES, input) };
    const props = { restFloor: null, pane: null, paneStands: false, low: 60 + cardHeight + EDGE, columnTop: 60, layer: {}, spanning: true };
    const bindings = {
      props, placed, floorWas: { current: null }, ids: [1, 2], slot: null, turned: false,
      mapFoot: { current: null }, recent: new Set([2]), overBar: undefined, anew: undefined, turnStarted: false,
      mapMeasured: { current: { boxes: [{ id: 1, top: 68 * zoom, bottom: keptBottom * zoom }], clip: { top: 68 * zoom, bottom: keptBottom * zoom } } }, zoom,
      nextToastPlaces, mapToastBox, EDGE,
    };
    const run = new Function(...Object.keys(bindings), stripTypeScriptTypes(room.slice(start, end)));
    for (let pending = 0, count = 1 + Math.floor(random() * 4); pending < count; pending++) {
      run(...Object.values(bindings));
      assert.equal(placed.current.places.get(2), "map", `sequence ${sequence}: the new toast cannot commit to the card's stale top`);
    }
    props.columnTop = keptBottom + EDGE;
    props.low = props.columnTop + cardHeight + EDGE;
    run(...Object.values(bindings));
    assert.equal(placed.current.places.get(1), "map", "the toast being read stays put");
    const settled = { low: props.low, column: true };
    assert.deepEqual(placed.current.places.get(2), settled);
    bindings.recent.clear();
    run(...Object.values(bindings));
    assert.deepEqual(placed.current.places.get(2), settled, "the new toast moves only once across delayed measurements and aging");
  }
});
