import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied, type Env } from "../reducer.ts";
import type { FiredEffect, MusicRun, Playing, Playlist, SceneSound, Sound, SoundUse } from "../sound.ts";
import { AT, DM, member, room } from "../testutil.ts";
import { undoScope } from "../undoScope.ts";
import { SOUND_WORDS } from "./sound.ts";

/**
 * The sound reducer against docs/design/design-v1-music.md 6.3 and the
 * cases of section 11, each with the exact state it leaves.
 */

const BASE = Date.parse(AT);
/** Every start is the op's server time and the lead (D-261102-479). */
const LEAD = 400;
/** The server time an op `ms` after AT starts its sound at. */
const startAt = (ms: number) => BASE + ms + LEAD;
const S0 = startAt(0);

function envAt(ms: number, seq = 1): Env {
  return { seq, at: new Date(BASE + ms).toISOString() };
}

function step(state: RoomState, op: Op, ms = 0, who: Viewer = DM): Applied {
  const r = applyOp(state, op, who, envAt(ms));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r;
}

function refusal(state: RoomState, op: Op, ms = 0): string {
  const r = applyOp(state, op, DM, envAt(ms));
  assert.ok(!r.ok, `${op.t} is refused`);
  return r.message;
}

function sound(id: string, use: SoundUse, ms: number, name: string): Sound {
  return { id, rev: 0, name, assetId: `file-${id}`, ms, use };
}

const LIBRARY: Record<string, Sound> = {
  m1: sound("m1", "music", 190_000, "Harbor"),
  m2: sound("m2", "music", 200_000, "Lanterns"),
  m3: sound("m3", "music", 180_000, "Last call"),
  rain: sound("rain", "loop", 60_000, "Rain"),
  crowd: sound("crowd", "loop", 45_000, "Crowd"),
  wind: sound("wind", "loop", 30_000, "Wind"),
  fire: sound("fire", "loop", 20_000, "Fire"),
  birds: sound("birds", "loop", 40_000, "Birds"),
  thunder: sound("thunder", "effect", 25_000, "Thunder"),
  door: sound("door", "effect", 1_000, "Door"),
};

const TAVERN: Playlist = { id: "tavern", rev: 0, name: "Tavern night", sounds: ["m1", "m2", "m3"], repeat: "all", fade: 5 };

function soundRoom(overrides: Partial<RoomState> = {}): RoomState {
  return room({ sounds: { ...LIBRARY }, playlists: { tavern: TAVERN }, playing: null, ...overrides });
}

/** The room's scenes with these sounds. */
function withSceneSounds(state: RoomState, sounds: Record<string, SceneSound>): RoomState {
  const scenes = { ...state.scenes };
  for (const [id, sound] of Object.entries(sounds)) scenes[id] = { ...scenes[id]!, sound };
  return { ...state, scenes };
}

const playTavern: Op = { t: "music.play", run: "r1", playlistId: "tavern", order: ["m1", "m2", "m3"], repeat: "all", fade: 5 };
const tavernRun: MusicRun = { run: "r1", playlistId: "tavern", order: ["m1", "m2", "m3"], index: 0, repeat: "all", fade: 5, now: { soundId: "m1", at: S0 } };
const FULL = { music: 100, effects: 100 };

function playing(state: RoomState): Playing {
  assert.ok(state.playing, "something plays");
  return state.playing;
}

describe("the library (6.3)", () => {
  test("a create holds each use to its lengths, the upper caps with the 100 ms allowance", () => {
    const create = (id: string, use: SoundUse, ms: number, level?: number): Op => ({ t: "sound.create", id, assetId: `file-${id}`, name: "Boom", use, ms, ...(level !== undefined ? { level } : {}) });
    const effect = step(soundRoom(), create("boom", "effect", 30_000, 0)).state;
    assert.deepEqual(effect.sounds!.boom, { id: "boom", rev: 1, name: "Boom", assetId: "file-boom", ms: 30_000, use: "effect" }, "a level of 0 is stored as none");
    assert.deepEqual(step(soundRoom(), create("long", "music", 900_100, -35)).state.sounds!.long, { id: "long", rev: 1, name: "Boom", assetId: "file-long", ms: 900_100, use: "music", level: -35 });
    assert.equal(refusal(soundRoom(), create("x", "effect", 30_101)), "Effects are 30 seconds at most.");
    assert.equal(refusal(soundRoom(), create("x", "music", 900_101)), "Music is 15 minutes at most.");
    assert.equal(refusal(soundRoom(), create("x", "music", 29_999)), "Music is 30 seconds at least.");
    assert.equal(refusal(soundRoom(), create("x", "loop", 1_999)), "Background sounds are 2 seconds at least.");
    assert.equal(refusal(soundRoom(), create("x", "loop", 900_101)), "Background sounds are 15 minutes at most.");
    assert.equal(refusal(soundRoom(), create("rain", "loop", 60_000)), "sound already exists");
  });

  test("the library keeps 300 sounds and 30 playlists at most", () => {
    const library = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, sound(`s${i}`, "music", 60_000, `Track ${i}`)]));
    const create: Op = { t: "sound.create", id: "new", assetId: "file-new", name: "New", use: "music", ms: 60_000 };
    assert.equal(refusal(room({ sounds: library(300) }), create), "The room keeps 300 sounds at most. Delete one first.");
    assert.equal(step(room({ sounds: library(299) }), create).state.sounds!.new?.id, "new");
    const lists = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { ...TAVERN, id: `p${i}` }]));
    const newList: Op = { t: "playlist.create", id: "new", name: "New", sounds: ["m1"], repeat: "all", fade: 5 };
    assert.equal(refusal(soundRoom({ playlists: lists(30) }), newList), "The room keeps 30 playlists at most. Delete one first.");
    assert.equal(step(soundRoom({ playlists: lists(29) }), newList).state.playlists!.new?.id, "new");
  });

  test("a rename changes the name alone, even while the sound plays", () => {
    const looping = step(soundRoom(), { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    const r = step(looping, { t: "sound.update", id: "rain", name: "Storm" });
    assert.deepEqual(r.state.sounds!.rain, { ...LIBRARY.rain!, name: "Storm", rev: 1 });
    assert.deepEqual(r.touched, [keys.sound("rain")]);
  });

  test("a change of use is refused while the run's order or a loop names the sound, paused included, and for a length the use does not take", () => {
    const state = step(step(soundRoom(), playTavern).state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    assert.equal(refusal(state, { t: "sound.update", id: "m1", use: "loop" }), "This track is playing. Skip it or stop the music first.");
    assert.equal(refusal(state, { t: "sound.update", id: "m3", use: "loop" }), "This track is in the queue. Take it out under Up next first.", "a later track of the order");
    // From the reveal at 165 s m2 plays next, and from its start at 185 s it is the playing track.
    assert.equal(refusal(state, { t: "sound.update", id: "m2", use: "loop" }, 170_000), "This track plays next. Take it out of Up next first.");
    assert.equal(refusal(state, { t: "sound.update", id: "m2", use: "loop" }, 187_000), SOUND_WORDS.trackPlays, "the incoming track of a crossfade");
    assert.equal(refusal(state, { t: "sound.update", id: "m1", use: "loop" }, 187_000), SOUND_WORDS.trackQueued, "the outgoing one");
    assert.equal(refusal(state, { t: "sound.update", id: "rain", use: "music" }), "Stop it first. It is playing now.");
    const paused = step(state, { t: "music.pause" }, 10_000).state;
    assert.equal(refusal(paused, { t: "sound.update", id: "m2", use: "loop" }), SOUND_WORDS.trackQueued);
    assert.equal(refusal(soundRoom(), { t: "sound.update", id: "m1", use: "effect" }), "Effects are 30 seconds at most.");
    assert.equal(refusal(soundRoom(), { t: "sound.update", id: "door", use: "loop" }), "Background sounds are 2 seconds at least.");
  });

  test("an effect fired and given another use leaves its entry as history, and playing is not written", () => {
    const fired = step(soundRoom(), { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    const r = step(fired, { t: "sound.update", id: "thunder", use: "loop" }, 1_000);
    assert.equal(r.state.sounds!.thunder?.use, "loop");
    assert.equal(r.state.playing, fired.playing);
    assert.deepEqual(r.touched, [keys.sound("thunder")]);
  });

  test("a change of use takes the sound out of every playlist and scene sound it no longer fits, in the same op", () => {
    const quiet: Playlist = { id: "quiet", rev: 0, name: "Quiet", sounds: ["m3", "m1"], repeat: "off", fade: 0 };
    const state = withSceneSounds(soundRoom({ playlists: { tavern: TAVERN, quiet } }), {
      s1: { music: { soundId: "m3", repeat: "one", fade: 0 }, loops: [{ soundId: "rain", volume: 70 }] },
      s2: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }, { soundId: "crowd", volume: 60 }] },
    });
    const track = step(state, { t: "sound.update", id: "m3", use: "loop" });
    assert.deepEqual(track.touched, [keys.sound("m3"), keys.playlist("quiet"), keys.playlist("tavern"), keys.scene("s1")]);
    assert.deepEqual(track.state.playlists, { quiet: { ...quiet, sounds: ["m1"], rev: 1 }, tavern: { ...TAVERN, sounds: ["m1", "m2"], rev: 1 } });
    assert.deepEqual(track.state.scenes.s1!.sound, { music: null, loops: [{ soundId: "rain", volume: 70 }] });
    assert.equal(track.state.scenes.s2, state.scenes.s2, "a scene playing the playlist keeps it");
    // Rain changed to Music while two scenes name it (section 11): it leaves both in the same op.
    const rain = step(state, { t: "sound.update", id: "rain", use: "music" });
    assert.deepEqual(rain.touched, [keys.sound("rain"), keys.scene("s1"), keys.scene("s2")]);
    assert.deepEqual(rain.state.scenes.s1!.sound, { music: { soundId: "m3", repeat: "one", fade: 0 }, loops: [] });
    assert.deepEqual(rain.state.scenes.s2!.sound, { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "crowd", volume: 60 }] });
    assert.equal(rain.state.playlists, state.playlists, "music joins no playlist by itself");
  });
});

