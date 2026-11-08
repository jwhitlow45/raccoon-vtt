import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crossEndAt, effectLengthMs, following, musicAt, musicChanged, playingAt, reanchor, soundDue, soundStep, type MusicRun, type Playing, type SoundLengths } from "./sound.ts";

/** The music schedule's cases (docs/design/design-v1-music.md 6.3, 6.4 and section 11), at exact times. */
const T = 1_800_000_000_000;

function tracks(...lengths: number[]): { sounds: SoundLengths; order: string[] } {
  const sounds: Record<string, { ms: number; use: "music" }> = {};
  lengths.forEach((ms, i) => (sounds[`s${i}`] = { ms, use: "music" }));
  return { sounds, order: lengths.map((_, i) => `s${i}`) };
}

function run(order: string[], fields: Partial<MusicRun> = {}): MusicRun {
  return { run: "r0", order, index: 0, repeat: "all", fade: 5, now: { soundId: order[0]!, at: T }, ...fields };
}

function playing(music: MusicRun | null): Playing {
  return { rev: 3, music, loops: {}, effects: [], volume: { music: 80, effects: 80 } };
}

function step(music: MusicRun, sounds: SoundLengths, t: number): MusicRun | null {
  const out = soundStep(playing(music), sounds, t);
  assert.ok(out.changed, `a step at ${t - T} ms changes the run`);
  return out.changed ? out.music : music;
}

describe("the server moves the music on (6.4)", () => {
  test("a track of 3:10 with a 5 s crossfade is revealed 20 s before the next starts, crossed, and promoted when the crossing ends", () => {
    const { sounds, order } = tracks(190_000, 190_000, 190_000);
    const first = run(order);
    assert.equal(soundDue(playing(first), sounds), T + 165_000, "the reveal");
    assert.deepEqual(soundStep(playing(first), sounds, T + 164_999), { changed: false });
    const revealed = step(first, sounds, T + 165_000)!;
    assert.deepEqual(revealed.next, { soundId: "s1", at: T + 185_000 });
    assert.equal(revealed.now, first.now, "the track sounding stays now through the crossing");
    assert.equal(soundDue(playing(revealed), sounds), T + 190_000, "promoted when the outgoing track has ended");
    const promoted = step(revealed, sounds, T + 190_000)!;
    assert.deepEqual(promoted.now, { soundId: "s1", at: T + 185_000 });
    assert.equal(promoted.index, 1);
    assert.equal(promoted.next, undefined);
    assert.equal(soundDue(playing(promoted), sounds), T + 185_000 + 190_000 - 5_000 - 20_000);
  });

  test("tracks of 30 s with a 10 s crossfade are revealed 10 s before each start, never during the crossing into now", () => {
    const { sounds, order } = tracks(30_000, 30_000);
    const first = run(order, { fade: 10 });
    assert.equal(soundDue(playing(first), sounds), T + 10_000);
    const revealed = step(first, sounds, T + 10_000)!;
    assert.deepEqual(revealed.next, { soundId: "s1", at: T + 20_000 });
    // The crossing into s1 ends at 30 s, which is also when s0's reveal falls due, so one step does both.
    const promoted = step(revealed, sounds, T + 30_000)!;
    assert.deepEqual(promoted.now, { soundId: "s1", at: T + 20_000 });
    assert.deepEqual(promoted.next, { soundId: "s0", at: T + 40_000 }, "revealed 10 s before its start, once the crossing into now ended");
    assert.equal(soundDue(playing(promoted), sounds), T + 50_000);
  });

  test("Repeat off ends the run when its last track ends, Repeat all goes round, Repeat one never ticks", () => {
    const { sounds, order } = tracks(40_000);
    assert.equal(soundDue(playing(run(order, { repeat: "off" })), sounds), T + 40_000);
    assert.deepEqual(soundStep(playing(run(order, { repeat: "off" })), sounds, T + 40_000), { changed: true, music: null });
    assert.deepEqual(step(run(order), sounds, T + 15_000)!.next, { soundId: "s0", at: T + 35_000 }, "one track under Repeat all crosses into itself");
    assert.equal(soundDue(playing(run(order, { repeat: "one" })), sounds), null);
    assert.equal(soundDue(playing(run(order, { paused: 1_000 })), sounds), null);
    assert.equal(soundDue(playing(null), sounds), null);
    assert.equal(following(run(order, { repeat: "off" })), null);
  });

  test("a step an hour late skips whole passes and lands where stepping through each change would", () => {
    const { sounds, order } = tracks(30_000, 30_000);
    const late = soundStep(playing(run(order, { fade: 0 })), sounds, T + 3_600_000);
    assert.deepEqual(late, { changed: true, music: { ...run(order, { fade: 0 }), now: { soundId: "s0", at: T + 3_600_000 } } });
    let each: MusicRun | null = run(order, { fade: 0 });
    for (let t = T; each && soundDue(playing(each), sounds)! <= T + 3_600_000; ) {
      t = soundDue(playing(each), sounds)!;
      each = step(each, sounds, t);
    }
    assert.deepEqual(each, late.changed ? late.music : null);
  });

  test("a track whose sound is gone ends the run at once", () => {
    const { sounds, order } = tracks(30_000);
    assert.deepEqual(soundStep(playing(run(["gone", ...order])), sounds, T), { changed: true, music: null });
  });
});

