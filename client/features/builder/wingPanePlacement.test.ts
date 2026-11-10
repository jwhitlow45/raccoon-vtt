import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ViewBox } from "../../lib/view.ts";
import { insetsBeside, WING_SHEET_SHARE, wingFit, wingPanePlacement } from "./wingPanePlacement.ts";

/*
 * The wing pane's place (docs/design: dungeon generator phase 3, 3.3,
 * D-261110-236): docked at the map edge farther from the area's middle
 * from 600 px wide, a sheet of at most 60% below, and the camera's fit
 * into the rest of the map.
 */

const BARS = { top: 56, right: 0, bottom: 64, left: 0 };
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height }) as ViewBox;

describe("the wing pane's place", () => {
  test("from 600 px wide a 296 px card at the edge farther from the area's middle, the map's height between the bars", () => {
    const viewport = { width: 1440, height: 900 };
    const right = wingPanePlacement({ viewport, insets: BARS, areaX: 400, lane: null });
    assert.deepEqual(right, { kind: "card", side: "right", left: 1440 - 8 - 296, top: 64, width: 296, maxHeight: 900 - 64 - 8 - 64, height: 900 - 64 - 8 - 64 });
    const left = wingPanePlacement({ viewport, insets: BARS, areaX: 1100, lane: null });
    assert.equal(left.kind === "card" && left.side, "left");
    assert.equal(left.kind === "card" && left.left, 8);
    // At 600 exactly it is still a card, its side by the area.
    assert.equal(wingPanePlacement({ viewport: { width: 600, height: 800 }, insets: BARS, areaX: 100, lane: null }).kind, "card");
  });

  test("an area in the very middle docks the pane on the left, and a side panel's inset counts", () => {
    const viewport = { width: 1000, height: 800 };
    assert.equal((wingPanePlacement({ viewport, insets: BARS, areaX: 500, lane: null }) as { side: string }).side, "left");
    const panel = { ...BARS, right: 360 };
    const placed = wingPanePlacement({ viewport, insets: panel, areaX: 100, lane: null });
    assert.equal(placed.kind === "card" && placed.left + placed.width, 1000 - 360 - 8, "docked against the panel, not under it");
  });

  test("docked on the right it stops at the fight's alerts", () => {
    const placed = wingPanePlacement({ viewport: { width: 1440, height: 900 }, insets: BARS, areaX: 200, lane: { left: 1100, top: 64 } });
    assert.equal(placed.kind === "card" && placed.left + placed.width, 1100 - 8);
  });

  test("below 600 px a bottom sheet on the bottom bars, at most 60% of the map's height between the bars, the rest left for the ghost", () => {
    const room = 844 - 56 - 64;
    const placed = wingPanePlacement({ viewport: { width: 390, height: 844 }, insets: BARS, areaX: 200, lane: null });
    assert.deepEqual(placed, { kind: "sheet", bottom: 64, maxHeight: Math.round(room * WING_SHEET_SHARE), height: Math.round(room * WING_SHEET_SHARE) });
    // At 320 by 568 under tall bars, still 60% of what they leave, never the pane's least height past it.
    const small = wingPanePlacement({ viewport: { width: 320, height: 568 }, insets: { ...BARS, bottom: 170 }, areaX: 200, lane: null });
    assert.equal(small.kind === "sheet" && small.height, Math.max(120, Math.round((568 - 56 - 170) * WING_SHEET_SHARE)));
    // Where the bars leave less than the least height, the pane keeps it, as the other map panes do.
    const short = wingPanePlacement({ viewport: { width: 568, height: 320 }, insets: { ...BARS, bottom: 150 }, areaX: 200, lane: null });
    assert.equal(short.kind === "sheet" && short.height, 120);
  });
});

describe("the camera's fit beside the pane", () => {
  test("the area and join land in the middle of the map the card leaves", () => {
    const viewport = { width: 1440, height: 900 };
    const place = wingPanePlacement({ viewport, insets: BARS, areaX: 300, lane: null });
    const clear = insetsBeside(place, viewport, BARS);
    assert.equal(clear.right, 296 + 16);
    const fit = wingFit({ viewport, insets: BARS, place, box: box(10, 10, 30, 20) });
    const middleX = (0 + (1440 - clear.right)) / 2 / 1440;
    assert.ok(Math.abs(fit.anchor.x - middleX) < 1e-9, `${fit.anchor.x} against ${middleX}`);
    assert.ok(Math.abs(fit.anchor.y - (56 + (900 - 56 - 64) / 2) / 900) < 1e-9);
    // The whole box fits the room left, less the padding.
    assert.ok(fit.scale * 30 <= 1440 - clear.right - 48 + 1e-9);
  });

  test("on a phone the box lands above the sheet", () => {
    const viewport = { width: 390, height: 844 };
    const place = wingPanePlacement({ viewport, insets: BARS, areaX: 200, lane: null });
    const fit = wingFit({ viewport, insets: BARS, place, box: box(0, 0, 40, 40) });
    const sheetTop = 844 - 64 - Math.round((844 - 56 - 64) * WING_SHEET_SHARE);
    assert.ok(fit.anchor.y * 844 < sheetTop, "its middle above the sheet's top");
    assert.ok(fit.anchor.y * 844 > 56, "and below the top bar");
  });
});