describe("deleting a sound (6.3, section 11)", () => {
  test("a sounding effect deletes at once, and its entries leave both effect lists", () => {
    let state = step(soundRoom(), { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    state = step(state, { t: "effect.fire", id: "e2", soundId: "door" }, 100).state;
    state = step(state, { t: "view.blackout", blackout: true }, 150).state;
    state = step(state, { t: "effect.fire", id: "e3", soundId: "thunder" }, 200).state;
    assert.equal(playing(state).dmEffects?.length, 1);
    const r = step(state, { t: "sound.delete", id: "thunder" }, 1_000);
    assert.equal(r.state.sounds!.thunder, undefined);
    assert.deepEqual(r.state.playing, { rev: 4, music: null, loops: {}, effects: [{ id: "e2", soundId: "door", at: startAt(100) }], volume: FULL });
  });

  test("a playing loop, the playing track and the revealed next are refused in the panel's words", () => {
    const state = step(step(soundRoom(), playTavern).state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    assert.equal(refusal(state, { t: "sound.delete", id: "rain" }), "Stop it first. It is playing now.");
    assert.equal(refusal(state, { t: "sound.delete", id: "m1" }), "This track is playing. Skip it or stop the music first.");
    assert.equal(refusal(state, { t: "sound.delete", id: "m2" }, 170_000), "This track plays next. Take it out of Up next first.");
    assert.equal(refusal(state, { t: "sound.delete", id: "ghost" }), "sound is not here");
  });

  test("a sound in two playlists and a scene leaves all of them in one op", () => {
    const quiet: Playlist = { id: "quiet", rev: 0, name: "Quiet", sounds: ["m3", "m1"], repeat: "off", fade: 0 };
    const state = withSceneSounds(soundRoom({ playlists: { tavern: TAVERN, quiet } }), {
      s1: { music: { soundId: "m3", repeat: "one", fade: 0 }, loops: [{ soundId: "crowd", volume: 50 }] },
      s2: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }, { soundId: "crowd", volume: 60 }] },
    });
    const r = step(state, { t: "sound.delete", id: "m3" });
    assert.deepEqual(r.touched, [keys.sound("m3"), keys.playlist("quiet"), keys.playlist("tavern"), keys.scene("s1")]);
    assert.deepEqual(r.state.playlists, { quiet: { ...quiet, sounds: ["m1"], rev: 1 }, tavern: { ...TAVERN, sounds: ["m1", "m2"], rev: 1 } });
    assert.deepEqual(r.state.scenes.s1!.sound, { music: null, loops: [{ soundId: "crowd", volume: 50 }] });
    assert.equal(undoScope({ t: "sound.delete", id: "m3" }, state), "none", "a delete records no step (D-261102-471)");
    const loop = step(state, { t: "sound.delete", id: "crowd" });
    assert.deepEqual(loop.state.scenes.s1!.sound!.loops, []);
    assert.deepEqual(loop.state.scenes.s2!.sound!.loops, [{ soundId: "rain", volume: 40 }]);
  });
});

