import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MusicRefusal, jumpedAt, musicAt, positionAt, queueEdited, seededShuffle, seekBoundMs, type MusicRefusalKey, type MusicRun, type Playlist, type QueueContext, type QueueEdit, type SoundLengths } from "./sound.ts";

/**
 * The queue's rules (docs/design/design-v1-music-player.md 6.2 to 6.5 and
 * the cases of section 10) on the helpers alone: each edit, each refusal
 * and each edit that writes nothing, where `next` lands, a paused run,
 * jumps, the seek's bound and the seeded shuffle's pinned output.
 */

const T = 1_800_000_000_000;
const TWELVE = Array.from({ length: 12 }, (_, i) => `s${i}`);

/** Music tracks of 60 s named s0 up to s(n-1), x1 and x2 outside every run, and a background sound. */
function library(n = 12): SoundLengths {
  const sounds: Record<string, { ms: number; use: "music" | "loop" }> = { x1: { ms: 60_000, use: "music" }, x2: { ms: 60_000, use: "music" }, rain: { ms: 30_000, use: "loop" } };
  for (let i = 0; i < n; i++) sounds[`s${i}`] = { ms: 60_000, use: "music" };
  return sounds;
}

const SOUNDS = library();

/** A run of `order` playing its track at `index` from T, under Repeat all with a 5 s crossfade unless `fields` say otherwise. */
function at(order: string[], index: number, fields: Partial<MusicRun> = {}): MusicRun {
  return { run: "r1", playlistId: "tavern", order, index, repeat: "all", fade: 5, now: { soundId: order[index]!, at: T }, ...fields };
}

function ctx(playlist: Pick<Playlist, "sounds"> | null = { sounds: TWELVE }, sounds: SoundLengths = SOUNDS): QueueContext {
  return { sounds, playlist };
}

/** Before the reveal of a 60 s track with a 5 s crossfade, which comes 35 s in. */
const EARLY = T + 1_000;

function edited(music: MusicRun, edit: QueueEdit, t = EARLY, context = ctx()): MusicRun {
  return queueEdited(music, edit, context, t);
}

function refused(key: MusicRefusalKey, rule: () => unknown): void {
  assert.throws(rule, (e: unknown) => e instanceof MusicRefusal && e.key === key, key);
}

/** "3 of 12": s2 plays, s0 and s1 come again under Repeat all after s11. */
const THIRD = at(TWELVE, 2);
const order = (...n: number[]) => n.map((i) => `s${i}`);

describe("Play next and Add to queue (6.4)", () => {
  test("Play next of a playlist while one of its tracks plays puts the others right after it in the order given, moving any the run holds", () => {
    assert.deepEqual(edited(THIRD, { t: "next", soundIds: ["s5", "s2", "s9"] }), { ...THIRD, order: order(0, 1, 2, 5, 9, 3, 4, 6, 7, 8, 10, 11) }, "no refusal for the playing track");
    assert.deepEqual(edited(THIRD, { t: "next", soundIds: ["x1", "s0"] }), { ...THIRD, order: ["s1", "s2", "x1", "s0", ...order(3, 4, 5, 6, 7, 8, 9, 10, 11)], index: 1 }, "a track heard before moves out from before the playing one");
  });

  test("Play next writes nothing for the playing track alone or tracks already next in that order", () => {
    assert.equal(edited(THIRD, { t: "next", soundIds: ["s2"] }), THIRD);
    assert.equal(edited(THIRD, { t: "next", soundIds: ["s3", "s4"] }), THIRD);
  });

  test("every id an edit adds is a music sound", () => {
    refused("notMusic", () => edited(THIRD, { t: "next", soundIds: ["s4", "rain"] }));
    refused("notMusic", () => edited(THIRD, { t: "add", soundIds: ["ghost"] }));
  });

  test("Add to queue appends what the run lacks, and under Repeat all leaves every track it holds where it is", () => {
    assert.deepEqual(edited(THIRD, { t: "add", soundIds: ["s0", "x1", "s2", "s7"] }), { ...THIRD, order: [...TWELVE, "x1"] });
    assert.equal(edited(THIRD, { t: "add", soundIds: ["s0", "s7"] }), THIRD, "every one still to come: nothing written");
    const one = at(TWELVE, 2, { repeat: "one" });
    assert.equal(edited(one, { t: "add", soundIds: ["s0"] }), one, "Repeat one shapes the queue as Repeat all does");
  });

  test("Add to queue under Repeat off moves a heard track to the end, so it plays again, and leaves one still to come in place", () => {
    const fifth = at(order(0, 1, 2, 3, 4, 5, 6, 7), 4, { repeat: "off" });
    assert.deepEqual(edited(fifth, { t: "add", soundIds: ["s1", "s6", "x1", "s4"] }), { ...fifth, order: order(0, 2, 3, 4, 5, 6, 7, 1).concat("x1"), index: 3 });
    assert.equal(edited(fifth, { t: "add", soundIds: ["s6"] }), fifth);
  });

  test("the queue holds 100 tracks at most", () => {
    const sounds = library(100);
    const full = at(Array.from({ length: 100 }, (_, i) => `s${i}`), 0);
    refused("queueFull", () => edited(full, { t: "add", soundIds: ["x1"] }, EARLY, ctx(null, sounds)));
    refused("queueFull", () => edited(full, { t: "next", soundIds: ["x1", "s5"] }, EARLY, ctx(null, sounds)));
    const almost = at(Array.from({ length: 99 }, (_, i) => `s${i}`), 0);
    assert.equal(edited(almost, { t: "add", soundIds: ["x1"] }, EARLY, ctx(null, sounds)).order?.length, 100);
  });
});