describe("the DM's music ops act on the track sounding at t (6.3)", () => {
  const { sounds, order } = tracks(60_000, 60_000, 60_000);
  /** A to B crossfading from T+50 s to T+60 s. */
  const crossing = (): MusicRun => ({ ...run(order, { fade: 10 }), next: { soundId: "s1", at: T + 50_000 } });

  test("a pause during the A to B crossfade promotes B first and keeps B's own place, and a resume a minute later goes on from it", () => {
    const paused = musicChanged(crossing(), { t: "pause" }, sounds, T + 55_000)!;
    assert.deepEqual(paused.now, { soundId: "s1", at: T + 50_000 });
    assert.equal(paused.index, 1);
    assert.equal(paused.paused, 5_000);
    assert.equal(paused.next, undefined);
    const resumed = musicChanged(paused, { t: "resume", run: "r1" }, sounds, T + 115_000)!;
    assert.deepEqual(resumed.now, { soundId: "s1", at: T + 110_000 });
    assert.equal(resumed.run, "r1");
    assert.equal(resumed.paused, undefined);
  });

  test("a resume near a track's end reveals its next at once, never before t, and the crossfade shortens to what remains", () => {
    const paused = { ...run(order, { fade: 10 }), paused: 55_000 };
    const resumed = musicChanged(paused, { t: "resume", run: "r1" }, sounds, T + 200_000)!;
    assert.deepEqual(resumed.now, { soundId: "s0", at: T + 145_000 });
    assert.deepEqual(resumed.next, { soundId: "s1", at: T + 200_000 });
    assert.equal(crossEndAt(resumed.now, 60_000, resumed.next!, 10_000), T + 205_000, "the outgoing track's end");
  });

  test("a skip during a crossing goes past the incoming track, and Repeat off's last track ends the run", () => {
    const skipped = musicChanged(crossing(), { t: "skip", run: "r1" }, sounds, T + 55_000)!;
    assert.deepEqual(skipped.now, { soundId: "s2", at: T + 55_000 });
    assert.equal(skipped.index, 2);
    assert.equal(musicChanged({ ...run(order, { repeat: "off" }), index: 2, now: { soundId: "s2", at: T } }, { t: "skip", run: "r1" }, sounds, T + 1_000), null);
    assert.deepEqual(musicChanged({ ...run(order), index: 2, now: { soundId: "s2", at: T } }, { t: "skip", run: "r1" }, sounds, T + 1_000)!.now, { soundId: "s0", at: T + 1_000 });
  });

  test("a change of crossfade during a crossing promotes first, and B keeps its own place", () => {
    const set = musicChanged(crossing(), { t: "set", fade: 2 }, sounds, T + 55_000)!;
    assert.deepEqual(set.now, { soundId: "s1", at: T + 50_000 });
    assert.equal(set.fade, 2);
    assert.equal(playingAt(set, T + 55_000).soundId, "s1");
  });

  test("Repeat one to all in the third pass keeps the place heard, and the next track follows this pass", () => {
    const one = run(order, { repeat: "one", fade: 5 });
    // A 60 s track crossing itself over 5 s repeats every 55 s: the third pass starts 110 s in.
    const set = musicChanged(one, { t: "set", repeat: "all" }, sounds, T + 130_000)!;
    assert.deepEqual(set.now, { soundId: "s0", at: T + 110_000 });
    assert.equal(set.next, undefined, "not revealed yet");
    assert.equal(soundDue(playing(set), sounds), T + 145_000);
    assert.deepEqual(step(set, sounds, T + 145_000)!.next, { soundId: "s1", at: T + 165_000 });
  });

  test("reanchor during Repeat one's crossing keeps the occurrence fading in", () => {
    const one = run(order, { repeat: "one", fade: 5 });
    const set = reanchor({ ...one, repeat: "off" }, one, sounds, T + 57_000);
    assert.deepEqual(set.now, { soundId: "s0", at: T + 55_000 });
  });

  test("a stop and a change on no run are silence, and a pause of a paused run keeps it", () => {
    assert.equal(musicChanged(crossing(), { t: "stop" }, sounds, T + 1_000), null);
    assert.equal(musicChanged(null, { t: "pause" }, sounds, T + 1_000), null);
    const paused = { ...run(order), paused: 4_000 };
    assert.deepEqual(musicChanged(paused, { t: "pause" }, sounds, T + 90_000), paused);
    assert.deepEqual(musicAt(paused, sounds, T + 900_000), paused, "a paused run never moves on");
  });
});

describe("fired effects", () => {
  test("a built-in sounds 2 s at most, a room effect its length, and history nothing", () => {
    const sounds: SoundLengths = { thunder: { ms: 25_000, use: "effect" }, rain: { ms: 60_000, use: "loop" } };
    assert.equal(effectLengthMs({ id: "e1", builtin: "rumble", at: T }, sounds), 2_000);
    assert.equal(effectLengthMs({ id: "e2", soundId: "thunder", at: T }, sounds), 25_000);
    assert.equal(effectLengthMs({ id: "e3", soundId: "rain", at: T }, sounds), 0, "a sound given another use is history");
    assert.equal(effectLengthMs({ id: "e4", soundId: "gone", at: T }, sounds), 0);
  });
});

