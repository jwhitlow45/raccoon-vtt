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
  squeezedRect,
  squeezedSize,
  storedCenter,
  tokenHeightFt,
  verticalExtentFt,
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

describe("squeezed footprints (docs/design-v1-maps-vision.md 4.1)", () => {
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

