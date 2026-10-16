import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { afterResize, rememberedReturn, type Growth, type Pose } from "./resizeMemory.ts";

const pose = (size: Pose["size"], x: number, y: number): Pose => ({ size, x, y });

describe("the growths this page sent (docs/design-v1-token-window.md 8.2)", () => {
  test("a growth is remembered, and a shrink to its starting size goes back to its place", () => {
    const grown = afterResize([], pose("medium", 4, 4), pose("large", 4, 4), true, null);
    assert.deepEqual(grown, [{ from: pose("medium", 4, 4), to: pose("large", 4, 4) }]);
    assert.deepEqual(rememberedReturn(grown, pose("large", 4, 4), "medium"), { at: { x: 4, y: 4 }, kept: [] });
  });

  test("Medium to Large to Huge, then Huge to Medium goes back to the Medium's square, and Huge to Large to the Large's place", () => {
    let growths: Growth[] = afterResize([], pose("medium", 4, 4), pose("large", 4, 4), true, null);
    growths = afterResize(growths, pose("large", 4, 4), pose("huge", 3, 3), true, null);
    assert.equal(growths.length, 2);
    const toMedium = rememberedReturn(growths, pose("huge", 3, 3), "medium");
    assert.deepEqual(toMedium, { at: { x: 4, y: 4 }, kept: [] });
    const toLarge = rememberedReturn(growths, pose("huge", 3, 3), "large");
    assert.deepEqual(toLarge?.at, { x: 4, y: 4 });
    assert.deepEqual(toLarge?.kept, [growths[0]]);
    // Taken, the shrink keeps only the older growths.
    assert.deepEqual(afterResize(growths, pose("huge", 3, 3), pose("large", 4, 4), false, toLarge!.kept), [growths[0]]);
  });

  test("a move, an undo or another device's resize leaves the token elsewhere: the list is stale and gives no return", () => {
    const growths = afterResize([], pose("medium", 4, 4), pose("huge", 3, 3), true, null);
    assert.equal(rememberedReturn(growths, pose("huge", 5, 3), "medium"), null, "moved since");
    assert.equal(rememberedReturn(growths, pose("medium", 4, 4), "tiny"), null, "an undo put it back to Medium");
    assert.equal(rememberedReturn(growths, pose("gargantuan", 3, 3), "medium"), null, "another device grew it further");
    assert.equal(rememberedReturn(growths, pose("huge", 3, 3), "small"), null, "no growth started from Small");
    // A shrink with no return drops the list, and a growth from a stale list starts a new one.
    assert.deepEqual(afterResize(growths, pose("huge", 5, 3), pose("medium", 6, 4), false, null), []);
    assert.deepEqual(afterResize(growths, pose("medium", 9, 9), pose("large", 9, 9), true, null), [{ from: pose("medium", 9, 9), to: pose("large", 9, 9) }]);
  });

  test("a reload starts with none, and a Tiny one keeps its quarter", () => {
    assert.equal(rememberedReturn([], pose("large", 4, 4), "medium"), null);
    const growths = afterResize([], pose("tiny", 4.5, 4), pose("medium", 4, 4), true, null);
    assert.deepEqual(rememberedReturn(growths, pose("medium", 4, 4), "tiny")?.at, { x: 4.5, y: 4 });
  });
});
