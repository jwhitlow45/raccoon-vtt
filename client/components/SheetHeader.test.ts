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
const { HideButton, PaneHeader, SheetHeader } = await import("./SheetHeader.tsx");
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

/*
 * A docked window's header sticks to the top of its scrolling frame, so it
 * takes back the frame's 4 px top padding to cover what scrolls under it.
 * It gives that back with a 48 px row's 2 px above and below its buttons,
 * so its Close and title stand where a map pane's header puts them, 6 px
 * under the frame's top edge inside its border, not 4
 * (docs/design-v1-polish.md R7).
 */
describe("a sticky pane header", () => {
  const row = (markup: string) => /^<div[^>]*style="([^"]*)"/.exec(markup)?.[1] ?? "";

  test("pads 6 px above its buttons and 2 below, 52 px in all, over the frame's 4 px it takes back", () => {
    const style = row(renderToStaticMarkup(createElement(PaneHeader, { title: "Goblin", onClose() {}, sticky: true })));
    assert.match(style, /margin:-4px -12px 0/);
    assert.match(style, /padding:6px 12px 2px/);
    assert.match(style, /min-height:52px/);
  });

  test("stands its buttons where a pane's own header does: 2 px under the frame's padding, as a 48 px row centers 44 px buttons", () => {
    const own = row(renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {} })));
    assert.match(own, /min-height:48px/);
    assert.match(own, /align-items:center/);
    const sticky = row(renderToStaticMarkup(createElement(PaneHeader, { title: "Goblin", onClose() {}, sticky: true })));
    const [top, , bottom] = (/padding:(\d+)px (\d+)px (\d+)px/.exec(sticky) ?? []).slice(1).map(Number);
    const reach = Number(/margin:-(\d+)px/.exec(sticky)?.[1]);
    assert.equal(top! - reach, (48 - 44) / 2, "the sticky header's buttons stand higher or lower than a pane's");
    assert.equal(bottom, (48 - 44) / 2);
  });
});
