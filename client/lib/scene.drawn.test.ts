import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { actionsName, atDragSpot, dragAim, drawnAt, footprint, rulesOutline, rulesSpot, snapPosition } from "./scene.ts";

const HEX: Grid = { shape: "hex", orient: "rows" };

describe("drawn and rules spots (snap-off 6.1)", () => {
  test("a nudge moves the drawn spot by eighths of a square on squares", () => {
    assert.deepEqual(drawnAt(SQUARES, { x: 3, y: 3, nudge: { x: 3, y: -3 } }), { x: 3.375, y: 2.625 });
    assert.deepEqual(drawnAt(SQUARES, { x: 3, y: 3 }), { x: 3, y: 3 });
  });

  test("a hex scene draws the stored spot, and no grid trusts the nudge", () => {
    assert.deepEqual(drawnAt(HEX, { x: 2, y: 4, nudge: { x: 1, y: 1 } }), { x: 2, y: 4 });
    assert.deepEqual(drawnAt(null, { x: 2, y: 4, nudge: { x: 1, y: 1 } }), { x: 2.125, y: 4.125 });
  });

  test("rulesSpot takes a drawn point back by the nudge", () => {
    assert.deepEqual(rulesSpot({ nudge: { x: -2, y: 1 } }, { x: 4.75, y: 1.125 }), { x: 5, y: 1 });
    assert.deepEqual(rulesSpot({}, { x: 4.75, y: 1.125 }), { x: 4.75, y: 1.125 });
  });

  test("every valid nudge draws a token that snaps back to its own spot, and rulesSpot undoes drawnAt", () => {
    const sizes = fc.oneof(
      fc.constantFrom("tiny", "small", "medium", "large", "huge", "gargantuan").map((size) => ({ size }) as const),
      fc.record({ size: fc.constant("custom" as const), w: fc.integer({ min: 2, max: 80 }).map((v) => v / 4), h: fc.integer({ min: 2, max: 80 }).map((v) => v / 4) }),
    );
    fc.assert(
      fc.property(sizes, fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 40 }), fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }), (s, cx, cy, nx, ny) => {
        const fp = footprint(s);
        // A half-square snap step (Tiny) keeps the nudge within one eighth, as the model bounds it.
        const half = Math.min(fp.w, fp.h) < 1;
        const nudge = half ? { x: Math.sign(nx), y: Math.sign(ny) } : { x: nx, y: ny };
        fc.pre(nudge.x !== 0 || nudge.y !== 0);
        const step = half ? 0.5 : 1;
        const token = { ...s, x: cx * step, y: cy * step, nudge };
        const drawn = drawnAt(SQUARES, token);
        const snapped = snapPosition(SQUARES, drawn.x, drawn.y, fp);
        // Rounding a point just left of 0 gives -0, the same spot.
        assert.deepEqual({ x: snapped.x + 0, y: snapped.y + 0 }, { x: token.x, y: token.y });
        assert.deepEqual(rulesSpot(token, drawn), { x: token.x, y: token.y });
      }),
    );
  });
});

describe("the rules outline (snap-off section 4)", () => {
  test("a nudged token's rules box on the board, and none unnudged or on hexes", () => {
    assert.deepEqual(rulesOutline(SQUARES, { size: "medium", x: 3, y: 3, nudge: { x: 3, y: -3 } }), { x: 3, y: 3, w: 1, h: 1 });
    assert.deepEqual(rulesOutline(SQUARES, { size: "large", x: 2, y: 6, nudge: { x: -1, y: 2 } }), { x: 2, y: 6, w: 2, h: 2 });
    assert.equal(rulesOutline(SQUARES, { size: "medium", x: 3, y: 3 }), null);
    assert.equal(rulesOutline(HEX, { size: "medium", x: 3, y: 3, nudge: { x: 1, y: 0 } }), null);
  });
});

