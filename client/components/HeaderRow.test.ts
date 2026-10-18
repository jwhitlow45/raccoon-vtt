import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The side panel's header rows share one shape (docs/design-v1-side-headers.md
 * 3.1 and 5): a 44 px line of targets with a 1 px rule at its foot and no
 * padding above or below, so the tab row, the bar between two panes, the
 * party line and a subpage's header are one height. A shaped control draws
 * a 32 px pill inside its 44 px target, behind its words and last in it,
 * so a badge's hidden words follow its title in its name.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { headerRow, PillButton, PILL_HEIGHT, PILL_INSET } = await import("./HeaderRow.tsx");

describe("a header row", () => {
  test("is 45 px: 44 px of targets and the rule at its foot, with no padding above or below", () => {
    for (const raised of [true, false]) {
      const row = headerRow(raised);
      assert.equal(row.minHeight, 45);
      assert.equal(row.boxSizing, "border-box");
      assert.equal(row.padding, "0 8px", "8 px at the sides, none above or below");
      assert.equal(row.borderBottom, "1px solid #3a3a44");
      assert.equal(row.borderTop, undefined);
    }
  });

  test("a pane's own header is a raised band, the party line and a subpage's header the panel's surface", () => {
    assert.equal(headerRow(true).background, "#2a2a32");
    assert.equal(headerRow(false).background, "#1f1f25");
  });
});

describe("a pill", () => {
  test("is 32 px, centered in a 44 px target", () => {
    assert.equal(PILL_HEIGHT, 32);
    assert.equal(PILL_INSET, 6);
  });

  test("comes after the words, behind them, and carries the focus ring", () => {
    const markup = renderToStaticMarkup(createElement(PillButton, { "aria-label": "Ask the party", title: "Ask the party", onClick() {} }, "Ask"));
    assert.match(markup, /^<button type="button" data-pill-focus=""/);
    assert.match(markup, /isolation:isolate/, "the button is the pill's stacking context");
    assert.match(markup, /min-height:44px/);
    assert.match(markup, />Ask<span data-pill=""/, "the pill follows the words");
    assert.match(markup, /<span data-pill="" style="position:absolute;z-index:-1;left:0;right:0;top:6px;bottom:6px/);
  });
});
