import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headerStacks, SHEET_HEADER, SHEET_HEADER_STACKED, SHEET_MAX_WIDTH, SHEET_MIN_HEIGHT, sheetCap, sheetMaxHeight, sheetMode, sheetRoom, sheetWidth, sideSheetWidth } from "./sheetCap.ts";

/** A 390 x 844 phone at 100%: the 52 px top bar and the 60 px toolbar, no safe areas. */
const PHONE = { height: 844, safeTop: 0, safeBottom: 0, insetTop: 52, insetBottom: 60 };

describe("the sheet's height cap", () => {
  test("without a reserve it takes 60% of the screen when that fits under the bars", () => {
    assert.equal(sheetCap(PHONE), 844 * 0.6);
  });

  test("on a short screen it keeps 24 px of map between the bars and its top", () => {
    const space = { ...PHONE, height: 300 };
    assert.equal(sheetRoom(space), 300 - 52 - 60 - 24);
    assert.equal(sheetCap(space), SHEET_MIN_HEIGHT + 44);
  });

  test("a reserve wider than the 24 px gap keeps room for what docks there", () => {
    // 320 x 480 at 130% in a fight: 369 px tall, the bars and the turn band 100, the toolbar 60, the dock 48 and its 8 px gap (3.2.1).
    const space = { height: 480 / 1.3, safeTop: 0, safeBottom: 0, insetTop: 100, insetBottom: 60 };
    assert.equal(Math.round(sheetCap({ ...space, reserveTop: 56 })), 153);
    assert.equal(Math.round(sheetCap(space)), 185);
    assert.equal(sheetRoom({ ...space, reserveTop: 10 }), sheetRoom(space), "a reserve under the gap changes nothing");
  });

  test("it never goes below 120 px, even when the dock does not fit", () => {
    // The forced case of 3.2.1: 44 and 34 px safe areas leave 131 px between the bars and the toolbar.
    const space = { height: 480 / 1.3, safeTop: 44, safeBottom: 34, insetTop: 100, insetBottom: 60 };
    assert.ok(sheetRoom({ ...space, reserveTop: 56 }) < SHEET_MIN_HEIGHT, "the dock does not fit, so its buttons go to the header");
    assert.equal(sheetCap({ ...space, reserveTop: 56 }), SHEET_MIN_HEIGHT);
    assert.equal(sheetCap(space), SHEET_MIN_HEIGHT);
  });

  test("the CSS says the same: a 120 px floor, 60% of the screen, and the larger of the gap and the reserve", () => {
    const css = sheetMaxHeight({ top: 52, bottom: 60 });
    assert.match(css, /^max\(120px, min\(calc\(60dvh \/ var\(--rvtt-ui, 1\)\), calc\(100% - env\(safe-area-inset-top, 0px\) - env\(safe-area-inset-bottom, 0px\) - 136px\)\)\)$/);
    assert.match(sheetMaxHeight({ top: 52, bottom: 60 }, 56), / - 168px\)\)\)$/);
    assert.match(sheetMaxHeight({ top: 52, bottom: 60 }, 8), / - 136px\)\)\)$/);
  });
});

describe("the sheet's width cap (docs/design-v1-look-pass.md 2.8)", () => {
  test("a medium dialog's width", () => {
    assert.equal(SHEET_MAX_WIDTH, 560);
  });

  test("an upright tablet's sheet stops at 560 px: 820 and 744 across, 820 at 130%, 600, and one past the cap", () => {
    for (const width of [820, 744, 820 / 1.3, 600, 561]) assert.equal(sheetWidth("bottom", width), 560, `${width} px`);
  });

  test("a phone's sheet spans its width as before, 560 px and under", () => {
    for (const width of [560, 430, 390, 360, 320, 320 / 1.3]) assert.equal(sheetWidth("bottom", width), width, `${width} px`);
  });

  test("no cap on a phone held sideways: the sheet on the right keeps its own width, and the very short mode the whole screen", () => {
    assert.equal(sheetWidth("side", 844), 340);
    assert.equal(sheetWidth("side", 932), 340);
    assert.equal(Math.round(sheetWidth("side", 513)), 308);
    for (const width of [844, 932, 480 / 1.3]) assert.equal(sheetWidth("full", width), width, `${width} px`);
  });
});

