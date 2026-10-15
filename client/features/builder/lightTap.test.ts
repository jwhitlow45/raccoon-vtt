import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Light, Token } from "#shared/model.ts";
import { lightAt, lightCaption, lightCaptionSpot, lightModeHint, lightReach, sceneHasLights, tokenBodies } from "./lightTap.ts";

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

describe("lightCaptionSpot (LPD-REGRESS-3)", () => {
  // A light at cell (5, 5) at 40 px a cell: its sun at screen (200, 200). The caption is 200 x 18 px.
  const light = { x: 5, y: 5 };
  const size = { width: 200, height: 18 };
  const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

  test("in open ground it sits under the sun, as it always has", () => {
    assert.deepEqual(lightCaptionSpot(light, size, 40, []), { x: 5, y: 5 + 28 / 40 });
  });

  test("a token's name under the sun moves it over the sun, then to either side", () => {
    const under = box(190, 220, 260, 236);
    assert.deepEqual(lightCaptionSpot(light, size, 40, [under]), { x: 5, y: 5 - 28 / 40 });
    const over = box(150, 165, 250, 180);
    const right = lightCaptionSpot(light, size, 40, [under, over]);
    assert.deepEqual(right, { x: (200 + 17 + 6 + 100) / 40, y: 5 });
    const rightName = box(240, 195, 300, 210);
    assert.deepEqual(lightCaptionSpot(light, size, 40, [under, over, rightName]), { x: (200 - 17 - 6 - 100) / 40, y: 5 });
  });

  test("with names all round it is not drawn, as a height pill is not", () => {
    const all = [box(190, 220, 260, 236), box(150, 165, 250, 180), box(240, 195, 300, 210), box(60, 195, 120, 210)];
    assert.equal(lightCaptionSpot(light, size, 40, all), null);
  });

  test("a name beside the caption's spot but clear of it leaves it where it was", () => {
    assert.deepEqual(lightCaptionSpot(light, size, 40, [box(305, 220, 360, 236)]), { x: 5, y: 5 + 28 / 40 });
  });

  test("the tokens' bodies count too, since the caption draws over them", () => {
    const goblin = { id: "g", sceneId: "s1", x: 6, y: 4, size: "medium" } as Token;
    const ogre = { id: "o", sceneId: "s1", x: 2, y: 2, size: "large" } as Token;
    const elsewhere = { id: "e", sceneId: "s2", x: 0, y: 0, size: "medium" } as Token;
    assert.deepEqual(tokenBodies({ g: goblin, o: ogre, e: elsewhere }, "s1", 40), [box(240, 160, 280, 200), box(80, 80, 160, 160)]);
    const under = box(190, 220, 260, 236);
    const over = box(150, 165, 250, 180);
    const spot = lightCaptionSpot(light, size, 40, [under, over, ...tokenBodies({ g: goblin }, "s1", 40)]);
    assert.deepEqual(spot, { x: (200 - 17 - 6 - 100) / 40, y: 5 }, "the goblin beside the sun sends it to the left");
  });
});
