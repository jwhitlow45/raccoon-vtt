import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/*
 * The table display holds the dark look for its page whatever the device
 * chose, and letting go gives back the device's latest choice
 * (docs/design/design-v1-light-theme.md 6.4, D-261102-364). Server rendering
 * runs no effects, so the page's layout effects are caught as it renders
 * and run here, as a mount and an unmount would.
 */

const captureKey = Symbol.for("display-pages-layout");
let effects: (() => void | (() => void))[] = [];
(globalThis as Record<symbol, unknown>)[captureKey] = (run: () => void | (() => void)) => {
  effects.push(run);
};
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/display/DisplayPages.tsx")) return result;
    const source = String(result.source);
    const replaced = source.replaceAll("useLayoutEffect(", 'globalThis[Symbol.for("display-pages-layout")](');
    assert.notEqual(source, replaced, "the page has a layout effect to catch");
    return { ...result, source: replaced };
  },
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: DisplayPages } = await import("./DisplayPages.tsx");
const { scheme, startScheme } = await import("../../lib/scheme.ts");
const { setThemeChoice } = await import("../device/settings.ts");

for (const roomId of [null, "R1"]) {
  test(`${roomId ? "the room's display" : "the code page"} holds dark on a light device, and gives the latest choice back as it goes`, () => {
    startScheme();
    setThemeChoice("light");
    assert.equal(scheme(), "light");
    effects = [];
    renderToStaticMarkup(createElement(DisplayPages, { roomId, hash: "" }));
    const releases = effects.map((run) => run()).filter((r): r is () => void => typeof r === "function");
    try {
      assert.equal(scheme(), "dark", "dark from its mount");
      setThemeChoice("auto");
      setThemeChoice("light");
      assert.equal(scheme(), "dark", "a choice made meanwhile waits for the release");
    } finally {
      for (const release of releases) release();
    }
    assert.equal(scheme(), "light", "the device's own choice once it goes");
    setThemeChoice("dark");
  });
}
