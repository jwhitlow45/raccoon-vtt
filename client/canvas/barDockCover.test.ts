import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barCapacity } from "./barButtons.ts";
import { DEFAULT_CHROME, DEFAULT_SPOT, EDGE, columnFacts, laneChoice, paneLaneBox, placeBar, restingBar, toastTop, type Chrome, type ColumnFacts } from "./barDock.ts";

/*
 * A turn card in the alerts column (docs/design-v1-combat-controls.md 4.2
 * and 4.6): the bar's lane and a map pane skip it, since it lasts the
 * whole turn, while a toast keeps 8 px under it as under any first card
 * (review CCB-OPUS-2), so a toast on a phone never lies over its Show.
 * It is drawn last (review CCB-OPUS-11), so with other cards the first
 * one drawn is the first one measured.
 */

const TOP = 122;
const TURN = 44;
/** The cards a turn card is drawn under, with heights as a phone draws them. */
const LEADS = [
  ["a notice", 60],
  ["the time-up line", 48],
] as const;

describe("a turn card in the column: toasts keep under it, the bar and panes skip it (CCB-OPUS-2)", () => {
  test("a turn card alone publishes facts with no first card and its height as the cover; nothing at all publishes none", () => {
    assert.deepEqual(columnFacts(null, { top: TOP, measured: { content: TURN, first: 0, cover: TURN } }), { top: TOP, content: TURN, first: 0, cover: TURN });
    assert.equal(columnFacts(null, { top: TOP, measured: { content: 0, first: 0, cover: 0 } }), null);
    assert.equal(columnFacts(null, { top: TOP, measured: { content: 0, first: 0 } }), null);
    const unfolded = columnFacts(null, { top: TOP, measured: { content: 180, first: 0, cover: 180 } });
    assert.equal(unfolded?.cover, 180, "unfolded, its whole height");
    const same = columnFacts(unfolded, { top: TOP, measured: { content: 180, first: 0, cover: 180 } });
    assert.equal(same, unfolded, "the same object back when nothing changed");
    assert.notEqual(columnFacts(unfolded, { top: TOP, measured: { content: 180, first: 0, cover: TURN } }), unfolded, "a fold changes the cover");
  });

  test("a toast starts 8 px under a lone turn card, folded or not, and under the card drawn above a turn card", () => {
    const phone = { spanning: true, cards: true, optionsTop: 700 };
    const folded = columnFacts(null, { top: TOP, measured: { content: TURN, first: 0, cover: TURN } });
    assert.equal(toastTop({ ...phone, column: folded }), TOP + TURN + EDGE);
    const open = columnFacts(null, { top: TOP, measured: { content: 180, first: 0, cover: 180 } });
    assert.equal(toastTop({ ...phone, column: open }), TOP + 180 + EDGE);
    // A notice or the time-up line, then the turn card: the toast keeps under the card above it, as the bar does.
    for (const [what, height] of LEADS) {
      const led = columnFacts(null, { top: TOP, measured: { content: height + 8 + TURN, first: height, cover: height } });
      assert.equal(toastTop({ ...phone, column: led }), TOP + height + EDGE, what);
    }
    // Facts with no cover, as the summary row's, keep the first card's.
    assert.equal(toastTop({ ...phone, column: { top: TOP, content: 44, first: 44 } }), TOP + 44 + EDGE);
  });

  test("the bar docked under the column keeps a notice or the time-up line above a turn card whole (CCB-OPUS-11)", () => {
    // A phone held sideways: the lane from under the top bar to the screen's foot, with room for the bar under the first card.
    for (const [what, height] of LEADS) {
      const column = columnFacts(null, { top: TOP, measured: { content: height + 8 + TURN, first: height, cover: height } });
      const { lane, floor } = laneChoice({ laneTop: 60, laneHeight: 322, column, besideRoom: 0 });
      assert.equal(lane, "stacked", what);
      assert.equal(floor, TOP + height + EDGE, `${what}: the bar's floor is 8 px under its foot at ${TOP + height}`);
    }
  });

  test("the bar, its resting place, its capacity and a pane read a lone turn card as no card", () => {
    const lone: ColumnFacts = { top: 60, content: 180, first: 0, cover: 180 };
    assert.deepEqual(laneChoice({ laneTop: 60, laneHeight: 700, column: lone, besideRoom: 0 }), laneChoice({ laneTop: 60, laneHeight: 700, column: null, besideRoom: 0 }));
    const chrome: Chrome = { ...DEFAULT_CHROME, top: 52, bottom: 60 };
    for (const [layout, viewport] of [
      [{ width: 1280, height: 800 }, { width: 920, height: 800 }],
      [{ width: 390, height: 844 }, { width: 390, height: 844 }],
      [{ width: 844, height: 390 }, { width: 844, height: 390 }],
    ] as const) {
      const at = { layout, viewport, chrome, foot: 0, spot: DEFAULT_SPOT, height: 300, width: 316 };
      assert.deepEqual(placeBar({ ...at, anchor: null, column: lone }), placeBar({ ...at, anchor: null, column: null }), `docked at ${layout.width}`);
      assert.deepEqual(placeBar({ ...at, anchor: { x: 195, y: 400 }, tokenHeight: 40, column: lone }), placeBar({ ...at, anchor: { x: 195, y: 400 }, tokenHeight: 40, column: null }), `by its token at ${layout.width}`);
      assert.deepEqual(restingBar({ ...at, column: lone }), restingBar({ ...at, column: null }));
      const { height: _, ...room } = at;
      assert.equal(barCapacity({ ...room, anchor: null, column: lone }), barCapacity({ ...room, anchor: null, column: null }));
    }
    assert.equal(paneLaneBox({ viewport: { width: 1440, height: 900 }, chrome, column: lone, folded: false }), null);
    assert.notEqual(paneLaneBox({ viewport: { width: 1440, height: 900 }, chrome, column: { ...lone, first: 60 }, folded: false }), null, "a card besides the turn card keeps the pane out of the lane");
  });
});
