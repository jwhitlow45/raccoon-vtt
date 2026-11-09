import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clockText, playerLoopsLine, playlistDetail, playlistLeavesScenes, runLine, sceneLine, sizeText, skipName, storageLine, useLeavesLine } from "./words.ts";
import * as words from "./words.ts";

const MB = 1024 * 1024;

describe("the words of the Sound panel (docs/design/design-v1-music.md 4.1 and 4.3)", () => {
  test("times read as a clock", () => {
    assert.equal(clockText(0), "0:00");
    assert.equal(clockText(84_999), "1:24");
    assert.equal(clockText(900_000), "15:00");
    assert.equal(clockText(3_725_000), "1:02:05");
    assert.equal(clockText(-5), "0:00");
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

describe("the words of the Sound panel's views and the Now playing chip (docs/design/design-v1-sound-layout.md 9)", () => {
  test("the panel, the view row and the nothing-playing lines, word for word", () => {
    assert.deepEqual([words.SOUND_TITLE, words.SOUND_VIEWS, words.NOW_VIEW, words.LIBRARY_VIEW], ["Sound", "Sound", "Now playing", "Library"]);
    const pick = words.NO_MUSIC_PICK;
    assert.equal(`${pick.before}${pick.link}${pick.after}`, "No music is playing. Pick a playlist or a track in Library.");
    assert.equal(pick.link, "Library", "the link button's own word");
    assert.equal(words.NO_MUSIC_PLAYING, "No music is playing.");
  });

  test("Table sound says for everyone once, and points each device at its own volume", () => {
    assert.equal(words.TABLE_SOUND, "Table sound");
    assert.equal(words.TABLE_SOUND_HELP, "What everyone at the table hears, set here for every device. Each device sets its own volume from the speaker on its top bar.");
    assert.deepEqual([words.MUSIC_LABEL, words.EFFECTS_LABEL], ["Music", "Effects"]);
    assert.equal(words.musicVolume(), "Music volume for everyone", "the accessible name keeps whose volume it is");
    assert.ok(words.musicVolume().startsWith(words.MUSIC_LABEL), "and holds the visible word");
  });

  test("the names that say for everyone drop it when only the DM's devices sound", () => {
    assert.deepEqual([words.musicVolume(), words.effectsVolume(), words.loopVolumeName("Rain"), words.fireName("Click")], ["Music volume for everyone", "Effects volume for everyone", "Rain volume for everyone", "Play Click for everyone"]);
    assert.deepEqual([words.musicVolume("dm"), words.effectsVolume("dm"), words.loopVolumeName("Rain", "dm"), words.fireName("Click", "dm")], ["Music volume", "Effects volume", "Rain volume", "Play Click"]);
  });

  test("Only DM devices play: the switch, its help, the DM's reminder and the players' line, word for word (docs/design/design-v1-sound-dm-only.md 11)", () => {
    assert.equal(words.DM_ONLY_SWITCH, "Only DM devices play");
    assert.equal(words.DM_ONLY_HELP, "For a table that hears the sound from one speaker. Players' devices and the table display play nothing and don't ask. Each DM device still plays unless it is muted.");
    assert.equal(words.DM_ONLY_ON, "Only DM devices play the sound.");
    assert.equal(words.DM_PLAYS_IT, "The DM plays the sound on their own device.");
  });

  test("this device's volume: the speaker's name and the notes carry the level or Muted, and the help says what sounds while muted (docs/design/design-v1-volume.md 9)", () => {
    assert.deepEqual([words.VOLUME, words.MUTE, words.UNMUTE, words.MUTED], ["Volume", "Mute", "Unmute", "Muted"]);
    assert.equal(words.volumeNote({ muted: false, volume: 80 }), "80%");
    assert.equal(words.volumeNote({ muted: true, volume: 80 }), "Muted", "never the level it keeps");
    assert.equal(words.speakerName({ muted: false, volume: 45 }), "Volume on this device: 45%");
    assert.equal(words.speakerName({ muted: true, volume: 45 }), "Volume on this device: muted");
    assert.equal(words.DEVICE_HELP_PLAYER, "This device only. At one table, the DM can turn on Only DM devices play in Sound. Music uses about 60 MB of data an hour, none while muted. On an iPhone it pauses other apps' music and plays even with the ringer off.");
    assert.equal(words.DEVICE_HELP_DM, "This device only. Table sound, in Sound, sets the volumes for everyone. Music uses about 60 MB of data an hour, none while muted. On an iPhone it pauses other apps' music and plays even with the ringer off.");
    assert.equal(words.TURN_SOUND_HELP, "A short chime on your turn and a trap's sound, even while muted. Android phones also vibrate.");
    assert.equal(words.PING_SOUND_HELP, "A short tone when someone pings the map, even while muted.");
    assert.deepEqual([words.CANNOT_PLAY, words.DEVICE_MUTED], ["This browser can't play the room's sound.", "This device is muted."]);
  });

  test("the chip's player, its loading lines and the maker's", () => {
    assert.deepEqual(
      [words.CHIP_PAUSE, words.CHIP_PLAY, words.PLAYER_TITLE, words.BACKGROUND, words.OPEN_SOUND, words.OPENING_PLAYER, words.PLAYER_FAILED, words.OPENING_PLAYLIST, words.PLAYLIST_FAILED, words.MUSIC_IS_PLAYING],
      ["Pause", "Play", "Now playing", "Background", "Open Sound", "Opening the player…", "Couldn't open the player.", "Opening the playlist…", "Couldn't open the playlist.", "Music is playing"],
    );
    assert.equal(words.stopName("Rain on the cobblestones"), "Stop Rain on the cobblestones");
  });

  test("the chip's text and name in each state of 5.2, and its stopped state", () => {
    const music = { t: "music", name: "Tavern at night", run: "Tavern night · 3 of 12", paused: false } as const;
    assert.equal(words.chipText(music), "Tavern at night");
    assert.equal(words.chipName(music), "Now playing: Tavern at night, Tavern night · 3 of 12");
    assert.equal(words.chipText({ ...music, paused: true }), "Paused · Tavern at night");
    assert.equal(words.chipName({ ...music, paused: true }), "Now playing, paused: Tavern at night, Tavern night · 3 of 12");
    assert.equal(words.chipText({ t: "background", count: 2 }), "2 background sounds");
    assert.equal(words.chipName({ t: "background", count: 2 }), "Now playing: 2 background sounds");
    assert.equal(words.chipName({ t: "background", count: 1 }), "Now playing: 1 background sound");
    assert.equal(words.chipText({ t: "stopped" }), "Now playing");
    assert.equal(words.chipName({ t: "stopped" }), "Now playing, stopped");
  });

  test("the background count, the chip's and Now playing's with no music", () => {
    assert.equal(words.backgroundCount(1), "1 background sound");
    assert.equal(words.backgroundCount(4), "4 background sounds");
  });
});
