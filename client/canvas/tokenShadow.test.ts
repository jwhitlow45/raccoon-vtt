import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type Token } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { SHADOW_CORE, shadowShape, tokenLift } from "./tokenShadow.ts";

/** A scene "s1" whose first chunk has these heights, keyed "x,y". */
function chunks(heights: Record<string, number>): Record<string, BuildChunk> {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number);
    feet[y! * CHUNK_CELLS + x!] = v;
  }
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } };
}

const token = (x: number, y: number, elevation: number, size: Token["size"] = "medium") => ({ sceneId: "s1", x, y, elevation, size });

describe("token shadows", () => {
  test("only a token above the ground casts one", () => {
    assert.equal(shadowShape(0), null);
    assert.equal(shadowShape(-10), null);
    assert.ok(shadowShape(5));
  });

  test("the shadow drifts from 0.2 cell just off the ground to 0.6 at 30 ft, and shrinks and fades as the token rises", () => {
    assert.ok(Math.abs(shadowShape(0.001)!.offset - 0.2) < 1e-4);
    assert.ok(Math.abs(shadowShape(15)!.offset - 0.4) < 1e-9);
    assert.equal(shadowShape(30)!.offset, 0.6);
    assert.equal(shadowShape(120)!.offset, 0.6);
    const lifts = [5, 10, 20, 30];
    const shapes = lifts.map((l) => shadowShape(l)!);
    for (let i = 1; i < shapes.length; i++) {
      assert.ok(shapes[i]!.offset > shapes[i - 1]!.offset);
      assert.ok(shapes[i]!.scale < shapes[i - 1]!.scale);
      assert.ok(shapes[i]!.alpha < shapes[i - 1]!.alpha);
    }
    assert.deepEqual(shadowShape(60), shadowShape(30));
  });

  test("from 5 ft up, the shadow's dark core shows past the token's disc on its lower right, Medium, Large and Huge alike", () => {
    // A round token `side` cells across, its disc's radius side / 2. Along the diagonal down and to the right the
    // shadow's center sits offset * sqrt(2) from the token's, and its full darkness reaches SHADOW_CORE of its radius.
    for (const side of [1, 2, 3]) {
      for (const lift of [5, 10, 15, 20, 30, 60]) {
        const shape = shadowShape(lift, { w: side, h: side })!;
        const coreReach = shape.offset * Math.SQRT2 + SHADOW_CORE * shape.scale * (side / 2);
        assert.ok(coreReach >= 0.6 * side, `a ${side}-cell token at ${lift} ft: the core reaches ${coreReach.toFixed(3)} cells from the middle`);
      }
    }
  });

  test("a Medium or smaller token's shadow offset is the one-cell offset, and a larger one's scales with its shorter side", () => {
    assert.deepEqual(shadowShape(10, { w: 1, h: 1 }), shadowShape(10));
    assert.deepEqual(shadowShape(10, { w: 0.5, h: 0.5 }), shadowShape(10));
    assert.ok(Math.abs(shadowShape(10, { w: 2, h: 2 })!.offset - 2 * shadowShape(10)!.offset) < 1e-12);
    assert.ok(Math.abs(shadowShape(10, { w: 1, h: 3 })!.offset - shadowShape(10)!.offset) < 1e-12);
  });

  test("on a scene without heights the ground is 0", () => {
    assert.equal(tokenLift({}, token(3, 3, 30)), 30);
    assert.equal(tokenLift({}, token(3, 3, 0)), 0);
  });

  test("a token standing on raised ground has no lift, so a platform never looks like flight", () => {
    const c = chunks({ "3,3": 10 });
    assert.equal(tokenLift(c, token(3, 3, 10)), 0);
    assert.equal(tokenLift(c, token(3, 3, 25)), 15);
  });

  test("a token inside the ground casts none", () => {
    assert.equal(tokenLift(chunks({ "3,3": 10 }), token(3, 3, 0)), 0);
  });

  test("a footprint's ground is the highest ground under it", () => {
    const c = chunks({ "4,4": 20 });
    assert.equal(tokenLift(c, token(3, 3, 30, "large")), 10);
  });

  test("while dragged, the shadow shows the lift the token would land with", () => {
    const c = chunks({ "6,3": 10, "8,3": 40 });
    // On the ground, it stays on the ground wherever it lands.
    assert.equal(tokenLift(c, token(3, 3, 0), { x: 6, y: 3 }), 0);
    // Flying at 30 ft over a 10 ft platform: 20 ft above it.
    assert.equal(tokenLift(c, token(3, 3, 30), { x: 6, y: 3 }), 20);
    // Over ground higher than it flies, it lands on that ground.
    assert.equal(tokenLift(c, token(3, 3, 30), { x: 8, y: 3 }), 0);
    // Burrowed at -5 ft, it keeps its elevation, which is above the ground of a pit.
    const pit = chunks({ "3,3": 0, "6,3": -20 });
    assert.equal(tokenLift(pit, token(3, 3, -5), { x: 6, y: 3 }), 15);
    // A drop where it already stands is no move.
    assert.equal(tokenLift(c, token(6, 3, 30), { x: 6, y: 3 }), 20);
  });
});
