import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { overflowRecord, turnPlacement } from "./band.ts";

/** The layout size of a window at an interface size (features/device/layout.ts layoutSize). */
function layout(width: number, height: number, scale = 1): { width: number; height: number } {
  return { width: width / scale, height: height / scale };
}

describe("turnPlacement", () => {
  test("from 900 px wide the strip sits in the top bar, whatever overflowed", () => {
    assert.equal(turnPlacement({ ...layout(1280, 800), overflowedAt: null }), "bar");
    assert.equal(turnPlacement({ ...layout(900, 1200), overflowedAt: 5000 }), "bar");
  });

  test("a phone in portrait takes the band", () => {
    assert.equal(turnPlacement({ ...layout(390, 844), overflowedAt: null }), "band");
    assert.equal(turnPlacement({ ...layout(375, 667), overflowedAt: null }), "band");
  });

  test("a short phone in landscape keeps the strip in the bar", () => {
    assert.equal(turnPlacement({ ...layout(844, 390), overflowedAt: null }), "bar");
    assert.equal(turnPlacement({ ...layout(667, 375), overflowedAt: null }), "bar");
  });

  test("landscape at 500 px tall or more takes the band, as a tablet held sideways under 900 px would", () => {
    assert.equal(turnPlacement({ ...layout(880, 500), overflowedAt: null }), "band");
    assert.equal(turnPlacement({ ...layout(880, 620), overflowedAt: null }), "band");
  });

  test("the interface size reads the chrome's own pixels", () => {
    // 1,000 x 700 at 130% lays out as 769 x 538: a phone, landscape, but too tall for the bar.
    assert.equal(turnPlacement({ ...layout(1000, 700, 1.3), overflowedAt: null }), "band");
    // 844 x 390 at 130% is 649 x 300: still short landscape.
    assert.equal(turnPlacement({ ...layout(844, 390, 1.3), overflowedAt: null }), "bar");
    // 1,280 x 800 at 150% is 853 x 533: under 900 wide and 500 tall or more.
    assert.equal(turnPlacement({ ...layout(1280, 800, 1.5), overflowedAt: null }), "band");
  });

  test("a recorded overflow keeps the band until the layout is wider than the record", () => {
    const at = overflowRecord(null, 667, 60);
    assert.equal(at, 727);
    assert.equal(turnPlacement({ ...layout(667, 375), overflowedAt: at }), "band");
    assert.equal(turnPlacement({ ...layout(727, 375), overflowedAt: at }), "band", "exactly the record still overflowed by a hair");
    assert.equal(turnPlacement({ ...layout(844, 390), overflowedAt: at }), "bar");
    // At 130% the same window is 513 px wide, under the record.
    assert.equal(turnPlacement({ ...layout(667, 375, 1.3), overflowedAt: at }), "band");
  });

  test("a record never shrinks, so a larger need wins", () => {
    assert.equal(overflowRecord(727, 650, 40), 727);
    assert.equal(overflowRecord(727, 800, 40), 840);
  });
});
