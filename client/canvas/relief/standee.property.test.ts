import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { COVER_INSET } from "../../features/attach/groups.ts";
import { MAX_SCALE } from "../../lib/camera.ts";
import type { Turn } from "../../lib/view.ts";
import type { VBox } from "./pieces.ts";
import { ON_GROUND, standeeParts, standeeShape, type Seat, type StandeeModel } from "./standee.ts";

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

test("a standee's decor frame is its footprint's size, never reaches below its foot, and starts at or above its drawn top, for every model, footprint, turn and seat", () => {
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
        // The ring's middle is the base, and the foot the seat's rise up it.
        const foot = (shape.ring.y0 + shape.ring.y1) / 2 - s.rise;
        assert.ok(shape.frame.y1 <= foot + 1e-9, "the frame's bottom, where the bar and badges sit, never under the foot");
        assert.ok(shape.frame.y0 <= shape.drawnBox.y0 + 1e-9, "the frame's top, where the name and chips sit, at or over the drawn top");
        assert.ok(Math.abs(shape.frame.y1 - shape.frame.y0 - box.h) < 1e-9 && Math.abs(shape.frame.x1 - shape.frame.x0 - box.w) < 1e-9, "the footprint's size");
        assert.ok(Math.abs((shape.frame.x0 + shape.frame.x1) / 2 - (shape.ring.x0 + shape.ring.x1) / 2) < 1e-9, "centered on the ring, however off-center the model draws");
        // A dragged token carries its decor in its own group (standeeParts), which must land on the still layout's frame (review SOL-MC-06).
        const parts = standeeParts(turn, shape.drawnBase, ground, box, s, m);
        assert.ok(Math.abs(shape.base.x + parts.decor.x - shape.frame.x0) < 1e-6 && Math.abs(shape.base.y + parts.decor.y - shape.frame.y0) < 1e-6, "the dragged decor on the still frame");
      },
    ),
    { numRuns: 2000 },
  );
});

test("a low, wide model on a Gargantuan footprint keeps its decor on its foot at every turn (review LP59-ISO-1's slab)", () => {
  const slab: StandeeModel = { side: 1, anchorY: 0.6, box: [0, 52, 100, 60] };
  for (const turn of [0, 1, 2, 3] as Turn[]) {
    const s = standeeShape(turn, { x: 10, y: 10, w: 4, h: 4 }, 0, 0, 40, 800, ON_GROUND, slab);
    assert.deepEqual(s.frame, standeeShape(turn, { x: 10, y: 10, w: 4, h: 4 }, 0, 0, 40, 800).frame, `turn ${turn}`);
  }
});

test("a flat model on a Gargantuan footprint keeps its ring top inside its bounds at every zoom (review MODELC-O-1's case)", () => {
  const flat: StandeeModel = { side: 1.05, anchorY: 0.55, box: [2, 48, 98, 58] };
  for (const scale of [30, 40, 60, 100, 220, MAX_SCALE]) {
    const s = standeeShape(0, { x: 10, y: 10, w: 4, h: 4 }, 0, 0, scale, 800, { rise: 0, inset: 1 }, flat);
    assert.ok(inside(s.paints, s.bounds) && s.ring.y0 >= s.bounds.y0, `scale ${scale}`);
  }
});
