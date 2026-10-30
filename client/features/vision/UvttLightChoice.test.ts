import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { IMPORT_CHOICE_NAME, UvttLightChoice } = await import("./UvttLightChoice.tsx");

describe("the names of the import's choices", () => {
  test("share one style at the input size and the strong weight, as Players see does", () => {
    assert.equal(IMPORT_CHOICE_NAME.fontSize, theme.font.input);
    assert.equal(IMPORT_CHOICE_NAME.fontWeight, theme.weight.strong);
  });

  test("the light choice's name renders with it", () => {
    const html = renderToStaticMarkup(createElement(UvttLightChoice, { value: "bright", proposal: null, disabled: false, onChange: () => {} }));
    const name = /<span[^>]*style="([^"]*)"[^>]*>Light, for party vision<\/span>/.exec(html);
    assert.ok(name, "the name span renders");
    assert.match(name[1] ?? "", new RegExp(`font-size:${theme.font.input}px`));
    assert.match(name[1] ?? "", new RegExp(`font-weight:${theme.weight.strong}`));
  });

  test("the dialog's portal label takes the same constant, not the dialog's 14 px", () => {
    const source = readFileSync(new URL("../uvtt/ImportDialog.tsx", import.meta.url), "utf8");
    assert.match(source, /<span id=\{portalsId\} style=\{IMPORT_CHOICE_NAME\}>/);
  });
});