describe("a sideways sheet's header", () => {
  /** The header's width: the sheet less the safe area it holds on each side and its two 1 px borders. */
  const inside = (sheet: number, safeLeft: number, safeRight: number) => sheet - safeLeft - safeRight - 2;

  test("Back, Hide and Close keep one row from 200 px of header, 192 with actions", () => {
    assert.equal(headerStacks({ width: 200, buttons: 3, actions: false }), false);
    assert.equal(headerStacks({ width: 199, buttons: 3, actions: false }), true);
    assert.equal(headerStacks({ width: 192, buttons: 3, actions: true }), false);
    assert.equal(headerStacks({ width: 191, buttons: 3, actions: true }), true);
  });

  test("every sideways sheet in the doc's sizes keeps one row", () => {
    // 844 x 390 with 47 px insets, at 100% and 130%: the 340 px sheet holds the right inset.
    assert.equal(inside(sideSheetWidth(844), 0, 47), 291);
    assert.equal(headerStacks({ width: inside(sideSheetWidth(844), 0, 47), buttons: 3, actions: false }), false);
    assert.equal(headerStacks({ width: inside(sideSheetWidth(649), 0, 47), buttons: 3, actions: false }), false);
    // 667 x 375 at 130% (513 x 288): the 60% cap, 308 px.
    assert.equal(Math.round(sideSheetWidth(513)), 308);
    assert.equal(headerStacks({ width: inside(sideSheetWidth(513), 0, 0), buttons: 3, actions: false }), false);
    // 480 x 320 at 100%: 288 px, 239 inside.
    assert.equal(Math.round(inside(sideSheetWidth(480), 0, 47)), 239);
    assert.equal(headerStacks({ width: inside(sideSheetWidth(480), 0, 47), buttons: 3, actions: false }), false);
  });

  test("the very short mode at 480 x 320 at 130% has 275 px, with no borders, where five buttons stack and three do not", () => {
    const width = Math.round(480 / 1.3 - 47 - 47);
    assert.equal(width, 275);
    assert.equal(headerStacks({ width, buttons: 3, actions: false }), false);
    assert.equal(headerStacks({ width, buttons: 5, actions: true }), true, "Back, Hide, Close and the dock's two buttons");
    assert.equal(headerStacks({ width, buttons: 4, actions: true }), false, "one dock button still fits");
  });
});

describe("a sideways sheet's mode", () => {
  const mode = (height: number, topBars: number, safeBottom = 21, header = SHEET_HEADER) => sheetMode({ height, safeTop: 0, safeBottom, topBars, header });

  test("the doc's sizes, band or not: the very short mode exactly where the body would be under 88 px", () => {
    // Bodies inside the sheet's borders. 844 x 390: 199, 151 with the band.
    assert.equal(mode(390, 52), "side");
    assert.equal(mode(390, 100), "side");
    // 844 x 390 at 130% (300 tall): 109, or 61 with the band.
    assert.equal(mode(300, 52), "side");
    assert.equal(mode(300, 100), "full");
    // 667 x 375, no insets: 205 and 157. At 130% (288): 118, and 70 with the band.
    assert.equal(mode(375, 52, 0), "side");
    assert.equal(mode(375, 100, 0), "side");
    assert.equal(mode(288, 52, 0), "side");
    assert.equal(mode(288, 100, 0), "full");
    // 932 x 430 at 130% (331): 139, and 91 with the band, still a sheet.
    assert.equal(mode(331, 52), "side");
    assert.equal(mode(331, 100), "side");
    // 480 x 320: 129, and 81 with the band. At 130% (246), 55 with no band: always the very short mode.
    assert.equal(mode(320, 52), "side");
    assert.equal(mode(320, 100), "full");
    assert.equal(mode(246, 52), "full");
    assert.equal(mode(246, 100), "full");
  });

  test("88 px of body inside the sheet's borders is enough, 87 is not, and a stacked header counts its 78 px", () => {
    // 52 + 60 + 56 + the 1 px border above and below + 88 = 258.
    assert.equal(mode(258, 52, 0), "side");
    assert.equal(mode(257, 52, 0), "full");
    assert.equal(mode(258, 52, 0, SHEET_HEADER_STACKED), "full");
  });
});
