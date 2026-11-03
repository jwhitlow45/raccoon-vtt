import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Sound } from "#shared/sound.ts";
import { room, scene } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** A DM's sound Setup steps go on the Setup stack in the panel's words (docs/design/design-v1-sound.md 6.6). */
describe("sound undo labels", () => {
  const rain: Sound = { id: "rain", rev: 0, name: "Rain", assetId: "file-rain", ms: 20_000, use: "effect" };
  const s = room({
    scenes: { road: scene("road", { name: "Forest road" }) },
    sounds: { rain },
    playlists: { tavern: { id: "tavern", rev: 0, name: "Tavern night", sounds: [], repeat: "all", fade: 5 } },
  });

  test("a sound's rename and change of use name the sound as it was", () => {
    assert.equal(describeOp({ t: "sound.update", id: "rain", name: "Storm" }, s), "renaming Rain");
    assert.equal(describeOp({ t: "sound.update", id: "rain", use: "loop" }, s), "using Rain as background");
    assert.equal(describeOp({ t: "sound.update", id: "rain", use: "music", name: "Storm" }, s), "using Rain as music", "a change of use says so before the name");
    assert.equal(describeOp({ t: "sound.update", id: "rain", use: "effect", name: "Storm" }, s), "renaming Rain", "the same use is a rename");
    assert.equal(describeOp({ t: "sound.update", id: "rain", use: "effect" }, { ...s, sounds: { rain: { ...rain, use: "loop" } } }), "using Rain as an effect");
    assert.equal(describeOp({ t: "sound.update", id: "gone", name: "Storm" }, s), "renaming a sound");
  });

  test("creating, changing and deleting the playlist Tavern night", () => {
    assert.equal(describeOp({ t: "playlist.create", id: "new", name: "Tavern night", sounds: [], repeat: "all", fade: 5 }, s), "creating the playlist Tavern night");
    assert.equal(describeOp({ t: "playlist.update", id: "tavern", name: "Late night" }, s), "changing the playlist Tavern night");
    assert.equal(describeOp({ t: "playlist.delete", id: "tavern" }, s), "deleting the playlist Tavern night");
    assert.equal(describeOp({ t: "playlist.delete", id: "gone" }, s), "deleting a playlist");
  });

  test("changing the sound of the scene Forest road, its sound sent alone", () => {
    assert.equal(describeOp({ t: "scene.update", sceneId: "road", patch: { sound: { music: null, loops: [] } } }, s), "changing the sound of the scene Forest road");
    assert.equal(describeOp({ t: "scene.update", sceneId: "road", patch: { sound: null } }, s), "changing the sound of the scene Forest road");
  });

  test("turning on and off Players see what is playing, the switch sent alone", () => {
    assert.equal(describeOp({ t: "room.update", settings: { soundNames: true } }, s), "turning on Players see what is playing");
    assert.equal(describeOp({ t: "room.update", settings: { soundNames: false } }, s), "turning off Players see what is playing");
    assert.equal(describeOp({ t: "room.update", settings: { soundNames: true, playersSeeOrder: "all" } }, s), "changing room settings");
  });
});
