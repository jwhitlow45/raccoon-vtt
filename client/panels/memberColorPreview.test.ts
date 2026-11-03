import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accentFor } from "../lib/accent.ts";

/*
 * The Members color picker's sample button and its note follow the page's
 * scheme (docs/design/design-v1-light-theme.md 6.3): an orange member reads
 * "Buttons stay yellow." on dark and the crest's darker shade on light.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ColorPreview } = await import("./MembersPanel.tsx");

const preview = (color: string, scheme: "dark" | "light") => renderToStaticMarkup(createElement(ColorPreview, { color, scheme }));

describe("the color picker's preview", () => {
  test("draws the sample in the scheme's accent, with its text color", () => {
    for (const scheme of ["dark", "light"] as const) {
      const a = accentFor("#8e4ec6", scheme);
      assert.match(preview("#8e4ec6", scheme), new RegExp(`background:${a.accent};color:${a.onAccent}`, "i"));
    }
    assert.notEqual(accentFor("#8e4ec6", "dark").accent, accentFor("#8e4ec6", "light").accent);
  });

  test("an orange member reads the crest note of the scheme", () => {
    assert.match(preview("#f38400", "dark"), /Buttons stay yellow\./);
    assert.match(preview("#f38400", "light"), /Buttons use the crest&#x27;s darker shade so they stay readable\./);
  });

  test("the map color dot keeps the member's own color in both", () => {
    for (const scheme of ["dark", "light"] as const) assert.match(preview("#f38400", scheme), /background:#f38400/);
  });
});
