import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MusicRun, SoundLengths } from "#shared/sound.ts";
import { comingNext, dragKey, dropSlot, keyMove, keyMovedInList, makeRoom, moveTo, movedInList, placeOf, previousTarget, queueLists } from "./dragOrder.ts";

/*
 * Up next's lists and moves (docs/design/design-v1-music-player.md 4.3 and
 * 10): the lists from the track Now playing names, numbered across both,
 * the seam as one slot, Home and End by name, what ends a drag, Previous's
 * rule and the Sound group's Next line.
 */

const T = 1_000_000;
const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
const sounds: SoundLengths = Object.fromEntries(ids.map((id) => [id, { ms: 60_000, use: "music" as const }]));

/** A Tavern night run at "3 of 12", t3 playing since T. */
function run(over: Partial<MusicRun> = {}): MusicRun {
  return { run: "r1", playlistId: "pl", order: ids, index: 2, repeat: "all", fade: 5, now: { soundId: "t3", at: T }, ...over };
}

describe("the lists", () => {
  test("Repeat all: Up next after the playing track, then the order from the top up to it, numbered across both", () => {
    const lists = queueLists(run(), sounds, T + 1_000)!;
    assert.deepEqual(lists.ahead, ids.slice(3));
    assert.deepEqual(lists.again, ["t1", "t2"]);
    assert.deepEqual(lists.played, []);
    assert.deepEqual(placeOf(lists, "t4"), { place: 1, of: 11 });
    assert.deepEqual(placeOf(lists, "t1"), { place: 10, of: 11 }, "the second list goes on from the first");
    assert.equal(placeOf(lists, "t3"), null, "the playing track has no row");
  });

  test("Repeat off: Up next alone is numbered, and the tracks heard are Played, with no handle", () => {
    const lists = queueLists(run({ repeat: "off" }), sounds, T + 1_000)!;
    assert.deepEqual(lists.again, []);
    assert.deepEqual(lists.played, ["t1", "t2"]);
    assert.deepEqual(placeOf(lists, "t4"), { place: 1, of: 9 });
    assert.equal(placeOf(lists, "t1"), null);
  });

  test("from next.at the incoming track is Now playing and leaves Up next, before the stored index moves", () => {
    const crossing = run({ next: { soundId: "t4", at: T + 55_000 } });
    const before = queueLists(crossing, sounds, T + 54_999)!;
    assert.equal(before.playing, "t3");
    assert.equal(before.ahead[0], "t4");
    const after = queueLists(crossing, sounds, T + 55_000)!;
    assert.equal(after.playing, "t4", "the crossfade has started: the incoming track plays");
    assert.equal(after.index, 3);
    assert.equal(after.ahead.includes("t4"), false, "so Remove offers no row for it");
    assert.equal(after.ahead[0], "t5");
    assert.deepEqual(after.again, ["t1", "t2", "t3"]);
  });

  test("no run, no lists", () => {
    assert.equal(queueLists(null, sounds, T), null);
  });
});

describe("moves", () => {
  const lists = queueLists(run(), sounds, T + 1_000)!;

  test("a drop at a slot names its neighbour after, and the first and last places by name", () => {
    assert.deepEqual(moveTo(lists, "t6", 1), { t: "move", soundId: "t6", to: { before: "t5" } });
    assert.deepEqual(moveTo(lists, "t6", 0), { t: "move", soundId: "t6", to: "first" });
    assert.deepEqual(moveTo(lists, "t6", 10), { t: "move", soundId: "t6", to: "last" });
    assert.equal(moveTo(lists, "t6", 2), null, "where it already is");
    assert.equal(moveTo(lists, "t3", 0), null, "the playing track has no row to move");
  });

  test("the seam is one slot, the order's end, for a row from either list", () => {
    // Up next holds 9 rows, so the seam is slot 8 among a first-list row's 10 others, and 9 among a second-list row's.
    assert.deepEqual(moveTo(lists, "t4", 8), { t: "move", soundId: "t4", to: "passEnd" }, "a first-list row dropped at the end of Up next");
    assert.deepEqual(moveTo(lists, "t2", 9), { t: "move", soundId: "t2", to: "passEnd" }, "a second-list row dropped at the seam");
    assert.equal(moveTo(lists, "t12", 8), null, "Up next's last row is at the seam already");
    assert.deepEqual(moveTo(lists, "t1", 9), { t: "move", soundId: "t1", to: "passEnd" }, "the second list's first row stands at the seam in play order, yet moves from the order's start to its end, 3 of 12 becoming 2 of 12");
  });

  test("Up and Down step one place in play order and past the seam, Home and End go to the named ends", () => {
    assert.deepEqual(keyMove(lists, "t5", "ArrowUp"), { t: "move", soundId: "t5", to: "first" });
    assert.deepEqual(keyMove(lists, "t5", "ArrowDown"), { t: "move", soundId: "t5", to: { before: "t7" } });
    assert.deepEqual(keyMove(lists, "t12", "ArrowDown"), { t: "move", soundId: "t12", to: { before: "t2" } }, "Down from Up next's last row goes after the second list's first");
    assert.deepEqual(keyMove(lists, "t1", "ArrowUp"), { t: "move", soundId: "t1", to: { before: "t12" } }, "Up from the second list's first row goes before Up next's last");
    assert.deepEqual(keyMove(lists, "t11", "ArrowDown"), { t: "move", soundId: "t11", to: "passEnd" }, "a row that becomes Up next's last stays in Up next");
    assert.deepEqual(keyMove(lists, "t2", "ArrowUp"), { t: "move", soundId: "t2", to: { before: "t1" } }, "a row that becomes the second list's first stays in it");
    assert.deepEqual(keyMove(lists, "t8", "Home"), { t: "move", soundId: "t8", to: "first" });
    assert.deepEqual(keyMove(lists, "t8", "End"), { t: "move", soundId: "t8", to: "last" });
    assert.equal(keyMove(lists, "t4", "ArrowUp"), null);
    assert.equal(keyMove(lists, "t4", "Home"), null);
    assert.equal(keyMove(lists, "t2", "ArrowDown"), null);
    assert.equal(keyMove(lists, "t2", "End"), null);
    assert.equal(keyMove(lists, "t5", "Enter"), null);
  });

  test("Repeat off moves within Up next alone, its end the order's", () => {
    const off = queueLists(run({ repeat: "off" }), sounds, T + 1_000)!;
    assert.deepEqual(moveTo(off, "t4", 8), { t: "move", soundId: "t4", to: "last" });
    assert.deepEqual(keyMove(off, "t11", "ArrowDown"), { t: "move", soundId: "t11", to: "last" });
    assert.equal(keyMove(off, "t1", "ArrowUp"), null, "a Played row has no handle");
  });
});

