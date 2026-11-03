import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { canApply, SOUND_OFF, type PermissionDeps } from "./permissions.ts";
import type { OpOf } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import type { LoopPlaying, Playing, SceneSound, Sound, SoundUse } from "./sound.ts";
import { AT, DM, room } from "./testutil.ts";

/*
 * A scene's sound while the server's switch is off
 * (docs/design/design-v1-sound.md 6.2 and 4.6, MUS-R1-06): refused when it
 * would start a sound file, and passed when it starts none, so a Move
 * players to a scene whose sound is silence still goes. The reducer is the
 * oracle: whatever passes starts no music run and no background sound.
 */

const OFF: PermissionDeps = { canUseAsset: () => true, roomSound: false };
const ON: PermissionDeps = { canUseAsset: () => true, roomSound: true };

function sound(id: string, use: SoundUse): Sound {
  return { id, rev: 0, name: id, assetId: `file-${id}`, ms: use === "effect" ? 2_000 : 60_000, use };
}

const MUSICS: Record<string, SceneSound["music"]> = {
  none: null,
  playlist: { playlistId: "tavern", repeat: "all", fade: 5 },
  empty: { playlistId: "quiet", repeat: "all", fade: 5 },
  track: { soundId: "m1", repeat: "one", fade: 0 },
};
const LOOPS: Record<string, SceneSound["loops"]> = {
  none: [],
  rain: [{ soundId: "rain", volume: 70 }],
  both: [
    { soundId: "rain", volume: 70 },
    { soundId: "wind", volume: 40 },
  ],
  "an effect": [{ soundId: "thunder", volume: 70 }],
};
const PLAYING: Record<string, Record<string, LoopPlaying>> = { nothing: {}, rain: { l1: { soundId: "rain", at: Date.parse(AT), volume: 50 } } };

function roomWith(sceneSound: SceneSound | undefined, loops: Record<string, LoopPlaying>, playerSceneId: string): RoomState {
  const state = room({
    sounds: { m1: sound("m1", "music"), m2: sound("m2", "music"), rain: sound("rain", "loop"), wind: sound("wind", "loop"), thunder: sound("thunder", "effect") },
    playlists: { tavern: { id: "tavern", rev: 0, name: "Tavern", sounds: ["m1", "m2"], repeat: "all", fade: 5 }, quiet: { id: "quiet", rev: 0, name: "Quiet", sounds: [], repeat: "all", fade: 5 } },
    playing: { rev: 1, music: null, loops, effects: [], volume: { music: 100, effects: 100 } },
  });
  state.meta.playerSceneId = playerSceneId;
  if (sceneSound) state.scenes.s2 = { ...state.scenes.s2!, sound: sceneSound };
  return state;
}

/** Whether the op, applied, starts a music run or a background sound that did not play before. */
function startsFile(state: RoomState, op: OpOf<"sound.scene">): boolean {
  const r = applyOp(state, op, DM, { seq: 1, at: AT });
  if (!r.ok) return false;
  const before = state.playing as Playing;
  const after = (r.state.playing ?? before) as Playing;
  const newRun = after.music !== null && after.music.run !== before.music?.run;
  const newLoop = Object.keys(after.loops).some((id) => !Object.hasOwn(before.loops, id));
  return newRun || newLoop;
}

describe("a scene's sound with the switch off (MUS-R1-06)", () => {
  test("every scene's sound that passes starts no file, and every one that would start a file is refused", () => {
    let passed = 0;
    let refused = 0;
    for (const [musicName, music] of Object.entries(MUSICS)) {
      for (const [loopsName, loops] of Object.entries(LOOPS)) {
        for (const [playingName, nowPlaying] of Object.entries(PLAYING)) {
          for (const where of ["s2", "s1"]) {
            for (const onMove of [true, undefined]) {
              const state = roomWith({ music, loops }, nowPlaying, where);
              const order = musicName === "playlist" ? ["m1", "m2"] : musicName === "track" ? ["m1"] : [];
              const op: OpOf<"sound.scene"> = { t: "sound.scene", sceneId: "s2", run: "r9", order, ...(onMove ? { onMove } : {}) };
              const name = `music ${musicName}, loops ${loopsName}, playing ${playingName}, players on ${where}, onMove ${onMove}`;
              const decision = canApply(op, DM, state, OFF);
              const starts = startsFile(state, op);
              assert.equal(decision.ok, !starts, name);
              if (!decision.ok) assert.equal(decision.message, SOUND_OFF, name);
              assert.equal(canApply(op, DM, state, ON).ok, true, `${name}, switch on`);
              if (decision.ok) passed++;
              else refused++;
            }
          }
        }
      }
    }
    assert.ok(passed > 0 && refused > 0, `${passed} passed, ${refused} refused`);
  });

  test("a Move players to a scene whose sound is silence, or that has none, passes, and one with music or a background sound is refused", () => {
    const move = (sceneSound: SceneSound | undefined) => canApply({ t: "sound.scene", sceneId: "s2", run: "r1", order: [], onMove: true }, DM, roomWith(sceneSound, {}, "s2"), OFF);
    assert.equal(move({ music: null, loops: [] }).ok, true, "silence");
    assert.equal(move(undefined).ok, true, "no sound of its own");
    assert.equal(move({ music: MUSICS.empty!, loops: [] }).ok, true, "a playlist with no tracks");
    assert.equal(move({ music: null, loops: LOOPS["an effect"]! }).ok, true, "a background sound that is now an effect");
    assert.deepEqual(move({ music: null, loops: LOOPS.rain! }), { ok: false, code: "invalid", message: SOUND_OFF });
    const music = canApply({ t: "sound.scene", sceneId: "s2", run: "r1", order: ["m1", "m2"], onMove: true }, DM, roomWith({ music: MUSICS.playlist!, loops: [] }, {}, "s2"), OFF);
    assert.deepEqual(music, { ok: false, code: "invalid", message: SOUND_OFF });
  });
});