describe("a change of crossfade keeps the next track's reveal within 20 s (docs/design/design-v1-sound-dm-only.md 9)", () => {
  test("a 30 s track at Crossfade 2, revealed at 8 s and set to 10 s at 9 s, keeps its next, now 11 s ahead", () => {
    const { sounds, order } = tracks(30_000, 30_000);
    const first = run(order, { fade: 2 });
    assert.equal(soundDue(playing(first), sounds), T + 8_000);
    const revealed = step(first, sounds, T + 8_000)!;
    assert.deepEqual(revealed.next, { soundId: "s1", at: T + 28_000 });
    const set = musicChanged(revealed, { t: "set", fade: 10 }, sounds, T + 9_000)!;
    assert.deepEqual(set.next, { soundId: "s1", at: T + 20_000 }, "kept, though the clamp would reveal it at 10 s under the new fade");
  });

  test("Crossfade 10 s set to Off just after a reveal withdraws the next track, and the tick reveals it again 20 s before its start", () => {
    const { sounds, order } = tracks(60_000, 60_000);
    const revealed = step(run(order, { fade: 10 }), sounds, T + 30_000)!;
    assert.deepEqual(revealed.next, { soundId: "s1", at: T + 50_000 });
    const set = musicChanged(revealed, { t: "set", fade: 0 }, sounds, T + 30_001)!;
    assert.equal(set.next, undefined, "it would start 30 s ahead");
    assert.equal(soundDue(playing(set), sounds), T + 40_000);
    assert.deepEqual(step(set, sounds, T + 40_000)!.next, { soundId: "s1", at: T + 60_000 });
  });

  test("Crossfade Off set to 10 s just after a reveal keeps the next track, now 10 s ahead", () => {
    const { sounds, order } = tracks(60_000, 60_000);
    const revealed = step(run(order, { fade: 0 }), sounds, T + 40_000)!;
    assert.deepEqual(revealed.next, { soundId: "s1", at: T + 60_000 });
    const set = musicChanged(revealed, { t: "set", fade: 10 }, sounds, T + 40_000)!;
    assert.deepEqual(set.next, { soundId: "s1", at: T + 50_000 });
  });

  test("a next exactly 20 s ahead stays, one a millisecond further leaves", () => {
    const { sounds, order } = tracks(60_000, 60_000);
    const revealed = step(run(order, { fade: 10 }), sounds, T + 30_000)!;
    assert.deepEqual(musicChanged(revealed, { t: "set", fade: 5 }, sounds, T + 35_000)!.next, { soundId: "s1", at: T + 55_000 });
    assert.equal(musicChanged(revealed, { t: "set", fade: 5 }, sounds, T + 34_999)!.next, undefined);
    // The schedule never reveals inside the crossing into now, so only a hand-made run meets the edge where the clamp would
    // reveal later: a 35 s track 5 s in, set to 10 s, whose next would start exactly 20 s ahead.
    const { sounds: short, order: two } = tracks(35_000, 35_000);
    const early: MusicRun = { ...run(two, { fade: 0 }), next: { soundId: "s1", at: T + 35_000 } };
    assert.deepEqual(reanchor({ ...early, fade: 10 }, early, short, T + 5_000).next, { soundId: "s1", at: T + 25_000 });
  });

  test("a set stored before op version 50 keeps a revealed next wherever it now starts, as it played", () => {
    const { sounds, order } = tracks(60_000, 60_000);
    const revealed = step(run(order, { fade: 10 }), sounds, T + 30_000)!;
    const old = musicChanged(revealed, { t: "set", fade: 0 }, sounds, T + 30_000, false)!;
    assert.deepEqual(old.next, { soundId: "s1", at: T + 60_000 }, "30 s ahead");
    assert.deepEqual(reanchor({ ...revealed, fade: 0 }, revealed, sounds, T + 30_000, false).next, old.next);
    assert.equal(reanchor({ ...revealed, fade: 0 }, revealed, sounds, T + 30_000).next, undefined);
  });

  test("Repeat one, and Repeat off on the last track, drop the next track by design", () => {
    const { sounds, order } = tracks(60_000, 60_000);
    const revealed = step(run(order, { fade: 5 }), sounds, T + 35_000)!;
    assert.ok(revealed.next);
    assert.equal(musicChanged(revealed, { t: "set", repeat: "one" }, sounds, T + 36_000)!.next, undefined);
    const last = step({ ...run(order, { fade: 5 }), index: 1, now: { soundId: "s1", at: T } }, sounds, T + 35_000)!;
    assert.deepEqual(last.next, { soundId: "s0", at: T + 55_000 });
    assert.equal(musicChanged(last, { t: "set", repeat: "off" }, sounds, T + 36_000)!.next, undefined);
  });
});
