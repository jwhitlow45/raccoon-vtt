import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PathStop } from "../model.ts";
import { stopFootprint } from "./footprint.ts";
import { COLUMNS, ROWS } from "./hexWalls.testkit.ts";
import { SQUARES } from "./grid.ts";
import { hexStandPlace } from "./movement.ts";
import { hexRouteFeet, routeFeet } from "./route.ts";
import { MAX_PATH_STOPS } from "../protocol.ts";
import { legGeometry, oneSize, publicCounters, reshapeLeg, stopsForNonOwners, stopsForOwners, withStop } from "./path.ts";

/**
 * A path's stops each keep the size the creature had there
 * (docs/design-v1-token-window.md 8.7): projection hands every viewer each
 * stop's size, and compaction never joins a leg across a resize while it
 * has another corner to drop.
 */
const MEDIUM = { w: 1, h: 1 };
const at = (x: number, footprint?: PathStop["footprint"], more: Partial<PathStop> = {}): PathStop => ({ x, y: 0, elevation: 0, seen: true, ...(footprint ? { footprint } : {}), ...more });

describe("each stop's size in what viewers get", () => {
  const stops = [at(0, MEDIUM), at(3, MEDIUM, { seen: undefined }), at(4, undefined, { uncounted: true }), at(6)];

  test("owners get every stop with its size", () => {
    assert.deepEqual(stopsForOwners(stops), [
      { x: 0, y: 0, elevation: 0, footprint: MEDIUM },
      { x: 3, y: 0, elevation: 0, footprint: MEDIUM },
      { x: 4, y: 0, elevation: 0, uncounted: true },
      { x: 6, y: 0, elevation: 0 },
    ]);
  });

  test("others get the stops they saw, each with its own size, the unseen one dropped", () => {
    assert.deepEqual(stopsForNonOwners(stops), [{ x: 0, y: 0, elevation: 0, footprint: MEDIUM }, { x: 4, y: 0, elevation: 0 }, { x: 6, y: 0, elevation: 0 }]);
  });

  test("one size: neither stop holds a footprint, or both hold the same", () => {
    assert.equal(oneSize(at(0), at(1)), true);
    assert.equal(oneSize(at(0, MEDIUM), at(1, { w: 1, h: 1 })), true);
    assert.equal(oneSize(at(0, MEDIUM), at(1)), false);
    assert.equal(oneSize(at(0, MEDIUM), at(1, { w: 2, h: 2 })), false);
    // A stop without one was made at the size now, and a squeeze keeps the size.
    assert.equal(oneSize(at(0, MEDIUM), at(1), { w: 1, h: 1 }), true);
    assert.equal(oneSize(at(0, MEDIUM), at(1), { w: 2, h: 2 }), false);
    assert.equal(oneSize(at(0, { w: 2, h: 2, squeeze: true }), at(1), { w: 2, h: 2 }), true);
  });

  test("a leg that changed the footprint rather than moved it: a resize anywhere, or a squeeze taken or left in place", () => {
    const LARGE = { w: 2, h: 2 };
    const SQUEEZED = { w: 2, h: 2, squeeze: true as const };
    assert.equal(reshapeLeg(at(0, MEDIUM), at(1), LARGE), true, "a resize that moved it");
    assert.equal(reshapeLeg(at(0, MEDIUM), at(0), LARGE), true, "a resize in place");
    assert.equal(reshapeLeg(at(0, SQUEEZED), at(0), LARGE), true, "a squeeze left in place");
    assert.equal(reshapeLeg(at(0, LARGE), at(0), SQUEEZED), true, "a squeeze taken in place");
    assert.equal(reshapeLeg(at(0, LARGE), at(3), SQUEEZED), false, "a move into a squeeze is a move");
    assert.equal(reshapeLeg(at(0, SQUEEZED), at(3), LARGE), false, "and one out of it");
    // A path stored before version 6 holds no footprints, and every leg of it is a move.
    assert.equal(reshapeLeg(at(0), at(3), SQUEEZED), false);
  });

  test("a squeezed stop's footprint reaches owners and others with its squeeze", () => {
    const squeezed = [at(0, { w: 2, h: 2, squeeze: true }), at(3)];
    assert.deepEqual(stopsForOwners(squeezed)[0]!.footprint, { w: 2, h: 2, squeeze: true });
    assert.deepEqual(stopsForNonOwners(squeezed)[0]!.footprint, { w: 2, h: 2, squeeze: true });
  });
});