describe("playlists (6.3)", () => {
  test("a playlist's tracks are music sounds of the library, at its create and at its update", () => {
    const create = (sounds: string[], shuffle?: true): Op => ({ t: "playlist.create", id: "quiet", name: "Quiet", sounds, repeat: "off", fade: 2, ...(shuffle ? { shuffle } : {}) });
    assert.equal(refusal(soundRoom(), create(["m1", "rain"])), "That track isn't in the music any more.");
    assert.equal(refusal(soundRoom(), create(["m1", "ghost"])), SOUND_WORDS.notMusic);
    assert.equal(refusal(soundRoom(), { t: "playlist.create", id: "tavern", name: "Again", sounds: [], repeat: "all", fade: 5 }), "playlist already exists");
    const made = step(soundRoom(), create(["m3", "m1"], true)).state;
    assert.deepEqual(made.playlists!.quiet, { id: "quiet", rev: 1, name: "Quiet", sounds: ["m3", "m1"], repeat: "off", fade: 2, shuffle: true });
    assert.equal(refusal(made, { t: "playlist.update", id: "quiet", sounds: ["m3", "m1", "thunder"] }), SOUND_WORDS.notMusic);
    const changed = step(made, { t: "playlist.update", id: "quiet", sounds: ["m1", "m2", "m3"], shuffle: false, repeat: "one", fade: 10, name: "Calm" }).state;
    assert.deepEqual(changed.playlists!.quiet, { id: "quiet", rev: 2, name: "Calm", sounds: ["m1", "m2", "m3"], repeat: "one", fade: 10 });
    assert.equal(refusal(made, { t: "playlist.update", id: "gone", name: "X" }), "playlist is not here");
  });

  test("a playlist's delete clears the music of every scene sound naming it, and a run keeps its id as a label", () => {
    const state = withSceneSounds(step(soundRoom(), playTavern).state, {
      s1: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 70 }] },
      s2: { music: { soundId: "m1", repeat: "one", fade: 0 }, loops: [] },
    });
    const r = step(state, { t: "playlist.delete", id: "tavern" }, 5_000);
    assert.deepEqual(r.touched, [keys.scene("s1"), keys.playlist("tavern")]);
    assert.deepEqual(r.state.playlists, {});
    assert.deepEqual(r.state.scenes.s1!.sound, { music: null, loops: [{ soundId: "rain", volume: 70 }] });
    assert.equal(r.state.scenes.s2, state.scenes.s2);
    assert.equal(r.state.playing, state.playing, "playing is not written");
    assert.equal(playing(r.state).music?.playlistId, "tavern");
  });
});

describe("music (6.3)", () => {
  test("a play compares its order with the playlist: the same tracks each once, each a music sound, or the one track alone", () => {
    const play = (fields: Partial<Extract<Op, { t: "music.play" }>>): Op => ({ ...(playTavern as Extract<Op, { t: "music.play" }>), ...fields });
    const r = step(soundRoom(), play({ order: ["m2", "m3", "m1"], index: 1, repeat: "off", fade: 2 }));
    assert.deepEqual(r.state.playing, {
      rev: 1,
      music: { run: "r1", playlistId: "tavern", order: ["m2", "m3", "m1"], index: 1, repeat: "off", fade: 2, now: { soundId: "m3", at: S0 } },
      loops: {},
      effects: [],
      volume: FULL,
    });
    assert.deepEqual(r.touched, [keys.playing]);
    assert.equal(refusal(soundRoom(), play({ order: ["m1", "m2"] })), "The playlist changed. Try again.");
    assert.equal(refusal(soundRoom(), play({ order: ["m1", "m2", "rain"] })), SOUND_WORDS.orderChanged);
    assert.equal(refusal(soundRoom(), play({ order: ["m1", "m2", "m3", "rain"] })), SOUND_WORDS.orderChanged);
    assert.equal(refusal(soundRoom(), play({ order: ["m1", "m1", "m2"] })), SOUND_WORDS.orderChanged, "each track once");
    // A playlist naming a track that is no longer music, as no op leaves one, still plays only music.
    const stale = soundRoom({ playlists: { tavern: { ...TAVERN, sounds: ["m1", "m2", "door"] } } });
    assert.equal(refusal(stale, play({ order: ["door", "m1", "m2"] })), SOUND_WORDS.notMusic);
    assert.equal(refusal(soundRoom({ playlists: {} }), play({})), "playlist is not here");
    const one: Op = { t: "music.play", run: "r2", soundId: "m2", order: ["m2"], repeat: "one", fade: 0 };
    assert.deepEqual(step(soundRoom(), one, 500).state.playing!.music, { run: "r2", order: ["m2"], index: 0, repeat: "one", fade: 0, now: { soundId: "m2", at: startAt(500) } });
    assert.equal(refusal(soundRoom(), { ...one, order: ["m1"] } as Op), "one track plays alone");
    assert.equal(refusal(soundRoom(), { ...one, soundId: "rain", order: ["rain"] } as Op), SOUND_WORDS.notMusic);
  });

  test("pause, resume, skip, set and stop land at exact times, each a lead after its op", () => {
    const played = step(soundRoom(), playTavern).state;
    const paused = step(played, { t: "music.pause" }, 60_000);
    assert.deepEqual(paused.state.playing!.music, { ...tavernRun, paused: 60_000 });
    const again = step(paused.state, { t: "music.pause" }, 70_000);
    assert.deepEqual(again.touched, [], "a pause of a paused run writes nothing");
    const resumed = step(paused.state, { t: "music.resume", run: "r2" }, 120_000).state;
    assert.deepEqual(resumed.playing!.music, { ...tavernRun, run: "r2", now: { soundId: "m1", at: S0 + 60_000 } }, "every device resumes at the same place");
    const skipped = step(resumed, { t: "music.skip", run: "r3" }, 130_000).state;
    assert.deepEqual(skipped.playing!.music, { ...tavernRun, run: "r3", index: 1, now: { soundId: "m2", at: S0 + 130_000 } });
    const stopped = step(skipped, { t: "music.stop" }, 150_000).state;
    assert.deepEqual(stopped.playing, { rev: 5, music: null, loops: {}, effects: [], volume: FULL });
    assert.deepEqual(step(stopped, { t: "music.stop" }, 160_000).touched, [], "a stop of no run writes nothing");
    for (const op of [{ t: "music.pause" }, { t: "music.resume", run: "r4" }, { t: "music.skip", run: "r4" }, { t: "music.set", fade: 2 }] as Op[]) {
      assert.equal(refusal(stopped, op, 170_000), "Nothing is playing.", op.t);
    }
  });

  test("a resume near a track's end reveals its next at once, and a skip past the last track with Repeat off ends the run", () => {
    const paused = step(step(soundRoom(), playTavern).state, { t: "music.pause" }, 180_000).state;
    assert.deepEqual(paused.playing!.music, { ...tavernRun, paused: 180_000 }, "the revealed next is dropped");
    const resumed = step(paused, { t: "music.resume", run: "r2" }, 300_000).state;
    assert.deepEqual(resumed.playing!.music, { ...tavernRun, run: "r2", now: { soundId: "m1", at: S0 + 120_000 }, next: { soundId: "m2", at: S0 + 305_000 } });
    const last = step(soundRoom(), { ...playTavern, index: 2, repeat: "off" } as Op).state;
    assert.equal(step(last, { t: "music.skip", run: "r2" }, 1_000).state.playing!.music, null);
  });

  test("a change of repeat or crossfade keeps the place heard, and the next track follows this pass", () => {
    const played = step(soundRoom(), playTavern).state;
    // At 170 s the reveal (at 165 s) has placed m2 at 185 s.
    const one = step(played, { t: "music.set", repeat: "one" }, 170_000).state;
    assert.deepEqual(one.playing!.music, { ...tavernRun, repeat: "one" }, "Repeat one has no next");
    const longer = step(played, { t: "music.set", fade: 10 }, 170_000).state;
    assert.deepEqual(longer.playing!.music, { ...tavernRun, fade: 10, next: { soundId: "m2", at: S0 + 180_000 } });
    assert.deepEqual(step(played, { t: "music.set", fade: 5 }, 10_000).touched, [], "the same settings write nothing");
    // Past the reveal the same settings leave the run as the schedule has it then, which a tick would store anyway.
    assert.deepEqual(step(played, { t: "music.set", fade: 5 }, 170_000).state.playing!.music, { ...tavernRun, next: { soundId: "m2", at: S0 + 185_000 } });
  });

  test("during a crossfade every music op promotes the incoming track first, which keeps its own place", () => {
    const played = step(soundRoom(), playTavern).state;
    // m1 is revealed at 165 s, m2 starts at 185 s, and the crossing ends at 190 s.
    const promoted = { ...tavernRun, index: 1, now: { soundId: "m2", at: S0 + 185_000 } };
    assert.deepEqual(step(played, { t: "music.pause" }, 187_000).state.playing!.music, { ...promoted, paused: 2_000 });
    assert.deepEqual(step(played, { t: "music.skip", run: "r2" }, 187_000).state.playing!.music, { ...tavernRun, run: "r2", index: 2, now: { soundId: "m3", at: S0 + 187_000 } }, "a skip goes past the incoming track");
    assert.deepEqual(step(played, { t: "music.set", fade: 10 }, 187_000).state.playing!.music, { ...promoted, fade: 10 });
  });
});

