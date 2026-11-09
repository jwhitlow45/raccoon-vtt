import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bandFit, turnPlacement, turnPlaces, type BandTimer } from "./band.ts";

/** The layout size of a window at an interface size (features/device/layout.ts layoutSize). */
function layout(width: number, height: number, scale = 1): { width: number; height: number } {
  return { width: width / scale, height: height / scale };
}

describe("turnPlacement", () => {
  test("from 900 px wide the strip sits in the top bar, whatever overflowed", () => {
    assert.equal(turnPlacement({ ...layout(1280, 800), band: false }), "bar");
    assert.equal(turnPlacement({ ...layout(900, 1200), band: true }), "bar");
  });

  test("a phone in portrait takes the band", () => {
    assert.equal(turnPlacement({ ...layout(390, 844), band: false }), "band");
    assert.equal(turnPlacement({ ...layout(375, 667), band: false }), "band");
  });

  test("a short phone in landscape keeps the strip in the bar", () => {
    assert.equal(turnPlacement({ ...layout(844, 390), band: false }), "bar");
    assert.equal(turnPlacement({ ...layout(667, 375), band: false }), "bar");
  });

  test("landscape at 500 px tall or more takes the band, as a tablet held sideways under 900 px would", () => {
    assert.equal(turnPlacement({ ...layout(880, 500), band: false }), "band");
    assert.equal(turnPlacement({ ...layout(880, 620), band: false }), "band");
  });

  test("the interface size reads the chrome's own pixels", () => {
    // 1,000 x 700 at 130% lays out as 769 x 538: a phone, landscape, but too tall for the bar.
    assert.equal(turnPlacement({ ...layout(1000, 700, 1.3), band: false }), "band");
    // 844 x 390 at 130% is 649 x 300: still short landscape.
    assert.equal(turnPlacement({ ...layout(844, 390, 1.3), band: false }), "bar");
    // 1,280 x 800 at 150% is 853 x 533: under 900 wide and 500 tall or more.
    assert.equal(turnPlacement({ ...layout(1280, 800, 1.5), band: false }), "band");
  });

  test("on a short landscape phone the top bar's band step moves the strip, and only there", () => {
    assert.equal(turnPlaces(layout(844, 390)), "either");
    assert.equal(turnPlacement({ ...layout(667, 375), band: true }), "band");
    assert.equal(turnPlacement({ ...layout(667, 375), band: false }), "bar");
    assert.equal(turnPlaces(layout(1280, 800)), "bar");
    assert.equal(turnPlacement({ ...layout(1280, 800), band: true }), "bar", "from 900 px up the band step is never taken, and would not move it");
    assert.equal(turnPlaces(layout(390, 844)), "band");
    assert.equal(turnPlacement({ ...layout(390, 844), band: false }), "band");
  });
});

/** The three fields most cases name: nameMin has its own cases. */
function stripName(fit: ReturnType<typeof bandFit>) {
  const { nameMin: _nameMin, ...rest } = fit;
  return rest;
}

describe("bandFit (LPD-DMPHONE-2)", () => {
  // The DM's band has four creatures to come. A player's has none, and End turn on their own turn.
  const fit = (width: number, scale: number, more: { timer?: BandTimer; endTurn?: boolean; round?: number } = {}) =>
    stripName(bandFit({ width: width / scale, round: more.round ?? 1, timer: more.timer ?? "none", endTurn: more.endTurn ?? false, next: more.endTurn ? 0 : 4 }));

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
    assert.deepEqual(fit(390, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: true }, "Your turn under the name keeps its 60 px (LP32-POLISH e)");
    assert.deepEqual(fit(360, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: true });
    assert.deepEqual(fit(320, 1.3, { timer: "over", endTurn: true }), { disks: 0, round: false, stackEnd: true });
    assert.deepEqual(fit(320, 1.3, { endTurn: true }), { disks: 0, round: false, stackEnd: false }, "without the timer the round gives way, so Your turn reads whole beside End turn (LP32-POLISH e)");
    assert.deepEqual(fit(360, 1.3, { endTurn: true }), { disks: 0, round: true, stackEnd: false });
    assert.deepEqual(fit(390, 1, { timer: "over", endTurn: true }), { disks: 0, round: true, stackEnd: false });
  });

  test("Your turn keeps its 60 px where End turn stacked still fits beside it, and gives way to a few letters where it does not (320 x 568 at 130% with the time up)", () => {
    const at = (width: number, scale: number, timer: BandTimer) => bandFit({ width: width / scale, round: 1, timer, endTurn: true, next: 0 }).nameMin;
    assert.equal(at(320, 1.3, "none"), 60);
    assert.equal(at(390, 1.3, "over"), 60);
    assert.equal(at(320, 1.3, "over"), 36, "a name column of 60 px would push End turn off the screen");
    assert.equal(bandFit({ width: 320, round: 1, timer: "none", endTurn: false, next: 0 }).nameMin, 36, "never on another's turn");
  });

  test("a running clock takes the room its text needs, not the room of 10:00 (P3R-4)", () => {
    assert.deepEqual(fit(320, 1.3, { timer: { clock: "10:00" } }), { disks: 0, round: true, stackEnd: false });
    assert.deepEqual(fit(320, 1.3, { timer: { clock: "0:30" } }), { disks: 1, round: true, stackEnd: false }, "a short clock leaves a disk room");
    assert.ok(fit(320, 1.3, { timer: { clock: "1:05" } }).disks >= fit(320, 1.3, { timer: "over" }).disks, "a clock never takes more than the time-up");
  });

  test("a long fight's round takes more room, so the disks give way sooner", () => {
    assert.ok(fit(320, 1.3, { round: 12 }).disks <= fit(320, 1.3, { round: 1 }).disks);
    assert.deepEqual(fit(320, 1.3, { round: 12, timer: "over" }), { disks: 0, round: true, stackEnd: false });
  });

  test("the DM's Next counts as End turn does: the disks give way for it, the round after them, never the name", () => {
    const dm = (width: number, scale: number, timer: BandTimer = "none") => stripName(bandFit({ width: width / scale, round: 1, timer, endTurn: false, dmNext: true, next: 4 }));
    assert.deepEqual(dm(390, 1), { disks: 4, round: true, stackEnd: false }, "a phone at 100% keeps all four faces");
    assert.deepEqual(dm(320, 1), { disks: 2, round: true, stackEnd: false });
    assert.deepEqual(dm(390, 1, "over"), { disks: 2, round: true, stackEnd: false });
    assert.deepEqual(dm(320, 1.3), { disks: 0, round: true, stackEnd: false });
    assert.deepEqual(dm(320, 1.3, "over"), { disks: 0, round: false, stackEnd: false }, "the round gives way next, and Next never stacks");
    for (const width of [240, 280, 320, 360, 390, 430]) {
      assert.ok(dm(width, 1).disks <= fit(width, 1).disks, `Next takes room at ${width}`);
    }
  });
});
