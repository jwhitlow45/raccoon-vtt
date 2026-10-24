import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barCapacity } from "./barButtons.ts";
import { DEFAULT_CHROME, DEFAULT_SPOT, EDGE, columnFacts, laneChoice, paneLaneBox, placeBar, restingBar, toastTop, type Chrome, type ColumnFacts } from "./barDock.ts";

/*
 * A turn card in the alerts column (docs/design-v1-combat-controls.md 4.2
 * and 4.6): the bar's lane and a map pane skip it, since it lasts the
 * whole turn, while a toast keeps 8 px under it as under any first card
 * (review CCB-OPUS-2), so a toast on a phone never lies over its Show.
 */

const TOP = 122;
const TURN = 44;

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

  test("a toast starts 8 px under a lone turn card, folded or not, and under a turn card that leads a notice", () => {
    const phone = { spanning: true, cards: true, optionsTop: 700 };
    const folded = columnFacts(null, { top: TOP, measured: { content: TURN, first: 0, cover: TURN } });
    assert.equal(toastTop({ ...phone, column: folded }), TOP + TURN + EDGE);
    const open = columnFacts(null, { top: TOP, measured: { content: 180, first: 0, cover: 180 } });
    assert.equal(toastTop({ ...phone, column: open }), TOP + 180 + EDGE);
    // The turn card, then a notice: the bar measures the notice, the toast the turn card above it.
    const led: ColumnFacts = { top: TOP, content: TURN + 8 + 60, first: 60, cover: TURN };
    assert.equal(toastTop({ ...phone, column: led }), TOP + TURN + EDGE);
    // Facts with no cover, as the summary row's, keep the first card's.
    assert.equal(toastTop({ ...phone, column: { top: TOP, content: 44, first: 44 } }), TOP + 44 + EDGE);
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
