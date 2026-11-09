import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * The dungeon preview's corner (docs/design/design-v1-light-theme.md 6.4,
 * D-261102-545, review LTB-1): the picture and its ground keep the board's
 * dark look in either scheme, so what stands in the corner, Reroll, takes
 * the dark palette and the accent resolved for dark, its focus ring
 * included, or the light accent's ring would read 2.5:1 on the dark ground.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DungeonPreview } = await import("./Preview.tsx");
const { BOARD_SCOPE, boardTheme, theme } = await import("../../lib/theme.ts");
const { tokenPattern } = await import("../../components/testing/tokenPattern.ts");

const declares = (style: string, property: string, value: string) => new RegExp(`(^|;)${tokenPattern(property)}:${tokenPattern(value)}(;|$)`).test(style);

test("the corner that holds Reroll puts the whole dark palette and the dark accent in scope, on the board's ground", () => {
  const html = renderToStaticMarkup(
    createElement(DungeonPreview, { drawn: null, width: 400, height: 300, drawing: false, onPictured: () => undefined, onPictureFailed: () => undefined }, createElement("button", { type: "button" }, "Reroll")),
  );
  const box = /^<div style="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(declares(box, "background", boardTheme.color.bg), box);
  const corner = /<div style="([^"]*)"><button type="button">Reroll<\/button>/.exec(html)?.[1] ?? "";
  assert.notEqual(corner, "");
  for (const [name, value] of Object.entries(BOARD_SCOPE)) {
    const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    assert.ok(declares(corner, property, value), property);
  }
  // Set under the scope: the color it would inherit is the page's, worked out before the scope.
  assert.ok(declares(corner, "color", theme.color.text), corner);
});

test("Reroll itself wears the board's two-tone ring, whose dark halo stands between its ring and the picture's stone (review LTA-1)", async () => {
  const { readFileSync } = await import("node:fs");
  const dialog = readFileSync(new URL("./GenerateDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /<Button size="sm" \{\.\.\.ON_BOARD\} style=\{ON_BOARD_STYLE\}.*>\n\s*Reroll/);
});

const previewMarkup = (drawing: boolean, drawingNow?: boolean) =>
  renderToStaticMarkup(createElement(DungeonPreview, { drawn: null, width: 400, height: 300, drawing, drawingNow, onPictured: () => undefined, onPictureFailed: () => undefined }));

test("Look closer's status words are in the markup at once, before its render starts, and an ordinary redraw keeps the delay (DG2-SOL-01)", async () => {
  const { DRAWING } = await import("./words.ts");
  assert.ok(previewMarkup(true, true).includes(DRAWING), "drawingNow shows the words on the first render");
  assert.ok(!previewMarkup(true).includes(DRAWING), "a plain redraw waits the shared delay");
  const { readFileSync } = await import("node:fs");
  const dialog = readFileSync(new URL("./GenerateDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /drawingNow=\{looking\}/);
});

test("no empty pill is drawn before the drawing words show (DG2-OP-07)", () => {
  assert.equal(previewMarkup(true), previewMarkup(false));
  assert.notEqual(previewMarkup(true, true), previewMarkup(false));
});
