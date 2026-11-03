import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { drawnAt, footprint, rulesSpot, snapPosition } from "./scene.ts";

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
