import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * Escape in the journal's or the monster's editor with unsaved changes
 * asks before it discards, and a second Escape discards. Shown as plain
 * text, the question was never read out, so a screen reader user heard
 * nothing between the two (LPD-DESK-8).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DiscardQuestion, dialogCard, DIALOG_PHONE_MAX } = await import("./Dialog.tsx");
const { theme } = await import("../lib/theme.ts");

describe("the question an editor asks before it discards", () => {
  test("is an alert, so it is read out as it appears", () => {
    const markup = renderToStaticMarkup(createElement(DiscardQuestion));
    assert.match(markup, /^<span role="alert"[^>]*>Throw away your changes\?<\/span>$/);
  });
});

/*
 * The handout viewer fills the window on a short layout and once it grows
 * (docs/design-v1-layout-hierarchy.md 5.1), where a computer's card would
 * leave dim room around it. `full` gives any width the phone's card.
 */
describe("the shape of a dialog's card", () => {
  const screen = {
    width: "100%",
    height: "100%",
    border: "none",
    borderRadius: 0,
    paddingTop: theme.safe.top,
    paddingBottom: theme.safe.bottom,
    paddingLeft: theme.safe.left,
    paddingRight: theme.safe.right,
  };

  test("full takes the whole screen inside the safe areas at a computer's width", () => {
    for (const width of [DIALOG_PHONE_MAX, 844, 1280]) {
      assert.deepEqual(dialogCard(width, { full: true, width: "lg" }), { card: screen, bottom: false }, `at ${width}`);
      assert.deepEqual(dialogCard(width, { full: true, phone: "sheet" }), { card: screen, bottom: false }, `a sheet at ${width}`);
    }
  });

  test("without it a computer keeps the card, and a phone the whole screen or a sheet", () => {
    const card = dialogCard(1280, { width: "lg", phone: "fill" });
    assert.equal(card.bottom, false);
    assert.equal(card.card.width, `min(${theme.layout.dialog.lg}px, calc(100% - ${theme.space(8)}px))`);
    assert.equal(card.card.height, `min(calc(100% - ${theme.space(8)}px), 760px)`);
    assert.deepEqual(dialogCard(DIALOG_PHONE_MAX - 1, { width: "lg" }), { card: screen, bottom: false });
    assert.equal(dialogCard(390, { phone: "sheet" }).bottom, true);
  });
});
