import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { room, scene, token } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** Undo steps on a hex scene say its cell word (docs/design-v1-hex-grids.md section 8). */

function hexRoom() {
  return room({ scenes: { s1: scene("s1", { name: "Goblin cave", gridShape: "hexRows" }) }, tokens: { g2: token("g2", { name: "Goblin", number: 2 }) } });
}

describe("undo step labels on a hex scene", () => {
  test("difficult ground says how many hexes", () => {
    const s = hexRoom();
    assert.equal(describeOp({ t: "build.rough", sceneId: "s1", cells: ["1,1", "2,1", "3,1"], on: true }, s), "marking 3 hexes as difficult ground on the scene Goblin cave");
    assert.equal(describeOp({ t: "build.rough", sceneId: "s1", cells: ["1,1"], on: false }, s), "clearing difficult ground from 1 hex on the scene Goblin cave");
  });

  test("a Custom size reads as its category, as a creature takes it on hexes", () => {
    const s = hexRoom();
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { size: "custom", w: 2, h: 3 } }, s), "resizing Goblin 2 to Huge");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { size: "large" } }, s), "resizing Goblin 2 to Large");
  });
});
