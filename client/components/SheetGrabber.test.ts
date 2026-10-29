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
 * Each design This device offers keeps the room its own height needs
 * (docs/design-v1-sheet-swipe.md 4.8). Which surfaces show one
 * at which sizes is e2e/swipe.e2e.ts test 14's, read against the swipe's
 * own mark on each surface.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PaneHeader, SheetHeader } = await import("./SheetHeader.tsx");
const { GRABBER_DESIGNS, grabberRoom, parseGrabber } = await import("./grabberDesigns.ts");
const { setSheetHandle } = await import("../features/device/settings.ts");

const grabbers = (markup: string) => [...markup.matchAll(/<svg[^>]*data-sheet-grabber[^>]*>/g)].map((m) => m[0]);
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
    assert.match(pill, /width="36"/);
    assert.match(pill, /height="4"/);
    assert.match(style, /left:50%/);
    assert.match(style, /margin-left:-18px/);
    // controlBorder at rest, and the member's accent through the custom property the swipe sets while a finger holds the sheet, fading 150 ms each way.
    assert.match(style, /color:var\(--rvtt-grabber-held, #76747f\)/);
    assert.match(style, /transition:color 150ms ease/);
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

  test("the default is the ringed tail, drawn in one color, and an unknown stored design falls back to it", () => {
    assert.deepEqual(
      GRABBER_DESIGNS.map((d) => [d.id, d.name]),
      [
        ["tail", "Ringed tail"],
        ["mask", "Bandit mask"],
        ["beans", "Paw beans"],
        ["rod", "Scroll rod"],
        ["rune", "Rune divider"],
        ["pill", "Plain pill"],
      ],
    );
    for (const raw of [null, "", "blob", "Tail", "pill "]) assert.equal(parseGrabber(raw), "tail", String(raw));
    for (const d of GRABBER_DESIGNS) assert.equal(parseGrabber(d.id), d.id);
    const [tail = ""] = grabbers(renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true })));
    assert.match(tail, /data-grabber-design="tail"/);
    assert.match(tail, /fill="currentColor"/);
  });

  test("each design keeps the room above a header that its height needs: its 5 px place, its height and 1 px, the mask the tallest", () => {
    assert.deepEqual(Object.fromEntries(GRABBER_DESIGNS.map((d) => [d.id, grabberRoom(d.id)])), { tail: 10, mask: 15, beans: 14, rod: 12, rune: 12, pill: 10 });
    try {
      for (const d of GRABBER_DESIGNS) {
        setSheetHandle(d.id);
        const room = grabberRoom(d.id);
        const sheet = renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true }));
        const [shown = ""] = grabbers(sheet);
        assert.match(shown, new RegExp(`data-grabber-design="${d.id}"`));
        assert.match(shown, new RegExp(`width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}"`), d.id);
        assert.match(styleOf(shown), new RegExp(`top:5px;left:50%;margin-left:-${d.width / 2}px`), d.id);
        // The row's buttons stand the room down, and the header grows by the room less the 6 px it kept: nothing else in it moves.
        assert.match(styleOf(/^<header[^>]*>/.exec(sheet)?.[0] ?? ""), new RegExp(`min-height:${56 + room - 6}px;padding:${room - 6}px 8px 0`), d.id);
        const stacked = renderToStaticMarkup(createElement(SheetHeader, { title: "Log", onClose() {}, grab: true, stacked: true }));
        assert.match(styleOf(/^<header[^>]*>/.exec(stacked)?.[0] ?? ""), new RegExp(`padding:${6 + room - 6}px 8px 6px`), d.id);
        const detail = renderToStaticMarkup(createElement(SheetHeader, { title: "Scene", detail: "12 x 8 squares", onClose() {}, grab: true }));
        assert.equal(grabbers(detail).length, 1, `${d.id}: a detail header has one grabber`);
        assert.match(styleOf(/^<header[^>]*>/.exec(detail)?.[0] ?? ""), new RegExp(`padding-top:${room - 6}px(;|$)`), `${d.id}: the detail header leaves room for its design`);
        const noGrab = renderToStaticMarkup(createElement(SheetHeader, { title: "Scene", detail: "12 x 8 squares", onClose() {} }));
        assert.equal(grabbers(noGrab).length, 0, `${d.id}: a detail header that does not swipe has no grabber`);
        assert.match(styleOf(/^<header[^>]*>/.exec(noGrab)?.[0] ?? ""), /padding-top:0(;|$)/, `${d.id}: a detail header that does not swipe keeps its height`);
        const pane = renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {}, grab: true }));
        const paneRow = styleOf(/^<div[^>]*>/.exec(pane)?.[0] ?? "");
        assert.match(paneRow, new RegExp(`padding-top:${room - 2}px(;|$)`), d.id);
        assert.match(paneRow, new RegExp(`min-height:${48 + room - 2}px`), d.id);
        const sticky = styleOf(/^<div[^>]*>/.exec(renderToStaticMarkup(createElement(PaneHeader, { title: "Label", onClose() {}, grab: true, sticky: true })))?.[0] ?? "");
        assert.match(sticky, new RegExp(`padding:${room}px 12px 2px`), d.id);
        assert.match(sticky, new RegExp(`min-height:${48 + room - 2}px`), d.id);
      }
    } finally {
      setSheetHandle("tail");
    }
  });
});
