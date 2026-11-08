import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { soundStep } from "#shared/sound.ts";
import { DM, env, room } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Synced music and sound in the stored-state schema
 * (docs/design/design-v1-music.md 6.3, 6.7 and 8): the library, playlists,
 * what plays and each scene's sound within their ops' bounds, and whatever
 * names a sound naming one the room holds under the use it plays as.
 */

const T = 1_791_835_200_400;

/** A room with a sound of every use, a playlist, a scene's sound and something of every kind playing. */
function full(): RoomState {
  const state = room();
  state.meta.settings = { ...state.meta.settings, soundNames: true };
  state.sounds = {
    m1: { id: "m1", rev: 1, name: "Tavern", assetId: "a1", ms: 120_000, use: "music" },
    m2: { id: "m2", rev: 1, name: "Road", assetId: "a2", ms: 90_000, use: "music", level: -30 },
    l1: { id: "l1", rev: 1, name: "Rain", assetId: "a3", ms: 20_000, use: "loop" },
    e1: { id: "e1", rev: 1, name: "Door", assetId: "a4", ms: 1_500, use: "effect" },
  };
  state.playlists = { pl1: { id: "pl1", rev: 1, name: "Night", sounds: ["m1", "m2"], shuffle: true, repeat: "all", fade: 5 } };
  state.playing = {
    rev: 4,
    music: { run: "r1", playlistId: "pl1", order: ["m2", "m1"], index: 0, repeat: "all", fade: 5, now: { soundId: "m2", at: T }, next: { soundId: "m1", at: T + 85_000 } },
    loops: { lp1: { soundId: "l1", at: T, volume: 60 } },
    effects: [
      { id: "f1", soundId: "e1", at: T },
      { id: "f2", builtin: "click", at: T },
    ],
    dmEffects: [{ id: "f3", soundId: "e1", at: T }],
    volume: { music: 100, effects: 80 },
  };
  state.scenes.s1 = { ...state.scenes.s1!, sound: { music: { playlistId: "pl1", repeat: "all", fade: 2 }, loops: [{ soundId: "l1", volume: 40 }] } };
  state.scenes.s2 = { ...state.scenes.s2!, sound: { music: { soundId: "m1", repeat: "one", fade: 0, shuffle: true }, loops: [] } };
  return state;
}

/** The full room through JSON, as a backup holds it, after `edit`. */
function parse(edit: (state: RoomState) => void = () => {}): { ok: true } | { ok: false; message: string } {
  const state = JSON.parse(JSON.stringify(full())) as RoomState;
  edit(state);
  const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
  return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
}

function refused(edit: (state: RoomState) => void, message?: RegExp, why = ""): void {
  const parsed = parse(edit);
  assert.equal(parsed.ok, false, `passed: ${why}`);
  if (message && !parsed.ok) assert.match(parsed.message, message, why);
}

function passes(edit: (state: RoomState) => void, why = ""): void {
  const parsed = parse(edit);
  assert.ok(parsed.ok, `${why}: ${parsed.ok ? "" : parsed.message}`);
}

const many = <T>(n: number, make: (i: number) => [string, T]): Record<string, T> => Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));

describe("a backup's sound (docs/design/design-v1-music.md 6.7)", () => {
  test("a room with sounds of every use, a playlist, scene sounds and everything playing parses, and keeps every field", () => {
    const parsed = parseRoomState(JSON.parse(JSON.stringify(full())));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.sounds, full().sounds);
    assert.deepEqual(parsed.state.playlists, full().playlists);
    assert.deepEqual(parsed.state.playing, full().playing);
    assert.deepEqual(parsed.state.scenes.s1!.sound, full().scenes.s1!.sound);
    assert.equal(parsed.state.meta.settings.soundNames, true);
  });

  test("a room from before sound parses, and so do an empty library and silence", () => {
    const old = parseRoomState(JSON.parse(JSON.stringify(room())));
    assert.ok(old.ok, old.ok ? "" : old.message);
    assert.equal("sounds" in old.state || "playlists" in old.state || "playing" in old.state, false);
    passes((s) => {
      s.sounds = {};
      s.playlists = {};
      s.playing = null;
      s.scenes.s1!.sound = { music: null, loops: [] };
      delete s.scenes.s2!.sound;
    }, "empty");
  });

  test("the names switch is true or absent", () => {
    passes((s) => delete s.meta.settings.soundNames, "absent");
    refused((s) => ((s.meta.settings as Record<string, unknown>).soundNames = false), /soundNames/);
  });

  test("Only DM devices play is true or absent, and a room keeps it (docs/design/design-v1-sound-dm-only.md 8)", () => {
    const on = full();
    on.meta.settings = { ...on.meta.settings, soundDmOnly: true };
    const parsed = parseRoomState(JSON.parse(JSON.stringify(on)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.state.meta.settings.soundDmOnly, true);
    passes((s) => delete s.meta.settings.soundDmOnly, "absent");
    for (const wrong of [false, "on", 1]) refused((s) => ((s.meta.settings as Record<string, unknown>).soundDmOnly = wrong), /soundDmOnly/);
  });
});

