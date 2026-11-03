import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { RoomState, Viewer } from "../model.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import type { Playlist, SceneSound, Sound, SoundUse } from "../sound.ts";
import { AT, member, room } from "../testutil.ts";
import { DEPENDED_ON, PARENT_GONE, restoreReferenceConflicts } from "./misc.ts";

/**
 * Undo setup meets the sound's typed references (docs/design/design-v1-sound.md
 * 6.6 and section 11), through the inverses the ops record and a restore
 * marked as the server marks its own.
 */

const A: Viewer = { memberId: "dmA", role: "dm" };
const B: Viewer = { memberId: "dmB", role: "dm" };
const BASE = Date.parse(AT);

function sound(id: string, use: SoundUse, ms: number, name: string): Sound {
  return { id, rev: 0, name, assetId: `file-${id}`, ms, use };
}

const TAVERN: Playlist = { id: "tavern", rev: 0, name: "Tavern night", sounds: ["m1", "m2", "m3"], repeat: "all", fade: 5 };

function soundRoom(sounds: Partial<Record<string, Sound>> = {}, scenes: Record<string, SceneSound> = {}): RoomState {
  const state = room({
    members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm"), p1: member("p1") },
    sounds: {
      m1: sound("m1", "music", 190_000, "Harbor"),
      m2: sound("m2", "music", 200_000, "Lanterns"),
      m3: sound("m3", "music", 180_000, "Last call"),
      solo: sound("solo", "music", 120_000, "Solo"),
      rain: sound("rain", "loop", 60_000, "Rain"),
      crowd: sound("crowd", "loop", 45_000, "Crowd"),
      wind: sound("wind", "loop", 30_000, "Wind"),
      thunder: sound("thunder", "effect", 25_000, "Thunder"),
      ...(sounds as Record<string, Sound>),
    },
    playlists: { tavern: TAVERN },
    playing: null,
  });
  for (const [id, value] of Object.entries(scenes)) state.scenes[id] = { ...state.scenes[id]!, sound: value };
  return state;
}

let seq = 0;
function run(state: RoomState, op: Op, who: Viewer = A): { state: RoomState; inverse: RestoreEntry[] } {
  seq++;
  const r = applyOp(state, op, who, { seq, at: new Date(BASE + seq * 1_000).toISOString() });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

/** An undo as the server builds it, marked so the reference checks apply, or a stored one from before without the mark. */
function undo(state: RoomState, entries: RestoreEntry[], deps = true) {
  seq++;
  return applyOp(state, { t: "sys.restore", entries, from: "undo", ...(deps ? { deps: true as const } : {}) }, A, { seq, at: new Date(BASE + seq * 1_000).toISOString() });
}

function refusedWith(state: RoomState, entries: RestoreEntry[], message: string): void {
  const r = undo(state, entries);
  assert.ok(!r.ok, "the undo is refused");
  assert.equal(r.message, message);
  assert.ok(undo(state, entries, false).ok, "a stored restore without the mark still replays");
}

function passes(state: RoomState, entries: RestoreEntry[]): RoomState {
  const r = undo(state, entries);
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

const playTavern: Op = { t: "music.play", run: "r1", playlistId: "tavern", order: ["m1", "m2", "m3"], repeat: "all", fade: 5 };

describe("Undo setup against what plays (6.6, section 11)", () => {
  test("undo of an Effect changed to Background now playing as a loop is refused in the panel's words, and passes once it stops", () => {
    const changed = run(soundRoom({ rain: sound("rain", "effect", 20_000, "Rain") }), { t: "sound.update", id: "rain", use: "loop" });
    const looping = run(changed.state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 });
    refusedWith(looping.state, changed.inverse, "Stop Rain first. It is playing as background.");
    assert.deepEqual(restoreReferenceConflicts(looping.state, changed.inverse), [], "no other work to undo first");
    const stopped = run(looping.state, { t: "loop.stop", id: "l1" });
    assert.equal(passes(stopped.state, changed.inverse).sounds!.rain?.use, "effect");
  });

  test("undo of a use change is refused while the run plays the sound as music, paused or not", () => {
    const changed = run(soundRoom({ solo: sound("solo", "loop", 120_000, "Solo") }), { t: "sound.update", id: "solo", use: "music" });
    const playing = run(changed.state, { t: "music.play", run: "r1", soundId: "solo", order: ["solo"], repeat: "one", fade: 0 });
    refusedWith(playing.state, changed.inverse, "Stop Solo first. It is playing as music.");
    const paused = run(playing.state, { t: "music.pause" });
    refusedWith(paused.state, changed.inverse, "Stop Solo first. It is playing as music.");
    assert.equal(passes(run(paused.state, { t: "music.stop" }).state, changed.inverse).sounds!.solo?.use, "loop");
  });

  test("an effect fired then given another use: its undo passes and leaves its entry as history, never firing it again", () => {
    const fired = run(soundRoom(), { t: "effect.fire", id: "e1", soundId: "thunder" });
    const changed = run(fired.state, { t: "sound.update", id: "thunder", use: "loop" });
    const back = passes(changed.state, changed.inverse);
    assert.equal(back.sounds!.thunder?.use, "effect");
    assert.equal(back.playing, changed.state.playing, "a restore never writes playing");
  });

  test("undo of a playlist delete after a volume change is allowed, and the run's label names it again", () => {
    const played = run(soundRoom({}, { s1: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 70 }] } }), playTavern);
    const deleted = run(played.state, { t: "playlist.delete", id: "tavern" });
    const mixed = run(deleted.state, { t: "sound.mix", music: 40 });
    const back = passes(mixed.state, deleted.inverse);
    assert.deepEqual({ ...back.playlists!.tavern!, rev: 0 }, TAVERN);
    assert.deepEqual(back.scenes.s1!.sound, played.state.scenes.s1!.sound);
    assert.equal(back.playing, mixed.state.playing, "the run is untouched");
    assert.equal(back.playing!.music?.playlistId, "tavern");
    assert.equal(back.playing!.volume.music, 40);
  });
});

