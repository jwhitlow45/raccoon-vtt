import assert from "node:assert/strict";
import { test } from "node:test";
import { room, scene } from "#shared/testutil.ts";
import { noSceneText, sceneToOpen } from "./noScene.ts";

/*
 * Live play 44: the DM deleted the players' scene while their device showed
 * it, and the device read "Create a scene to get started." in a room of 12
 * scenes, and still did once Undo setup brought the scene back with the
 * players on it.
 */

test("a DM device showing no scene in a room with scenes asks for one from the Scenes panel, and only a room with none asks to create one", () => {
  assert.equal(noSceneText("dm", true), "Pick a scene in the Scenes panel.");
  assert.equal(noSceneText("dm", false), "Create a scene to get started.");
  assert.equal(noSceneText("player", true), "Waiting for the DM to pick a scene.");
  assert.equal(noSceneText("player", false), "Waiting for the DM to pick a scene.");
});

test("a DM device showing no scene opens the players' scene once it stands, and nothing else", () => {
  const view = room({ scenes: { keep: scene("keep"), crypt: scene("crypt") } });
  const on = (playerSceneId: string | null) => ({ ...view, meta: { ...view.meta, playerSceneId } });
  assert.equal(sceneToOpen(on("keep"), "dm", null), "keep", "Undo setup brought the players' scene back");
  assert.equal(sceneToOpen(on(null), "dm", null), null, "the players wait on no scene too: the DM picks");
  assert.equal(sceneToOpen(on("gone"), "dm", null), null, "a players' scene this copy does not hold yet");
  assert.equal(sceneToOpen(on("keep"), "dm", "crypt"), null, "a device that shows a scene keeps it");
  assert.equal(sceneToOpen(on("keep"), "player", null), null, "a player's device is sent its scene");
  assert.equal(sceneToOpen(null, "dm", null), null, "no room yet");
});
