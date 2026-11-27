import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { COVER_INSET } from "../../features/attach/groups.ts";
import { MAX_SCALE } from "../../lib/camera.ts";
import type { Turn } from "../../lib/view.ts";
import type { VBox } from "./pieces.ts";
import { standeeShape, type Seat, type StandeeModel } from "./standee.ts";

/*
 * A standee's bounds are what culls it and what a scroll repaints it by
 * (IsoBoard.tsx paintedBoxOf), so everything it paints lies inside them:
 * its drawn art, a model's drawn box however flat or low, its ring with its
 * outlines and facing tick, its shadow, and the frame its decor lays out
 * on, at every turn, seat, footprint and zoom up to MAX_SCALE
 * (docs/design/design-v1-token-models.md 6, review MODELC-O-1).
 */

const inside = (a: VBox, b: VBox) => a.x0 >= b.x0 - 1e-9 && a.y0 >= b.y0 - 1e-9 && a.x1 <= b.x1 + 1e-9 && a.y1 <= b.y1 + 1e-9;

const model: fc.Arbitrary<StandeeModel> = fc
  .record({ side: fc.double({ min: 0.25, max: 4, noNaN: true }), anchorY: fc.double({ min: 0, max: 1, noNaN: true }), x: fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 })), y: fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 })) })
  .filter(({ x, y }) => x[0] !== x[1] && y[0] !== y[1])
  .map(({ side, anchorY, x, y }) => ({ side, anchorY, box: [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)] as [number, number, number, number] }));

const seat: fc.Arbitrary<Seat> = fc.oneof(
  fc.constant({ rise: 0, inset: 1 }),
  fc.record({ rise: fc.double({ min: 0, max: 4, noNaN: true }), inset: fc.constantFrom(1, COVER_INSET) }),
);

test("everything a standee paints lies inside its bounds, a model's included, at every turn, seat, footprint and zoom", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<Turn>(0, 1, 2, 3),
      fc.record({ x: fc.double({ min: -50, max: 50, noNaN: true }), y: fc.double({ min: -50, max: 50, noNaN: true }), w: fc.double({ min: 0.5, max: 20, noNaN: true }), h: fc.double({ min: 0.5, max: 20, noNaN: true }) }),
      fc.double({ min: -20, max: 40, noNaN: true }),
      fc.double({ min: 0, max: 30, noNaN: true }),
      fc.double({ min: 1, max: MAX_SCALE, noNaN: true }),
      seat,
      fc.option(model, { nil: null }),
      (turn, box, ground, height, scale, s, m) => {
        const shape = standeeShape(turn, box, ground + height, ground, scale, 800, s, m);
        assert.ok(inside(shape.paints, shape.bounds), "paints");
        assert.ok(inside(shape.drawnBox, shape.bounds), "drawn box");
        assert.ok(inside(shape.ring, shape.bounds), "ring");
        assert.ok(inside(shape.frame, shape.bounds), "decor frame");
        if (shape.shadow) assert.ok(inside(shape.shadow, shape.bounds), "shadow");
      },
    ),
    { numRuns: 2000 },
  );
});

test("a flat model on a Gargantuan footprint keeps its ring top inside its bounds at every zoom (review MODELC-O-1's case)", () => {
  const flat: StandeeModel = { side: 1.05, anchorY: 0.55, box: [2, 48, 98, 58] };
  for (const scale of [30, 40, 60, 100, 220, MAX_SCALE]) {
    const s = standeeShape(0, { x: 10, y: 10, w: 4, h: 4 }, 0, 0, scale, 800, { rise: 0, inset: 1 }, flat);
    assert.ok(inside(s.paints, s.bounds) && s.ring.y0 >= s.bounds.y0, `scale ${scale}`);
  }
});