describe("moves and removes (6.4, 4.3)", () => {
  test("first, the seam, the cycle's end and before a track, each resolved at the edit's time", () => {
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s9", to: "first" }).order, order(0, 1, 2, 9, 3, 4, 5, 6, 7, 8, 10, 11));
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s5", to: { before: "s3" } }).order, order(0, 1, 2, 5, 3, 4, 6, 7, 8, 9, 10, 11));
    // Under Repeat all the cycle's end is just before the playing track: s5 is then the last of the second list.
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s5", to: "last" }), { ...THIRD, order: order(0, 1, 5, 2, 3, 4, 6, 7, 8, 9, 10, 11), index: 3 });
    const off = at(TWELVE, 2, { repeat: "off" });
    assert.deepEqual(edited(off, { t: "move", soundId: "s5", to: "last" }).order, order(0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 5), "under Repeat off the order's end");
  });

  test("a first-list row dropped at the seam keeps 3 of 12, and a second-list row there reads 2 of 12", () => {
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s4", to: "passEnd" }), { ...THIRD, order: order(0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 4), index: 2 });
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s0", to: "passEnd" }), { ...THIRD, order: order(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0), index: 1 });
    assert.deepEqual(edited(THIRD, { t: "move", soundId: "s0", to: "first" }), { ...THIRD, order: order(1, 2, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11), index: 1 });
  });

  test("the playing track, a track that left and a before naming no other track of the order are refused", () => {
    refused("playingStays", () => edited(THIRD, { t: "move", soundId: "s2", to: "first" }));
    refused("leftQueue", () => edited(THIRD, { t: "move", soundId: "x1", to: "first" }));
    refused("leftQueue", () => edited(THIRD, { t: "move", soundId: "s5", to: { before: "s5" } }));
    refused("leftQueue", () => edited(THIRD, { t: "move", soundId: "s5", to: { before: "x1" } }));
    refused("playingStays", () => edited(THIRD, { t: "remove", soundId: "s2" }));
  });

  test("a move to where the track already is and a remove of a track the order lacks write nothing", () => {
    assert.equal(edited(THIRD, { t: "move", soundId: "s3", to: "first" }), THIRD);
    assert.equal(edited(THIRD, { t: "move", soundId: "s11", to: "passEnd" }), THIRD);
    assert.equal(edited(THIRD, { t: "move", soundId: "s1", to: "last" }), THIRD);
    assert.equal(edited(THIRD, { t: "move", soundId: "s4", to: { before: "s5" } }), THIRD);
    assert.equal(edited(THIRD, { t: "remove", soundId: "x1" }), THIRD);
  });

  test("a remove keeps index on the playing track", () => {
    assert.deepEqual(edited(THIRD, { t: "remove", soundId: "s5" }), { ...THIRD, order: order(0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11) });
    assert.deepEqual(edited(THIRD, { t: "remove", soundId: "s0" }), { ...THIRD, order: order(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), index: 1 });
  });
});

