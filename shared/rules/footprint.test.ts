import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boxDistanceFt, tokenCellBox } from "./distance.ts";
import {
  canSqueeze,
  footprintRect,
  footprintSize,
  isSqueezed,
  occupiedCells,
  occupiedRange,
  rangeAt,
  squeezedRect,
  squeezedSize,
  storedCenter,
  tokenHeightFt,
  verticalExtentFt,
  wholeRangeInto,
  type CellRange,
  type FootprintToken,
} from "./footprint.ts";
import { SQUARES } from "./grid.ts";

function tok(over: Partial<FootprintToken> = {}): FootprintToken {
  return { size: "medium", x: 0, y: 0, elevation: 0, ...over };
}

describe("footprint", () => {
  test("sizes follow the 2024 table", () => {
    assert.deepEqual(footprintSize(tok({ size: "tiny" })), { w: 0.5, h: 0.5 });
    assert.deepEqual(footprintSize(tok({ size: "small" })), { w: 1, h: 1 });
    assert.deepEqual(footprintSize(tok({ size: "large" })), { w: 2, h: 2 });
    assert.deepEqual(footprintSize(tok({ size: "huge" })), { w: 3, h: 3 });
    assert.deepEqual(footprintSize(tok({ size: "gargantuan" })), { w: 4, h: 4 });
    assert.deepEqual(footprintSize(tok({ size: "custom", w: 2.5, h: 40 })), { w: 2.5, h: 20 });
    assert.deepEqual(footprintSize(tok({ size: "custom" })), { w: 1, h: 1 });
  });

  test("small and larger snap to whole cells, tiny to half cells", () => {
    assert.deepEqual(footprintRect(SQUARES, tok({ x: 2.4, y: 3.6 })), { x: 2, y: 4, w: 1, h: 1 });
    assert.deepEqual(footprintRect(SQUARES, tok({ size: "tiny", x: 2.3, y: 3.8 })), { x: 2.5, y: 4, w: 0.5, h: 0.5 });
    assert.deepEqual(footprintRect(SQUARES, tok({ size: "large", x: 0.6, y: -0.2 })), { x: 1, y: 0, w: 2, h: 2 });
  });

  test("occupied cells are the whole cells the snapped footprint overlaps", () => {
    assert.deepEqual(occupiedCells(SQUARES, tok({ x: 3, y: 4 })), [{ x: 3, y: 4 }]);
    assert.deepEqual(occupiedRange(SQUARES, tok({ size: "large", x: 1, y: 1 })), { x0: 1, y0: 1, x1: 3, y1: 3 });
    assert.equal(occupiedCells(SQUARES, tok({ size: "huge", x: 0, y: 0 })).length, 9);
    assert.deepEqual(occupiedRange(SQUARES, tok({ size: "custom", w: 1.5, h: 1, x: 2, y: 2 })), { x0: 2, y0: 2, x1: 4, y1: 3 });
  });

  test("a tiny creature occupies the one cell that contains it", () => {
    for (const [x, y] of [
      [4, 4],
      [4.5, 4],
      [4, 4.5],
      [4.5, 4.5],
      [4.6, 4.4],
    ] as const) {
      assert.deepEqual(occupiedCells(SQUARES, tok({ size: "tiny", x, y })), [{ x: 4, y: 4 }], `tiny at ${x},${y}`);
    }
  });

  test("height defaults to the footprint side in feet", () => {
    assert.equal(tokenHeightFt(tok(), 5), 5);
    assert.equal(tokenHeightFt(tok({ size: "large" }), 5), 10);
    assert.equal(tokenHeightFt(tok({ size: "tiny" }), 5), 2.5);
    assert.equal(tokenHeightFt(tok({ size: "custom", w: 2, h: 4 }), 5), 10);
    assert.equal(tokenHeightFt(tok({ height: 12 }), 5), 12);
    assert.deepEqual(verticalExtentFt(tok({ elevation: 30, size: "large" }), 5), { lo: 30, hi: 40 });
    assert.deepEqual(verticalExtentFt(tok({ elevation: -10 }), 10), { lo: -10, hi: 0 });
  });
});