describe("a full path keeps its legs at one size (withStop)", () => {
  const full = (head: PathStop[]): PathStop[] => [...head, ...Array.from({ length: MAX_PATH_STOPS - head.length }, (_, i) => at(100 + i))];

  test("the oldest corner whose legs lie at one size goes, the joined stop keeping its size", () => {
    const stops = full([at(0, MEDIUM), at(1, MEDIUM), at(2, MEDIUM)]);
    const next = withStop({ turn: 1, stops }, at(999)).stops;
    assert.equal(next.length, MAX_PATH_STOPS);
    assert.deepEqual(next.slice(0, 2), [at(0, MEDIUM), at(2, MEDIUM)], "the corner at x 1 went, and the joined stop is still Medium");
  });

  test("never a resize's stop nor the stop before it", () => {
    // A move at Medium, then a resize to Large (no footprint: the size now), then moves at Large.
    const stops = full([at(0, MEDIUM), at(1, MEDIUM), at(1, undefined, { uncounted: true }), at(5)]);
    const next = withStop({ turn: 1, stops }, at(999)).stops;
    assert.deepEqual(next.slice(0, 4), [at(0, MEDIUM), at(1, MEDIUM), at(1, undefined, { uncounted: true }), at(100)], "the corner at x 5 went");
    const resizedFirst = full([at(0, MEDIUM), at(0, undefined, { uncounted: true }), at(5)]);
    assert.deepEqual(withStop({ turn: 1, stops: resizedFirst }, at(999)).stops.slice(0, 3), [at(0, MEDIUM), at(0, undefined, { uncounted: true }), at(100)]);
  });

  test("with no corner at one size left, the oldest goes, and the joined leg counts if either leg did", () => {
    const large = { w: 2, h: 2 };
    const stops: PathStop[] = [at(0, MEDIUM)];
    for (let i = 0; i < 25; i++) {
      const before = i % 2 === 0 ? MEDIUM : large;
      const after = i % 2 === 0 ? large : MEDIUM;
      stops.push(at(1 + 2 * i, before), at(2 + 2 * i, i === 24 ? undefined : after, { uncounted: true }));
    }
    assert.equal(stops.length, 51);
    const kept = withStop({ turn: 1, stops: stops.slice(0, 50) }, stops[50]!).stops;
    assert.equal(kept.length, MAX_PATH_STOPS);
    assert.deepEqual(kept.slice(0, 3), [at(0, MEDIUM), at(2, large), at(3, large)], "the move at x 1 and the resize at x 2 joined, counted, at the resize's size");
  });
});


describe("a visible route's corners keep their own stand (LP26-RIDE-1)", () => {
  const rules = { feetPerCell: 5, diagonal: "fiveTen" as const };
  const zero = { h: 0, v: 0 };

  for (const g of [ROWS, COLUMNS]) for (const [size, small] of [["large", "medium"], ["huge", "large"]] as const) {
    test(`${g.orient}, ${size}: into and out of a squeeze, the displayed feet equal the stored route's feet`, () => {
      const point = (col: number, row: number, squeeze: boolean) => ({
        size,
        ...hexStandPlace(g, { size, x: 0, y: 0 }, { size: squeeze ? small : size, ref: g.orient === "rows" ? { col, row } : { col: row, row: col }, squeezed: squeeze }),
        elevation: 0,
        ...(squeeze ? { squeeze: true as const } : {}),
      });
      const inward = [point(8, 7, false), point(11, 9, false), point(16, 9, true)];
      const through = [...inward, point(18, 10, true), point(20, 11, false)];
      const bent = [point(2, 2, false), point(4, 4, false), point(3, 4, true)];
      const back = [point(2, 2, false), point(4, 4, false), point(3, 3, true)];
      for (const points of [inward, inward.toReversed(), through, through.toReversed(), bent, bent.toReversed(), back, back.toReversed()]) {
        const start = points[0]!;
        const token = points.at(-1)!;
        const from: PathStop = { ...start, footprint: stopFootprint(start), seen: true };
        const to: PathStop = { x: token.x, y: token.y, elevation: token.elevation, via: points.slice(1, -1).flatMap((p) => [p.x, p.y]), routeSeen: true, seen: true };
        const stored = hexRouteFeet(g, start, points, token.squeeze === true, points.slice(1).map(() => ({ extra: 1, swim: 0 as const })), rules, zero, { swimSpeed: false });
        const displayed = legGeometry(g, token, from, to, rules, zero);
        assert.equal(displayed.moved, stored.moved);
        assert.equal(displayed.cost, stored.moved, "the public geometry reveals no extra cost");
        if (points === inward) assert.equal(displayed.moved, 45, "the reported mount walk");
        assert.deepEqual(publicCounters(g, token, [from, to], rules, true), { h: stored.diag[0], v: stored.diag[1] });
      }
    });
  }

  test("squares: a Large creature's half-cell corners count where the route walked them", () => {
    const inward = [{ x: 3, y: 9, elevation: 0 }, { x: 6, y: 9.5, elevation: 0 }, { x: 7.5, y: 9.5, elevation: 0 }, { x: 11.5, y: 9.5, elevation: 0 }];
    for (const points of [inward, inward.toReversed()]) {
      const entering = points === inward;
      const token = { size: "large" as const, ...points.at(-1)!, ...(entering ? { squeeze: true as const } : {}) };
      const from: PathStop = { ...points[0]!, footprint: { w: 2, h: 2, ...(!entering ? { squeeze: true as const } : {}) }, seen: true };
      const to: PathStop = { ...points.at(-1)!, via: points.slice(1, -1).flatMap((p) => [p.x, p.y]), seen: true, routeSeen: true };
      const stored = routeFeet(points, points.slice(1).map(() => ({ extra: 1, swim: 0 as const })), rules, zero, { swimSpeed: false, step: 1 });
      assert.deepEqual(legGeometry(SQUARES, token, from, to, rules, zero), { ...stored, cost: stored.moved });
      assert.deepEqual(publicCounters(SQUARES, token, [from, to], rules, true), { h: stored.diag[0], v: stored.diag[1] });
    }
  });
});