describe("background sounds (6.3)", () => {
  test("a loop starts a lead after its op, a fifth is refused in the panel's words, and so is a sound already looping", () => {
    let state = soundRoom();
    for (const [i, id] of ["rain", "crowd", "wind", "fire"].entries()) state = step(state, { t: "loop.start", id: `l${i}`, soundId: id, volume: 70 }, i * 1_000).state;
    assert.deepEqual(playing(state).loops, {
      l0: { soundId: "rain", at: S0, volume: 70 },
      l1: { soundId: "crowd", at: S0 + 1_000, volume: 70 },
      l2: { soundId: "wind", at: S0 + 2_000, volume: 70 },
      l3: { soundId: "fire", at: S0 + 3_000, volume: 70 },
    });
    assert.equal(refusal(state, { t: "loop.start", id: "l4", soundId: "birds", volume: 70 }), "Up to four background sounds can play at once. Stop one first.");
    assert.equal(refusal(state, { t: "loop.start", id: "l4", soundId: "rain", volume: 70 }), "That background sound is already playing.");
    assert.equal(refusal(soundRoom(), { t: "loop.start", id: "l0", soundId: "thunder", volume: 70 }), SOUND_WORDS.notLoop);
    assert.equal(refusal(soundRoom(), { t: "loop.start", id: "constructor", soundId: "rain", volume: 70 }), "that id is reserved");
  });

  test("a loop's volume is set in place, and a stop takes it out, twice writing nothing", () => {
    const state = step(soundRoom(), { t: "loop.start", id: "l0", soundId: "rain", volume: 70 }).state;
    const set = step(state, { t: "loop.set", id: "l0", volume: 30 }, 5_000).state;
    assert.deepEqual(playing(set).loops, { l0: { soundId: "rain", at: S0, volume: 30 } });
    assert.deepEqual(step(set, { t: "loop.set", id: "l0", volume: 30 }, 6_000).touched, []);
    assert.equal(refusal(set, { t: "loop.set", id: "l9", volume: 30 }), "that background sound is not here");
    const stopped = step(set, { t: "loop.stop", id: "l0" }, 7_000).state;
    assert.deepEqual(stopped.playing, { rev: 3, music: null, loops: {}, effects: [], volume: FULL });
    assert.deepEqual(step(stopped, { t: "loop.stop", id: "l0" }, 8_000).touched, []);
  });
});

describe("effects (6.3, MUS-OPUS-41)", () => {
  test("firing 9 more effects 200 ms apart never cuts a 25 s effect: the newest 8 are kept, and older ones while they sound", () => {
    let state = step(soundRoom(), { t: "effect.fire", id: "e0", soundId: "thunder" }).state;
    for (let k = 1; k <= 9; k++) state = step(state, { t: "effect.fire", id: `d${k}`, soundId: "door" }, k * 200).state;
    const door = (k: number): FiredEffect => ({ id: `d${k}`, soundId: "door", at: startAt(k * 200) });
    // d1 ended at 1.6 s, before d9 fired at 2.2 s. Thunder sounds until 25.4 s.
    assert.deepEqual(playing(state).effects, [{ id: "e0", soundId: "thunder", at: S0 }, door(2), door(3), door(4), door(5), door(6), door(7), door(8), door(9)]);
  });

  test("an effect list holds 16 at most, the newest", () => {
    let state = soundRoom();
    for (let k = 0; k < 20; k++) state = step(state, { t: "effect.fire", id: `e${k}`, soundId: "thunder" }, k * 200).state;
    assert.deepEqual(
      playing(state).effects.map((e) => e.id),
      Array.from({ length: 16 }, (_, i) => `e${i + 4}`),
    );
  });

  test("behind a blackout an effect goes to the DM's list alone, a built-in too", () => {
    const fired = step(soundRoom(), { t: "effect.fire", id: "e0", soundId: "door" }).state;
    const dark = step(fired, { t: "view.blackout", blackout: true }, 100).state;
    const r = step(step(dark, { t: "effect.fire", id: "e1", soundId: "thunder" }, 200).state, { t: "effect.fire", id: "b1", builtin: "crash" }, 300);
    assert.deepEqual(r.state.playing, {
      rev: 3,
      music: null,
      loops: {},
      effects: [{ id: "e0", soundId: "door", at: S0 }],
      dmEffects: [
        { id: "e1", soundId: "thunder", at: startAt(200) },
        { id: "b1", builtin: "crash", at: startAt(300) },
      ],
      volume: FULL,
    });
  });

  test("an id fired twice and a sound that is not an effect are refused", () => {
    const fired = step(soundRoom(), { t: "effect.fire", id: "e0", soundId: "door" }).state;
    assert.equal(refusal(fired, { t: "effect.fire", id: "e0", builtin: "click" }), "That effect was already played.");
    assert.equal(refusal(fired, { t: "effect.fire", id: "e1", soundId: "rain" }), "That effect isn't in the room any more.");
    assert.equal(refusal(fired, { t: "effect.fire", id: "e1", soundId: "ghost" }), SOUND_WORDS.notEffect);
  });
});

