import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Playing, Playlist, SceneSound, Sound } from "#shared/sound.ts";
import { builtinMs } from "../engine/builtins.ts";
import { busyRefusal, effectsSounding, loopsFull, musicShown, orderFor, sceneOrder, sceneSoundFrom, sceneSoundNames, soundsByUse, soundToStop, useLeaves } from "./state.ts";
import { STOP_IT_FIRST, STOP_MUSIC_FIRST } from "./words.ts";

const sound = (id: string, use: Sound["use"], ms: number, name = id): Sound => ({ id, rev: 1, name, assetId: `a-${id}`, ms, use });

const SOUNDS: Record<string, Sound> = {
  pony: sound("pony", "music", 190_000, "The Prancing Pony"),
  road: sound("road", "music", 120_000, "Road"),
  march: sound("march", "music", 60_000, "march"),
  rain: sound("rain", "loop", 40_000, "Rain"),
  crowd: sound("crowd", "loop", 30_000, "Crowd"),
  thunder: sound("thunder", "effect", 25_000, "Thunder"),
};

const TAVERN: Playlist = { id: "tavern", rev: 1, name: "Tavern night", sounds: ["pony", "rain", "road", "gone"], repeat: "all", fade: 5 };

function playing(over: Partial<Playing> = {}): Playing {
  return { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 }, ...over };
}