describe("Shuffle (6.4, 6.5)", () => {
  test("on under Repeat all at 3 of 12 mixes every other track by the seed and keeps 3 of 12, then off puts the playlist's order back", () => {
    const on = edited(THIRD, { t: "shuffle", seed: "mix1" });
    // seededShuffle of the other eleven by "mix1", pinned: the playing track keeps its place.
    assert.deepEqual(on, { ...THIRD, order: order(1, 7, 2, 8, 11, 3, 4, 10, 6, 9, 0, 5), shuffle: true });
    assert.equal(edited(on, { t: "shuffle", seed: "mix2" }), on, "on while on writes nothing");
    assert.deepEqual(edited(on, { t: "unshuffle" }), THIRD);
    assert.equal(edited(THIRD, { t: "unshuffle" }), THIRD, "off while off writes nothing");
    const one = at(TWELVE, 2, { repeat: "one" });
    assert.deepEqual(edited(one, { t: "shuffle", seed: "mix1" }), { ...one, order: on.order, shuffle: true }, "Repeat one shuffles as Repeat all");
  });

  test("on under Repeat off at 5 of 8 mixes only tracks 6 to 8, and off after the playlist was deleted only drops the flag", () => {
    const fifth = at(order(0, 1, 2, 3, 4, 5, 6, 7), 4, { repeat: "off" });
    const on = edited(fifth, { t: "shuffle", seed: "abc" });
    assert.deepEqual(on, { ...fifth, order: [...order(0, 1, 2, 3, 4), ...seededShuffle(order(5, 6, 7), "abc")], shuffle: true });
    const { shuffle: _flag, ...off } = on;
    assert.deepEqual(edited(on, { t: "unshuffle" }, EARLY, ctx(null)), off);
  });

  test("off puts tracks the playlist lacks after its own, and under Repeat off touches nothing heard", () => {
    const mixed = at(["s3", "x1", "s0", "s2", "s1"], 3, { shuffle: true });
    assert.deepEqual(edited(mixed, { t: "unshuffle" }, EARLY, ctx({ sounds: order(0, 1, 2, 3) })), at(order(0, 1, 2, 3).concat("x1"), 2));
    const off = at(["s0", "s2", "s4", "s3", "x1", "s1"], 2, { repeat: "off", shuffle: true });
    const { shuffle: _flag, ...plain } = off;
    assert.deepEqual(edited(off, { t: "unshuffle" }, EARLY, ctx({ sounds: order(0, 1, 2, 3, 4) })), { ...plain, order: ["s0", "s2", "s4", "s1", "s3", "x1"] });
  });
});

describe("where the next track lands after an edit (6.4, 6.6)", () => {
  /** s2 with s3 revealed: from 35 s the next starts at 55 s. */
  const revealed = at(TWELVE, 2, { next: { soundId: "s3", at: T + 55_000 } });
  const INSIDE = T + 40_000;

  test("inside the reveal window an edit that changes the following track swaps next to it at the same start", () => {
    assert.deepEqual(edited(revealed, { t: "next", soundIds: ["s7"] }, INSIDE).next, { soundId: "s7", at: T + 55_000 });
    assert.deepEqual(edited(revealed, { t: "remove", soundId: "s3" }, INSIDE).next, { soundId: "s4", at: T + 55_000 }, "a removed next gives way to the track after it");
    assert.deepEqual(edited(revealed, { t: "move", soundId: "s9", to: "passEnd" }, INSIDE).next, { soundId: "s3", at: T + 55_000 }, "one that keeps it keeps it");
  });

  test("before the reveal window an edit reveals nothing early", () => {
    assert.equal(edited(THIRD, { t: "next", soundIds: ["s7"] }).next, undefined);
  });

  test("Add to queue on Repeat off's last track reveals the added track once its reveal is due, never before the edit's time", () => {
    const last = at(order(0, 1, 2, 3), 3, { repeat: "off" });
    assert.equal(edited(last, { t: "add", soundIds: ["x1"] }, T + 10_000).next, undefined, "before the window");
    assert.deepEqual(edited(last, { t: "add", soundIds: ["x1"] }, T + 50_000).next, { soundId: "x1", at: T + 55_000 });
    assert.deepEqual(edited(last, { t: "add", soundIds: ["x1"] }, T + 57_000).next, { soundId: "x1", at: T + 57_000 }, "past its crossfade's start: at the edit's time");
  });

  test("a paused run and Repeat one reveal no next", () => {
    const paused = at(TWELVE, 2, { paused: 50_000 });
    assert.deepEqual(edited(paused, { t: "next", soundIds: ["s7"] }, T + 500_000), { ...paused, order: order(0, 1, 2, 7, 3, 4, 5, 6, 8, 9, 10, 11) });
    assert.equal(edited(at(TWELVE, 2, { repeat: "one" }), { t: "next", soundIds: ["s7"] }, INSIDE).next, undefined);
  });

  test("an edit during an A to B crossfade acts after B, which musicAt promotes first", () => {
    const crossing = musicAt(revealed, SOUNDS, T + 57_000)!;
    assert.deepEqual(crossing.now, { soundId: "s3", at: T + 55_000 });
    const out = edited(crossing, { t: "next", soundIds: ["s9"] }, T + 57_000);
    assert.deepEqual(out.order, order(0, 1, 2, 3, 9, 4, 5, 6, 7, 8, 10, 11));
    assert.equal(out.index, 3);
    assert.deepEqual(edited(crossing, { t: "remove", soundId: "s2" }, T + 57_000).order, order(0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11), "the outgoing track is only queued now");
  });
});