describe("the room's volumes, a scene's sound and Stop all (6.3, 4.6)", () => {
  test("sound.mix sets the room's volumes and writes nothing when they are the same", () => {
    const mixed = step(soundRoom(), { t: "sound.mix", music: 40 }).state;
    assert.deepEqual(mixed.playing, { rev: 1, music: null, loops: {}, effects: [], volume: { music: 40, effects: 100 } });
    assert.deepEqual(step(mixed, { t: "sound.mix", music: 40, effects: 100 }).touched, []);
    assert.deepEqual(playing(step(mixed, { t: "sound.mix", effects: 20 }).state).volume, { music: 40, effects: 20 });
  });

  const A: Viewer = { memberId: "dmA", role: "dm" };
  const B: Viewer = { memberId: "dmB", role: "dm" };
  function scenesWithSound(): RoomState {
    const state = soundRoom({ members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm"), p1: member("p1") } });
    return withSceneSounds(state, {
      s1: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 70 }] },
      s2: { music: { soundId: "m2", repeat: "one", fade: 0 }, loops: [{ soundId: "crowd", volume: 50 }] },
    });
  }
  const sceneA: Op = { t: "sound.scene", sceneId: "s1", run: "ra", order: ["m1", "m2", "m3"], onMove: true };
  const sceneB: Op = { t: "sound.scene", sceneId: "s2", run: "rb", order: ["m2"], onMove: true };
  const soundOfA: Playing = {
    rev: 1,
    music: { run: "ra", playlistId: "tavern", order: ["m1", "m2", "m3"], index: 0, repeat: "all", fade: 5, now: { soundId: "m1", at: startAt(100) } },
    loops: { "ra-0": { soundId: "rain", at: startAt(100), volume: 70 } },
    effects: [],
    volume: FULL,
  };
  const soundOfB = (rev: number): Playing => ({
    rev,
    music: { run: "rb", order: ["m2"], index: 0, repeat: "one", fade: 0, now: { soundId: "m2", at: startAt(200) } },
    loops: { "rb-0": { soundId: "crowd", at: startAt(200), volume: 50 } },
    effects: [],
    volume: FULL,
  });

  test("with onMove a scene's sound plays only while the players are on that scene, and a scene with none plays nothing", () => {
    const state = scenesWithSound();
    const elsewhere = step(state, sceneB, 100, A);
    assert.deepEqual(elsewhere.touched, [], "refused silently");
    assert.equal(elsewhere.state.playing, null);
    assert.deepEqual(step(state, { ...sceneB, onMove: undefined } as Op, 200).state.playing, soundOfB(1), "Play it plays it wherever the players are");
    const silent = soundRoom();
    assert.deepEqual(step(silent, { t: "sound.scene", sceneId: "s1", run: "r1", order: [] }).touched, []);
    assert.equal(refusal(state, { t: "sound.scene", sceneId: "gone", run: "r1", order: [] }), "scene is not here");
  });

  test("two DMs move the players to A and to B at once: B's sound plays only if the players end on B", () => {
    const moveTo = (sceneId: string): Op => ({ t: "room.setPlayerScene", sceneId });
    // Both moves land before either scene's sound: only the scene the players end on plays.
    let endB = step(step(scenesWithSound(), moveTo("s1"), 0, A).state, moveTo("s2"), 0, B).state;
    endB = step(endB, sceneA, 100, A).state;
    assert.equal(endB.playing, null, "A's sound is refused once the players are on B");
    assert.deepEqual(step(endB, sceneB, 200, B).state.playing, soundOfB(1));
    let endA = step(step(scenesWithSound(), moveTo("s2"), 0, B).state, moveTo("s1"), 0, A).state;
    endA = step(endA, { ...sceneB }, 200, B).state;
    assert.equal(endA.playing, null);
    assert.deepEqual(step(endA, sceneA, 100, A).state.playing, soundOfA);
    // Each scene's sound right after its move: B's replaces A's, so the last move wins.
    let interleaved = step(scenesWithSound(), moveTo("s1"), 0, A).state;
    interleaved = step(interleaved, sceneA, 100, A).state;
    interleaved = step(step(interleaved, moveTo("s2"), 150, B).state, sceneB, 200, B).state;
    assert.deepEqual(interleaved.playing, soundOfB(2));
  });

  test("a scene's sound replaces what plays: the same playlist plays on, the same loops keep their at at the scene's volumes, the rest stop and new ones start", () => {
    let state = step(soundRoom(), playTavern).state;
    state = step(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    state = step(state, { t: "loop.start", id: "l2", soundId: "wind", volume: 50 }).state;
    state = withSceneSounds(state, { s2: { music: { playlistId: "tavern", repeat: "off", fade: 2 }, loops: [{ soundId: "rain", volume: 30 }, { soundId: "crowd", volume: 60 }] } });
    const r = step(state, { t: "sound.scene", sceneId: "s2", run: "r9", order: ["m3", "m2", "m1"] }, 10_000);
    assert.deepEqual(r.state.playing, {
      rev: 4,
      music: tavernRun,
      loops: { l1: { soundId: "rain", at: S0, volume: 30 }, "r9-0": { soundId: "crowd", at: S0 + 10_000, volume: 60 } },
      effects: [],
      volume: FULL,
    });
    // Another playlist or a single track starts a run from the order the DM's device fixed. No music is silence.
    const other = withSceneSounds(state, { s2: { music: { soundId: "m3", repeat: "one", fade: 0 }, loops: [] } });
    assert.deepEqual(step(other, { t: "sound.scene", sceneId: "s2", run: "r9", order: ["m3"] }, 10_000).state.playing!.music, {
      run: "r9",
      order: ["m3"],
      index: 0,
      repeat: "one",
      fade: 0,
      now: { soundId: "m3", at: S0 + 10_000 },
    });
    const quiet = withSceneSounds(state, { s2: { music: null, loops: [] } });
    assert.deepEqual(step(quiet, { t: "sound.scene", sceneId: "s2", run: "r9", order: [] }, 10_000).state.playing, { rev: 4, music: null, loops: {}, effects: [], volume: FULL });
    const changed = withSceneSounds(state, { s2: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [] } });
    const emptied = { ...changed, playlists: { tavern: { ...TAVERN, sounds: [] } }, playing: { ...playing(changed), music: null } };
    assert.equal(step(emptied, { t: "sound.scene", sceneId: "s2", run: "r9", order: [] }, 10_000).state.playing!.music, null, "a playlist left with no tracks is silence");
  });

  test("Stop all clears music, loops and both effect lists, and writes nothing when all is quiet", () => {
    let state = step(soundRoom(), playTavern).state;
    state = step(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    state = step(state, { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    state = step(step(state, { t: "view.blackout", blackout: true }).state, { t: "effect.fire", id: "e2", soundId: "door" }).state;
    const stopped = step(state, { t: "sound.stopAll" }, 1_000).state;
    assert.deepEqual(stopped.playing, { rev: 5, music: null, loops: {}, effects: [], volume: FULL });
    assert.deepEqual(step(stopped, { t: "sound.stopAll" }, 2_000).touched, []);
  });
});

describe("the server's step (6.4)", () => {
  test("sys.sound refuses a stale from, and takes the run it carries, its loops and effects cleared when it says so", () => {
    let state = step(soundRoom(), playTavern).state;
    state = step(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    state = step(state, { t: "effect.fire", id: "e1", soundId: "door" }).state;
    const revealed: MusicRun = { ...tavernRun, next: { soundId: "m2", at: S0 + 185_000 } };
    assert.equal(refusal(state, { t: "sys.sound", from: 2, music: revealed as never }), "the sound changed since this step was worked out");
    const r = step(state, { t: "sys.sound", from: 3, music: revealed as never }, 165_000);
    assert.deepEqual(r.state.playing, { ...playing(state), rev: 4, music: revealed });
    const silent = step(state, { t: "sys.sound", from: 3, music: null, loops: {}, effects: [] }, 900_000);
    assert.deepEqual(silent.state.playing, { rev: 4, music: null, loops: {}, effects: [], volume: FULL });
  });
});

describe("no Setup op writes playing (D-261102-471)", () => {
  test("every Setup op in a room that plays leaves playing the same object, out of its touched keys and its undo", () => {
    let state = withSceneSounds(soundRoom(), { s1: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "crowd", volume: 50 }] } });
    state = step(state, playTavern).state;
    state = step(state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }).state;
    state = step(state, { t: "effect.fire", id: "e1", soundId: "thunder" }).state;
    state = step(step(state, { t: "view.blackout", blackout: true }).state, { t: "effect.fire", id: "e2", soundId: "door" }).state;
    state = step(state, { t: "view.blackout", blackout: false }).state;
    const setup: Op[] = [
      { t: "sound.update", id: "rain", name: "Storm" },
      { t: "sound.update", id: "thunder", use: "loop" },
      { t: "sound.update", id: "door", use: "effect", name: "Creak" },
      { t: "sound.update", id: "crowd", use: "music" },
      { t: "playlist.create", id: "quiet", name: "Quiet", sounds: ["m3"], repeat: "off", fade: 0 },
      { t: "playlist.update", id: "tavern", sounds: ["m3", "m2", "m1"], shuffle: true },
      { t: "playlist.delete", id: "tavern" },
      { t: "scene.update", sceneId: "s2", patch: { sound: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 40 }] } } },
      { t: "scene.update", sceneId: "s1", patch: { sound: null } },
      { t: "room.update", settings: { soundNames: true } },
      { t: "room.update", settings: { soundDmOnly: true } },
    ];
    for (const op of setup) {
      assert.equal(undoScope(op, state), "setup", op.t);
      const r = step(state, op, 30_000);
      assert.equal(r.state.playing, state.playing, `${op.t} leaves playing as it was`);
      assert.ok(!r.touched.includes(keys.playing), `${op.t} touches no playing`);
      assert.ok(r.inverse && !r.inverse.some((e) => e.key === keys.playing), `${op.t}'s undo puts no playing back`);
    }
  });
});