describe("a stored sound (6.1, 8)", () => {
  const sound = (patch: Record<string, unknown>) => (s: RoomState) => Object.assign(s.sounds!.m1!, patch);

  test("its length is whole, within a file's bounds and fits its use with the 100 ms allowance past the upper cap only", () => {
    refused(sound({ ms: 120_000.5 }), /ms/, "not whole");
    refused(sound({ ms: SOUND_LIMITS.fileMaxMs + 1 }), /ms/, "past a file's cap");
    refused((s) => Object.assign(s.sounds!.e1!, { ms: SOUND_LIMITS.fileMinMs - 1 }), /ms/, "under a file's floor");
    refused(sound({ ms: 10_000 }), /sounds\.m1\.ms: a sound's length does not fit its use/, "a 10 s file claiming Music");
    passes(sound({ ms: 30_000 }), "Music's floor");
    passes(sound({ ms: 15 * 60_000 + 100 }), "Music's cap with the allowance");
    refused(sound({ ms: 15 * 60_000 + 101 }), /does not fit/, "Music's cap past the allowance");
    passes((s) => Object.assign(s.sounds!.e1!, { ms: 30_100 }), "an Effect at its cap with the allowance");
    refused((s) => Object.assign(s.sounds!.e1!, { ms: 30_101 }), /does not fit/, "an Effect past it");
    refused((s) => Object.assign(s.sounds!.l1!, { ms: 1_999 }), /does not fit/, "Background under its floor, which has no allowance");
  });

  test("its level is whole within its bounds, its use one of the three, and its name and asset follow the file's rules", () => {
    passes(sound({ level: -240 }), "the lowest level");
    passes(sound({ level: 120 }), "the highest level");
    refused(sound({ level: 121 }), /level/);
    refused(sound({ level: -241 }), /level/);
    refused(sound({ level: 1.5 }), /level/);
    refused(sound({ use: "ambience" }), /use/);
    refused(sound({ name: "" }), /name/);
    refused(sound({ name: "Tav‮ern" }), /name/, "a text direction character");
    refused(sound({ name: "x".repeat(81) }), /name/, "too long");
    refused((s) => delete (s.sounds!.m1 as { name?: string }).name, /name/, "a stored sound has its name");
    refused(sound({ assetId: "" }), /assetId/);
    refused(sound({ assetId: "a".repeat(65) }), /assetId/);
    refused(sound({ extra: true }), /extra|Unrecognized/);
  });

  test("each is under its own id, and the room holds at most 300", () => {
    refused((s) => (s.sounds!.other = { ...s.sounds!.e1!, id: "e2" }), /sounds\.other: an entry under another id/);
    const library = (n: number) => (s: RoomState) => (s.sounds = { ...s.sounds, ...many(n - 4, (i) => [`x${i}`, { id: `x${i}`, rev: 0, name: `Sound ${i}`, assetId: "a9", ms: 1_000, use: "effect" as const }]) });
    passes(library(SOUND_LIMITS.soundsPerRoom), "300 sounds");
    refused(library(SOUND_LIMITS.soundsPerRoom + 1), /at most 300 sounds/);
  });
});

describe("a stored playlist (6.1, 8)", () => {
  test("its tracks are music sounds of the room, each once, at most 100", () => {
    refused((s) => (s.playlists!.pl1!.sounds = ["m1", "m1"]), /listed twice/);
    refused((s) => (s.playlists!.pl1!.sounds = ["m1", "l1"]), /playlists\.pl1\.sounds\.1: not a music sound of the room/, "a background sound");
    refused((s) => (s.playlists!.pl1!.sounds = ["gone"]), /playlists\.pl1\.sounds\.0: not a music sound/, "a sound the room does not hold");
    passes((s) => (s.playlists!.pl1!.sounds = []), "an empty playlist");
    const tracks = (n: number) => (s: RoomState) => {
      s.sounds = { ...s.sounds, ...many(n, (i) => [`t${i}`, { id: `t${i}`, rev: 0, name: `Track ${i}`, assetId: "a9", ms: 60_000, use: "music" as const }]) };
      s.playlists!.pl1!.sounds = Array.from({ length: n }, (_, i) => `t${i}`);
    };
    passes(tracks(SOUND_LIMITS.playlistTracks), "100 tracks");
    refused(tracks(SOUND_LIMITS.playlistTracks + 1), /sounds/);
  });

  test("its name, repeat and fade follow their ops, each is under its own id, and the room holds at most 30", () => {
    refused((s) => (s.playlists!.pl1!.name = ""), /name/);
    refused((s) => ((s.playlists!.pl1! as Record<string, unknown>).fade = 3), /fade/);
    refused((s) => ((s.playlists!.pl1! as Record<string, unknown>).repeat = "shuffle"), /repeat/);
    refused((s) => ((s.playlists!.pl1! as Record<string, unknown>).shuffle = false), /shuffle/);
    refused((s) => (s.playlists!.pl2 = { ...s.playlists!.pl1!, id: "pl3" }), /playlists\.pl2: an entry under another id/);
    const lists = (n: number) => (s: RoomState) => (s.playlists = many(n, (i) => [`p${i}`, { id: `p${i}`, rev: 0, name: `List ${i}`, sounds: ["m1"], repeat: "off" as const, fade: 0 as const }]));
    passes((s) => {
      lists(SOUND_LIMITS.playlistsPerRoom)(s);
      s.scenes.s1!.sound!.music = null;
      s.playing!.music = { ...s.playing!.music!, playlistId: "p0" };
    }, "30 playlists");
    refused(lists(SOUND_LIMITS.playlistsPerRoom + 1), /at most 30 playlists/);
  });
});

describe("a scene's sound (4.6, 6.6)", () => {
  test("its shape is the scene op's", () => {
    refused((s) => (s.scenes.s1!.sound!.music = { playlistId: "pl1", soundId: "m1", repeat: "all", fade: 0 }), /a playlist or one track/);
    refused((s) => (s.scenes.s1!.sound!.loops = [{ soundId: "l1", volume: 1 }, { soundId: "l1", volume: 2 }]), /listed twice/);
    refused((s) => (s.scenes.s1!.sound!.loops = Array.from({ length: 5 }, (_, i) => ({ soundId: `l${i}`, volume: 1 }))), /loops/);
    refused((s) => (s.scenes.s1!.sound!.loops[0]!.volume = 101), /volume/);
  });

  test("its playlist exists, its one track is music and its background sounds are Background", () => {
    refused((s) => (s.scenes.s1!.sound!.music = { playlistId: "gone", repeat: "all", fade: 0 }), /scenes\.s1\.sound\.music\.playlistId: not a playlist of the room/);
    refused((s) => (s.scenes.s2!.sound!.music = { soundId: "l1", repeat: "all", fade: 0 }), /scenes\.s2\.sound\.music\.soundId: not a music sound/);
    refused((s) => (s.scenes.s2!.sound!.music = { soundId: "gone", repeat: "all", fade: 0 }), /scenes\.s2\.sound\.music\.soundId: not a music sound/);
    refused((s) => (s.scenes.s1!.sound!.loops = [{ soundId: "m1", volume: 10 }]), /scenes\.s1\.sound\.loops\.0\.soundId: not a background sound/);
    refused((s) => (s.scenes.s1!.sound!.loops = [{ soundId: "gone", volume: 10 }]), /scenes\.s1\.sound\.loops\.0\.soundId: not a background sound/);
  });
});

describe("what plays (6.3)", () => {
  const run = (patch: Record<string, unknown>) => (s: RoomState) => Object.assign(s.playing!.music!, patch);

  test("the run's order, now and next are music sounds of the room, and its playlist is only a label", () => {
    refused(run({ order: ["m2", "l1"] }), /playing\.music\.order\.1: not a music sound/, "a background sound in the order");
    refused(run({ order: ["m2", "gone"] }), /playing\.music\.order\.1: not a music sound/, "a sound the room does not hold");
    refused(run({ next: { soundId: "l1", at: T } }), /playing\.music\.next\.soundId: not a music sound/);
    refused((s) => {
      s.sounds!.m2 = { ...s.sounds!.m2!, use: "loop" };
      s.playlists!.pl1!.sounds = ["m1"];
    }, /playing\.music\.order\.0: not a music sound/, "now given another use");
    passes(run({ playlistId: "deleted" }), "a deleted playlist's id");
    passes(run({ order: ["m2"], index: 0, next: undefined }), "an order unlike the playlist's");
    passes((s) => delete s.playing!.music!.playlistId, "one track alone");
    passes(run({ order: ["m1", "m2"], index: 1, next: { soundId: "m1", at: T + 85_000 } }), "next back to the first track under Repeat all");
  });

  test("its index lies in the order and names now, and next comes only while it plays under Repeat all or off", () => {
    refused(run({ index: 2 }), /index/, "past the order");
    refused(run({ index: 1 }), /index names its track/, "another track than now");
    refused(run({ index: -1 }), /index/);
    refused(run({ order: ["m2", "m2"] }), /listed twice/);
    refused(run({ order: [] }), /order/);
    refused(run({ paused: 4_000 }), /only a playing run/, "next while paused");
    passes(run({ paused: 4_000, next: undefined }), "paused");
    refused(run({ repeat: "one" }), /only a playing run/, "next under Repeat one");
    passes(run({ repeat: "one", next: undefined }), "Repeat one");
    passes(run({ repeat: "off" }), "Repeat off");
    refused(run({ fade: 3 }), /fade/);
    refused(run({ run: "r 1" }), /run/);
  });

  test("times are whole ms from 0, and volumes 0 to 100", () => {
    refused(run({ now: { soundId: "m2", at: T + 0.5 } }), /at/, "a fraction of a ms");
    refused(run({ now: { soundId: "m2", at: -1 } }), /at/, "before 1970");
    refused(run({ paused: 0.5, next: undefined }), /paused/);
    refused((s) => (s.playing!.loops.lp1!.at = 1.5), /at/);
    refused((s) => (s.playing!.effects[0]!.at = 1e300), /at/, "far past any date");
    refused((s) => (s.playing!.loops.lp1!.volume = 101), /volume/);
    refused((s) => (s.playing!.volume.music = 101), /music/);
    refused((s) => (s.playing!.volume.effects = 0.5), /effects/);
    refused((s) => (s.playing!.rev = -1), /rev/);
  });

  test("at most 4 loops, each a Background sound of the room, keyed by a plain id that names no member of Object.prototype", () => {
    refused((s) => (s.playing!.loops.lp1!.soundId = "m1"), /playing\.loops\.lp1\.soundId: not a background sound/);
    refused((s) => (s.playing!.loops.lp1!.soundId = "gone"), /playing\.loops\.lp1\.soundId: not a background sound/);
    const loops = (n: number) => (s: RoomState) => (s.playing!.loops = many(n, (i) => [`lp${i}`, { soundId: "l1", at: T, volume: 50 }]));
    passes(loops(SOUND_LIMITS.loops), "4 loops");
    refused(loops(SOUND_LIMITS.loops + 1), /at most 4 background sounds/);
    for (const key of ["constructor", "toString", "hasOwnProperty", "__defineGetter__"]) refused((s) => (s.playing!.loops = { [key]: { soundId: "l1", at: T, volume: 50 } }), /loops/, key);
    refused((s) => (s.playing!.loops = { "lp 1": { soundId: "l1", at: T, volume: 50 } }), /loops/, "not a plain id");
  });

  test("each effect list holds at most 16 entries, each naming any sound as history, or a built-in", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, soundId: "e1", at: T }));
    passes((s) => (s.playing!.effects = list(SOUND_LIMITS.effectsListed)), "16 effects");
    refused((s) => (s.playing!.effects = list(SOUND_LIMITS.effectsListed + 1)), /effects/);
    passes((s) => (s.playing!.dmEffects = list(SOUND_LIMITS.effectsListed)), "16 of the DM's");
    refused((s) => (s.playing!.dmEffects = list(SOUND_LIMITS.effectsListed + 1)), /dmEffects/);
    passes((s) => (s.playing!.effects = [{ id: "f1", soundId: "gone", at: T }, { id: "f2", soundId: "m1", at: T }]), "a deleted sound, and one given another use");
    passes((s) => delete s.playing!.dmEffects, "no list of the DM's");
    refused((s) => (s.playing!.effects = [{ id: "f1", soundId: "e1", builtin: "click", at: T }]), /room effect or a built-in/);
    refused((s) => (s.playing!.effects = [{ id: "f1", builtin: "boom" as "click", at: T }]), /builtin/);
  });

  test("nothing playing is null or absent", () => {
    passes((s) => (s.playing = null), "null");
    passes((s) => delete s.playing, "absent");
    passes((s) => (s.playing!.music = null), "no music");
  });
});

