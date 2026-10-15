import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Light } from "#shared/model.ts";
import { lightAt, lightCaption, lightModeHint, lightReach, sceneHasLights } from "./lightTap.ts";

function light(id: string, x: number, y: number, patch: Partial<Light> = {}): Light {
  return { id, rev: 1, sceneId: "s1", x, y, bright: 20, dim: 20, on: true, walls: true, ...patch };
}

describe("lights in the builder", () => {
  test("a tap picks the nearest light on the scene within reach", () => {
    const lights = {
      a: light("a", 2, 2),
      b: light("b", 2.5, 2),
      c: light("c", 2.1, 2, { sceneId: "s2" }),
    };
    assert.equal(lightAt(lights, "s1", { x: 2.2, y: 2 }, 0.5)?.id, "a");
    assert.equal(lightAt(lights, "s1", { x: 2.3, y: 2 }, 0.5)?.id, "b");
    // A light on another scene is never picked, however close.
    assert.equal(lightAt(lights, "s2", { x: 2.1, y: 2 }, 0.5)?.id, "c");
    assert.equal(lightAt(lights, "s1", { x: 4, y: 4 }, 0.5), null);
    assert.equal(lightAt(undefined, "s1", { x: 2, y: 2 }, 0.5), null);
  });

  test("a light's rings: bright light to its radius, dim light that far again beyond it", () => {
    // The SRD's Lamp: bright 15 ft, dim 30 ft beyond.
    assert.deepEqual(lightReach({ bright: 15, dim: 30 }, 5), { bright: 3, dim: 9 });
    assert.deepEqual(lightReach({ bright: 20, dim: 20 }, 10), { bright: 2, dim: 4 });
    assert.deepEqual(lightReach({ bright: 0, dim: 10 }, 5), { bright: 0, dim: 2 });
  });

  test("a selected light says its radii as the rings draw them, its label, and whether it is off", () => {
    // The SRD's Lamp: its outer ring is at 45 ft, so the caption says 45, not the 30 ft band.
    assert.equal(lightCaption({ bright: 15, dim: 30, on: true, label: "Lamp" }), "Lamp: 15 ft bright, dim to 45 ft");
    assert.equal(lightCaption({ bright: 20, dim: 20, on: false, label: "Torch" }), "Torch: 20 ft bright, dim to 40 ft, off");
    assert.equal(lightCaption({ bright: 0, dim: 10, on: true }), "dim to 10 ft");
    assert.equal(lightCaption({ bright: 20, dim: 0, on: true }), "20 ft bright");
  });

  test("the Lights mode says how to place the first light on a scene that has none", () => {
    const lights = { a: light("a", 2, 2), b: light("b", 3, 3, { sceneId: "s2" }) };
    assert.equal(sceneHasLights(lights, "s1"), true);
    assert.equal(sceneHasLights(lights, "s3"), false);
    assert.equal(sceneHasLights(undefined, "s1"), false);
    assert.match(lightModeHint(true), /^Tap the map to place/);
    assert.equal(lightModeHint(false), "This scene has no lights yet. Tap the map to place the light chosen.");
  });
});
