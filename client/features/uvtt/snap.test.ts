import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cutLong, WallGraph } from "./snap.ts";

const L = 64;

describe("cutting a long free wall", () => {
  test("a wall of 8 squares or less stays whole", () => {
    assert.deepEqual(cutLong(0, 0, 8 * L, 0), [[0, 0, 512, 0]]);
  });

  test("when rounding the joints makes a part too long, it is cut once more", () => {
    // Without the 1/32 margin, two parts are tried first: rounding puts their joint at (512, 23), 8.008 squares from the start.
    const parts = cutLong(0, 0, 1023, 45, 0);
    assert.equal(parts.length, 3);
    for (const [ax, ay, bx, by] of parts) assert.ok((bx - ax) ** 2 + (by - ay) ** 2 <= 512 * 512);
    assert.deepEqual(parts[0]!.slice(0, 2), [0, 0]);
    assert.deepEqual(parts[2]!.slice(2), [1023, 45]);
    assert.deepEqual(cutLong(0, 0, 1023, 45), parts);
  });

  test("a 200-square wall becomes 26 parts, each joined to the next", () => {
    const parts = cutLong(0, 0, 200 * L, 0);
    assert.equal(parts.length, Math.ceil(200 / (8 - 1 / 32)));
    for (let i = 1; i < parts.length; i++) assert.deepEqual(parts[i]!.slice(0, 2), parts[i - 1]!.slice(2));
  });
});

describe("the wall graph", () => {
  test("an end welded onto a grid wall's middle lands exactly on its line, and the grid wall stays whole", () => {
    const g = new WallGraph();
    g.add(0, 3 * L, 6 * L, 3 * L, "wall", false);
    g.add(130, 3 * L + 5, 150, 400, "wall", false);
    g.pinGrid(6.4);
    g.weld(6.4);
    assert.equal(g.welded, 1);
    const result = g.result();
    assert.equal(result.length, 2);
    const free = result.find((s) => !g.gridAt(s))!;
    assert.deepEqual([free.ax, free.ay], [130, 3 * L]);
    assert.ok(result.some((s) => g.gridAt(s) && s.ax === 0 && s.bx === 6 * L));
  });

  test("a pinned grid end pulls a loose end onto itself rather than leaving the grid", () => {
    const g = new WallGraph();
    g.add(2 * L, 2 * L, 5 * L, 2 * L, "wall", false);
    g.add(5 * L + 4, 2 * L + 3, 7 * L + 30, 4 * L + 20, "wall", false);
    g.pinGrid(6.4);
    g.weld(6.4);
    const result = g.result();
    assert.ok(result.some((s) => (s.ax === 5 * L && s.ay === 2 * L) || (s.bx === 5 * L && s.by === 2 * L)));
    assert.ok(result.filter((s) => !g.gridAt(s)).every((s) => (s.ax === 5 * L && s.ay === 2 * L) || (s.bx === 5 * L && s.by === 2 * L)));
  });

  test("a door wins over a wall on the same two points", () => {
    const g = new WallGraph();
    g.add(10, 10, 100, 40, "wall", false);
    g.add(100, 40, 10, 10, "door", true);
    assert.deepEqual(g.result().map((s) => s.kind), ["door"]);
  });
});
