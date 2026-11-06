import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clockText, playerLoopsLine, playerMusicLine, playlistDetail, playlistLeavesScenes, runLine, sceneLine, sizeText, skipName, storageLine, timeShown, useLeavesLine } from "./words.ts";

const MB = 1024 * 1024;

describe("the words of Ambiance's Sound (docs/design/design-v1-music.md 4.1 and 4.3)", () => {
  test("times read as a clock, and aloud as one of the other", () => {
    assert.equal(clockText(0), "0:00");
    assert.equal(clockText(84_999), "1:24");
    assert.equal(clockText(900_000), "15:00");
    assert.equal(clockText(3_725_000), "1:02:05");
    assert.equal(clockText(-5), "0:00");
    assert.deepEqual(timeShown(84_000, 190_000), { text: "1:24 / 3:10", spoken: "1:24 of 3:10" });
    assert.equal(timeShown(200_000, 190_000).text, "3:10 / 3:10", "a position past the end reads the end");
  });

  test("a playlist's row and the run's line", () => {
    assert.equal(playlistDetail(12, 41 * 60_000 + 10_000), "12 tracks · 41 min");
    assert.equal(playlistDetail(1, 30_000), "1 track · 1 min");
    assert.equal(playlistDetail(0, 0), "No tracks");
    assert.equal(runLine({ playlistName: "Tavern night", place: 3, count: 12, single: false }), "Tavern night · 3 of 12");
    assert.equal(runLine({ playlistName: null, place: 3, count: 12, single: false }), "3 of 12");
    assert.equal(runLine({ playlistName: null, place: 1, count: 1, single: true }), "One track");
  });

  test("Skip names the incoming track only while a crossfade runs", () => {
    assert.equal(skipName(null), "Skip to the next track");
    assert.equal(skipName("Rain"), "Skip past Rain");
  });

  test("the scene's line in each state", () => {
    assert.equal(sceneLine("Forest road", null), "Forest road has no sound of its own.");
    assert.equal(sceneLine("Forest road", { names: [] }), "Forest road is silent.");
    assert.equal(sceneLine("Forest road", { names: ["Tavern night", "Rain", "Crowd"] }), "Forest road's sound: Tavern night, Rain, Crowd.");
  });

  test("a player's lines name only what the projection names", () => {
    assert.equal(playerMusicLine("The Prancing Pony"), "Music: The Prancing Pony");
    assert.equal(playerMusicLine(null), "Music is playing.");
    assert.equal(playerLoopsLine(["Rain", "Crowd"]), "Background: Rain, Crowd");
    assert.equal(playerLoopsLine([null, null]), "2 background sounds are playing.");
    assert.equal(playerLoopsLine([null]), "1 background sound is playing.");
    assert.equal(playerLoopsLine(["Rain", null]), "2 background sounds are playing.", "a half-named set names none");
    assert.equal(playerLoopsLine([]), null);
  });

  test("what a change of use or a playlist's delete leaves", () => {
    assert.equal(useLeavesLine("Rain", 1, 2), "Rain leaves 1 playlist and 2 scenes.");
    assert.equal(useLeavesLine("Rain", 0, 1), "Rain leaves 1 scene.");
    assert.equal(useLeavesLine("Rain", 3, 0), "Rain leaves 3 playlists.");
    assert.equal(useLeavesLine("Rain", 0, 0), null);
    assert.equal(playlistLeavesScenes(2), "It leaves 2 scenes' sound.");
    assert.equal(playlistLeavesScenes(1), "It leaves 1 scene's sound.");
    assert.equal(playlistLeavesScenes(0), null);
  });

  test("the storage line", () => {
    assert.equal(storageLine({ used: 384 * MB, quota: 1024 * MB, sounds: 212 * MB }), "Sounds use 212 MB. Images and sounds share the room's 1 GB, and 640 MB is free.");
    assert.equal(sizeText(1536 * MB), "1.5 GB");
    assert.equal(sizeText(0), "0 MB");
    assert.equal(sizeText(1000), "under 1 MB");
    assert.match(storageLine({ used: 2048 * MB, quota: 1024 * MB, sounds: 0 }), /and 0 MB is free\.$/, "a room past its quota has none free");
  });
});
