import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { room, scene } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** Scene setup's undo names (docs/design-v1-map-discovery.md 8.1 and 8.3, lane MS1). */

describe("undo step labels, scene setup", () => {
  const rooms = (extra: Record<string, ReturnType<typeof scene>> = {}) =>
    room({
      scenes: {
        s1: scene("s1", { name: "Crypt", fogEnabled: true, vision: { on: true, light: "dark" } }),
        s2: scene("s2", { name: "Hall", order: 1 }),
        s3: scene("s3", { name: "Tomb", order: 2 }),
        s4: scene("s4", { name: "Town", order: 3, fogEnabled: true }),
        ...extra,
      },
    });

  test("Players see names the choice it went to", () => {
    const state = rooms();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s2", patch: { fogEnabled: true, vision: { on: true, light: "bright" } } }, state), "setting Players see on the scene Hall to Explore");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { fogEnabled: true, vision: { on: false, light: "dark" } } }, state), "setting Players see on the scene Crypt to Reveal by hand");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s4", patch: { fogEnabled: false, vision: { on: false, light: "bright" } } }, state), "setting Players see on the scene Town to Everything");
    // The Party vision switch alone keeps its own words.
    assert.equal(describeOp({ t: "scene.update", sceneId: "s2", patch: { vision: { on: true, light: "bright" } } }, state), "turning on party vision on the scene Hall");
  });
});
