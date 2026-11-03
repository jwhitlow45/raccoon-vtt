import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, type ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { room } from "#shared/testutil.ts";
import { checkWholeScenes, growthBound, measuredLog, measuredStateBytes, SizeGuard } from "./sizeGuard.ts";

/**
 * Synced music and sound in the size guard (docs/design/design-v1-sound.md
 * 6.3): the library, the playlists and what plays ride in every DM's
 * projection, so they count in the room-level part, exactly, and only while
 * each holds something, as the projection carries them.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };

function projectionBytes(view: ProjectedState): number {
  // Derived undo metadata has its own bound and may name private log lines.
  const { hpUndoLogIds: _undo, ...meta } = view.meta;
  return serializedBytes({ ...view, meta });
}

function dmScene(state: RoomState, sceneId: string): number {
  return projectionBytes(projectState({ ...state, log: [...measuredLog(state.log)], sight: {} } as unknown as RoomState, DM, { sceneId }));
}

function applied(state: RoomState, op: Op, seq: number): { state: RoomState; growth: number } {
  const result = applyOp(state, op, DM, { seq, at: "2026-10-12T00:00:00.000Z" });
  assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
  return { state: result.state, growth: growthBound(state, result.state, result.touched) };
}

const SETUP: Op[] = [
  { t: "sound.create", id: "m1", assetId: "0192f0aa-0000-7000-8000-000000000001", name: "Tavern at night", use: "music", ms: 120_000 },
  { t: "sound.create", id: "m2", assetId: "0192f0aa-0000-7000-8000-000000000002", name: "Road", use: "music", ms: 90_000, level: -35 },
  { t: "sound.create", id: "l1", assetId: "0192f0aa-0000-7000-8000-000000000003", name: "Rain on the roof", use: "loop", ms: 20_000 },
  { t: "sound.create", id: "e1", assetId: "0192f0aa-0000-7000-8000-000000000004", name: "Door", use: "effect", ms: 1_500 },
  { t: "playlist.create", id: "pl1", name: "Night", sounds: ["m1", "m2"], shuffle: true, repeat: "all", fade: 5 },
  { t: "music.play", run: "r1", playlistId: "pl1", order: ["m2", "m1"], repeat: "all", fade: 5 },
  { t: "loop.start", id: "lp1", soundId: "l1", volume: 60 },
  { t: "effect.fire", id: "f1", soundId: "e1" },
  { t: "view.blackout", blackout: true },
  { t: "effect.fire", id: "f2", soundId: "e1" },
  { t: "scene.update", sceneId: "s1", patch: { sound: { music: { playlistId: "pl1", repeat: "all", fade: 2 }, loops: [{ soundId: "l1", volume: 40 }] } } },
  { t: "room.update", settings: { soundNames: true } },
];

/** A room from before sound, then every op above, each with its state and growth bound. */
function steps(): { before: RoomState; state: RoomState; growth: number; op: Op }[] {
  let state = room();
  return SETUP.map((op, i) => {
    const before = state;
    const next = applied(state, op, i + 1);
    state = next.state;
    return { before, ...next, op };
  });
}

function assertExact(state: RoomState, why: string): void {
  for (const sceneId of ["s1", "s2"]) {
    const bytes = dmScene(state, sceneId);
    assert.equal(new SizeGuard({ sceneLimit: bytes }).check(state, [sceneId], 0).ok, true, `${why}, ${sceneId}`);
    assert.equal(new SizeGuard({ sceneLimit: bytes - 1 }).check(state, [sceneId], 0).ok, false, `${why}, ${sceneId}`);
  }
}

describe("sound in the size guard (docs/design/design-v1-sound.md 6.3)", () => {
  test("the library, the playlists and what plays count in the room-level part, exactly, after every op that writes them", () => {
    const all = steps();
    const last = all.at(-1)!.state;
    assert.ok(last.sounds && last.playlists && last.playing?.music && last.playing.dmEffects?.length === 1 && last.scenes.s1!.sound);
    for (const { state, op } of all) assertExact(state, op.t);
    // The whole room's own bytes count them too, so the room check and the import's check of every scene read them.
    assert.equal(measuredStateBytes(last), serializedBytes(last));
    const bytes = dmScene(last, "s2");
    assert.equal(checkWholeScenes(last, bytes).ok, true);
    assert.equal(checkWholeScenes(last, bytes - 1).ok, false);
  });

  test("an empty library, no playlists and silence add nothing, as the projection leaves them out", () => {
    const quiet = { ...room(), sounds: {}, playlists: {}, playing: null };
    assert.equal(dmScene(quiet, "s1"), dmScene(room(), "s1"));
    assertExact(quiet, "empty");
    // Every sound deleted and the music stopped: the fields stay in the state, empty, and the measure follows the projection.
    let state = steps().at(-1)!.state;
    let seq = 100;
    for (const op of [{ t: "sound.stopAll" }, { t: "scene.update", sceneId: "s1", patch: { sound: null } }, { t: "playlist.delete", id: "pl1" }, ...["m1", "m2", "l1", "e1"].map((id) => ({ t: "sound.delete", id }))] as Op[]) {
      state = applied(state, op, seq++).state;
      assertExact(state, op.t);
    }
    assert.deepEqual([state.sounds, state.playlists], [{}, {}]);
  });

  test("the growth bound covers each op, the first sound and the first playlist in a room from before sound bringing their record's field", () => {
    for (const { before, state, growth, op } of steps()) {
      const grew = serializedBytes(state) - serializedBytes(before);
      assert.ok(growth >= grew, `${op.t}: bound ${growth} under ${grew}`);
    }
  });
});