describe("the queue's ops (docs/design/design-v1-music-player.md 6.3 and 6.4)", () => {
  const extra = { m4: sound("m4", "music", 170_000, "Smoke"), m60: sound("m60", "music", 60_000, "Short"), x: sound("x", "music", 120_000, "Elsewhere") };
  const FOUR: Playlist = { id: "four", rev: 0, name: "Four", sounds: ["m1", "m2", "m3", "m4"], repeat: "all", fade: 5 };
  const queueRoom = (): RoomState => soundRoom({ sounds: { ...LIBRARY, ...extra }, playlists: { tavern: TAVERN, four: FOUR } });
  const playFour: Op = { t: "music.play", run: "r1", playlistId: "four", order: ["m1", "m2", "m3", "m4"], repeat: "all", fade: 5 };
  const fourRun: MusicRun = { run: "r1", playlistId: "four", order: ["m1", "m2", "m3", "m4"], index: 0, repeat: "all", fade: 5, now: { soundId: "m1", at: S0 } };
  const four = () => step(queueRoom(), playFour).state;
  const queue = (edit: Extract<Op, { t: "music.queue" }>["edit"], from = "r1"): Op => ({ t: "music.queue", from, edit });
  const at = (state: RoomState, op: Op, ms: number, opVersion?: number) => applyOp(state, op, DM, { ...envAt(ms), ...(opVersion !== undefined ? { opVersion } : {}) });

  test("no run, a stale from and a jump made on another track are refused in the panel's words", () => {
    assert.equal(refusal(queueRoom(), queue({ t: "remove", soundId: "m2" })), "Nothing is playing.");
    assert.equal(refusal(queueRoom(), { t: "music.jump", run: "r2", from: "r1", soundId: "m2" }), SOUND_WORDS.nothingPlaying);
    const played = four();
    assert.equal(refusal(played, queue({ t: "remove", soundId: "m2" }, "r0")), "The music changed. Try again.");
    assert.equal(refusal(played, { t: "music.jump", run: "r2", from: "r0", soundId: "m2" }), SOUND_WORDS.musicChanged);
    assert.equal(refusal(played, { t: "music.jump", run: "r2", from: "r1", soundId: "m1", ms: 5_000, on: "m2" }), "The music moved on. Try again.");
    // Past the promotion at 190 s the seek made on m1 is refused, while Play now, which names no track, still lands.
    assert.equal(refusal(played, { t: "music.jump", run: "r2", from: "r1", soundId: "m1", ms: 5_000, on: "m1" }, 191_000), SOUND_WORDS.musicMovedOn);
    assert.equal(step(played, { t: "music.jump", run: "r2", from: "r1", soundId: "m4" }, 191_000).state.playing!.music?.now.soundId, "m4");
    assert.equal(refusal(step(played, { t: "music.stop" }, 1_000).state, queue({ t: "unshuffle" })), SOUND_WORDS.nothingPlaying);
  });

  test("the helpers' refusals come through in their words", () => {
    const played = four();
    assert.equal(refusal(played, queue({ t: "remove", soundId: "m1" })), "The playing track stays in the queue. Skip it or stop the music.");
    assert.equal(refusal(played, queue({ t: "move", soundId: "x", to: "first" })), "That track left the queue.");
    assert.equal(refusal(played, queue({ t: "next", soundIds: ["rain"] })), SOUND_WORDS.notMusic);
    assert.equal(refusal(played, { t: "music.jump", run: "r2", from: "r1", soundId: "x" }), SOUND_WORDS.leftQueue);
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`b${i}`, sound(`b${i}`, "music", 60_000, `Track ${i}`)]));
    const full = step(soundRoom({ sounds: { ...LIBRARY, ...big } }), { t: "music.play", run: "r1", soundId: "b0", order: ["b0"], repeat: "all", fade: 0 }).state;
    const ninetyNine = Object.keys(big).filter((id) => id !== "b0");
    const added = step(full, queue({ t: "add", soundIds: ninetyNine })).state;
    assert.equal(added.playing!.music?.order?.length, 100);
    assert.equal(refusal(added, queue({ t: "add", soundIds: ["m1"] })), "The queue holds 100 tracks at most.");
  });

  test("an edit writes playing alone with no step, and one that changes nothing writes nothing, so a second DM's stale press undoes nothing", () => {
    const played = four();
    const r = step(played, queue({ t: "remove", soundId: "m3" }), 1_000);
    assert.deepEqual(r.state.playing!.music, { ...fourRun, order: ["m1", "m2", "m4"] });
    assert.deepEqual(r.touched, [keys.playing]);
    assert.equal(undoScope(queue({ t: "remove", soundId: "m3" }), played), "none");
    const again = step(r.state, queue({ t: "remove", soundId: "m3" }), 2_000);
    assert.deepEqual(again.touched, []);
    assert.equal(again.state.playing, r.state.playing);
    // Past the reveal a no-write still writes nothing: the tick stores what the schedule moved on.
    const late = step(played, queue({ t: "move", soundId: "m2", to: "first" }), 170_000);
    assert.deepEqual(late.touched, []);
    assert.equal(refusal(r.state, queue({ t: "move", soundId: "m3", to: "first" }), 3_000), "That track left the queue.", "the other DM's move of the removed track");
    const off = step(step(played, queue({ t: "shuffle", seed: "s1" }), 1_000).state, queue({ t: "unshuffle" }), 2_000).state;
    assert.deepEqual(step(off, queue({ t: "unshuffle" }), 3_000).touched, [], "Shuffle off twice");
  });

  test("an edit during the m1 to m2 crossfade promotes m2 first, and Home on a later row lands right after it", () => {
    const played = four();
    const r = step(played, queue({ t: "move", soundId: "m4", to: "first" }), 187_000);
    assert.deepEqual(r.state.playing!.music, { ...fourRun, order: ["m1", "m2", "m4", "m3"], index: 1, now: { soundId: "m2", at: S0 + 185_000 } });
    assert.equal(refusal(played, queue({ t: "move", soundId: "m2", to: "last" }), 187_000), SOUND_WORDS.playingStays, "a move of the row that promoted");
  });

  test("inside the reveal window Play next swaps the revealed next at the same start", () => {
    const played = four();
    const r = step(played, queue({ t: "next", soundIds: ["m4"] }), 170_000);
    assert.deepEqual(r.state.playing!.music, { ...fourRun, order: ["m1", "m4", "m2", "m3"], next: { soundId: "m4", at: S0 + 185_000 } });
  });

  test("a seek to 0:59 of a 1:00 Repeat one track with a 10 s crossfade is held to 0:49, playing, and paused then resumed", () => {
    const one = step(queueRoom(), { t: "music.play", run: "r1", soundId: "m60", order: ["m60"], repeat: "one", fade: 10 }).state;
    const sought = step(one, { t: "music.jump", run: "r2", from: "r1", soundId: "m60", ms: 59_000, on: "m60" }, 5_000).state.playing!.music!;
    assert.deepEqual(sought, { run: "r2", order: ["m60"], index: 0, repeat: "one", fade: 10, now: { soundId: "m60", at: startAt(5_000) - 49_000 } });
    const paused = step(one, { t: "music.pause" }, 5_000).state;
    const moved = step(paused, { t: "music.jump", run: "r2", from: "r1", soundId: "m60", ms: 59_000, on: "m60" }, 6_000).state;
    assert.deepEqual(moved.playing!.music, { run: "r2", order: ["m60"], index: 0, repeat: "one", fade: 10, now: { soundId: "m60", at: S0 }, paused: 49_000 }, "stays paused at the new place");
    const resumed = step(moved, { t: "music.resume", run: "r3" }, 20_000).state;
    assert.deepEqual(resumed.playing!.music?.now, { soundId: "m60", at: startAt(20_000) - 49_000 });
    // A track's last second stays out of reach under every repeat, and ms 0 is the default.
    const all = step(four(), { t: "music.jump", run: "r2", from: "r1", soundId: "m2", ms: 300_000 }, 1_000).state.playing!.music!;
    assert.deepEqual(all.now, { soundId: "m2", at: startAt(1_000) - 199_000 });
    assert.deepEqual(step(four(), { t: "music.jump", run: "r2", from: "r1", soundId: "m3" }, 1_000).state.playing!.music!.now, { soundId: "m3", at: startAt(1_000) });
  });

  test("a play's shuffle is stored on its run", () => {
    const r = step(queueRoom(), { ...playFour, order: ["m3", "m1", "m4", "m2"], shuffle: true } as Op);
    assert.deepEqual(r.state.playing!.music, { ...fourRun, order: ["m3", "m1", "m4", "m2"], now: { soundId: "m3", at: S0 }, shuffle: true });
  });
});

