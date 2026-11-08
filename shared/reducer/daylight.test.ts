import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opSchema } from "../protocol.ts";
import { apply, room, scene } from "../testutil.ts";

/** Light that follows the time of day, and dawn and dusk (docs/design/design-v1-calendar-c2c3.md 6). */

const H = 3_600;

describe("the contract (6.1, 6.2)", () => {
  test("a stored vision holds byClock only as true, a patch true or false", () => {
    const create = (vision: object) => opSchema.safeParse({ t: "scene.create", scene: { id: "s9", name: "S", bounds: { w: 10, h: 10 }, vision } });
    assert.ok(create({ on: true, light: "dim", byClock: true }).success);
    assert.ok(!create({ on: true, light: "dim", byClock: false }).success, "a stored vision never holds false");
    const patch = (vision: object) => opSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { vision } });
    assert.ok(patch({ on: true, light: "dim", byClock: true }).success);
    assert.ok(patch({ on: true, light: "dim", byClock: false }).success);
  });

  test("dawn and dusk go on a clock update alone, in whole minutes within their halves of the day", () => {
    const update = (daylight: object) => opSchema.safeParse({ t: "clock.update", daylight });
    for (const daylight of [
      { dawn: 0, dusk: 12 * H },
      { dawn: 11 * H, dusk: 23 * H },
      { dawn: 5 * H + 30 * 60, dusk: 18 * H },
    ]) {
      assert.ok(update(daylight).success, JSON.stringify(daylight));
    }
    for (const daylight of [
      { dawn: 11 * H + 60, dusk: 18 * H },
      { dawn: 6 * H, dusk: 23 * H + 60 },
      { dawn: -60, dusk: 18 * H },
      { dawn: 6 * H, dusk: 12 * H - 60 },
      { dawn: 6 * H + 30, dusk: 18 * H },
      { dawn: 6 * H },
      { dawn: 6 * H, dusk: 18 * H, extra: 1 },
    ]) {
      assert.ok(!update(daylight).success, JSON.stringify(daylight));
    }
  });

  test("a vision patch without byClock keeps it, false clears it, and it is stored only while true", () => {
    const s = room();
    s.scenes.s1 = scene("s1", { vision: { on: true, light: "dim", perPlayer: true, byClock: true } });
    const kept = apply(s, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "dim" } } });
    assert.deepEqual(kept.scenes.s1!.vision, { on: false, light: "dim", perPlayer: true, byClock: true }, "Players see's patches keep it");
    const cleared = apply(kept, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", byClock: false } } });
    assert.deepEqual(cleared.scenes.s1!.vision, { on: false, light: "bright", perPlayer: true });
    const on = apply(cleared, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", perPlayer: false, byClock: true } } });
    assert.deepEqual(on.scenes.s1!.vision, { on: false, light: "bright", byClock: true });
    const created = apply(room(), { t: "scene.create", scene: { id: "s9", name: "S", bounds: { w: 10, h: 10 }, vision: { on: false, light: "dark", byClock: true } } });
    assert.deepEqual(created.scenes.s9!.vision, { on: false, light: "dark", byClock: true });
  });
});
