import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, room, scene, token } from "#shared/testutil.ts";
import { opSchema } from "#shared/protocol.ts";
import { describeOp } from "./undoLabels.ts";
import { UndoTable } from "./undoTesting.ts";

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

  test("Use default records one setup step that undoes and redoes shape, grid and bounds", () => {
    const state = hexRoom();
    state.scenes.s1!.map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 10, y: 10 } };
    const table = new UndoTable(state);
    const op = opSchema.parse({ t: "scene.setGrid", sceneId: "s1", cellPx: 47, originPx: { x: 0, y: 0 }, gridShape: "squares", bounds: { w: 29, h: 21 } });
    assert.equal(table.play(DM, op), "ok");
    const values = () => {
      const { rev: _, ...scene } = table.state.scenes.s1!;
      return scene;
    };
    const restored = values();
    assert.equal(restored.gridShape, undefined);
    assert.deepEqual(restored.bounds, { w: 29, h: 21 });
    assert.equal(restored.map!.cellPx, 47);
    assert.equal(table.stacks.peek(DM.memberId, "undo", "setup")?.label, "lining up the grid of the scene Goblin cave");
    assert.equal(table.undo(DM, "setup"), "ok");
    const { rev: _, ...before } = state.scenes.s1!;
    assert.deepEqual(values(), before);
    assert.equal(table.undo(DM, "setup"), "nothing to undo");
    assert.equal(table.redo(DM, "setup"), "ok");
    assert.deepEqual(values(), restored);
  });
});
