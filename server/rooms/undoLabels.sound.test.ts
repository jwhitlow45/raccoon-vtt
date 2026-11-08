import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Sound } from "#shared/sound.ts";
import { room, scene } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** A DM's sound Setup steps go on the Setup stack in the panel's words (docs/design/design-v1-music.md 6.6). */
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

  test("adding a track to the playlist Tavern night, each named as it was, and the queue's ops as changing the music (docs/design/design-v1-music-player.md 6.3)", () => {
    const harbor: Sound = { id: "harbor", rev: 0, name: "Harbor at dusk", assetId: "file-harbor", ms: 120_000, use: "music" };
    const t = { ...s, sounds: { ...s.sounds, harbor } };
    assert.equal(describeOp({ t: "playlist.add", id: "tavern", soundId: "harbor" }, t), "adding Harbor at dusk to the playlist Tavern night");
    assert.equal(describeOp({ t: "playlist.add", id: "gone", soundId: "harbor" }, t), "adding Harbor at dusk to a playlist");
    assert.equal(describeOp({ t: "playlist.add", id: "tavern", soundId: "gone" }, t), "adding a track to the playlist Tavern night");
    assert.equal(describeOp({ t: "music.queue", from: "r1", edit: { t: "next", soundIds: ["harbor"] } }, t), "changing the music");
    assert.equal(describeOp({ t: "music.queue", from: "r1", edit: { t: "shuffle", seed: "s1" } }, t), "changing the music");
    assert.equal(describeOp({ t: "music.jump", run: "r2", from: "r1", soundId: "harbor", ms: 30_000, on: "harbor" }, t), "changing the music");
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

  test("turning on and off Only DM devices play, the switch sent alone (docs/design/design-v1-sound-dm-only.md 4)", () => {
    assert.equal(describeOp({ t: "room.update", settings: { soundDmOnly: true } }, s), "turning on Only DM devices play");
    assert.equal(describeOp({ t: "room.update", settings: { soundDmOnly: false } }, s), "turning off Only DM devices play");
    assert.equal(describeOp({ t: "room.update", settings: { soundDmOnly: true, soundNames: true } }, s), "changing room settings");
    assert.equal(describeOp({ t: "room.update", name: "Keep", settings: { soundDmOnly: true } }, s), "changing room settings");
  });
});
