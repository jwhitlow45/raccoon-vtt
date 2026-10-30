import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useRollModeMenu } = await import("./useRollModeMenu.tsx");
const { RollModeMenu } = await import("./RollModeMenu.tsx");
import type { PopoverHandle } from "../../components/Popover.tsx";
import type { UseRollModeMenuOptions } from "./useRollModeMenu.tsx";

function render(capability: UseRollModeMenuOptions["capability"], disabled = false) {
  function Probe() {
    const binding = useRollModeMenu({ source: "c:one|save:dex", name: "Dexterity save, proficient", capability, disabled, dm: false, onTap() {}, onRoll() {} });
    const { tooltipHold: _hold, ...props } = binding.buttonProps;
    return createElement("div", {}, createElement("button", { type: "button", ...props, "aria-describedby": binding.describe("proficiency-help"), "aria-label": "Dexterity save, proficient", style: { minHeight: 44, ...binding.pressStyle } }, "DEX +5"), binding.menu);
  }
  return renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) }));
}
test("eligible source retains its name, description, role and dimensions without a wrapper", () => {
  const html = render({ d20: true, visibility: "request" });
  assert.match(html, /^<div><button type="button"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /aria-label="Dexterity save, proficient"/);
  assert.match(html, /aria-describedby="proficiency-help [^"]+"/);
  assert.match(html, /aria-keyshortcuts="ContextMenu Shift\+F10"/);
  assert.match(html, /aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html, /Hold, right-click or Shift\+F10 for Advantage, Disadvantage or Normal/);
  assert.doesNotMatch(html, /min-width|padding|tooltipHold/);
});
test("excluded and disabled sources receive no menu attributes or hint", () => {
  for (const html of [render({ d20: false, visibility: "creature" }), render({ d20: true, visibility: "selectable" }, true)]) {
    assert.doesNotMatch(html, /aria-haspopup|aria-expanded|aria-keyshortcuts|Hold, right-click/);
    assert.match(html, /aria-describedby="proficiency-help"/);
  }
});
test("menu actions render in order with visible fixed and repeat explanations", () => {
  const handle = { open: true, kind: "menu", contentId: "roll-menu", anchor: { current: null }, box: { current: null }, how: { by: "key", from: "first" } } as unknown as PopoverHandle;
  const html = renderToStaticMarkup(createElement(RollModeMenu, { handle, name: "Longbow", capability: { d20: true, visibility: "repeat", repeat: true }, dm: true, onPick() {} }));
  assert.match(html, /data-roll-mode-menu=""/);
  assert.match(html, /role="menu"[^>]*aria-label="Roll options for Longbow"/);
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /menuitemradio|aria-checked|touch-action:none/);
  assert.match(html, /This repeat keeps its recorded visibility/);
  assert.match(html, /Current effects are not rebuilt/);
  assert.match(html, /aria-disabled="true"/);
});

test("a pick closes and focuses before dispatch, names the source origin and revalidates the live route", () => {
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node };
  const events: string[] = [];
  class FakeNode {}
  Object.assign(globalThis, { window: new EventTarget(), document: { activeElement: null, body: null }, Node: FakeNode });
  try {
    let valid = true;
    let binding: ReturnType<typeof useRollModeMenu> | undefined;
    function Probe() {
      binding = useRollModeMenu({ source: "one", name: "Dexterity save", capability: { d20: true, visibility: "request" }, dm: true, valid: () => valid, onTap: () => events.push("tap"), onRoll: (override) => events.push(`roll:${override}`) });
      return null;
    }
    renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) }));
    assert.ok(binding);
    const node = { style: { boxShadow: "" }, closest: () => null, parentElement: null, isConnected: true, getClientRects: () => [1], focus: () => events.push("focus"), dispatchEvent: (event: Event) => { events.push(event.type); return true; } };
    binding.buttonProps.ref(node as unknown as HTMLButtonElement);
    const menu = (binding.menu as { props: { children: unknown[] } }).props.children[1] as { props: { onPick(override: string): void } };
    const keyEvent = { key: "F10", shiftKey: true, preventDefault() {} } as never;
    binding.buttonProps.onKeyDown?.(keyEvent);
    menu.props.onPick("secret"); assert.deepEqual(events, [], "disabled choices never dispatch or close");
    menu.props.onPick("adv"); assert.deepEqual(events, ["focus", "rvtt-roll-mode-origin", "roll:adv"]);
    menu.props.onPick("adv"); assert.deepEqual(events, ["focus", "rvtt-roll-mode-origin", "roll:adv"], "a closed invocation cannot run twice");
    events.length = 0;
    binding.buttonProps.onKeyDown?.(keyEvent); valid = false;
    menu.props.onPick("dis"); assert.deepEqual(events, ["focus"], "an invalid live target closes without rolling");
  } finally { Object.assign(globalThis, previous); }
});

