import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardSizes, chipFit, PIN_CELL_PX, screenPx, setBoardInterfaceScale, TEXT_FLOOR_PX } from "./boardScale.ts";

describe("board sizes for a zoom", () => {
  test("at the pin every mark is its old fixed size", () => {
    const s = boardSizes(PIN_CELL_PX);
    assert.equal(s.namePx, 12);
    assert.equal(s.hpPx, 11);
    assert.equal(s.chipPx, 18);
    assert.equal(s.ringPx, 3);
    assert.equal(s.barPx, 5);
  });

  test("they grow with the map, names to 16 px and HP to 15 px", () => {
    const s = boardSizes(56);
    assert.equal(s.namePx, 16);
    assert.equal(boardSizes(90).namePx, 16);
    assert.equal(boardSizes(90).hpPx, 15);
  });

  test("no text draws under the floor, each line clamped on its own, counters and badges included", () => {
    for (const cell of [4, 11.4, 16, 22, 29, 33.7]) {
      const s = boardSizes(cell);
      for (const px of [s.namePx, s.hpPx, s.pillPx, s.chipTextPx, s.counterPx, s.badgeTextPx, s.numberPx]) assert.ok(px >= TEXT_FLOOR_PX, `${px} px at ${cell} px a cell`);
      assert.ok(s.focusNamePx >= 14);
    }
  });

  test("icon chips and strokes have their own floors, so they stay visible", () => {
    const far = boardSizes(11.4);
    assert.equal(far.chipPx, 12);
    assert.equal(far.ringPx, 1.5);
    assert.equal(far.barPx, 3);
  });

  test("text sizes are whole half pixels, so a cached measure matches what is drawn", () => {
    for (const cell of [17.3, 41.9, 47.21]) {
      const s = boardSizes(cell);
      for (const px of [s.namePx, s.hpPx, s.chipTextPx]) assert.equal(px * 2, Math.round(px * 2));
    }
  });

  test("a chip holding text grows to fit it", () => {
    const s = boardSizes(11.4);
    assert.equal(chipFit(s, 4), Math.ceil(s.chipTextPx + 6));
    assert.ok(chipFit(s, 20) >= 26);
  });

  test("the interface size scales names, chips, badges and bars, never the token's ring", () => {
    for (const cell of [11.4, PIN_CELL_PX, 90]) {
      const base = boardSizes(cell, 1);
      const big = boardSizes(cell, 1.3);
      const small = boardSizes(cell, 0.85);
      for (const k of ["namePx", "hpPx", "chipPx", "chipTextPx", "badgeTextPx", "pillPx", "barPx"] as const) {
        assert.equal(big[k], Math.round(base[k] * 1.3 * 2) / 2, `${k} at 130%`);
        assert.equal(small[k], Math.round(base[k] * 0.85 * 2) / 2, `${k} at 85%`);
      }
      assert.equal(big.ringPx, base.ringPx);
      assert.equal(big.f, base.f);
    }
    assert.deepEqual(boardSizes(PIN_CELL_PX), boardSizes(PIN_CELL_PX, 1), "100% is the board as it was");
  });
});

describe("readouts at an interface size", () => {
  test("a screen size scales with the interface size, to half pixels, and is its design size at 100%", () => {
    for (const px of [4, 6, 12, 15]) assert.equal(screenPx(px, 1), px);
    assert.equal(screenPx(15, 1.3), 19.5);
    assert.equal(screenPx(12, 1.3), 15.5);
    assert.equal(screenPx(12, 0.85), 10);
    assert.equal(screenPx(15, 0.85), 13);
    for (const ui of [0.85, 1, 1.15, 1.3]) for (const px of [4, 6, 12, 15]) assert.equal(screenPx(px, ui) * 2, Math.round(screenPx(px, ui) * 2), `${px} px at ${ui}`);
  });

  test("it follows the device's interface size when none is given", () => {
    setBoardInterfaceScale(1.3);
    try {
      assert.equal(screenPx(15), 19.5);
    } finally {
      setBoardInterfaceScale(1);
    }
    assert.equal(screenPx(15), 15);
  });
});
