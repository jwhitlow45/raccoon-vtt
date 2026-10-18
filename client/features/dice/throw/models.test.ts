import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Vector3 } from "three";
import { splitD100 } from "./layout.ts";
import { buildModel, labelsOf, landing, MAX_TILT, shownFace } from "./models.ts";

/** The dice as solids, and the landing solved for every face (docs/design-v1-roll-animation.md 3.2). */

const KINDS = ["d4", "d6", "d8", "d10", "d12", "d20", "tens", "units", "coin"] as const;
const SIDES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, tens: 10, units: 10, coin: 1 } as const;

/** How far a landed number leans off upright on screen, in degrees. */
function lean(up: Vector3): number {
  return (Math.abs(Math.atan2(up.x, up.y)) * 180) / Math.PI;
}

describe("the dice models", () => {
  test("every kind has its number of flat faces, the d10's ten kites among them", () => {
    for (const kind of KINDS) {
      const model = buildModel(kind);
      if (kind === "coin") {
        assert.equal(model.labeled.length, 2, "the coin's two sides");
        continue;
      }
      assert.equal(model.faces.length, SIDES[kind], `${kind} faces`);
      assert.equal(model.labels.length, SIDES[kind]);
    }
    for (const face of buildModel("d10").faces) {
      assert.equal(face.triangles.length, 2, "a kite is two triangles in one plane");
      assert.equal(face.corners.length, 4);
    }
  });

  test("opposite faces add to n + 1 on the d6, d8, d10, d12 and d20", () => {
    for (const kind of ["d6", "d8", "d10", "d12", "d20"] as const) {
      const model = buildModel(kind);
      const n = SIDES[kind];
      assert.deepEqual(
        model.faces.map((f) => f.value).sort((a, b) => a - b),
        Array.from({ length: n }, (_, i) => i),
        `${kind} numbers each face once`,
      );
      for (const face of model.faces) {
        const opposite = model.faces.find((g) => g.normal.dot(face.normal) < -0.999);
        assert.ok(opposite, `${kind} face ${face.value + 1} has an opposite`);
        assert.equal(face.value + 1 + (opposite.value + 1), n + 1, `${kind}: ${face.value + 1} and ${opposite.value + 1}`);
      }
    }
  });

  test("each face, landed with any tilt the throw may give, faces the viewer and reads upright", () => {
    for (const kind of KINDS) {
      const model = buildModel(kind);
      const values = kind === "coin" ? [0] : model.labels.map((_, i) => i);
      for (const value of values) {
        for (const tilt of [-MAX_TILT, 0, MAX_TILT]) {
          const q = landing(model, value, tilt);
          const { face, up } = shownFace(model, value);
          const normal = face.normal.clone().applyQuaternion(q);
          assert.ok(normal.z >= 0.9999, `${kind} ${model.labels[value]} faces the viewer: ${normal.z}`);
          const leans = lean(up.clone().applyQuaternion(q));
          assert.ok(leans < 10, `${kind} ${model.labels[value]} leans ${leans.toFixed(1)} degrees`);
        }
      }
    }
  });

  test("a d4's result is printed at the corner it lands on top", () => {
    const model = buildModel("d4");
    for (let value = 0; value < 4; value++) {
      const { face, label } = shownFace(model, value);
      assert.equal(label?.value, value);
      assert.ok(face.labels.some((l) => l.value === value), "the shown face carries the corner's number");
    }
  });

  test("the d10 reads 10, not 0, and a percentile's dice read tens and units", () => {
    assert.equal(labelsOf("d10").at(-1), "10");
    assert.deepEqual(labelsOf("tens").slice(0, 3), ["00", "10", "20"]);
    assert.deepEqual(labelsOf("units").slice(0, 3), ["0", "1", "2"]);
    assert.deepEqual(splitD100(84).text, ["80", "4"]);
    assert.deepEqual(splitD100(100).text, ["00", "0"]);
    assert.deepEqual(splitD100(7).text, ["00", "7"]);
    for (const face of [1, 7, 10, 55, 84, 99, 100]) {
      const { tens, units, text } = splitD100(face);
      assert.equal(labelsOf("tens")[tens], text[0]);
      assert.equal(labelsOf("units")[units], text[1]);
    }
  });
});
