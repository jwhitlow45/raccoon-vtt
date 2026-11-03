import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, SoundFacts } from "#shared/model.ts";
import type { Sound } from "#shared/sound.ts";
import { room } from "#shared/testutil.ts";
import { withoutSound } from "./exportRoom.ts";
import { refillSoundFacts, remapState, type ImportedAsset } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A backup's sound on import (docs/design/design-v1-sound.md 6.7): the
 * library and the playlists follow their new ids and each file its new row,
 * what played is dropped so the room starts silent, `refillSoundFacts` takes
 * every length from the rows and leaves out a sound whose file failed or
 * whose length does not fit its use, with its places, and `withoutSound`
 * leaves nothing about sound at all.
 */

// The intake's kinds (server/assets/kinds.ts) take "sound" with the intake itself (7.2).
const SOUND_KIND = "sound" as string as ImportedAsset["kind"];
const T = 1_791_835_200_400;

/** A file mid-run: a sound of every use, a playlist, two scene sounds and everything playing, each length a claim. */
function file(): RoomState {
  const state = room();
  state.meta.settings = { ...state.meta.settings, soundNames: true };
  const sound = (id: string, use: Sound["use"], ms: number, extra: Partial<Sound> = {}): Sound => ({ id, rev: 2, name: id, assetId: `a-${id}`, ms, use, ...extra });
  state.sounds = { m1: sound("m1", "music", 120_000), m2: sound("m2", "music", 90_000, { level: -30 }), l1: sound("l1", "loop", 20_000), e1: sound("e1", "effect", 1_500) };
  state.playlists = { pl1: { id: "pl1", rev: 1, name: "Night", sounds: ["m1", "m2"], repeat: "all", fade: 5 } };
  state.playing = {
    rev: 9,
    music: { run: "r1", playlistId: "pl1", order: ["m2", "m1"], index: 0, repeat: "all", fade: 5, now: { soundId: "m2", at: T } },
    loops: { lp1: { soundId: "l1", at: T, volume: 60 } },
    effects: [{ id: "f1", soundId: "e1", at: T }],
    volume: { music: 70, effects: 80 },
  };
  state.scenes.s1 = { ...state.scenes.s1!, sound: { music: { playlistId: "pl1", repeat: "all", fade: 2 }, loops: [{ soundId: "l1", volume: 40 }] } };
  state.scenes.s2 = { ...state.scenes.s2!, sound: { music: { soundId: "m1", repeat: "one", fade: 0 }, loops: [] } };
  return state;
}

const ROWS: [string, ImportedAsset][] = ["m1", "m2", "l1", "e1"].map((id) => [`a-${id}`, { id: `A-${id}-2`, kind: SOUND_KIND }]);

const facts = (ms: number, extra: Partial<SoundFacts> = {}): SoundFacts => ({ ms, channels: 2, kbps: 128, ...extra });
/** The rows the import's frame walk made, under their new ids: every length a little off what the file claimed. */
const REAL = new Map<string, SoundFacts>([
  ["A-m1-2", facts(121_032)],
  ["A-m2-2", facts(89_995, { channels: 1, kbps: 64 })],
  ["A-l1-2", facts(20_010)],
  ["A-e1-2", facts(1_567, { kbps: 192 })],
]);

/** New ids that say what they were, so the tests can follow them. */
function namer(): () => string {
  let n = 0;
  return () => `new-${n++}`;
}

function remapped(rows: [string, ImportedAsset][] = ROWS, state: RoomState = file()): RoomState {
  return remapState(state, { assets: new Map(rows), newId: namer() });
}

/** The remapped room's sound by its old name, which it keeps. */
function byName(state: RoomState, name: string): Sound | undefined {
  return Object.values(state.sounds ?? {}).find((s) => s.name === name);
}

function parses(state: RoomState): void {
  const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
}

