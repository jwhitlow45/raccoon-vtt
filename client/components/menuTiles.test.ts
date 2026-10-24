import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tileRows } from "./menuTiles.ts";

/*
 * The rows of Setup's and Tools' tiles (docs/design-v1-tool-options.md
 * 5.1 and 5.2), from the widths Chrome draws them at in Inter: the setup
 * tools, then a DM's play tools, each at least the 60 px tile.
 */

const SETUP = [73.9, 60, 60, 84.7, 83.9];
const PLAY = [60, 60, 60, 60, 60, 60];
const GAP = 4;
/** The room a phone's width leaves the tiles: its 8 px margins, the box's 1 px border and 12 px padding at each side. */
const room = (phone: number) => phone - 2 * (8 + 1 + 12);
const sizes = (rows: number[][]) => rows.map((r) => r.length);

describe("a menu's tile rows", () => {
  test("the five setup tools stand in one row from a 430 px phone up, with no cap", () => {
    for (const phone of [440, 430]) assert.deepEqual(tileRows(SETUP, GAP, room(phone)), { rows: [[0, 1, 2, 3, 4]], width: null }, `at ${phone} px`);
  });

  test("where they do not fit, three and two, never four and one alone, capped at the wider row", () => {
    for (const phone of [412, 402, 390, 375, 360, 320]) {
      const out = tileRows(SETUP, GAP, room(phone));
      assert.deepEqual(sizes(out.rows), [3, 2], `at ${phone} px`);
      assert.ok(Math.abs(out.width! - (73.9 + 60 + 60 + 2 * GAP)) < 1e-9, `at ${phone} px the cap is ${out.width}`);
    }
  });

  test("at 130% on a 320 px phone the setup tools still take two rows", () => {
    const zoomed = SETUP.map((w) => w * 1.3);
    assert.deepEqual(sizes(tileRows(zoomed, GAP * 1.3, 265.4).rows), [3, 2]);
  });

  test("a row past its room by a hair of floating point still fits, and by a twentieth of a pixel does not, so the browser never wraps its last tile alone", () => {
    // The five setup tools and their gaps take 378.5 px.
    assert.equal(tileRows(SETUP, GAP, 378.5).width, null, "its room exactly");
    assert.equal(tileRows(SETUP, GAP, 378.495).width, null, "a sum of measured widths a hair past");
    assert.deepEqual(sizes(tileRows(SETUP, GAP, 378.45).rows), [3, 2], "0.05 px past");
    assert.deepEqual(sizes(tileRows(SETUP, GAP, 378.2).rows), [3, 2], "0.3 px past");
  });

  test("six play tools that do not fit one row stand three and three, and in three rows two to a row", () => {
    assert.equal(tileRows(PLAY, GAP, 380).width, null);
    assert.deepEqual(sizes(tileRows(PLAY, GAP, 300).rows), [3, 3]);
    assert.deepEqual(sizes(tileRows(PLAY, GAP, 200).rows), [3, 3]);
    assert.deepEqual(sizes(tileRows(PLAY, GAP, 150).rows), [2, 2, 2]);
  });

  test("the fewest rows come first, even when the last of them holds one tile", () => {
    assert.deepEqual(sizes(tileRows([100, 100, 100, 100, 300], 0, 400).rows), [4, 1]);
  });

  test("one tile, none, or tiles wider than the room each stand in a row of their own", () => {
    assert.deepEqual(tileRows([120], GAP, 50), { rows: [[0]], width: null });
    assert.deepEqual(tileRows([], GAP, 50), { rows: [], width: null });
    assert.deepEqual(sizes(tileRows([200, 200], GAP, 100).rows), [1, 1]);
  });
});
