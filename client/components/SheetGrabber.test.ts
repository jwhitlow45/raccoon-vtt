import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The grabber shows that a phone's sheet swipes. It is drawn by the grab
 * area that swipes, so a header that is no grab area shows none, and one
 * that is shows exactly one. It is decoration laid over the room above
 * the header's buttons: hidden from screen readers, out of the focus
 * order, taking no pointer, and adding no height. Which surfaces show one
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
      // Placed against the header itself, which holds it.
      assert.match(/^<header[^>]*>/.exec(on)?.[0] ?? "", /position:relative/);
    }
  });

  test("is decoration: hidden, out of the focus order, no pointer, centered 1 px into the 6 px above the buttons", () => {
    const [pill = ""] = grabbers(renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true })));
    assert.match(pill, /aria-hidden="true"/);
    assert.doesNotMatch(pill, /tabindex|role=/i);
    const style = styleOf(pill);
    assert.match(style, /pointer-events:none/);
    assert.match(style, /position:absolute/);
    assert.match(style, /top:1px/);
    assert.match(style, /width:36px/);
    assert.match(style, /height:4px/);
    assert.match(style, /left:50%/);
    assert.match(style, /margin-left:-18px/);
  });

  test("a pane's header shows one as a sheet, reaching over the frame's 4 px top padding without moving its row", () => {
    const on = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {}, grab: true }));
    const off = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {} }));
    assert.equal(grabbers(on).length, 1);
    assert.equal(grabbers(off).length, 0);
    const row = styleOf(/^<div[^>]*>/.exec(on)?.[0] ?? "");
    // 4 px up and 4 px of padding back, so the 48 px row and its buttons stand where they did.
    assert.match(row, /margin-top:-4px/);
    assert.match(row, /padding-top:4px/);
    assert.match(row, /min-height:52px/);
    assert.match(styleOf(grabbers(on)[0] ?? ""), /top:1px/);
    assert.doesNotMatch(styleOf(/^<div[^>]*>/.exec(off)?.[0] ?? ""), /margin-top|padding-top/);
  });
});