describe("a backup's sound on import (docs/design/design-v1-sound.md 6.7)", () => {
  test("sounds and playlists take new ids, each file its new row's, and every reference follows", () => {
    const state = remapped();
    const m1 = byName(state, "m1")!;
    const m2 = byName(state, "m2")!;
    const l1 = byName(state, "l1")!;
    for (const [name, sound] of [["m1", m1], ["m2", m2], ["l1", l1], ["e1", byName(state, "e1")!]] as const) {
      assert.match(sound.id, /^new-/, name);
      assert.equal(state.sounds![sound.id], sound, `${name} under its own id`);
      assert.equal(sound.assetId, `A-${name}-2`, `${name}'s file`);
    }
    assert.equal(m2.level, -30);
    const [playlist] = Object.values(state.playlists!);
    assert.match(playlist!.id, /^new-/);
    assert.equal(state.playlists![playlist!.id], playlist);
    assert.deepEqual(playlist!.sounds, [m1.id, m2.id]);
    const [s1, s2] = Object.values(state.scenes).sort((a, b) => a.order - b.order);
    assert.deepEqual(s1!.sound, { music: { playlistId: playlist!.id, repeat: "all", fade: 2 }, loops: [{ soundId: l1.id, volume: 40 }] });
    assert.deepEqual(s2!.sound, { music: { soundId: m1.id, repeat: "one", fade: 0 }, loops: [] });
    assert.equal(state.meta.settings.soundNames, true, "the names switch stays");
    // Each sound's name is its old id, so only the ids that are no name can be looked for.
    const json = JSON.stringify(state);
    for (const old of ["pl1", "a-m1", "a-m2", "a-l1", "a-e1"]) assert.ok(!json.includes(`"${old}"`), `${old} is left`);
  });

  test("an imported room starts silent, even from a file saved mid-run, and parses", () => {
    const state = remapped();
    assert.equal(state.playing, null);
    const refilled = refillSoundFacts(state, REAL);
    assert.equal(refilled.left, 0);
    parses(refilled.state);
  });

  test("a room from before sound comes through without any of it", () => {
    const state = remapped([], room());
    assert.equal("sounds" in state || "playlists" in state || "playing" in state, false);
    assert.deepEqual(refillSoundFacts(state, new Map()), { state, left: 0 });
    parses(state);
  });

  test("a sound whose file did not come through as a sound names no row, and the old room's file never", () => {
    const rows = ROWS.filter(([old]) => old !== "a-m2").concat([["a-m2", { id: "A-m2-2", kind: "map" }]]).filter(([old]) => old !== "a-e1");
    const state = remapped(rows);
    for (const name of ["m2", "e1"]) {
      const sound = byName(state, name)!;
      assert.match(sound.assetId, /^new-/, `${name} takes an id no row has`);
      assert.notEqual(sound.assetId, "A-m2-2");
    }
    const refilled = refillSoundFacts(state, REAL);
    assert.equal(refilled.left, 2);
    assert.deepEqual(Object.values(refilled.state.sounds!).map((s) => s.name).sort(), ["l1", "m1"]);
    parses(refilled.state);
  });
});

