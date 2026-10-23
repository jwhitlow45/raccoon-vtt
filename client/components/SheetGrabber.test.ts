import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The grabber shows that a phone's sheet swipes. It is drawn by the grab
 * area that swipes, so a header that is no grab area shows none, and one
 * that is shows exactly one. It is decoration laid over the room above
 * the header's buttons: hidden from screen readers, out of the focus
 * order and taking no pointer. It sits 5 px under the top edge, 1 px
 * clear of the buttons, so a header that kept 6 px above its buttons
 * grows 4 px for it, and one that is no grab area keeps its height.
 * Which surfaces show one
 * at which sizes is e2e/swipe.e2e.ts test 14's, read against the swipe's
 * own mark on each surface.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PaneHeader, SheetHeader } = await import("./SheetHeader.tsx");

const grabbers = (markup: string) => [...markup.matchAll(/<span[^>]*data-sheet-grabber[^>]*>/g)].map((m) => m[0]);
const styleOf = (tag: string) => /style="([^"]*)"/.exec(tag)?.[1] ?? "";

describe("the sheet grabber", () => {
  test("a sheet's header shows exactly one while it is a grab area, in each of its shapes, and none otherwise", () => {
    const shapes = [{}, { stacked: true }, { detail: "12 x 8 squares" }, { back: { label: "Back to Menu", onBack() {} } }];
    for (const shape of shapes) {
      const on = renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true, ...shape }));
      const off = renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, ...shape }));
      assert.equal(grabbers(on).length, 1, JSON.stringify(shape));
      assert.equal(grabbers(off).length, 0, JSON.stringify(shape));
      // Placed against the header itself, which holds it, and 4 px taller for it: 10 px above the buttons, 6 without.
      const header = styleOf(/^<header[^>]*>/.exec(on)?.[0] ?? "");
      assert.match(header, /position:relative/);
      assert.match(header, "stacked" in shape ? /padding:10px 8px 6px/ : "detail" in shape ? /padding-top:4px/ : /min-height:60px;padding:4px 8px 0/);
      assert.match(styleOf(/^<header[^>]*>/.exec(off)?.[0] ?? ""), "stacked" in shape ? /padding:6px 8px 6px/ : "detail" in shape ? /padding-top:0/ : /min-height:56px;padding:0px 8px 0/);
    }
  });

  test("is decoration: hidden, out of the focus order, no pointer, 5 px under the top edge", () => {
    const [pill = ""] = grabbers(renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true })));
    assert.match(pill, /aria-hidden="true"/);
    assert.doesNotMatch(pill, /tabindex|role=/i);
    const style = styleOf(pill);
    assert.match(style, /pointer-events:none/);
    assert.match(style, /position:absolute/);
    assert.match(style, /top:5px/);
    assert.match(style, /width:36px/);
    assert.match(style, /height:4px/);
    assert.match(style, /left:50%/);
    assert.match(style, /margin-left:-18px/);
  });

  test("a pane's header shows one as a sheet, reaching over the frame's 4 px top padding and growing 4 px for it", () => {
    const on = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {}, grab: true }));
    const off = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {} }));
    assert.equal(grabbers(on).length, 1);
    assert.equal(grabbers(off).length, 0);
    const row = styleOf(/^<div[^>]*>/.exec(on)?.[0] ?? "");
    // 4 px up over the frame's padding and 8 px of padding back: the 48 px row and its buttons stand 4 px lower, 10 px under the frame's top.
    assert.match(row, /margin-top:-4px/);
    assert.match(row, /padding-top:8px/);
    assert.match(row, /min-height:56px/);
    assert.match(styleOf(grabbers(on)[0] ?? ""), /top:5px/);
    assert.doesNotMatch(styleOf(/^<div[^>]*>/.exec(off)?.[0] ?? ""), /margin-top|padding-top/);
  });

  test("a sticky pane header that is a grab area keeps the same room: 10 px above its buttons, the pill 5 px down", () => {
    const markup = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {}, grab: true, sticky: true }));
    assert.equal(grabbers(markup).length, 1);
    // A sticky header already reaches over the frame's 4 px and keeps a pane row's 2 px under its buttons, so it grows 4 px, as a pane's own does.
    const row = styleOf(/^<div[^>]*>/.exec(markup)?.[0] ?? "");
    assert.match(row, /padding:10px 12px 2px/);
    assert.match(row, /min-height:56px/);
    assert.match(styleOf(grabbers(markup)[0] ?? ""), /top:5px/);
  });
});