describe("a drag", () => {
  test("its slot is the count of the other rows above the dragged row's middle", () => {
    const mids = [28, 84, 140, 196];
    assert.equal(dropSlot(mids, 1, 84), 1);
    assert.equal(dropSlot(mids, 1, 150), 2);
    assert.equal(dropSlot(mids, 1, 10), 0);
    assert.equal(dropSlot(mids, 1, 999), 3);
  });

  test("the others make room in the slot's list, and close the gap in the row's own", () => {
    // Up next t4 t5 t6, the second list t1 t2, as play order: [0, 0, 0, 1, 1].
    const lists = [0, 0, 0, 1, 1];
    assert.deepEqual(makeRoom(lists, 0, 2, 50), [0, -50, -50, 0, 0], "t4 to Up next's end, the seam: t5 and t6 rise, the second list stays");
    assert.deepEqual(makeRoom(lists, 0, 3, 50), [0, -50, -50, 0, 50], "t4 between t1 and t2: t2 drops");
    assert.deepEqual(makeRoom(lists, 2, 0, 50), [50, 50, 0, 0, 0], "t6 to the top: the two above drop");
    assert.deepEqual(makeRoom(lists, 3, 3, 50), [0, 0, 0, 0, -50], "t1 at the seam shows under Up next, so t2 closes its gap");
    assert.deepEqual(makeRoom(lists, 4, 0, 50), [50, 50, 50, 0, 0], "t2 to the top: Up next drops, and t1 stays");
  });

  test("it holds on to the run, the playing track and the order by value, never the run's object", () => {
    const a = queueLists(run(), sounds, T + 1_000)!;
    const louder = queueLists({ ...run(), fade: 5 }, sounds, T + 2_000)!;
    assert.equal(dragKey(a), dragKey(louder), "a new object with the same run, track and order keeps the drag");
    assert.notEqual(dragKey(a), dragKey(queueLists(run({ order: [...ids].reverse(), index: 9 }), sounds, T + 1_000)), "a new order ends it");
    assert.notEqual(dragKey(a), dragKey(queueLists(run({ run: "r2" }), sounds, T + 1_000)), "a new run ends it");
    const crossing = run({ next: { soundId: "t4", at: T + 55_000 } });
    assert.notEqual(dragKey(queueLists(crossing, sounds, T + 54_999)), dragKey(queueLists(crossing, sounds, T + 55_000)), "next.at ends it, with no frame from the server");
  });
});

describe("the maker's list", () => {
  test("a move to a slot among the others, and the keys", () => {
    assert.deepEqual(movedInList(["a", "b", "c", "d"], "d", 1), ["a", "d", "b", "c"]);
    assert.equal(movedInList(["a", "b", "c"], "b", 1), null);
    assert.deepEqual(keyMovedInList(["a", "b", "c"], "b", "ArrowUp"), ["b", "a", "c"]);
    assert.deepEqual(keyMovedInList(["a", "b", "c"], "b", "End"), ["a", "c", "b"]);
    assert.deepEqual(keyMovedInList(["a", "b", "c"], "c", "Home"), ["c", "a", "b"]);
    assert.equal(keyMovedInList(["a", "b", "c"], "a", "ArrowUp"), null);
  });
});

describe("Previous", () => {
  test("the track's start once 3 s have played, else the one before, wrapping under Repeat all and one, the first's start under Repeat off", () => {
    const at3 = queueLists(run(), sounds, T)!;
    assert.equal(previousTarget(at3, 2_000), "t2", "0:02 of track 3");
    assert.equal(previousTarget(at3, 40_000), "t3", "0:40 of track 3");
    assert.equal(previousTarget(at3, 3_000), "t3");
    const first = (repeat: "all" | "one" | "off") => queueLists(run({ repeat, index: 0, now: { soundId: "t1", at: T } }), sounds, T)!;
    assert.equal(previousTarget(first("off"), 2_000), "t1");
    assert.equal(previousTarget(first("one"), 2_000), "t12");
    assert.equal(previousTarget(first("all"), 2_000), "t12");
  });
});

describe("the Next line", () => {
  test("the track that follows, this track again, or the last", () => {
    assert.deepEqual(comingNext(run(), sounds, T), { t: "track", soundId: "t4" });
    assert.deepEqual(comingNext(run({ repeat: "one" }), sounds, T), { t: "again" });
    assert.deepEqual(comingNext(run({ order: ["t3"], index: 0, playlistId: undefined }), sounds, T), { t: "again" }, "one track under Repeat all");
    assert.deepEqual(comingNext(run({ repeat: "off", index: 11, now: { soundId: "t12", at: T } }), sounds, T), { t: "last" });
    assert.equal(comingNext(null, sounds, T), null);
  });
});
