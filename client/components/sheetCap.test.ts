import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SHEET_MIN_HEIGHT, sheetCap, sheetMaxHeight, sheetRoom } from "./sheetCap.ts";

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
