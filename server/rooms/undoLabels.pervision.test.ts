import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { room, scene } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** Per-player vision's undo names (docs/design-v1-per-player-vision.md 6.7, lane PV1). */
describe("undo step labels, per-player vision", () => {
  const whole = room({ scenes: { s1: scene("s1", { name: "Goblin cave", vision: { on: true, light: "bright" } }) } });
  const perPlayer = room({ scenes: { s1: scene("s1", { name: "Goblin cave", vision: { on: true, light: "bright", perPlayer: true } }) } });

  test("the Sight row names which way it went", () => {
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "bright", perPlayer: true } } }, whole), "making sight per player on the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "bright", perPlayer: false } } }, perPlayer), "making sight whole party on the scene Goblin cave");
  });

  test("Party vision and the light keep their names on a per-player scene, whose patch keeps Per player", () => {
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright" } } }, perPlayer), "turning off party vision on the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: true } } }, perPlayer), "making the scene Goblin cave dark");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }, whole), "making the scene Goblin cave dark", "a patch that says Whole party on a whole-party scene changes nothing of it");
  });

  test("the DM's ticks", () => {
    assert.equal(describeOp({ t: "vision.holders", sceneId: "s1", on: ["p1"] }, perPlayer), "choosing who sees for themselves on the scene Goblin cave");
  });
});