test("containing scrolls preserve an open menu while its source remains visible", async () => {
  const { handleRollModeScroll } = await import("./useRollModeMenu.tsx");
  const previous = { document: globalThis.document, window: globalThis.window, Element: globalThis.Element };
  class ScrollElement {
    rect = { left: 10, right: 110, top: 20, bottom: 120 };
    child: ScrollElement | null = null;
    contains(node: unknown) { return node === this || node === this.child; }
    getBoundingClientRect() { return this.rect; }
  }
  const source = new ScrollElement();
  source.rect = { left: 30, right: 74, top: 40, bottom: 84 };
  const scroller = new ScrollElement(); scroller.child = source;
  Object.assign(globalThis, { document: {}, window: { innerWidth: 300, innerHeight: 200 }, Element: ScrollElement });
  try {
    let cancelled = 0, closed = 0;
    const scroll = (target: unknown, open = true) => handleRollModeScroll({ target: target as EventTarget, anchor: source as unknown as HTMLElement, open, cancel: () => { cancelled++; }, close: () => { closed++; } });
    scroll(scroller);
    assert.deepEqual([cancelled, closed], [0, 0], "a browser adjustment must not dismiss a visible source or release its consumed finger");
    source.rect.top = 15; source.rect.bottom = 59;
    scroll(scroller);
    assert.deepEqual([cancelled, closed], [0, 0], "a partly visible source keeps its menu");
    source.rect.top = -24; source.rect.bottom = 20;
    scroll(scroller);
    assert.deepEqual([cancelled, closed], [1, 1], "no overlap at the container edge closes the menu");
    source.rect = { left: 30, right: 74, top: 40, bottom: 84 };
    scroll(scroller, false);
    assert.deepEqual([cancelled, closed], [2, 2], "any containing scroll still cancels a pending hold");
    scroll(new ScrollElement(), false);
    assert.deepEqual([cancelled, closed], [2, 2], "menu scrolling and unrelated scrolling do not dismiss the source");
    scroll(document);
    assert.deepEqual([cancelled, closed], [2, 2], "a visible source survives a document scroll too");
    source.rect.top = 200; source.rect.bottom = 244;
    scroll(document);
    assert.deepEqual([cancelled, closed], [3, 3], "a source below the viewport closes the menu");
    scroller.rect = { left: 10, right: 110, top: 180, bottom: 280 };
    scroll(scroller);
    assert.deepEqual([cancelled, closed], [4, 4], "a nested scroller cannot keep an offscreen source alive");
    scroller.rect = { left: 10, right: 110, top: 20, bottom: 120 };
    for (const rect of [
      { left: 110, right: 154, top: 40, bottom: 84 },
      { left: -34, right: 10, top: 40, bottom: 84 },
      { left: 30, right: 74, top: 120, bottom: 164 },
      { left: 30, right: 30, top: 40, bottom: 84 },
    ]) {
      source.rect = rect;
      const before = closed; scroll(scroller);
      assert.equal(closed, before + 1, "a source past any container edge or with no area closes");
    }
    source.rect = { left: 30, right: 74, top: 119.5, bottom: 163.5 };
    const before = closed; scroll(scroller);
    assert.equal(closed, before, "fractional overlap at an interface scale still counts as visible");
  } finally { Object.assign(globalThis, previous); }
});