describe("typed references, forward (6.6)", () => {
  test("undo of a track's removal from a playlist after that sound's delete is refused as a broken reference", () => {
    const removed = run(soundRoom(), { t: "playlist.update", id: "tavern", sounds: ["m1", "m2"] });
    const gone = run(removed.state, { t: "sound.delete", id: "m3" });
    refusedWith(gone.state, removed.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(gone.state, removed.inverse), [keys.sound("m3")]);
  });

  test("a restored playlist or scene sound naming a sound whose use changed since is refused as a broken reference", () => {
    const deleted = run(soundRoom(), { t: "playlist.delete", id: "tavern" });
    const changed = run(deleted.state, { t: "sound.update", id: "m2", use: "loop" });
    refusedWith(changed.state, deleted.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(changed.state, deleted.inverse), [keys.sound("m2")]);
    const scene = run(soundRoom({}, { s2: { music: null, loops: [{ soundId: "rain", volume: 40 }] } }), { t: "scene.delete", sceneId: "s2" });
    const rain = run(scene.state, { t: "sound.update", id: "rain", use: "music" });
    refusedWith(rain.state, scene.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(rain.state, scene.inverse), [keys.sound("rain")]);
    assert.ok(passes(scene.state, scene.inverse).scenes.s2, "with the use as it was, the scene comes back");
  });

  test("a restored scene sound naming a playlist or a sound deleted since is refused as a broken reference", () => {
    const byList = run(soundRoom({}, { s2: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [] } }), { t: "scene.delete", sceneId: "s2" });
    const listGone = run(byList.state, { t: "playlist.delete", id: "tavern" });
    refusedWith(listGone.state, byList.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(listGone.state, byList.inverse), [keys.playlist("tavern")]);
    const byTrack = run(soundRoom({}, { s2: { music: { soundId: "solo", repeat: "one", fade: 0 }, loops: [{ soundId: "wind", volume: 30 }] } }), { t: "scene.delete", sceneId: "s2" });
    const trackGone = run(byTrack.state, { t: "sound.delete", id: "solo" });
    refusedWith(trackGone.state, byTrack.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(trackGone.state, byTrack.inverse), [keys.sound("solo")]);
    const loopGone = run(byTrack.state, { t: "sound.delete", id: "wind" });
    refusedWith(loopGone.state, byTrack.inverse, PARENT_GONE);
    assert.deepEqual(restoreReferenceConflicts(loopGone.state, byTrack.inverse), [keys.sound("wind")]);
  });
});