/*
 * The state machine rule: no sequence of the sound ops, the server's ticks
 * and Setup undos leaves a room the stored-state schema refuses, so every
 * room with sound exports and imports again.
 */
describe("the reducer and the stored-state schema agree on sound", () => {
  const SOUNDS = ["m1", "m2", "m3", "l1", "l2", "e1"];
  const id = fc.constantFrom(...SOUNDS);
  const use = fc.constantFrom("music" as const, "loop" as const, "effect" as const);
  const step = fc.oneof(
    fc.record({ t: fc.constant("sound.update" as const), id, use }),
    fc.record({ t: fc.constant("sound.delete" as const), id }),
    fc.record({ t: fc.constant("playlist.update" as const), sounds: fc.uniqueArray(id, { maxLength: 4 }) }),
    fc.record({ t: fc.constant("playlist.delete" as const) }),
    fc.record({ t: fc.constant("play" as const), order: fc.uniqueArray(id, { minLength: 1, maxLength: 4 }), repeat: fc.constantFrom("all" as const, "one" as const, "off" as const), fade: fc.constantFrom(0 as const, 2 as const, 5 as const, 10 as const) }),
    fc.record({ t: fc.constantFrom("music.pause" as const, "music.stop" as const, "sound.stopAll" as const) }),
    fc.record({ t: fc.constantFrom("music.resume" as const, "music.skip" as const) }),
    fc.record({ t: fc.constant("music.set" as const), repeat: fc.constantFrom("all" as const, "one" as const, "off" as const) }),
    fc.record({ t: fc.constant("loop.start" as const), id, key: fc.constantFrom("a", "b", "c", "d", "e", "constructor") }),
    fc.record({ t: fc.constant("loop.stop" as const), key: fc.constantFrom("a", "b", "c") }),
    fc.record({ t: fc.constant("effect.fire" as const), id: fc.option(id, { nil: undefined }) }),
    fc.record({ t: fc.constant("scene.sound" as const), music: fc.option(id, { nil: undefined }), loops: fc.uniqueArray(id, { maxLength: 3 }) }),
    fc.record({ t: fc.constant("sound.scene" as const), order: fc.uniqueArray(id, { maxLength: 4 }) }),
    fc.record({ t: fc.constant("blackout" as const), on: fc.boolean() }),
    fc.record({ t: fc.constant("tick" as const) }),
    fc.record({ t: fc.constant("undo" as const) }),
  );
  const lengths: Record<string, number> = { m1: 60_000, m2: 31_000, m3: 45_000, l1: 4_000, l2: 120_000, e1: 25_000 };
  const uses: Record<string, "music" | "loop" | "effect"> = { m1: "music", m2: "music", m3: "music", l1: "loop", l2: "loop", e1: "effect" };

  test("500 sequences leave the room parseable", () => {
    // What applied, so the property cannot pass on sequences the reducer refused throughout.
    const landed = new Set<string>();
    fc.assert(
      fc.property(fc.array(fc.record({ step, wait: fc.integer({ min: 0, max: 70_000 }) }), { minLength: 1, maxLength: 30 }), (steps) => {
        let state: RoomState = room();
        let seq = 1;
        let at = Date.parse("2026-10-12T20:00:00.000Z");
        let n = 0;
        const inverses: NonNullable<Extract<ReturnType<typeof applyOp>, { ok: true }>["inverse"]>[] = [];
        const apply = (op: Op): void => {
          const result = applyOp(state, op, DM, { ...env(seq++), at: new Date(at).toISOString() });
          if (!result.ok) return;
          landed.add(op.t);
          if (op.t !== "sys.restore" && result.inverse) inverses.push(result.inverse);
          state = result.state;
          const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
          assert.ok(parsed.ok, `${op.t}: ${parsed.ok ? "" : parsed.message}`);
        };
        for (const sound of SOUNDS) apply({ t: "sound.create", id: sound, assetId: `a-${sound}`, name: sound, use: uses[sound]!, ms: lengths[sound]! });
        apply({ t: "playlist.create", id: "pl1", name: "Night", sounds: ["m1", "m2", "m3"], repeat: "all", fade: 5 });
        for (const { step: st, wait } of steps) {
          at += wait;
          const run = `r${n++}`;
          if (st.t === "sound.update") apply({ t: "sound.update", id: st.id, use: st.use });
          else if (st.t === "sound.delete") apply({ t: "sound.delete", id: st.id });
          else if (st.t === "playlist.update") apply({ t: "playlist.update", id: "pl1", sounds: st.sounds });
          else if (st.t === "playlist.delete") apply({ t: "playlist.delete", id: "pl1" });
          else if (st.t === "play") {
            const listed = state.playlists?.pl1?.sounds;
            if (listed && listed.length > 0 && st.order.length > 1) apply({ t: "music.play", run, playlistId: "pl1", order: [...listed].reverse(), repeat: st.repeat, fade: st.fade });
            else apply({ t: "music.play", run, soundId: st.order[0]!, order: [st.order[0]!], repeat: st.repeat, fade: st.fade });
          } else if (st.t === "music.pause" || st.t === "music.stop" || st.t === "sound.stopAll") apply({ t: st.t });
          else if (st.t === "music.resume" || st.t === "music.skip") apply({ t: st.t, run });
          else if (st.t === "music.set") apply({ t: "music.set", repeat: st.repeat });
          else if (st.t === "loop.start") apply({ t: "loop.start", id: st.key, soundId: st.id, volume: 50 });
          else if (st.t === "loop.stop") apply({ t: "loop.stop", id: st.key });
          else if (st.t === "effect.fire") apply(st.id === undefined ? { t: "effect.fire", id: run, builtin: "click" } : { t: "effect.fire", id: run, soundId: st.id });
          else if (st.t === "scene.sound") {
            const music = st.music === undefined ? (state.playlists?.pl1 ? { playlistId: "pl1", repeat: "all" as const, fade: 2 as const } : null) : { soundId: st.music, repeat: "off" as const, fade: 0 as const };
            apply({ t: "scene.update", sceneId: "s1", patch: { sound: { music, loops: st.loops.map((soundId) => ({ soundId, volume: 30 })) } } });
          } else if (st.t === "sound.scene") apply({ t: "sound.scene", sceneId: "s1", run, order: st.order });
          else if (st.t === "blackout") apply({ t: "view.blackout", blackout: st.on });
          else if (st.t === "tick" && state.playing) {
            const due = soundStep(state.playing, state.sounds ?? {}, at);
            // A stored run always has its order and place, which only a projection leaves out.
            if (due.changed) apply({ t: "sys.sound", from: state.playing.rev, music: due.music as Extract<Op, { t: "sys.sound" }>["music"] });
          } else if (st.t === "undo") {
            const last = inverses.pop();
            if (last) apply({ t: "sys.restore", entries: last, from: "undo", deps: true });
          }
        }
      }),
      { numRuns: 500 },
    );
    for (const t of ["sound.update", "sound.delete", "playlist.update", "playlist.delete", "music.play", "music.pause", "music.resume", "music.skip", "music.set", "loop.start", "effect.fire", "scene.update", "sound.scene", "sys.sound", "sys.restore"]) {
      assert.ok(landed.has(t), `no ${t} applied`);
    }
  });
});