describe("squeezed footprints (docs/design/design-v1-maps-vision.md 4.1)", () => {
  test("a squeeze takes one cell off every side of at least 2 cells and keeps the rest", () => {
    assert.deepEqual(squeezedSize(tok({ size: "large" })), { w: 1, h: 1 });
    assert.deepEqual(squeezedSize(tok({ size: "huge" })), { w: 2, h: 2 });
    assert.deepEqual(squeezedSize(tok({ size: "gargantuan" })), { w: 3, h: 3 });
    assert.deepEqual(squeezedSize(tok({ size: "custom", w: 1, h: 3 })), { w: 1, h: 2 });
    assert.deepEqual(squeezedSize(tok({ size: "medium" })), { w: 1, h: 1 });
    assert.ok(canSqueeze(tok({ size: "large" })) && canSqueeze(tok({ size: "custom", w: 1, h: 3 })));
    assert.ok(!canSqueeze(tok({ size: "medium" })) && !canSqueeze(tok({ size: "custom", w: 1.99, h: 1.99 })));
  });

  test("the squeezed footprint is centered on the stored center, never snapped", () => {
    // A Large creature half a cell off the grid in a corridor from x = 5 to 6.
    const large = tok({ size: "large", x: 4.5, y: 3, squeeze: true });
    assert.deepEqual(storedCenter(large), { x: 5.5, y: 4 });
    assert.deepEqual(squeezedRect(large), { x: 5, y: 3.5, w: 1, h: 1 });
    assert.ok(isSqueezed(large));
    assert.deepEqual(footprintRect(SQUARES, large), { x: 5, y: 3.5, w: 1, h: 1 });
    // Unsqueezed, the same position snaps as before.
    assert.deepEqual(footprintRect(SQUARES, { ...large, squeeze: undefined }), { x: 5, y: 3, w: 2, h: 2 });
    // A flag on a token with no side to squeeze changes nothing.
    assert.deepEqual(footprintRect(SQUARES, tok({ x: 2.4, y: 3, squeeze: true })), { x: 2, y: 3, w: 1, h: 1 });
  });

  test("a squeezed Large creature in a corridor stands in the corridor's cells only", () => {
    const large = tok({ size: "large", x: 4.5, y: 3.5, squeeze: true });
    assert.deepEqual(occupiedRange(SQUARES, large), { x0: 5, y0: 4, x1: 6, y1: 5 });
    assert.deepEqual(occupiedCells(SQUARES, large), [{ x: 5, y: 4 }]);
    const tall = tok({ size: "custom", w: 1, h: 3, x: 2, y: 0.5, squeeze: true });
    assert.deepEqual(occupiedCells(SQUARES, tall), [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  test("distances and the ruler measure a squeezed creature from its squeezed cells", () => {
    const settings = { feetPerCell: 5, diagonal: "five" as const };
    const large = tok({ size: "large", x: 4.5, y: 3.5, squeeze: true });
    const east = tok({ x: 8, y: 4 });
    assert.equal(boxDistanceFt(tokenCellBox(SQUARES, large, 5), tokenCellBox(SQUARES, east, 5), settings), 15);
    assert.equal(boxDistanceFt(tokenCellBox(SQUARES, { ...large, squeeze: undefined }, 5), tokenCellBox(SQUARES, east, 5), settings), 10);
  });

  test("a squeeze leaves the height as it was", () => {
    assert.equal(tokenHeightFt(tok({ size: "large", squeeze: true }), 5), 10);
  });
});


describe("the squares wholly inside a footprint, as a squeezing walk reads them between its ends (wholeRangeInto)", () => {
  const whole = (w: number, h: number, x: number, y: number): CellRange => wholeRangeInto({ x0: 9, y0: 9, x1: 9, y1: 9 }, w, h, x, y);
  const SIDES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4] as const;

  test("a space on whole squares reads as it does unsnapped, every size and custom side whole", () => {
    for (const side of [1, 2, 3, 4]) for (const x of [0, 3, 7]) assert.deepEqual(whole(side, side, x, x + 1), rangeAt(side, side, x, x + 1), `side ${side} at ${x}`);
  });

  test("half a square off the grid, a Large creature reads one column or row, a Huge one two and a Gargantuan one three, never the rounded-up square", () => {
    assert.deepEqual(whole(2, 2, 13.5, -0.5), { x0: 14, y0: 0, x1: 15, y1: 1 }, "the edge squeeze reads square 14, 0 alone");
    assert.deepEqual(rangeAt(2, 2, 13.5, -0.5), { x0: 14, y0: 0, x1: 16, y1: 2 }, "where snapping reads 15, 0 past it too");
    assert.deepEqual(whole(2, 2, 4.5, 3), { x0: 5, y0: 3, x1: 6, y1: 5 });
    assert.deepEqual(whole(3, 3, 4.5, 4.5), { x0: 5, y0: 5, x1: 7, y1: 7 });
    assert.deepEqual(whole(4, 4, 0.5, 2), { x0: 1, y0: 2, x1: 4, y1: 6 });
  });

  test("a custom side with a part square reads only the squares it wholly covers", () => {
    // 2.5 by 2.5 at 3, 3 covers 3 to 5.5: snapping reads 3, 4 and 5, the whole squares 3 and 4.
    assert.deepEqual(whole(2.5, 2.5, 3, 3), { x0: 3, y0: 3, x1: 5, y1: 5 });
    assert.deepEqual(rangeAt(2.5, 2.5, 3, 3), { x0: 3, y0: 3, x1: 6, y1: 6 });
    assert.deepEqual(whole(2.5, 3.5, 3.5, 0.5), { x0: 4, y0: 1, x1: 6, y1: 4 });
  });

  test("an axis with no whole square keeps the snapped span there, and the other axis still reads whole", () => {
    // A Medium creature half off on both axes reads as it does today.
    assert.deepEqual(whole(1, 1, 4.5, 4.5), rangeAt(1, 1, 4.5, 4.5));
    assert.deepEqual(whole(0.5, 0.5, 4.5, 4), rangeAt(0.5, 0.5, 4.5, 4));
    // A custom 1 by 3 creature half off on both: its width holds no whole square, its height two.
    assert.deepEqual(whole(1, 3, 2.5, 0.5), { x0: rangeAt(1, 3, 2.5, 0.5).x0, y0: 1, x1: rangeAt(1, 3, 2.5, 0.5).x1, y1: 3 });
    // And the other way about: 3 by 1, its height the one with none.
    assert.deepEqual(whole(3, 1, 0.5, 2.5), { x0: 1, y0: rangeAt(3, 1, 0.5, 2.5).y0, x1: 3, y1: rangeAt(3, 1, 0.5, 2.5).y1 });
  });

  test("on each axis it reads every square wholly inside the unsnapped space and no other, or the snapped span where none is, at every half-square spot", () => {
    const wholeSpan = (lo: number, side: number): [number, number] => [Math.ceil(lo) + 0, Math.floor(lo + side)];
    for (const w of SIDES) {
      for (const h of SIDES) {
        for (let x = -1; x <= 2; x += 0.5) {
          for (let y = -1; y <= 2; y += 0.5) {
            const r = whole(w, h, x, y);
            const snapped = rangeAt(w, h, x, y);
            const [ax0, ax1] = wholeSpan(x, w);
            const [ay0, ay1] = wholeSpan(y, h);
            const at = `${w} by ${h} at ${x}, ${y}`;
            assert.deepEqual([r.x0, r.x1], ax1 > ax0 ? [ax0, ax1] : [snapped.x0, snapped.x1], `${at}: x`);
            assert.deepEqual([r.y0, r.y1], ay1 > ay0 ? [ay0, ay1] : [snapped.y0, snapped.y1], `${at}: y`);
          }
        }
      }
    }
  });

  test("a side that float addition leaves a hair short of a square still reads it", () => {
    // 4.35 - 2.35 is 1.9999999999999996, a hair short of 2.
    assert.deepEqual(whole(4.35 - 2.35, 4.35 - 2.35, 3, 3), { x0: 3, y0: 3, x1: 5, y1: 5 });
    for (const [x, y] of [[3 + 1e-12, 3 - 1e-12], [3 - 1e-12, 3 + 1e-12]] as const) assert.deepEqual(whole(2, 2, x, y), { x0: 3, y0: 3, x1: 5, y1: 5 }, `at ${x}, ${y}`);
  });
});
