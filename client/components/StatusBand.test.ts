import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { theme } from "../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { StatusBand } = await import("./StatusBand.tsx");

/*
 * The iPhone home-screen app's black strip under its white status bar text
 * on a light page (docs/design/design-v1-light-theme.md 6.4, D-261102-368):
 * the safe top's height, over every bar, sheet and popover fallback outside
 * the top layer, and transparent unless lib/scheme.ts sets it black.
 */
test("the status band is the safe top's height, over everything outside the top layer, and lets taps through", () => {
  const markup = renderToStaticMarkup(createElement(StatusBand));
  const style = /<div aria-hidden="true" data-rvtt-status-band="" style="([^"]*)"><\/div>/.exec(markup)?.[1];
  assert.ok(style, markup);
  assert.match(style, /position:fixed/);
  assert.match(style, /top:0/);
  assert.match(style, /left:0/);
  assert.match(style, /right:0/);
  assert.ok(style.includes(`height:${theme.safe.top}`), style);
  assert.match(style, new RegExp(`z-index:${theme.z.statusBand}(;|$)`));
  assert.match(style, /pointer-events:none/);
  assert.ok(style.includes("background:var(--rvtt-status-band, transparent)"), style);
  for (const [name, z] of Object.entries(theme.z)) if (name !== "statusBand") assert.ok(z < theme.z.statusBand, `${name} (${z}) stays under it`);
});
