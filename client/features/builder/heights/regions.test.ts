import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { heightHint } from "./hint.ts";
import { heightRegions, regionText } from "./regions.ts";

function chunk(heights: Record<string, number>, cx = 0, cy = 0): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number);
    feet[(y! - cy * CHUNK_CELLS) * CHUNK_CELLS + (x! - cx * CHUNK_CELLS)] = v;
  }
  return { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
}

/** Every cell of a rectangle, keyed "x,y", at one height. */
function block(x0: number, y0: number, x1: number, y1: number, v: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out[`${x},${y}`] = v;
  return out;
}

describe("height regions", () => {
  test("touching cells at one height are one region, the largest first", () => {
    const regions = heightRegions([chunk({ ...block(1, 1, 3, 2, 10), ...block(6, 6, 6, 6, -5) })], { w: 16, h: 16 });
    assert.deepEqual(
      regions.map((r) => [r.ground, r.size]),
      [
        [10, 6],
        [-5, 1],
      ],
    );
    assert.deepEqual(regions[1]!.spots, [{ x: 6.5, y: 6.5 }]);
  });

  test("cells meeting only at a corner, or at different heights, are separate regions", () => {
    const regions = heightRegions([chunk({ "1,1": 5, "2,2": 5, "3,2": 10 })], { w: 16, h: 16 });
    assert.equal(regions.length, 3);
  });

  test("a region runs across chunk borders", () => {
    const regions = heightRegions([chunk({ "15,3": 10 }), chunk({ "16,3": 10 }, 1, 0)], { w: 32, h: 16 });
    assert.deepEqual(regions.map((r) => r.size), [2]);
  });

  test("the number's first spot is the cell deepest in the region, and later spots stand apart", () => {
    const [r] = heightRegions([chunk(block(0, 0, 6, 6, 10))], { w: 16, h: 16 });
    assert.deepEqual(r!.spots[0], { x: 3.5, y: 3.5 });
    for (let i = 1; i < r!.spots.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = r!.spots[i]!;
        const b = r!.spots[j]!;
        assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= 2);
      }
    }
  });

  test("a ring's number sits on the ring, not in its hole", () => {
    const ring = { ...block(0, 0, 4, 0, 10), ...block(0, 4, 4, 4, 10), ...block(0, 1, 0, 3, 10), ...block(4, 1, 4, 3, 10) };
    const [r] = heightRegions([chunk(ring)], { w: 16, h: 16 });
    for (const s of r!.spots) assert.ok(ring[`${s.x - 0.5},${s.y - 0.5}`] === 10);
  });

  test("heights outside the scene are not regions", () => {
    assert.deepEqual(heightRegions([chunk({ "12,1": 10 })], { w: 10, h: 10 }), []);
  });

  test("numbers read up or down, as the elevation badge does", () => {
    assert.equal(regionText(10), "↑10 ft");
    assert.equal(regionText(-15), "↓15 ft");
  });
});

describe("the Height mode hint", () => {
  const base = { paint: "stairs", shape: 1, stairs: "a", height: 10 } as const;
  test("stairs say how the scene's automatic walls treat them", () => {
    assert.match(heightHint(base, undefined), /walls toward unpainted squares/);
    assert.match(heightHint(base, "all"), /walls toward unpainted squares/);
    assert.match(heightHint(base, "floor"), /get no walls/);
    assert.doesNotMatch(heightHint(base, "off"), /wall/);
  });

  test("a height of 0 clears, and an area says to drag corner to corner", () => {
    assert.equal(heightHint({ ...base, paint: "height", height: 0, shape: "area" }, "all"), "Drag from corner to corner to clear heights back to the ground.");
  });

  test("Auto points the way up, and the arrows settle the rest", () => {
    assert.match(heightHint(base, "off"), /\?/);
    assert.doesNotMatch(heightHint({ ...base, stairs: "n" }, "off"), /\?/);
  });
});