describe("Add to playlist (docs/design/design-v1-music-player.md 6.4)", () => {
  const add = (id: string, soundId: string): Op => ({ t: "playlist.add", id, soundId });

  test("an append of a music sound, a Setup step, and nothing written for one it holds", () => {
    const r = step(soundRoom(), add("tavern", "m2"));
    assert.deepEqual(r.touched, [], "it holds it");
    assert.equal(r.inverse, null, "no Setup step");
    const quiet = soundRoom({ playlists: { tavern: TAVERN, quiet: { id: "quiet", rev: 0, name: "Quiet", sounds: ["m3"], repeat: "off", fade: 0 } } });
    const added = step(quiet, add("quiet", "m1"));
    assert.deepEqual(added.state.playlists!.quiet, { id: "quiet", rev: 1, name: "Quiet", sounds: ["m3", "m1"], repeat: "off", fade: 0 });
    assert.deepEqual(added.touched, [keys.playlist("quiet")]);
    assert.ok(added.inverse && added.inverse.length > 0);
    assert.equal(undoScope(add("quiet", "m1"), quiet), "setup");
    assert.equal(refusal(quiet, add("quiet", "rain")), SOUND_WORDS.notMusic);
    assert.equal(refusal(quiet, add("gone", "m1")), "playlist is not here");
  });

  test("two DMs add at once: both land on a 3-track playlist, and on a 99-track one the second is refused at 100", () => {
    const both = step(step(soundRoom({ sounds: { ...LIBRARY, x: sound("x", "music", 60_000, "X") } }), add("tavern", "x")).state, add("tavern", "m1"));
    assert.deepEqual(step(both.state, add("tavern", "x")).touched, []);
    const big = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`b${i}`, sound(`b${i}`, "music", 60_000, `Track ${i}`)]));
    const ninetyNine: Playlist = { ...TAVERN, sounds: Object.keys(big).slice(0, 99) };
    const state = soundRoom({ sounds: { ...LIBRARY, ...big }, playlists: { tavern: ninetyNine } });
    const first = step(state, add("tavern", "b99"));
    assert.equal(first.state.playlists!.tavern!.sounds.length, 100);
    assert.equal(refusal(first.state, add("tavern", "b100")), "A playlist holds 100 tracks at most.");
    const sameTrack = step(step(soundRoom({ sounds: { ...LIBRARY, x: sound("x", "music", 60_000, "X") } }), add("tavern", "x")).state, add("tavern", "x"));
    assert.deepEqual(sameTrack.state.playlists!.tavern!.sounds, ["m1", "m2", "m3", "x"], "the same track twice lands once");
  });
});