describe("the rules outline mid-drag (SNAPBUILD-ASTRA-03)", () => {
  /*
   * Stored at x=3 nudged 3/8 right, the node dragged to fractional points:
   * the outline stands on the box the drop aims at, ordinary or free, never
   * at the node less the nudge.
   */
  const placed = { size: "medium" as const, x: 3, y: 3, nudge: { x: 3, y: 0 } };
  const live = (at: { x: number; y: number }, free: boolean) => {
    const aim = dragAim(placed, at, free);
    return rulesOutline(SQUARES, placed, snapPosition(SQUARES, aim.x, aim.y, footprint(placed)));
  };
  for (const [at, ordinary, free] of [
    [{ x: 3.625, y: 3 }, 3, 4],
    [{ x: 3.86, y: 3.2 }, 3, 4],
    [{ x: 4.3, y: 2.6 }, 4, 4],
    [{ x: 5.13, y: 3.45 }, 5, 5],
    [{ x: 5.4, y: 3.3 }, 5, 5],
    [{ x: 2.6, y: 3.49 }, 2, 3],
  ] as const) {
    test(`the node at (${at.x}, ${at.y}): box ${ordinary} for an ordinary drag, ${free} for a free one`, () => {
      const rowOf = (y: number) => Math.round(y);
      assert.deepEqual(live(at, false), { x: ordinary, y: rowOf(at.y), w: 1, h: 1 });
      assert.deepEqual(live(at, true), { x: free, y: rowOf(at.y), w: 1, h: 1 });
      for (const box of [live(at, false)!, live(at, true)!]) assert.ok(Number.isInteger(box.x) && Number.isInteger(box.y), "on the grid, not under the pointer");
    });
  }
});

describe("the rules outline at a lone drag's landing (SNAPBUILD-ASTRA-04)", () => {
  test("a landing that squeezes outlines the squeezed box, and one that names no squeeze the token's own", () => {
    const ogre = { size: "large" as const, x: 10, y: 6, nudge: { x: 2, y: 0 } };
    assert.deepEqual(rulesOutline(SQUARES, ogre, { x: 10.5, y: 3.5, squeeze: true }), { x: 11, y: 4, w: 1, h: 1 });
    assert.deepEqual(rulesOutline(SQUARES, ogre, { x: 11, y: 3, squeeze: false }), { x: 11, y: 3, w: 2, h: 2 });
    assert.deepEqual(rulesOutline(SQUARES, ogre, { x: 11, y: 3 }), { x: 11, y: 3, w: 2, h: 2 });
  });
});

describe("a token at a drag's spot (SNAPBUILD-ASTRA-04)", () => {
  test("squeezed as the spot says, else as the token is", () => {
    const squeezed = { x: 4.5, y: 4.5, squeeze: true as const, size: "large" as const };
    assert.deepEqual(atDragSpot(squeezed, { x: 6, y: 4, squeeze: false }), { x: 6, y: 4, size: "large" });
    assert.deepEqual(atDragSpot(squeezed, { x: 6.5, y: 4.5 }), { x: 6.5, y: 4.5, squeeze: true, size: "large" });
    assert.deepEqual(atDragSpot({ x: 1, y: 1, size: "large" as const }, { x: 6.5, y: 4.5, squeeze: true }), { x: 6.5, y: 4.5, squeeze: true, size: "large" });
  });
});

describe("a token's accessible name (snap-off section 4)", () => {
  test("a token drawn between squares says so at the end, and one on its square does not", () => {
    assert.equal(actionsName({ name: "Bree" }), "Bree actions");
    assert.equal(actionsName({ name: "Goblin", number: 2 }), "Goblin 2 actions");
    assert.equal(actionsName({ name: "Bree", nudge: { x: 3, y: 0 } }), "Bree actions, placed between squares");
    assert.equal(actionsName({ name: "Goblin", number: 2, nudge: { x: -1, y: 1 } }), "Goblin 2 actions, placed between squares");
  });
});
