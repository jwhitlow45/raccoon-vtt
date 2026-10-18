import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seededRandom } from "./layout.ts";
import { buildModel, landing, MAX_TILT } from "./models.ts";
import { DROPPED_OPACITY, LAND_MS, LAST_FRAME_MS, pathFor, poseAt, type DiePath } from "./poses.ts";

/** A die's scripted path (docs/design-v1-roll-animation.md 3.2 and 3.4). */

function paths(tag: string): DiePath[] {
  const random = seededRandom(tag);
  const model = buildModel("d20");
  return Array.from({ length: 6 }, (_, index) =>
    pathFor({ from: { x: 300, y: -400 }, to: { x: 30 + index * 52, y: -56 }, landing: landing(model, index, (random() - 0.5) * 2 * MAX_TILT), index }, random),
  );
}

describe("a die's path", () => {
  test("from 1,000 ms on, every die is exactly its landing, at its slot", () => {
    for (const path of paths("land")) {
      for (const ms of [LAND_MS, LAND_MS + 1, LAST_FRAME_MS, 5_000]) {
        const pose = poseAt(path, ms, false);
        assert.ok(pose.quaternion.equals(path.landing), `turned at ${ms} ms`);
        assert.ok(pose.position.x === path.to.x && pose.position.y === path.to.y, `placed at ${ms} ms`);
        assert.equal(pose.scale, 1);
        assert.equal(pose.reveal, 1, "the number in full ink");
      }
    }
  });

  test("every pose is finite, from before the throw to long after", () => {
    for (const path of paths("finite")) {
      for (let ms = -50; ms <= 1_300; ms += 7) {
        for (const dropped of [false, true]) {
          const p = poseAt(path, ms, dropped);
          const numbers = [p.position.x, p.position.y, p.position.z, p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w, p.scale, p.reveal, p.opacity];
          assert.ok(numbers.every(Number.isFinite), `at ${ms} ms`);
          assert.ok(Math.abs(p.quaternion.length() - 1) < 1e-9, "a rotation");
        }
      }
    }
  });

  test("the number darkens as the die arrives, and a dropped die dims only after it lands", () => {
    const [path] = paths("dim");
    assert.equal(poseAt(path!, 500, false).reveal, 0);
    assert.ok(poseAt(path!, 900, false).reveal > 0);
    assert.equal(poseAt(path!, LAND_MS, true).opacity, 1);
    assert.ok(Math.abs(poseAt(path!, LAST_FRAME_MS, true).opacity - DROPPED_OPACITY) < 1e-12);
    assert.equal(poseAt(path!, LAST_FRAME_MS, false).opacity, 1);
  });

  test("the same tag makes the same paths, and another tag others", () => {
    const pose = (p: DiePath) => poseAt(p, 400, false).position.toArray();
    assert.deepEqual(paths("one").map(pose), paths("one").map(pose));
    assert.notDeepEqual(paths("one").map(pose), paths("two").map(pose));
  });
});