describe("deleting a queued track (docs/design/design-v1-music-player.md 6.4, op version 48)", () => {
  const extra = { m4: sound("m4", "music", 170_000, "Smoke") };
  const FOUR: Playlist = { id: "four", rev: 0, name: "Four", sounds: ["m1", "m2", "m3", "m4"], repeat: "off", fade: 5 };
  const playFour: Op = { t: "music.play", run: "r1", playlistId: "four", order: ["m1", "m2", "m3", "m4"], index: 3, repeat: "off", fade: 5 };
  const fourth = () => step(soundRoom({ sounds: { ...LIBRARY, ...extra }, playlists: { tavern: TAVERN, four: FOUR } }), playFour).state;
  const del = (id: string): Op => ({ t: "sound.delete", id });
  const at = (state: RoomState, op: Op, ms: number, opVersion?: number) => applyOp(state, op, DM, { ...envAt(ms), ...(opVersion !== undefined ? { opVersion } : {}) });

  test("a played track under Repeat off while track 4 plays leaves the order, and the music plays on", () => {
    const r = step(fourth(), del("m2"), 1_000);
    assert.deepEqual(r.state.playing!.music, { run: "r1", playlistId: "four", order: ["m1", "m3", "m4"], index: 2, repeat: "off", fade: 5, now: { soundId: "m4", at: S0 } });
    assert.equal(r.state.sounds!.m2, undefined);
    assert.deepEqual(r.state.playlists!.four!.sounds, ["m1", "m3", "m4"]);
    assert.ok(r.touched.includes(keys.playing));
  });

  test("the playing track and the revealed next are refused, and a crossfade's outgoing track goes, the incoming one written as playing", () => {
    const played = step(soundRoom(), playTavern).state;
    assert.equal(refusal(played, del("m1")), SOUND_WORDS.trackPlays);
    assert.equal(refusal(played, del("m2"), 170_000), SOUND_WORDS.trackPlaysNext);
    const r = step(played, del("m1"), 187_000);
    assert.deepEqual(r.state.playing!.music, { ...tavernRun, order: ["m2", "m3"], index: 0, now: { soundId: "m2", at: S0 + 185_000 } });
    assert.equal(refusal(played, del("m2"), 187_000), SOUND_WORDS.trackPlays, "the incoming track");
  });

  test("a run the schedule ended by the delete's time is written as ended", () => {
    const last = step(soundRoom(), { t: "music.play", run: "r1", playlistId: "tavern", order: ["m1", "m2", "m3"], index: 2, repeat: "off", fade: 0 }).state;
    const r = step(last, del("m1"), 200_000);
    assert.equal(r.state.playing!.music, null);
  });

  test("an op stored before version 48 refuses every track of the order, as it did, and a sound no run names deletes alike", () => {
    const state = fourth();
    const old = at(state, del("m2"), 1_000, 47);
    assert.ok(!old.ok && old.message === SOUND_WORDS.trackQueued);
    const r = at(state, del("m2"), 1_000, 48);
    assert.ok(r.ok);
    assert.deepEqual(r.state.playing!.music?.order, ["m1", "m3", "m4"]);
    const effect = at(state, del("thunder"), 1_000, 47);
    assert.ok(effect.ok);
    assert.equal(effect.state.playing, state.playing, "playing is not written");
  });
});

describe("a scene's Shuffle on the run it starts (docs/design/design-v1-music-player.md 6.4, op version 48)", () => {
  const shuffled = (state: RoomState) => withSceneSounds(state, { s1: { music: { playlistId: "tavern", repeat: "all", fade: 5, shuffle: true }, loops: [] } });
  const scene: Op = { t: "sound.scene", sceneId: "s1", run: "r9", order: ["m3", "m1", "m2"] };
  const at = (state: RoomState, op: Op, ms: number, opVersion?: number) => applyOp(state, op, DM, { ...envAt(ms), ...(opVersion !== undefined ? { opVersion } : {}) });

  test("a run it starts is shuffled live and from version 48, and with no flag for an op stored before", () => {
    for (const version of [undefined, 48]) {
      const r = at(shuffled(soundRoom()), scene, 1_000, version);
      assert.ok(r.ok);
      assert.equal(r.state.playing!.music?.shuffle, true, `version ${version}`);
    }
    const old = at(shuffled(soundRoom()), scene, 1_000, 47);
    assert.ok(old.ok);
    assert.deepEqual(old.state.playing!.music, { run: "r9", playlistId: "tavern", order: ["m3", "m1", "m2"], index: 0, repeat: "all", fade: 5, now: { soundId: "m3", at: startAt(1_000) } });
  });

  test("a run of the same playlist plays on as it is, its own Shuffle kept", () => {
    const played = step(shuffled(soundRoom()), playTavern).state;
    const r = step(played, scene, 1_000);
    assert.equal(r.state.playing!.music, played.playing!.music);
    assert.equal(r.state.playing!.music?.shuffle, undefined);
  });
});

describe("Only DM devices play (docs/design/design-v1-sound-dm-only.md 8)", () => {
  const dmOnly = (on: boolean): Op => ({ t: "room.update", settings: { soundDmOnly: on } });

  test("room.update stores it as true and clears it as no setting, a patch without it leaves it, and it is a Setup step", () => {
    const on = step(soundRoom(), dmOnly(true));
    assert.equal(on.state.meta.settings.soundDmOnly, true);
    assert.equal(undoScope(dmOnly(true), soundRoom()), "setup");
    const other = step(on.state, { t: "room.update", settings: { soundNames: true } });
    assert.equal(other.state.meta.settings.soundDmOnly, true, "another setting's patch keeps it");
    const off = step(other.state, dmOnly(false));
    assert.equal("soundDmOnly" in off.state.meta.settings, false);
    assert.deepEqual(step(soundRoom(), dmOnly(false)).state.meta.settings, soundRoom().meta.settings, "off on a room without it adds nothing");
  });

  test("an effect fired while it is on is the DM's for good, a room effect and a built-in alike, and one fired after it is everyone's", () => {
    let state = step(soundRoom(), dmOnly(true)).state;
    state = step(state, { t: "effect.fire", id: "e1", soundId: "door" }, 1_000).state;
    state = step(state, { t: "effect.fire", id: "e2", builtin: "click" }, 2_000).state;
    assert.deepEqual(playing(state).dmEffects, [
      { id: "e1", soundId: "door", at: startAt(1_000) },
      { id: "e2", builtin: "click", at: startAt(2_000) },
    ]);
    assert.deepEqual(playing(state).effects, []);
    state = step(state, dmOnly(false), 3_000).state;
    assert.deepEqual(playing(state).dmEffects?.map((e) => e.id), ["e1", "e2"], "turning it off moves nothing into the open");
    state = step(state, { t: "effect.fire", id: "e3", soundId: "door" }, 4_000).state;
    assert.deepEqual(playing(state).effects.map((e) => e.id), ["e3"]);
    assert.equal(refusal(state, { t: "effect.fire", id: "e1", soundId: "door" }, 5_000), SOUND_WORDS.firedTwice, "an id is once across both lists");
  });

  test("music, background sounds and a scene's sound play for the DM as without it", () => {
    const plain = step(step(soundRoom(), playTavern).state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000).state;
    const on = step(step(step(soundRoom(), dmOnly(true)).state, playTavern).state, { t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 1_000).state;
    assert.deepEqual(on.playing, plain.playing);
  });
});
