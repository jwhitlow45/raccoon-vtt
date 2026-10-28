import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { doorsOf } from "./outlines.ts";
import type { Point, UvttPortal } from "./schema.ts";

const p = (x: number, y: number): Point => ({ x, y });

/** A portal as Arkenforge writes one: its size in `position`. */
function arkenforge(a: Point, b: Point, closed = true): UvttPortal {
  return { a, b, closed, position: p(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) };
}

/** A portal as Dungeondraft and Dungeon Alchemist write one: its midpoint in `position`. */
function midpoint(a: Point, b: Point, closed = true): UvttPortal {
  return { a, b, closed, position: p((a.x + b.x) / 2, (a.y + b.y) / 2) };
}

/** One door drawn as Arkenforge draws it, shaped like the tavern's: the leaf on the wall at x = 10, then three sides off it, the leaf third in the file. */
function outline(x = 10, y = 5, make = arkenforge): UvttPortal[] {
  return [
    make(p(x, y), p(x - 0.18, y)),
    make(p(x - 0.18, y), p(x - 0.3, y + 0.65)),
    make(p(x, y + 1), p(x, y)),
    make(p(x - 0.3, y + 0.65), p(x - 0.18, y + 1)),
  ];
}

describe("doors drawn as outlines", () => {
  test("an Arkenforge outline of four portals becomes its leaf, the longest, wherever it sits in the file", () => {
    const portals = outline();
    assert.deepEqual(doorsOf(portals), [portals[2]]);
    const two = [...outline(10, 5), ...outline(22, 6)];
    assert.deepEqual(doorsOf(two), [two[2], two[6]]);
  });

  test("ends a hair apart still join, as an exporter's rounding leaves them", () => {
    const portals = outline();
    portals[1] = arkenforge(p(9.82 + 0.004, 5.003), p(9.7, 5.65));
    assert.deepEqual(doorsOf(portals), [portals[2]]);
  });

  test("real doors joined around a corner, positioned at their midpoints, all stay", () => {
    // Dungeondraft's four doors around a room's top-left corner, as a real export joins them.
    const corner = [midpoint(p(1, 1), p(2, 1)), midpoint(p(2, 1), p(3, 1)), midpoint(p(1, 3), p(1, 2)), midpoint(p(1, 2), p(1, 1))];
    assert.deepEqual(doorsOf(corner), corner);
    assert.deepEqual(doorsOf(outline(10, 5, midpoint)).length, 4);
  });

  test("two outlines whose ends touch, a double door, keep both leaves, each on the other's line (FU34-ASTRA-04)", () => {
    const two = [...outline(10, 5), ...outline(10, 6)];
    assert.deepEqual(doorsOf(two), [two[2], two[6]]);
    assert.deepEqual(doorsOf(outline(10, 6)), [outline(10, 6)[2]]);
  });

  test("a straight double door stays two doors, even in Arkenforge's form", () => {
    const portals = [arkenforge(p(4, 8), p(5, 8)), arkenforge(p(5, 8), p(6, 8.002)), ...outline()];
    assert.deepEqual(doorsOf(portals), [portals[0], portals[1], portals[4]]);
  });

  test("a file that leaves out `position`, or puts one portal's at its midpoint, keeps every portal", () => {
    const none = outline().map((d) => ({ ...d, position: null }));
    assert.equal(doorsOf(none).length, 4);
    const mixed = [...outline(), midpoint(p(14, 3), p(15, 3))];
    assert.equal(doorsOf(mixed).length, 5);
  });

  test("a door on its own is kept, closed or not", () => {
    const lone = [arkenforge(p(3, 3), p(4, 3), false), ...outline()];
    assert.deepEqual(doorsOf(lone), [lone[0], lone[3]]);
    assert.deepEqual(doorsOf([]), []);
  });
});
