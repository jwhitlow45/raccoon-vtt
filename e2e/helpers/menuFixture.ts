import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Page } from "playwright-core";

let bundle: Promise<string> | undefined;

/** The real SideTabs at phone widths too, where Room normally replaces it with the Panels sheet. */
export async function moreMenuFixture(page: Page, origin: string, scale: number): Promise<void> {
  bundle ??= buildFixture();
  const url = `${origin}/fl5-menu-fixture`;
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="fl5-root"></div>' }));
  await page.goto(url);
  await page.evaluate((value) => localStorage.setItem("rvtt.uiScale", String(value)), scale);
  await page.addStyleTag({ content: readFileSync(new URL("../../client/globals.css", import.meta.url), "utf8") });
  await page.addScriptTag({ content: await bundle });
  await page.getByRole("tablist", { name: "Panels" }).locator('[aria-haspopup="menu"]').waitFor();
  await page.evaluate(async () => {
    const doc = (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document;
    await doc.fonts.ready;
  });
}

/** A separate entry keeps test scaffolding out of the shipped app. No server or extra port is needed. */
export async function buildFixture(): Promise<string> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const entry = `${root}client/fl5-menu-fixture.tsx`;
  const source = `
import { createElement as h, createRef } from "react";
import { createRoot } from "react-dom/client";
import { RoomScope, RoomScopeProvider } from "./state/scope.ts";
import { SideTabs } from "./pages/SideTabs.tsx";
import { panelsFor } from "./features/panels.ts";
import { chromeZoom } from "./features/device/layout.ts";
import { uiScale } from "./features/device/settings.ts";
import { theme } from "./lib/theme.ts";
const scale = uiScale();
const noop = () => {};
createRoot(document.getElementById("fl5-root")).render(
  h(RoomScopeProvider, { scope: new RoomScope() },
    h("aside", { style: { ...chromeZoom(scale), position: "fixed", right: 0, top: 0,
      width: Math.min(theme.layout.sidePanelWidth, innerWidth / scale),
      height: innerHeight / scale, background: theme.color.surface } },
      h(SideTabs, { hidden: false, zoom: scale, tabs: panelsFor("dm", true), tab: "token",
        badges: {}, badgeLabels: {}, grouped: true, onTab: noop, onHide: noop,
        split: { on: false, fits: true, below: null, onToggle: noop },
        onCutTitle: noop, tabRef: createRef(), onTabsDrawn: noop,
        tabId: (id) => "fl5-" + id, panelId: "fl5-panel" })))
);
`;
  const built = await build({
    configFile: `${root}vite.config.ts`,
    logLevel: "error",
    plugins: [{ name: "fl5-menu-fixture", resolveId: (id) => id === entry ? entry : undefined, load: (id) => id === entry ? source : undefined }],
    build: {
      write: false,
      sourcemap: false,
      minify: false,
      rollupOptions: { input: entry, output: { format: "iife", codeSplitting: false } },
    },
  });
  const outputs = Array.isArray(built) ? built : [built];
  const script = outputs.flatMap((output) => "output" in output ? output.output : []).find((output) => output.type === "chunk" && output.isEntry);
  if (!script || script.type !== "chunk") throw new Error("FL5 menu fixture produced no entry");
  return script.code;
}
