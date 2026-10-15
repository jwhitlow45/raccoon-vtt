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
const { DiscardQuestion } = await import("./Dialog.tsx");

describe("the question an editor asks before it discards", () => {
  test("is an alert, so it is read out as it appears", () => {
    const markup = renderToStaticMarkup(createElement(DiscardQuestion));
    assert.match(markup, /^<span role="alert"[^>]*>Throw away your changes\?<\/span>$/);
  });
});
