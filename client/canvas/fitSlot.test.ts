import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomScope } from "../state/scope.ts";
import { fitSlot, grownWithin, openingFrame, takeFrame } from "./fitSlot.ts";

const ENTRANCE = { x: 3, y: 10, width: 6, height: 5 };

test("DG-C: takeFrame gives the rectangle once, to its own scene", () => {
  const slot = new RoomScope().get(fitSlot);
  slot.frameOnOpen = { sceneId: "crypt", rect: ENTRANCE };
  assert.deepEqual(takeFrame(slot, "crypt"), ENTRANCE);
  assert.equal(takeFrame(slot, "crypt"), null, "a second opening is not framed again");
});

test("DG-C: takeFrame for another scene drops the request", () => {
  const slot = new RoomScope().get(fitSlot);
  slot.frameOnOpen = { sceneId: "crypt", rect: ENTRANCE };
  assert.equal(takeFrame(slot, "arena"), null);
  assert.equal(slot.frameOnOpen, null);
  assert.equal(takeFrame(slot, "crypt"), null, "a later visit to the scene is not framed");
});

test("DG-C: each room scope keeps its own request, so View as a player never sees the DM's", () => {
  const dm = new RoomScope();
  const preview = new RoomScope();
  dm.get(fitSlot).frameOnOpen = { sceneId: "crypt", rect: ENTRANCE };
  assert.equal(openingFrame(preview.get(fitSlot), { size: { width: 400, height: 300 }, cameraScene: "arena", sceneId: "crypt" }), null);
  assert.deepEqual(dm.get(fitSlot).frameOnOpen, { sceneId: "crypt", rect: ENTRANCE }, "the preview's opening left the DM's request alone");
});

test("DG-C: openingFrame waits for a size and takes nothing on the scene already open", () => {
  const slot = new RoomScope().get(fitSlot);
  slot.frameOnOpen = { sceneId: "crypt", rect: ENTRANCE };
  assert.equal(openingFrame(slot, { size: null, cameraScene: "arena", sceneId: "crypt" }), null);
  assert.ok(slot.frameOnOpen, "kept for the opening a size brings");
  assert.equal(openingFrame(slot, { size: { width: 400, height: 300 }, cameraScene: "crypt", sceneId: "crypt" }), null);
  assert.ok(slot.frameOnOpen, "a render of the scene already open keeps it");
  assert.deepEqual(openingFrame(slot, { size: { width: 400, height: 300 }, cameraScene: "arena", sceneId: "crypt" }), ENTRANCE);
});

test("DG-C: grownWithin grows by the margin and stays inside the scene", () => {
  assert.deepEqual(grownWithin({ x: 10, y: 10, width: 5, height: 4 }, 4, { w: 50, h: 50 }), { x: 6, y: 6, width: 13, height: 12 });
  assert.deepEqual(grownWithin({ x: 2, y: 44, width: 5, height: 4 }, 4, { w: 50, h: 50 }), { x: 0, y: 40, width: 11, height: 10 });
});
