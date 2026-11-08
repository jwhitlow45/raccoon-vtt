import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "../propertyTestutil.ts";
import { APART, contact, crossingsAt, indexPolygon, insideCrossings, LATTICE, MAX_COORD, onSegment, orient, pointInPolygon, TOUCH } from "./segments.ts";

/**
 * Property tests of the exact wall predicates (segments.ts). Sight, movement
 * and areas all ask them, on the server and on every device, and a seen
 * mark is a stored fact replay rebuilds, so an answer must not hang on
 * which end of a wall came first or which way a polygon was asked about.
 * segments.test.ts pins the cases by hand, and its seeded random scenes
 * check the split. These check the predicates the split stands on.
 */

type P = { x: number; y: number };

/**
 * Points on one scale per case: a tiny grid, where ends meet and lines run
 * collinear all the time, the stored walls' 1/64 lattice, or any double.
 * Shewchuk's predicates are exact only while no product underflows, so the
 * doubles keep away from the subnormal range: 0, or at least 1e-100 from it.
 */
function pointsOn(n: number): fc.Arbitrary<P[]> {
  const scale = (c: fc.Arbitrary<number>) => fc.array(fc.record({ x: c, y: c }).map((p) => ({ x: p.x, y: p.y })), { minLength: n, maxLength: n });
  return fc.oneof(
    scale(fc.integer({ min: 0, max: 4 })),
    scale(fc.integer({ min: 0, max: MAX_COORD * LATTICE }).map((v) => v / LATTICE)),
    scale(fc.double({ min: -2_000, max: 2_000, noNaN: true }).map((v) => (Math.abs(v) < 1e-100 ? 0 : v))),
  );
}

describe("the exact wall predicates (property)", () => {
  test("the orientation flips with its first two points and keeps with a turn of all three", () => {
    holds(
      fc.property(pointsOn(3), ([a, b, c]) => {
        const o = orient(a!.x, a!.y, b!.x, b!.y, c!.x, c!.y);
        assert.equal(orient(b!.x, b!.y, a!.x, a!.y, c!.x, c!.y), -o || 0, "swapping a and b flips the side");
        assert.equal(orient(b!.x, b!.y, c!.x, c!.y, a!.x, a!.y), o, "a turn of the three keeps it");
      }),
      20_000,
    );
  });

  test("the orientation is consistent at the edge of the domain the walls use, 1e-100 and the lattice's finest step", () => {
    const edge = [0, 1e-100, -1e-100, 1 / LATTICE, -1 / LATTICE, 0.0227, -0.0227, 1, 2_000, -2_000];
    for (const ax of edge) for (const ay of edge) for (const bx of edge) for (const by of edge) for (const cx of edge) for (const cy of edge) {
      const o = orient(ax, ay, bx, by, cx, cy);
      if (orient(bx, by, ax, ay, cx, cy) !== (-o || 0) || orient(bx, by, cx, cy, ax, ay) !== o) assert.fail(`inconsistent at ${[ax, ay, bx, by, cx, cy].join(", ")}`);
    }
  });

  // The doc comment of orient promises the exact sign only while no product of differences underflows into the subnormal range (ORIENT-UNDERFLOW).
  // Play never gets here, since an eye is stepped off a wall long before it is 1e-100 from the line. This pins the limit so a fix or an upgrade is noticed.
  test("known limit: a coordinate in the subnormal range can break the turn rule, so the properties keep clear of it", () => {
    const o = orient(0, 0, 0, 0.0227, 7.4e-323, -0.0227);
    assert.notEqual(orient(0, 0.0227, 7.4e-323, -0.0227, 0, 0), o);
  });

  test("how two walls meet does not hang on which is first or which way either runs", () => {
    holds(
      fc.property(pointsOn(4), ([a, b, c, d]) => {
        const k = contact(a!.x, a!.y, b!.x, b!.y, c!.x, c!.y, d!.x, d!.y);
        assert.equal(contact(c!.x, c!.y, d!.x, d!.y, a!.x, a!.y, b!.x, b!.y), k, "the other wall first");
        assert.equal(contact(b!.x, b!.y, a!.x, a!.y, c!.x, c!.y, d!.x, d!.y), k, "the first wall reversed");
        assert.equal(contact(a!.x, a!.y, b!.x, b!.y, d!.x, d!.y, c!.x, c!.y), k, "the second wall reversed");
      }),
      20_000,
    );
  });

  test("a point is on a wall exactly when a wall of length zero there touches it", () => {
    holds(
      fc.property(pointsOn(3), ([p, a, b]) => {
        const on = onSegment(p!.x, p!.y, a!.x, a!.y, b!.x, b!.y);
        assert.equal(contact(p!.x, p!.y, p!.x, p!.y, a!.x, a!.y, b!.x, b!.y), on ? TOUCH : APART);
        assert.equal(onSegment(p!.x, p!.y, b!.x, b!.y, a!.x, a!.y), on, "either end first");
      }),
      20_000,
    );
  });

  test("a polygon's crossings index answers inside or outside as the plain test does, inside its rows or past them", () => {
    holds(
      fc.property(
        fc.integer({ min: 3, max: 10 }).chain((n) => pointsOn(n + 1)),
        fc.integer({ min: -3, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        ([probe, ...vertices], row0, rows) => {
          const poly = Float64Array.from(vertices.flatMap((v) => [v.x, v.y]));
          const index = indexPolygon(poly, row0, rows);
          const viaIndex = insideCrossings(crossingsAt(index, probe!.y), probe!.x);
          assert.equal(viaIndex, pointInPolygon(poly, probe!.x, probe!.y));
        },
      ),
      10_000,
    );
  });
});
