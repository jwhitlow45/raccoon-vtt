import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
import { assetFileName, exportableState, withoutSound } from "./exportRoom.ts";

/** A backup's sounds (docs/design/design-v1-music.md 6.7, D-261102-475). */

const DM = { memberId: "dm1", role: "dm" as const };

function withSounds(): RoomState {
  const base = room();
  return {
    ...base,
    meta: { ...base.meta, settings: { ...base.meta.settings, soundNames: true, soundDmOnly: true } },
    scenes: { ...base.scenes, s1: scene("s1", { sound: { music: { soundId: "rain", repeat: "all", fade: 5 }, loops: [{ soundId: "wind", volume: 70 }] } }) },
    sounds: {
      rain: { id: "rain", rev: 0, name: "Rain", assetId: "00000000-0000-4000-8000-000000000001", ms: 60_000, use: "music" },
      wind: { id: "wind", rev: 0, name: "Wind", assetId: "00000000-0000-4000-8000-000000000002", ms: 10_000, use: "loop" },
    },
    playlists: { night: { id: "night", rev: 0, name: "Tavern night", sounds: ["rain"], repeat: "all", fade: 5 } },
    playing: { rev: 3, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "rain", at: 1 } }, loops: {}, effects: [], volume: { music: 80, effects: 80 } },
  };
}

describe("a backup without sounds", () => {
  test("keeps nothing about sound but Only DM devices play: an empty library, no playlist, silence, no scene's sound and the names switch off", () => {
    const out = withoutSound(withSounds());
    assert.deepEqual(out.sounds, {});
    assert.deepEqual(out.playlists, {});
    assert.equal(out.playing, null);
    assert.equal("sound" in out.scenes.s1!, false);
    assert.equal("soundNames" in out.meta.settings, false);
    // It holds no file and nothing hidden, and still routes the built-in effects (docs/design/design-v1-sound-dm-only.md 7).
    assert.equal(out.meta.settings.soundDmOnly, true);
    const { soundNames: _names, ...settings } = withSounds().meta.settings;
    assert.deepEqual(out.meta.settings, settings, "the other settings as they were");
    assert.equal(JSON.stringify(out).includes("Rain"), false, "no sound's name");
    assert.equal(JSON.stringify(out).includes("00000000-0000-4000-8000-00000000000"), false, "no sound's file");
    // The rest of the room is as it was.
    assert.deepEqual({ ...out, scenes: {}, meta: null }, { ...withSounds(), sounds: {}, playlists: {}, playing: null, scenes: {}, meta: null });
  });

  test("adds no collection a room from before sound never held", () => {
    const old = room();
    const out = withoutSound(old);
    for (const key of ["sounds", "playlists", "playing"]) assert.equal(key in out, false, key);
    assert.deepEqual(out, old);
  });

  test("the export leaves sounds out only when told, keeps Only DM devices play either way, and names a sound's entry .mp3", () => {
    const state = withSounds();
    for (const sounds of [true, false]) assert.equal(exportableState(state, DM, { sounds }).meta.settings.soundDmOnly, true, `sounds ${sounds}`);
    assert.deepEqual(exportableState(state, DM).sounds, state.sounds);
    assert.deepEqual(exportableState(state, DM, { sounds: true }).playing, state.playing);
    assert.deepEqual(exportableState(state, DM, { sounds: false }).sounds, {});
    assert.equal(assetFileName("ab".repeat(32), "sound", "full", "mp3"), `assets/${"ab".repeat(32)}-sound-full.mp3`);
    assert.equal(assetFileName("ab".repeat(32), "sound", "full", null), `assets/${"ab".repeat(32)}-sound-full.mp3`, "a sound is mp3 whatever its manifest says");
    assert.equal(assetFileName("ab".repeat(32), "video", "full", "webm"), `assets/${"ab".repeat(32)}-video-full.webm`);
    assert.equal(assetFileName("ab".repeat(32), "map", "full", "mp3"), `assets/${"ab".repeat(32)}-map-full.webp`);
  });
});
