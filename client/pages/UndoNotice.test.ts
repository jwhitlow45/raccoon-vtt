import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { DM, P1 } from "#shared/testutil.ts";
import { UNDO_NOTICE } from "../state/historyNotice.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
const { UndoNotice } = await import("./UndoNotice.tsx");
const { ModalSlots } = await import("./modalSlot.tsx");

function render(options: { dm?: boolean; shown?: boolean; display?: boolean; height?: number } = {}) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 320, innerHeight: options.height ?? 568 } });
  const store = createStore(() => ({ you: options.dm === false ? P1 : DM, undoNotice: options.shown !== false }));
  try {
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, display: options.display, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(UndoNotice) }) }));
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("the lasting undo notice exposes the exact rollout text and a 44 px dismiss control", () => {
  assert.equal(UNDO_NOTICE, "Undo now separates play from setup. Earlier undo history was cleared. Setup history is in the menu.");
  const html = render();
  assert.match(html, /data-undo-rollout-notice=""/);
  assert.ok(html.includes(UNDO_NOTICE));
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Dismiss undo notice"/);
  assert.match(html, /min-width:44px/);
  assert.match(html, /min-height:44px/);
  assert.doesNotMatch(html, />More</, "full text wraps on an upright phone");
});

test("dismissed notices, player views and displays render nothing", () => {
  assert.equal(render({ shown: false }), "");
  assert.equal(render({ dm: false }), "");
  assert.equal(render({ display: true }), "");
});

test("short screens keep the whole accessible text and the existing More control", () => {
  const html = render({ height: 320 });
  assert.ok(html.includes(UNDO_NOTICE));
  assert.match(html, />More</);
  assert.match(html, /aria-label="Dismiss undo notice"/);
});

test("modal sheets have a lasting undo notice slot before their passing notices", () => {
  const html = renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(ModalSlots) }));
  const undo = html.indexOf('data-rvtt-modal-slot="undo"');
  assert.ok(undo >= 0);
  assert.ok(undo < html.indexOf('data-rvtt-modal-slot="turn"'));
});
