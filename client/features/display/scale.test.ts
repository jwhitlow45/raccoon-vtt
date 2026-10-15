import assert from "node:assert/strict";
import { test } from "node:test";

// A page's local storage, shared by the DM's room window and a display window of the same browser.
const stored = new Map<string, string>([["rvtt.uiScale", "0.85"]]);
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});
const { restoreUiScale, setUiScale, uiScale } = await import("../device/settings.ts");
const { chooseDisplayUiScale, readDisplayUiScale } = await import("./remember.ts");
const { boardSizes, PIN_CELL_PX } = await import("../../lib/boardScale.ts");

test("a display's text size is its own, and never the room's interface size", () => {
  assert.equal(uiScale(), 0.85, "the page starts at the device's interface size");
  assert.equal(readDisplayUiScale(), 1, "a display with no size of its own reads 100%");

  chooseDisplayUiScale(1.3);
  assert.equal(stored.get("rvtt.displayUiScale"), "1.3");
  assert.equal(stored.get("rvtt.uiScale"), "0.85", "the DM's room in another window keeps its size");
  assert.equal(uiScale(), 1.3, "the display's page shows its own");
  assert.equal(boardSizes(PIN_CELL_PX).namePx, boardSizes(PIN_CELL_PX, 1.3).namePx, "names on the map follow it");
  assert.equal(readDisplayUiScale(), 1.3);

  // The room's This device page sets the device's size and leaves the display's alone.
  setUiScale(1.15);
  assert.equal(stored.get("rvtt.uiScale"), "1.15");
  assert.equal(stored.get("rvtt.displayUiScale"), "1.3");

  chooseDisplayUiScale(1.3);
  restoreUiScale();
  assert.equal(uiScale(), 1.15, "closing the display gives the page the device's stored size back");
});

test("a display takes its text size once it has rendered, never while rendering", async () => {
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { useDisplayTextSize } = await import("./remember.ts");
  stored.set("rvtt.displayUiScale", "0.85");
  restoreUiScale();
  const before = uiScale();
  assert.notEqual(before, 0.85);

  // A server render runs no effects, so it shows whether rendering alone changed the page's size.
  function Display() {
    useDisplayTextSize();
    return null;
  }
  renderToString(createElement(Display));
  assert.equal(uiScale(), before, "the page's size changed during a render");
});