describe("jumps (6.4, 4.2)", () => {
  const t = T + 40_000;

  test("Play now starts the track under the new run at the edit's time, its next not revealed early", () => {
    assert.deepEqual(jumpedAt(THIRD, "r2", "s7", 0, SOUNDS, t), { ...THIRD, run: "r2", index: 7, now: { soundId: "s7", at: t } });
    const revealed = at(TWELVE, 2, { next: { soundId: "s3", at: T + 55_000 } });
    assert.deepEqual(jumpedAt(revealed, "r2", "s7", 0, SOUNDS, t), { ...THIRD, run: "r2", index: 7, now: { soundId: "s7", at: t } }, "a revealed next does not carry over");
  });

  test("a seek places the track ms before t, its next revealed if due, never before t", () => {
    assert.deepEqual(jumpedAt(THIRD, "r2", "s2", 20_000, SOUNDS, t), { ...THIRD, run: "r2", now: { soundId: "s2", at: t - 20_000 } });
    assert.deepEqual(jumpedAt(THIRD, "r2", "s7", 50_000, SOUNDS, t).next, { soundId: "s8", at: T + 45_000 });
    assert.deepEqual(jumpedAt(THIRD, "r2", "s7", 58_000, SOUNDS, t).next, { soundId: "s8", at: t });
  });

  test("a paused run's seek of its own track stays paused at the new place, and a jump to another track plays", () => {
    const paused = at(TWELVE, 2, { paused: 10_000 });
    assert.deepEqual(jumpedAt(paused, "r2", "s2", 30_000, SOUNDS, t), { ...paused, run: "r2", paused: 30_000 });
    const { paused: _was, ...playing } = paused;
    assert.deepEqual(jumpedAt(paused, "r2", "s5", 1_000, SOUNDS, t), { ...playing, run: "r2", index: 5, now: { soundId: "s5", at: t - 1_000 } });
  });

  test("a track the order lacks is refused", () => {
    refused("leftQueue", () => jumpedAt(THIRD, "r2", "x1", 0, SOUNDS, t));
    refused("leftQueue", () => jumpedAt(THIRD, "r2", "rain", 0, SOUNDS, t));
  });

  test("a seek under Repeat one with a crossfade places a single first occurrence", () => {
    const one = at(TWELVE, 2, { repeat: "one", fade: 10 });
    const sought = jumpedAt(one, "r2", "s2", 49_000, SOUNDS, t);
    assert.equal(positionAt(sought, SOUNDS, t), 49_000);
    assert.equal(sought.next, undefined);
  });
});

describe("the seek's bound (4.2, 6.4)", () => {
  test("a track's length, or under Repeat one with a crossfade one pass", () => {
    assert.equal(seekBoundMs({ repeat: "all", fade: 10 }, 60_000), 60_000);
    assert.equal(seekBoundMs({ repeat: "off", fade: 10 }, 60_000), 60_000);
    assert.equal(seekBoundMs({ repeat: "one", fade: 10 }, 60_000), 50_000, "the bar reads 0:50");
    assert.equal(seekBoundMs({ repeat: "one", fade: 0 }, 60_000), 60_000);
    assert.equal(seekBoundMs({ repeat: "one", fade: 10 }, 12_000), 6_000, "a crossing held to half the track, as occurrencesAt holds it");
  });
});

describe("the seeded shuffle (6.5)", () => {
  test("golden outputs for fixed seeds, the same on every device and every replay", () => {
    assert.deepEqual(seededShuffle(TWELVE, "a"), order(8, 0, 1, 6, 9, 2, 4, 11, 5, 10, 3, 7));
    assert.deepEqual(seededShuffle(TWELVE, "r1"), order(5, 8, 0, 3, 7, 9, 11, 1, 2, 6, 10, 4));
    assert.deepEqual(seededShuffle(TWELVE, "Zx-9_q"), order(3, 0, 1, 11, 10, 2, 4, 9, 5, 8, 6, 7));
    assert.deepEqual(seededShuffle(TWELVE, "0".repeat(40)), order(8, 11, 5, 9, 3, 4, 2, 6, 1, 0, 10, 7));
    assert.deepEqual(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "seed"), [7, 3, 4, 2, 6, 8, 5, 9, 1, 10]);
  });

  test("a permutation that leaves its input alone, and nothing to mix for none or one", () => {
    const input = [...TWELVE];
    const out = seededShuffle(input, "r1");
    assert.deepEqual(input, TWELVE);
    assert.deepEqual([...out].sort(), [...TWELVE].sort());
    assert.deepEqual(seededShuffle([], "r1"), []);
    assert.deepEqual(seededShuffle(["s0"], "r1"), ["s0"]);
  });
});
