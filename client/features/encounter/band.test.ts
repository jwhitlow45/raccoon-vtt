import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bandFit, overflowRecord, turnPlacement } from "./band.ts";

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

describe("bandFit (LPD-DMPHONE-2)", () => {
  // The DM's band has four creatures to come. A player's has none, and End turn on their own turn.
  const fit = (width: number, scale: number, more: { timer?: "none" | "clock" | "over"; endTurn?: boolean; round?: number } = {}) =>
    bandFit({ width: width / scale, round: more.round ?? 1, timer: more.timer ?? "none", endTurn: more.endTurn ?? false, next: more.endTurn ? 0 : 4 });

  test("a phone at 100% shows the DM up to four Next disks, the round and the name", () => {
    assert.deepEqual(fit(390, 1), { disks: 4, round: true, stackEnd: false });
    assert.deepEqual(fit(320, 1), { disks: 4, round: true, stackEnd: false });
    assert.equal(bandFit({ width: 390, round: 1, timer: "none", endTurn: false, next: 2 }).disks, 2, "never more than there are");
  });

  test("the Next disks give way first, one at a time, so the name keeps its letters", () => {
    assert.deepEqual(fit(320, 1, { timer: "over" }), { disks: 2, round: true, stackEnd: false });
    assert.deepEqual(fit(390, 1.3, { timer: "over" }), { disks: 1, round: true, stackEnd: false });
    assert.deepEqual(fit(320, 1.3), { disks: 2, round: true, stackEnd: false });
    assert.deepEqual(fit(320, 1.3, { timer: "over" }), { disks: 0, round: true, stackEnd: false }, "320 px at 130% with time up: no disks, the name and the timer");
  });

  test("a player's own turn at 130%: the round gives way, then End turn stacks its words", () => {
    assert.deepEqual(fit(390, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: false });
    assert.deepEqual(fit(360, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: true });
    assert.deepEqual(fit(320, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: true });
    assert.deepEqual(fit(320, 1.3, { endTurn: true }), { disks: 0, round: true, stackEnd: false }, "without the timer everything fits");
    assert.deepEqual(fit(390, 1, { timer: "over", endTurn: true }), { disks: 0, round: true, stackEnd: false });
  });

  test("a long fight's round takes more room, so the disks give way sooner", () => {
    assert.ok(fit(320, 1.3, { round: 12 }).disks <= fit(320, 1.3, { round: 1 }).disks);
    assert.deepEqual(fit(320, 1.3, { round: 12, timer: "over" }), { disks: 0, round: true, stackEnd: false });
  });
});
