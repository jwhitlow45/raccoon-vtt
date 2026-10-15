import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { belowGround, belowGroundText, placeOnGround } from "./ground.ts";
import { raised, thorn, world } from "./testing.ts";

const chunks = world({ heights: raised(6, 0, 12, 12, 10) }).buildChunks;

describe("inside the ground (section 4.2)", () => {
  test("a token below the ground under it is told how far", () => {
    assert.deepEqual(belowGround(chunks, thorn({ x: 7, y: 2, elevation: 0 })), { ground: 10, depth: 10 });
    assert.equal(belowGroundText(10), "Inside the ground (10 ft below).");
  });
  test("on the ground or above it, nothing is said", () => {
    assert.equal(belowGround(chunks, thorn({ x: 7, y: 2, elevation: 10 })), null);
    assert.equal(belowGround(chunks, thorn({ x: 7, y: 2, elevation: 40 })), null);
    assert.equal(belowGround(chunks, thorn({ x: 2, y: 2, elevation: 0 })), null);
  });
  test("a burrower below unpainted ground is inside it too", () => {
    assert.deepEqual(belowGround(chunks, thorn({ x: 2, y: 2, elevation: -15 })), { ground: 0, depth: 15 });
  });
  test("a footprint reads the highest ground under it", () => {
    assert.deepEqual(belowGround(chunks, thorn({ size: "large", x: 5, y: 2, elevation: 0 })), { ground: 10, depth: 10 });
  });
});

describe("placing a token (section 4.2)", () => {
  test("a new token stands on the ground where it is placed", () => {
    assert.equal(placeOnGround(chunks, { sceneId: "s1", size: "medium", x: 7, y: 2 }).elevation, 10);
    assert.equal(placeOnGround(chunks, { sceneId: "s1", size: "medium", x: 7, y: 2, elevation: 0 }).elevation, 10);
  });
  test("on unpainted ground, or placed with a height of its own, it is left as it is", () => {
    const flat = { sceneId: "s1", size: "medium" as const, x: 2, y: 2 };
    assert.equal(placeOnGround(chunks, flat), flat);
    assert.equal(placeOnGround(chunks, { ...flat, x: 7, elevation: 30 }).elevation, 30);
  });
});
