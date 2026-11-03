import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import type { Playlist, Sound } from "#shared/sound.ts";
import { scene as sceneOf } from "#shared/testutil.ts";
import { moveSoundOp } from "./moveSound.ts";

/** The scene's sound behind a Move players (MUS-R1-06): sent only while the server offers sound files. */

const sounds: Record<string, Sound> = { m1: { id: "m1", rev: 0, name: "Harbor", assetId: "file-m1", ms: 60_000, use: "music" }, rain: { id: "rain", rev: 0, name: "Rain", assetId: "file-rain", ms: 20_000, use: "loop" } };
const playlists: Record<string, Playlist> = { night: { id: "night", rev: 0, name: "Night", sounds: ["m1"], repeat: "all", fade: 5 } };
const withSound: Scene = { ...sceneOf("s2"), sound: { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }] } };
const input = (serverSound: boolean) => ({ serverSound, playlists, sounds, newId: () => "run1", random: () => 0 });

describe("the scene's sound behind a move", () => {
  test("while the server offers sound files, a scene with sound sends it for the move, in the scene's order", () => {
    assert.deepEqual(moveSoundOp(withSound, input(true)), { t: "sound.scene", sceneId: "s2", run: "run1", order: ["m1"], onMove: true });
  });

  test("while the switch is off or not known yet, or for a scene with no sound, nothing is sent, so the move goes alone", () => {
    assert.equal(moveSoundOp(withSound, input(false)), null);
    assert.equal(moveSoundOp({ ...withSound, sound: { music: null, loops: [] } }, input(false)), null, "silence too: nothing plays to stop");
    assert.equal(moveSoundOp(sceneOf("s3"), input(true)), null);
  });
});
