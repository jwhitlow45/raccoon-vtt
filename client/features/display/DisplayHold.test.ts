import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

/*
 * The table display holds the dark look whatever the device chose, and
 * letting go gives back the device's latest choice
 * (docs/design/design-v1-light-theme.md 6.4, D-261102-364). The hold stands
 * outside the display's lazy pages, and on a fresh load from boot, so no
 * frame shows the device's light while their code loads (review LTB-2).
 * Server rendering runs no effects, so the hold's layout effect is caught
 * as it renders and run here, as a mount and an unmount would.
 */

const captureKey = Symbol.for("display-hold-layout");
let effects: (() => void | (() => void))[] = [];
(globalThis as Record<symbol, unknown>)[captureKey] = (run: () => void | (() => void)) => {
  effects.push(run);
};
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/display/DisplayHold.tsx")) return result;
    const source = String(result.source);
    const replaced = source.replaceAll("useLayoutEffect(", 'globalThis[Symbol.for("display-hold-layout")](');
    assert.notEqual(source, replaced, "the hold is a layout effect to catch");
    return { ...result, source: replaced };
  },
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DisplayHold } = await import("./DisplayHold.tsx");
const { holdAtBoot, scheme, startScheme } = await import("../../lib/scheme.ts");
const { setThemeChoice } = await import("../device/settings.ts");

/** Mounts the hold, and gives back its unmount. */
function mount(): () => void {
  effects = [];
  renderToStaticMarkup(createElement(DisplayHold, null, "the pages"));
  const releases = effects.map((run) => run()).filter((r): r is () => void => typeof r === "function");
  return () => {
    for (const release of releases) release();
  };
}

test("the hold keeps dark on a light device while mounted, and gives the latest choice back as it goes", () => {
  startScheme();
  setThemeChoice("light");
  assert.equal(scheme(), "light");
  const unmount = mount();
  try {
    assert.equal(scheme(), "dark", "dark from its mount");
    setThemeChoice("auto");
    setThemeChoice("light");
    assert.equal(scheme(), "dark", "a choice made meanwhile waits for the release");
  } finally {
    unmount();
  }
  assert.equal(scheme(), "light", "the device's own choice once it goes");
});

test("a boot hold keeps dark before the first render, and the route's hold takes over from it", () => {
  setThemeChoice("light");
  holdAtBoot("dark");
  assert.equal(scheme(), "dark", "dark before any render");
  const unmount = mount();
  assert.equal(scheme(), "dark");
  unmount();
  assert.equal(scheme(), "light", "the boot hold went when the route's took over, so leaving the display gives light back");
  setThemeChoice("dark");
});

test("App holds outside the display's lazy boundary, and main.tsx holds from boot on a display's path", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(app, /case "display":\n(\s*\/\/[^\n]*\n)?\s*return \(\n\s*<DisplayHold>\n\s*<LoadBoundary[^\n]*\n\s*<Suspense fallback=\{null\}>\n\s*<DisplayPages /);
  const main = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
  const boot = main.indexOf('parseRoute(location.pathname, { dev: import.meta.env.DEV }).name === "display") holdAtBoot("dark");');
  assert.ok(boot >= 0, "main.tsx holds dark on a display's path");
  assert.ok(boot < main.indexOf("\nstartScheme();"), "before the scheme first paints");
  assert.ok(boot < main.indexOf("createRoot("), "before the first render");
  const pages = readFileSync(new URL("./DisplayPages.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(pages, /holdScheme|holdForPage/, "the lazy pages take no hold of their own, which would come only once their code is in");
});
