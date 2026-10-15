import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clipLine, clipSegment, douglasPeucker, mergeClose, simplifyLine, snap } from "./simplify.ts";

const p = (x: number, y: number) => ({ x, y });

describe("simplifying a wall polyline", () => {
  test("points closer than a tenth of a square merge, and the line's ends stay put", () => {
    assert.deepEqual(mergeClose([p(0, 0), p(0.05, 0), p(1, 0), p(1.04, 0.02), p(1.08, 0)], 0.1), [p(0, 0), p(1.08, 0)]);
    assert.deepEqual(mergeClose([p(0, 0), p(2, 0), p(2.05, 0)], 0.1), [p(0, 0), p(2.05, 0)]);
    assert.deepEqual(mergeClose([p(0, 0), p(0.05, 0.05)], 0.1), []);
  });

  test("Douglas-Peucker drops points within the tolerance and keeps a real corner", () => {
    const wobble = [p(0, 0), p(1, 0.02), p(2, -0.03), p(3, 0), p(3, 3)];
    assert.deepEqual(douglasPeucker(wobble, 0.05), [p(0, 0), p(3, 0), p(3, 3)]);
    assert.deepEqual(douglasPeucker(wobble, 0.01), wobble);
  });

  test("a closed ring keeps its shape", () => {
    const ring = [p(0, 0), p(4, 0), p(4, 4), p(0, 4), p(0, 0)];
    assert.deepEqual(douglasPeucker(ring, 0.05), ring);
  });

  test("a long traced curve becomes a few points, every one on the 1/64 lattice", () => {
    const arc = Array.from({ length: 500 }, (_, i) => p(10 + 5 * Math.cos((i / 499) * Math.PI), 10 + 5 * Math.sin((i / 499) * Math.PI)));
    const out = simplifyLine(arc, 0.05, 0.1);
    assert.ok(out.length > 4 && out.length < 40, `${out.length} points`);
    for (const q of out) {
      assert.ok(Number.isInteger(q.x * 64) && Number.isInteger(q.y * 64));
    }
    assert.deepEqual(out[0], p(15, 10));
    assert.deepEqual(out[out.length - 1], p(5, snap(10 + 5 * Math.sin(Math.PI))));
  });

  test("snapping moves a coordinate at most 1/128", () => {
    for (const v of [0, 0.004, 0.0078125, 3.14159, 199.999]) {
      assert.ok(Math.abs(snap(v) - v) <= 1 / 128);
      assert.ok(Number.isInteger(snap(v) * 64));
    }
  });
});

describe("clipping to the scene", () => {
  test("a segment across the border is cut at it, and one outside is gone", () => {
    assert.deepEqual(clipSegment(p(-1, 1), p(1, 1), 10, 10), [p(0, 1), p(1, 1), true, false]);
    assert.deepEqual(clipSegment(p(5, 5), p(5, 12), 10, 10), [p(5, 5), p(5, 10), false, true]);
    assert.equal(clipSegment(p(-2, 1), p(-1, 3), 10, 10), null);
    assert.deepEqual(clipSegment(p(0, 0), p(10, 10), 10, 10), [p(0, 0), p(10, 10), false, false]);
  });

  test("a line that leaves and comes back becomes two lines", () => {
    const { parts, clipped } = clipLine([p(1, 1), p(1, -1), p(3, -1), p(3, 1), p(5, 1)], 10, 10);
    assert.equal(clipped, true);
    assert.deepEqual(parts, [
      [p(1, 1), p(1, 0)],
      [p(3, 0), p(3, 1), p(5, 1)],
    ]);
    assert.deepEqual(clipLine([p(1, 1), p(2, 2)], 10, 10), { parts: [[p(1, 1), p(2, 2)]], clipped: false });
  });
});
