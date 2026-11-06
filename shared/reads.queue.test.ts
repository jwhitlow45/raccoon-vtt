import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { reads, satisfies } from "./reads.ts";
import type { Sound } from "./sound.ts";
import { DM, room } from "./testutil.ts";

/*
 * What the queue's ops read (docs/design/design-v1-music-player.md 6.3):
 * what plays and the sounds of the run's order and of the edit, Shuffle
 * off its playlist while it exists, and Add to playlist its playlist and
 * track. So a DM's device predicts each at once, as it does Play.
 */

const music = (id: string): Sound => ({ id, rev: 0, name: id, assetId: `file-${id}`, ms: 120_000, use: "music" });

function playingRoom(playlistId: string | undefined): RoomState {
  return room({
    sounds: { m1: music("m1"), m2: music("m2"), m3: music("m3") },
    playlists: { tavern: { id: "tavern", rev: 0, name: "Tavern", sounds: ["m1", "m2"], repeat: "all", fade: 5 } },
    playing: {
      rev: 1,
      music: { run: "r1", ...(playlistId !== undefined ? { playlistId } : {}), order: ["m1", "m2"], index: 0, repeat: "all", fade: 5, now: { soundId: "m1", at: 1_000 } },
      loops: {},
      effects: [],
      volume: { music: 100, effects: 100 },
    },
  });
}

const keysOf = (op: Op, state: RoomState): string[] => {
  const r = reads(op, state);
  assert.ok(!("never" in r), op.t);
  return r.keys.map((k) => k.key).sort();
};

const run = [keys.playing, keys.sound("m1"), keys.sound("m2")];

describe("the queue's reads", () => {
  test("each edit reads what plays, the run's order and the tracks it names", () => {
    const state = playingRoom("tavern");
    const edit = (e: Extract<Op, { t: "music.queue" }>["edit"]): Op => ({ t: "music.queue", from: "r1", edit: e });
    assert.deepEqual(keysOf(edit({ t: "next", soundIds: ["m3"] }), state), [...run, keys.sound("m3")].sort());
    assert.deepEqual(keysOf(edit({ t: "add", soundIds: ["m3", "m2"] }), state), [...run, keys.sound("m3"), keys.sound("m2")].sort());
    assert.deepEqual(keysOf(edit({ t: "move", soundId: "m2", to: { before: "m3" } }), state), [...run, keys.sound("m2"), keys.sound("m3")].sort());
    assert.deepEqual(keysOf(edit({ t: "move", soundId: "m2", to: "last" }), state), [...run, keys.sound("m2")].sort());
    assert.deepEqual(keysOf(edit({ t: "remove", soundId: "m2" }), state), [...run, keys.sound("m2")].sort());
    assert.deepEqual(keysOf(edit({ t: "shuffle", seed: "s1" }), state), [...run].sort());
    assert.deepEqual(keysOf(edit({ t: "unshuffle" }), state), [...run, keys.playlist("tavern")].sort(), "the playlist whose order comes back");
    assert.deepEqual(keysOf(edit({ t: "unshuffle" }), playingRoom("gone")), [...run].sort(), "a deleted playlist is no read, so the flag alone still predicts");
    assert.deepEqual(keysOf(edit({ t: "unshuffle" }), playingRoom(undefined)), [...run].sort(), "a run of one track has none");
  });

  test("a jump reads what plays, the order and its track, and Add to playlist its playlist and track", () => {
    const state = playingRoom("tavern");
    assert.deepEqual(keysOf({ t: "music.jump", run: "r2", from: "r1", soundId: "m2", ms: 1_000, on: "m1" }, state), [...run, keys.sound("m2")].sort());
    assert.deepEqual(keysOf({ t: "music.jump", run: "r2", from: "r1", soundId: "m3" }, state), [...run, keys.sound("m3")].sort());
    assert.deepEqual(keysOf({ t: "playlist.add", id: "tavern", soundId: "m3" }, state), [keys.playlist("tavern"), keys.sound("m3")].sort());
  });

  test("a DM's view satisfies each, so the device predicts it", () => {
    const state = playingRoom("tavern");
    const projected = projectState(state, DM, { sceneId: null });
    const ops: Op[] = [
      { t: "music.queue", from: "r1", edit: { t: "next", soundIds: ["m3"] } },
      { t: "music.queue", from: "r1", edit: { t: "unshuffle" } },
      { t: "music.jump", run: "r2", from: "r1", soundId: "m2" },
      { t: "playlist.add", id: "tavern", soundId: "m3" },
    ];
    for (const op of ops) assert.ok(satisfies(reads(op, state), projected, DM, { sceneId: null }), op.t);
  });
});