describe("refillSoundFacts (6.7, MSOL-33, MUS-OPUS-53)", () => {
  const rows = () => new Map(REAL);

  test("refills every length from its row, whatever the file claimed, and keeps the rest of each sound", () => {
    const state = remapped();
    const { state: refilled, left } = refillSoundFacts(state, rows());
    assert.equal(left, 0);
    for (const [name, ms] of [["m1", 121_032], ["m2", 89_995], ["l1", 20_010], ["e1", 1_567]] as const) {
      const before = byName(state, name)!;
      assert.deepEqual(byName(refilled, name), { ...before, ms }, name);
    }
    assert.deepEqual(refilled.playlists, state.playlists);
    assert.deepEqual(refilled.scenes, state.scenes);
  });

  test("finds a row by its id in lower case, as the database writes it", () => {
    const { left, state } = refillSoundFacts(remapped(), new Map([...REAL].map(([id, f]) => [id.toLowerCase(), f])));
    assert.equal(left, 0);
    assert.equal(byName(state, "m1")!.ms, 121_032);
  });

  test("leaves out a 10 s file claiming Music, with its places in playlists and scene sounds, and counts it", () => {
    const real = rows();
    real.set("A-m1-2", facts(10_000));
    const state = remapped();
    const m1 = byName(state, "m1")!.id;
    const m2 = byName(state, "m2")!.id;
    const { state: refilled, left } = refillSoundFacts(state, real);
    assert.equal(left, 1);
    assert.equal(byName(refilled, "m1"), undefined);
    assert.equal(Object.hasOwn(refilled.sounds!, m1), false);
    assert.deepEqual(Object.values(refilled.playlists!)[0]!.sounds, [m2], "its playlist keeps the other track");
    const [s1, s2] = Object.values(refilled.scenes).sort((a, b) => a.order - b.order);
    assert.equal(s1!.sound!.music?.playlistId, Object.keys(refilled.playlists!)[0], "a scene playing its playlist still does");
    assert.deepEqual(s2!.sound, { music: null, loops: [] }, "a scene playing it alone falls silent");
    assert.ok(!JSON.stringify(refilled).includes(`"${m1}"`), "nothing names it");
    parses(refilled);
  });

  test("leaves out a background sound with its scene places, and a length past an Effect's cap with the allowance", () => {
    const real = rows();
    real.delete("A-l1-2");
    real.set("A-e1-2", facts(30_101));
    const { state, left } = refillSoundFacts(remapped(), real);
    assert.equal(left, 2);
    assert.deepEqual(Object.values(state.sounds!).map((s) => s.name).sort(), ["m1", "m2"]);
    assert.deepEqual(Object.values(state.scenes).sort((a, b) => a.order - b.order)[0]!.sound!.loops, []);
    parses(state);
    // Within the allowance it stays.
    real.set("A-e1-2", facts(30_100));
    assert.equal(refillSoundFacts(remapped(), real).left, 1);
  });

  test("leaves out a sound whose row's facts do not check, and counts it", () => {
    // A bitrate no MP3 frame has, and a field the column never holds, fail the intake's own rule too (MUS-R1-07).
    const bad: unknown[] = [
      facts(60_000.5),
      facts(199),
      facts(15 * 60_000 + 1_001),
      facts(60_000, { channels: 4 as 1 }),
      facts(60_000, { kbps: 63 }),
      facts(60_000, { kbps: 193 }),
      facts(60_000, { kbps: 100 }),
      { ...facts(60_000), title: "Night" },
      { ms: "60000", channels: 2, kbps: 128 },
      { ms: 60_000, channels: 2, kbps: "128" },
      null,
      "facts",
    ];
    for (const row of bad) {
      const real = rows();
      real.set("A-m1-2", row as SoundFacts);
      assert.equal(refillSoundFacts(remapped(), real).left, 1, JSON.stringify(row));
    }
    const edges = rows();
    edges.set("A-m1-2", facts(15 * 60_000 + 100, { channels: 1, kbps: 64 }));
    edges.set("A-m2-2", facts(30_000, { kbps: 192 }));
    assert.equal(refillSoundFacts(remapped(), edges).left, 0, "the bounds themselves pass");
  });
});

describe("withoutSound (6.7), the export's, which the import uses", () => {
  test("leaves no sound, playlist, what plays, scene sound or names switch, and the room still parses", () => {
    const state = withoutSound(remapped());
    assert.deepEqual([state.sounds, state.playlists, state.playing], [{}, {}, null]);
    assert.equal("soundNames" in state.meta.settings, false);
    for (const scene of Object.values(state.scenes)) assert.equal("sound" in scene, false, scene.id);
    assert.doesNotMatch(JSON.stringify(state), /"(soundNames|sound)":/, "no other trace");
    parses(state);
    // The rest of the room is as it was.
    const { sounds: _s, playlists: _p, playing: _pl, ...rest } = remapped();
    assert.deepEqual(state.members, rest.members);
    assert.deepEqual(state.log, rest.log);
  });

  test("a room from before sound comes through as it was", () => {
    const old = room();
    assert.deepEqual(withoutSound(old), old);
  });
});
