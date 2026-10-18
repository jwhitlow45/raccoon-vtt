import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * Hide puts a panel away and keeps it mounted, on the side panel and on a
 * sideways sheet. Drawn as a right chevron it looked like the scrolling tab
 * row's own arrow beside it, and like forward next to Back's left chevron
 * (docs/design-v1-layout-hierarchy.md 4.1, 4.2).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { HideButton, SheetHeader } = await import("./SheetHeader.tsx");
const { Icon } = await import("./Icon.tsx");

const svg = (markup: string) => /<svg[\s\S]*?<\/svg>/.exec(markup)?.[0] ?? "";
const icon = (name: "collapsePanel" | "chevronRight" | "back") => renderToStaticMarkup(createElement(Icon, { name }));

describe("Hide's icon", () => {
  test("is the framed panel, neither a scroll arrow nor Back's mirror", () => {
    const hide = svg(renderToStaticMarkup(createElement(HideButton, { label: "Hide panels", onClick() {} })));
    assert.equal(hide, icon("collapsePanel"));
    assert.notEqual(hide, icon("chevronRight"));
    assert.notEqual(hide, icon("back"));
  });

  test("a sheet header's Hide draws the same one", () => {
    const markup = renderToStaticMarkup(createElement(SheetHeader, { title: "Initiative", onClose() {}, onHide() {}, hideLabel: "Hide Initiative" }));
    const button = /<button[^>]*aria-label="Hide Initiative"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    assert.equal(svg(button), icon("collapsePanel"));
  });
});

/*
 * A subpage in a side panel pane sits under the tab row or the bar, which
 * name its panel, so its header takes a header row's 44 px and a pane
 * title's 16 px rather than a sheet's 56 and 18
 * (docs/design-v1-side-headers.md 3.3).
 */
describe("a compact header", () => {
  const header = (compact: boolean) => renderToStaticMarkup(createElement(SheetHeader, { title: "Members", compact, back: { label: "Back to Menu", onBack() {} } }));

  test("is one 44 px row with the title at 16 px", () => {
    const markup = header(true);
    assert.match(markup, /^<header style="[^"]*min-height:44px/);
    assert.match(markup, /<h2[^>]*font-size:16px/);
  });

  test("a sheet's header keeps 56 px and 18 px", () => {
    const markup = header(false);
    assert.match(markup, /^<header style="[^"]*min-height:56px/);
    assert.match(markup, /<h2[^>]*font-size:18px/);
  });
});
