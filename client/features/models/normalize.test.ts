import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { box, cylinder, figure, type Triangles } from "./fixtures.testutil.ts";
import { MODEL_WORDS, PLAIN, type ModelMesh } from "./mesh.ts";
import { fitModel, layoutAt, maxSizeOf, reachOf, rotationFor, UPS, type Rotation } from "./normalize.ts";

/** Standing a model up, fitting it to its footprint and laying out its frames (docs/design/design-v1-token-models.md 5, D-261127-173, 174, 371). */

const L = MODEL_LIMITS;

function meshOf(t: Triangles, axes: "yUp" | "zUp" = "yUp"): ModelMesh {
  const positions = new Float32Array(t);
  return { axes, parts: [{ positions, normals: new Float32Array(positions.length), index: null, uvs: null, colors: null, material: PLAIN }], textures: [], colorable: true, notes: [], triangles: t.length / 9 };
}

const apply = (r: Rotation, v: [number, number, number]) => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]].map((x) => Math.round(x) || 0);

/** Where a file point lands, fitted at Size 100%. */
function placed(mesh: ModelMesh, p: [number, number, number], up = 0, front = 0): number[] {
  const fit = fitModel(mesh, rotationFor(mesh.axes, up, front));
  const R = fit.rotation;
  const r = [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
  return r.map((v, i) => fit.scale * (v - fit.offset[i]!));
}

describe("standing a model up", () => {
  test("STL and OBJ stand Z up with their front toward -Y; GLB stands as it is", () => {
    assert.deepEqual(apply(rotationFor("zUp", 0, 0), [0, 0, 1]), [0, 1, 0]);
    assert.deepEqual(apply(rotationFor("zUp", 0, 0), [0, -1, 0]), [0, 0, 1]);
    assert.deepEqual(apply(rotationFor("yUp", 0, 0), [0, 0, 1]), [0, 0, 1]);
  });

  test("Stand it up turns each of the six axes up, and cycles", () => {
    const ups = UPS.map((_, u) => {
      const r = rotationFor("yUp", u, 0);
      // Which file axis now points up.
      for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as [number, number, number][]) if (apply(r, v)[1] === 1) return v.join(",");
      return "none";
    });
    assert.equal(new Set(ups).size, 6, ups.join(" "));
    assert.deepEqual(rotationFor("yUp", 6, 0), rotationFor("yUp", 0, 0));
  });

  test("Turn its front turns a quarter clockwise seen from above, four of them all the way round", () => {
    // From above, north up the screen: the front at +Z (toward the camera, south) turns to -X (west).
    assert.deepEqual(apply(rotationFor("yUp", 0, 1), [0, 0, 1]), [-1, 0, 0]);
    assert.deepEqual(rotationFor("yUp", 0, 4).map((v) => Math.round(v) || 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("fitting a model to its footprint", () => {
  test("finds a mini's round base and fills the footprint with it, the base's middle on the center and its bottom on the ground", () => {
    const mini = meshOf(figure().map((v, i) => (i % 3 === 0 ? v + 3 : i % 3 === 1 ? v + 7 : v)));
    const fit = fitModel(mini, rotationFor("yUp", 0, 0));
    assert.ok(fit.base);
    assert.ok(Math.abs(fit.scale - 1 / 0.999) < 0.01, `the 1-wide base fills the footprint: ${fit.scale}`);
    const [x, y, z] = placed(mini, [3.5, 7, 0]);
    assert.ok(Math.abs(x! - 0.5) < 0.01 && Math.abs(y!) < 1e-6 && Math.abs(z!) < 0.01, `the base's edge at the footprint's edge: ${x}, ${y}, ${z}`);
  });

  test("caps a based model's height at 2.5 footprints", () => {
    const tower = meshOf([...cylinder([0, 0], 0.5, 0, 0.1, 32), ...box([-0.1, 0, -0.1], [0.1, 5, 0.1])]);
    const fit = fitModel(tower, rotationFor("yUp", 0, 0));
    assert.ok(fit.base);
    assert.ok(Math.abs(fit.scale * 5 - 2.5) < 1e-6, `${fit.scale * 5} tall`);
  });

  test("centers a creature on its feet, not its box, and fits it in 1 by 1 by 1.4", () => {
    // Two feet near x = 0, a long tail out to x = 6: no base, so the feet's middle goes on the center.
    const wolf = meshOf([...box([-0.6, 0, -0.3], [-0.4, 2, 0.3]), ...box([0.4, 0, -0.3], [0.6, 2, 0.3]), ...box([-0.6, 2, -0.4], [6, 2.6, 0.4])]);
    const fit = fitModel(wolf, rotationFor("yUp", 0, 0));
    assert.ok(!fit.base);
    assert.ok(Math.abs(fit.scale - 1 / 6.6) < 1e-6, "the longest side fits the footprint");
    const [x, y] = placed(wolf, [0, 0, 0]);
    assert.ok(Math.abs(x!) < 1e-6 && Math.abs(y!) < 1e-6);
    // A tall post under a crossbar twice its width: its foot is too narrow to be a base, so it fits 1.4 high.
    const tall = meshOf([...box([0, 0, 0], [1, 10, 1]), ...box([-0.5, 9, 0], [1.5, 10, 1])]);
    const tallFit = fitModel(tall, rotationFor("yUp", 0, 0));
    assert.ok(!tallFit.base);
    assert.ok(Math.abs(tallFit.scale - 0.14) < 1e-6, "a thin tall model fits 1.4 high");
  });

  test("refuses a model with no size", () => {
    assert.throws(() => fitModel(meshOf(new Array(18).fill(2)), rotationFor("yUp", 0, 0)), { message: MODEL_WORDS.notModel });
  });
});

describe("laying out the frames", () => {
  const mini = meshOf(figure());
  const fit = fitModel(mini, rotationFor("yUp", 0, 0));
  const reach = reachOf(mini, fit);

  test("each box in whole hundredths inside its frame, the anchor inside, the side covering the ring and every view", () => {
    for (const size of [50, 100, 150]) {
      const { meta, side, top } = layoutAt(reach, size);
      assert.equal(meta.boxes.length, 8);
      for (const [x0, y0, x1, y1] of meta.boxes) {
        for (const v of [x0, y0, x1, y1]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
        assert.ok(x0 < x1 && y0 < y1);
      }
      assert.ok(meta.anchorY > 0 && meta.anchorY < 1);
      assert.equal(top, meta.anchorY * side);
      assert.ok(side >= 1 / (1 - (2 * L.gutterPx) / L.framePx) - 1e-9, "the ring, a footprint wide, fits inside the gutters");
      assert.ok(side >= L.minSide && side <= L.maxSide);
      assert.equal(Math.round(side * 1e4) / 1e4, side, "the side in four places");
    }
  });

  test("frame 0 faces the camera and frame 2 faces left: a nose toward +Z shows low in front, then off to the left", () => {
    const nosy = meshOf([...box([-0.2, 0, -0.2], [0.2, 1, 0.2]), ...box([-0.05, 0.5, 0.2], [0.05, 0.6, 1.2])]);
    const f = fitModel(nosy, rotationFor("yUp", 0, 0));
    const { meta } = layoutAt(reachOf(nosy, f), 100);
    const [, , , y1front] = meta.boxes[0]!;
    const [, , , y1back] = meta.boxes[4]!;
    assert.ok(y1front > y1back, "toward the camera reaches lower on the screen");
    const [x0left, , x1left] = meta.boxes[2]!;
    assert.ok(50 - x0left > x1left - 50, "turned 90 degrees clockwise, it points left");
    const [x0right, , x1right] = meta.boxes[6]!;
    assert.ok(x1right - 50 > 50 - x0right, "turned 270, it points right");
  });

  test("a based model 2.5 footprints tall stops short of 200%, its side at most 4, the next step past it", () => {
    const tower = meshOf([...cylinder([0, 0], 0.5, 0, 0.1, 32), ...box([-0.1, 0, -0.1], [0.1, 5, 0.1])]);
    const r = reachOf(tower, fitModel(tower, rotationFor("yUp", 0, 0)));
    const cap = maxSizeOf(r);
    assert.ok(cap < 200 && cap >= 100, `the cap is ${cap}`);
    assert.ok(layoutAt(r, cap).side <= L.maxSide);
    // One step more is past 4: the layout clamps a request for it to the cap.
    const asked = layoutAt(r, 200);
    assert.equal(asked.size, cap);
    assert.equal(asked.maxSize, cap);
    const stepped = layoutAt(r, cap + 10);
    assert.equal(stepped.size, cap);
  });

  test("Size moves in 10% steps from 50%, rounding a request to the nearest", () => {
    assert.equal(layoutAt(reach, 0).size, 50);
    assert.equal(layoutAt(reach, 104).size, 100);
    assert.equal(layoutAt(reach, 106).size, 110);
    assert.equal(layoutAt(reach, Number.NaN).size, 100);
  });
});
