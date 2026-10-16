import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PathStop } from "../model.ts";
import { MAX_PATH_STOPS } from "../protocol.ts";
import { oneSize, stopsForNonOwners, stopsForOwners, withStop } from "./path.ts";

/**
 * A path's stops each keep the size the creature had there
 * (docs/design-v1-token-window.md 8.7): projection hands every viewer each
 * stop's size, and compaction never joins a leg across a resize while it
 * has another corner to drop.
 */
const MEDIUM = { w: 1, h: 1 };
const at = (x: number, footprint?: { w: number; h: number }, more: Partial<PathStop> = {}): PathStop => ({ x, y: 0, elevation: 0, seen: true, ...(footprint ? { footprint } : {}), ...more });

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