describe("typed references, reverse (6.6)", () => {
  test("undo of a use change that took the sound out of two scenes puts them back together and passes, and so does its redo", () => {
    const scenes = { s1: { music: null, loops: [{ soundId: "rain", volume: 70 }] }, s2: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }, { soundId: "crowd", volume: 60 }] } } as const satisfies Record<string, SceneSound>;
    const state = soundRoom({}, scenes);
    const changed = run(state, { t: "sound.update", id: "rain", use: "music" });
    assert.deepEqual(changed.inverse.map((e) => e.key), [keys.sound("rain"), keys.scene("s1"), keys.scene("s2")]);
    assert.deepEqual(restoreReferenceConflicts(changed.state, changed.inverse), []);
    const r = undo(changed.state, changed.inverse);
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.equal(r.state.sounds!.rain?.use, "loop");
    assert.deepEqual(r.state.scenes.s1!.sound, scenes.s1);
    assert.deepEqual(r.state.scenes.s2!.sound, scenes.s2);
    const redo = applyOp(r.state, { t: "sys.restore", entries: r.inverse!, from: "redo", deps: true }, A, { seq: 900, at: AT });
    assert.ok(redo.ok, redo.ok ? "" : redo.message);
    assert.deepEqual(redo.state.scenes.s1!.sound!.loops, []);
    // Only the sound back, without the scenes it left: nothing names it as music, so nothing is left behind.
    assert.equal(passes(changed.state, changed.inverse.filter((e) => e.key === keys.sound("rain"))).sounds!.rain?.use, "loop");
  });

  test("undo of a use change is refused while another DM's playlist or scene names the sound under the use it has now", () => {
    const changed = run(soundRoom(), { t: "sound.update", id: "rain", use: "music" });
    const listed = run(changed.state, { t: "playlist.update", id: "tavern", sounds: ["m1", "m2", "m3", "rain"] }, B);
    refusedWith(listed.state, changed.inverse, DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(listed.state, changed.inverse), [keys.playlist("tavern")]);
    const scored = run(changed.state, { t: "scene.update", sceneId: "s2", patch: { sound: { music: { soundId: "rain", repeat: "one", fade: 0 }, loops: [] } } }, B);
    refusedWith(scored.state, changed.inverse, DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(scored.state, changed.inverse), [keys.scene("s2")]);
    const unlisted = run(listed.state, { t: "playlist.update", id: "tavern", sounds: ["m1", "m2", "m3"] }, B);
    assert.equal(passes(unlisted.state, changed.inverse).sounds!.rain?.use, "loop", "once it leaves them, the undo passes");
  });

  test("taking a playlist away is refused while a scene's sound names it, and a run's label never blocks", () => {
    const created = run(soundRoom(), { t: "playlist.create", id: "quiet", name: "Quiet", sounds: ["solo"], repeat: "off", fade: 0 });
    const scored = run(created.state, { t: "scene.update", sceneId: "s1", patch: { sound: { music: { playlistId: "quiet", repeat: "off", fade: 0 }, loops: [] } } }, B);
    refusedWith(scored.state, created.inverse, DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(scored.state, created.inverse), [keys.scene("s1")]);
    const playing = run(created.state, { t: "music.play", run: "r1", playlistId: "quiet", order: ["solo"], repeat: "off", fade: 0 }, B);
    const gone = passes(playing.state, created.inverse);
    assert.equal(gone.playlists!.quiet, undefined);
    assert.equal(gone.playing, playing.state.playing, "the run plays on, its playlistId a label");
    assert.equal(gone.playing!.music?.playlistId, "quiet");
  });

  test("a restore taking away a sound a playlist, a scene's sound or the live run names is refused, and an effect entry never blocks", () => {
    // No Setup step creates a sound, so only a hand-made restore takes one away. Unguarded, it always matches.
    const away = (id: string): RestoreEntry[] => [{ key: keys.sound(id), value: null }];
    const state = soundRoom({}, { s1: { music: null, loops: [{ soundId: "crowd", volume: 50 }] } });
    refusedWith(state, away("m1"), DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(state, away("m1")), [keys.playlist("tavern")]);
    refusedWith(state, away("crowd"), DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(state, away("crowd")), [keys.scene("s1")]);
    const solo = run(state, { t: "music.play", run: "r1", soundId: "solo", order: ["solo"], repeat: "one", fade: 0 }).state;
    refusedWith(solo, away("solo"), DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(solo, away("solo")), [keys.playing]);
    const wind = run(state, { t: "loop.start", id: "l1", soundId: "wind", volume: 70 }).state;
    refusedWith(wind, away("wind"), DEPENDED_ON);
    assert.deepEqual(restoreReferenceConflicts(wind, away("wind")), [keys.playing]);
    const fired = run(state, { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    assert.equal(passes(fired, away("thunder")).sounds!.thunder, undefined);
    assert.deepEqual(restoreReferenceConflicts(fired, away("thunder")), []);
  });
});