describe("what Ambiance's Sound reads (docs/design/design-v1-music.md 4.1)", () => {
  test("a play's order: the playlist's music tracks in order, shuffled only when it says so", () => {
    assert.deepEqual(orderFor({ playlistId: "tavern" }, { tavern: TAVERN }, SOUNDS), ["pony", "road"], "a loop and a sound that is gone never play as tracks");
    // A random of 0 always swaps with the first: [pony, road] becomes [road, pony].
    assert.deepEqual(orderFor({ playlistId: "tavern", shuffle: true }, { tavern: TAVERN }, SOUNDS, () => 0), ["road", "pony"]);
    assert.deepEqual(orderFor({ soundId: "march" }, {}, SOUNDS), ["march"]);
    assert.deepEqual(orderFor({ soundId: "rain" }, {}, SOUNDS), [], "a scene naming a sound no longer music plays none");
    assert.deepEqual(orderFor({ playlistId: "deleted" }, {}, SOUNDS), []);
  });

  test("a scene's sound from what plays: its playlist with the run's settings, or the one track of a run whose playlist went", () => {
    const loops = { l1: { soundId: "rain", at: 0, volume: 40 } };
    const run = { run: "r1", playlistId: "tavern", order: ["pony", "road"], index: 0, repeat: "one" as const, fade: 10 as const, now: { soundId: "pony", at: 0 } };
    assert.deepEqual(sceneSoundFrom(playing({ music: run, loops }), { tavern: { ...TAVERN, shuffle: true } }), {
      music: { playlistId: "tavern", repeat: "one", fade: 10, shuffle: true },
      loops: [{ soundId: "rain", volume: 40 }],
    });
    assert.deepEqual(sceneSoundFrom(playing({ music: run }), {}), { music: { soundId: "pony", repeat: "one", fade: 10 }, loops: [] });
    assert.deepEqual(sceneSoundFrom(null, {}), { music: null, loops: [] });
  });

  test("the scene's line names what it keeps, and silence names nothing", () => {
    const kept: SceneSound = { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 70 }, { soundId: "crowd", volume: 50 }] };
    assert.deepEqual(sceneSoundNames(kept, { tavern: TAVERN }, SOUNDS), ["Tavern night", "Rain", "Crowd"]);
    assert.deepEqual(sceneSoundNames({ music: null, loops: [] }, {}, SOUNDS), []);
    assert.deepEqual(sceneOrder({ music: null, loops: [] }, {}, SOUNDS), []);
  });

  test("a sound that plays refuses its delete and a change of use, in the panel's words", () => {
    const run = { run: "r1", playlistId: "tavern", order: ["pony", "road"], index: 0, repeat: "all" as const, fade: 5 as const, now: { soundId: "pony", at: 0 } };
    const p = playing({ music: run, loops: { l1: { soundId: "rain", at: 0, volume: 70 } }, effects: [{ id: "e1", soundId: "thunder", at: 0 }] });
    assert.equal(busyRefusal(p, "road"), STOP_MUSIC_FIRST, "a later track of the run's order too");
    assert.equal(busyRefusal(p, "rain"), STOP_IT_FIRST);
    assert.equal(busyRefusal(p, "thunder"), null, "a sounding effect deletes at once and stops");
    assert.equal(busyRefusal(p, "march"), null);
    assert.equal(busyRefusal(null, "pony"), null);
  });

  test("a change of use leaves only the places its old use held", () => {
    const scenes = {
      a: { sound: { music: { soundId: "pony", repeat: "all", fade: 5 }, loops: [] } as SceneSound },
      b: { sound: { music: { playlistId: "tavern", repeat: "all", fade: 5 }, loops: [{ soundId: "rain", volume: 70 }] } as SceneSound },
      c: {},
    };
    assert.deepEqual(useLeaves(SOUNDS.pony!, "effect", { tavern: TAVERN }, scenes), { playlists: 1, scenes: 1 });
    assert.deepEqual(useLeaves(SOUNDS.rain!, "music", { tavern: TAVERN }, scenes), { playlists: 0, scenes: 1 }, "a loop listed in a playlist by mistake is not the playlist's to leave");
    assert.deepEqual(useLeaves(SOUNDS.pony!, "music", { tavern: TAVERN }, scenes), { playlists: 0, scenes: 0 });
  });

  test("the board's pressed effects: for their length, both lists, and never a reclassified effect's history", () => {
    const sounds = { ...SOUNDS, was: sound("was", "loop", 40_000) };
    const p = playing({
      effects: [
        { id: "e1", soundId: "thunder", at: 1_000 },
        { id: "e2", builtin: "crash", at: 2_000 },
        { id: "e3", soundId: "was", at: 1_000 },
        { id: "e4", soundId: "gone", at: 1_000 },
      ],
      dmEffects: [{ id: "e5", builtin: "hiss", at: 1_500 }],
    });
    const at = (t: number) => effectsSounding(p, sounds, t);
    assert.deepEqual([...at(2_000).keys].sort(), ["builtin:crash", "builtin:hiss", "sound:thunder"]);
    assert.equal(at(2_000).nextEnd, Math.min(1_500 + builtinMs("hiss"), 2_000 + builtinMs("crash")));
    assert.deepEqual([...at(26_000).keys], [], "Thunder's 25 seconds are over");
    assert.equal(at(500).nextEnd, 1_000, "an effect fired for 400 ms ahead wakes the board at its start");
    assert.equal(effectsSounding(null, sounds, 0).nextEnd, null);
  });

  test("Stop all sound and the X-card's Stop the sound show for music, paused too, a loop, or an effect not over, a DM's behind a blackout included", () => {
    const run = { run: "r1", repeat: "all" as const, fade: 5 as const, now: { soundId: "pony", at: 0 } };
    assert.deepEqual(soundToStop(null, SOUNDS, 0), { now: false, until: null });
    assert.deepEqual(soundToStop(playing(), SOUNDS, 0), { now: false, until: null });
    assert.deepEqual(soundToStop(playing({ music: { ...run, paused: 4_000 } }), SOUNDS, 0), { now: true, until: null });
    assert.deepEqual(soundToStop(playing({ loops: { a: { soundId: "rain", at: 0, volume: 70 } } }), SOUNDS, 0), { now: true, until: null });
    // Fired behind a blackout: only the DM's own list holds it, and nothing else plays.
    const blackout = playing({ dmEffects: [{ id: "e1", soundId: "thunder", at: 1_400 }] });
    assert.deepEqual(soundToStop(blackout, SOUNDS, 1_000), { now: true, until: 26_400 }, "from its fire, 400 ms before it sounds");
    assert.deepEqual(soundToStop(blackout, SOUNDS, 26_400), { now: false, until: null }, "over, it is history");
    const both = playing({ effects: [{ id: "e2", builtin: "crash", at: 2_000 }], dmEffects: [{ id: "e1", soundId: "thunder", at: 1_400 }] });
    assert.equal(soundToStop(both, SOUNDS, 2_100).until, 26_400, "until the last of them ends");
    assert.equal(soundToStop(playing({ effects: [{ id: "e2", builtin: "crash", at: 2_000 }] }), SOUNDS, 2_100).now, true);
    assert.equal(soundToStop(playing({ dmEffects: [{ id: "e3", soundId: "rain", at: 0 }] }), SOUNDS, 100).now, false, "a sound no longer an Effect plays nowhere");
  });

  test("four loops fill Background", () => {
    const loops = Object.fromEntries(["a", "b", "c"].map((id) => [id, { soundId: id, at: 0, volume: 70 }]));
    assert.equal(loopsFull(playing({ loops })), false);
    assert.equal(loopsFull(playing({ loops: { ...loops, d: { soundId: "d", at: 0, volume: 70 } } })), true);
  });

  test("lists by name, a sound of another use left out", () => {
    assert.deepEqual(
      soundsByUse(SOUNDS, "music").map((s) => s.id),
      ["march", "road", "pony"],
    );
  });

  test("a paused run reads the place it paused at, and its playlist's name, or none once it went", () => {
    const run = { run: "r1", playlistId: "tavern", order: ["pony", "road"], index: 1, repeat: "all" as const, fade: 5 as const, now: { soundId: "road", at: 0 }, paused: 84_000 };
    const shown = musicShown(run, SOUNDS, { tavern: TAVERN }, 10_000_000);
    assert.equal(shown?.positionMs, 84_000);
    assert.equal(shown?.paused, true);
    assert.equal(shown?.place, 2);
    assert.equal(shown?.count, 2);
    assert.equal(shown?.playlistName, "Tavern night");
    assert.equal(shown?.crossingInto, null);
    assert.equal(musicShown(run, SOUNDS, {}, 0)?.playlistName, null);
    assert.equal(musicShown({ ...run, playlistId: undefined, order: ["road"] }, SOUNDS, {}, 0)?.single, true);
  });

  test("a run that plays reads its place on the timeline: the incoming track during a crossfade, and Repeat one's newest pass", () => {
    const run = { run: "r1", playlistId: "tavern", order: ["pony", "road"], index: 0, repeat: "all" as const, fade: 5 as const, now: { soundId: "pony", at: 1_000 }, next: { soundId: "road", at: 186_000 } };
    const before = musicShown(run, SOUNDS, { tavern: TAVERN }, 85_000)!;
    assert.equal(before.positionMs, 84_000);
    assert.equal(before.name, "The Prancing Pony");
    assert.equal(before.crossingInto, null);
    const crossing = musicShown(run, SOUNDS, { tavern: TAVERN }, 188_000)!;
    assert.equal(crossing.name, "Road", "Now playing names the incoming track once its crossfade starts");
    assert.equal(crossing.positionMs, 2_000);
    assert.equal(crossing.place, 2);
    assert.equal(crossing.crossingInto, "Road");
    const one = { ...run, repeat: "one" as const, next: undefined };
    assert.equal(musicShown(one, SOUNDS, {}, 1_000 + 185_000 + 15_000)?.positionMs, 15_000, "the second pass, a period of the length less the crossfade on");
    assert.equal(musicShown({ ...run, next: undefined }, SOUNDS, {}, 500_000)?.positionMs, 190_000, "past its end reads its end");
  });
});
