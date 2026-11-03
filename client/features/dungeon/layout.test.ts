import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Board, chooseEntrance, doorEdge, facingSides, loopLinks, middleDistance, placeDoorway, placeRooms, treeLinks, type Rect } from "./layout.ts";
import { seedStream } from "./random.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

/*
 * Rooms, the entrance, links and doorways (docs/design/design-v1-dungeon-generator.md
 * 5.3 steps 1 to 4), pinned by hand.
 */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("rooms", () => {
  test("stay inside the margin, sides in the density's range, rock between any two", () => {
    for (const density of ["sparse", "normal", "dense"] as const) {
      for (const wide of [false, true]) {
        const rooms = placeRooms(seedStream("1K7QH2MXA9F3TWQ5"), { ...DEFAULT_SETTINGS, w: 60, h: 45, rooms: 20, density, wide });
        const [lo, hi] = { sparse: [3, 6], normal: [4, 9], dense: [5, 12] }[density];
        const gap = { sparse: wide ? 7 : 6, normal: wide ? 5 : 4, dense: wide ? 4 : 3 }[density];
        assert.ok(rooms.length > 3);
        rooms.forEach((r, i) => {
          assert.ok(r.x >= 2 && r.y >= 2 && r.x + r.w <= 58 && r.y + r.h <= 43);
          for (const side of [r.w, r.h]) assert.ok(side >= Math.max(lo!, wide ? 4 : 0) && side <= hi!, `${density} side ${side}`);
          rooms.forEach((o, j) => {
            if (j <= i) return;
            const xg = Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w));
            const yg = Math.max(o.y - (r.y + r.h), r.y - (o.y + o.h));
            assert.ok(Math.max(xg, yg) >= gap);
          });
        });
      }
    }
  });

  test("a layout that leaves rooms out is tried again, so Small's six fit", () => {
    let all = 0;
    for (let i = 0; i < 50; i++) {
      const seed = `1${String(i).padStart(15, "0")}`;
      if (placeRooms(seedStream(seed), { ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 6 }).length === 6) all++;
    }
    // One layout alone fits all six about 40% of the time.
    assert.ok(all >= 47, `${all} of 50`);
  });
});

describe("the entrance", () => {
  test("is the room nearest a scene edge", () => {
    assert.deepEqual(chooseEntrance([rect(10, 10, 4, 4), rect(30, 3, 4, 4), rect(5, 20, 4, 4)], 50, 50), { room: 1, side: "n" });
    assert.deepEqual(chooseEntrance([rect(10, 10, 4, 4), rect(10, 40, 4, 4)], 50, 47), { room: 1, side: "s" });
    assert.deepEqual(chooseEntrance([rect(10, 10, 4, 4), rect(40, 20, 7, 4)], 50, 50), { room: 1, side: "e" });
  });

  test("ties go west, north, east, south, then by room order", () => {
    assert.deepEqual(chooseEntrance([rect(4, 20, 4, 4), rect(20, 4, 4, 4)], 50, 50), { room: 0, side: "w" });
    assert.deepEqual(chooseEntrance([rect(20, 4, 4, 4), rect(4, 20, 4, 4)], 50, 50), { room: 1, side: "w" });
    assert.deepEqual(chooseEntrance([rect(42, 20, 4, 4), rect(20, 4, 4, 4)], 50, 50), { room: 1, side: "n" });
    assert.deepEqual(chooseEntrance([rect(20, 42, 4, 4), rect(42, 20, 4, 4)], 50, 50), { room: 1, side: "e" });
    assert.deepEqual(chooseEntrance([rect(4, 10, 4, 4), rect(4, 30, 4, 4)], 50, 50), { room: 0, side: "w" });
  });
});

describe("links", () => {
  test("Prim's tree from the entrance joins the nearest room each time, a branch after its own link", () => {
    // A row of rooms: from the west end, each joins the one before.
    const row = [rect(30, 10, 4, 4), rect(2, 10, 4, 4), rect(16, 10, 4, 4), rect(9, 10, 4, 4), rect(23, 10, 4, 4)];
    assert.deepEqual(
      treeLinks(row, 1).map((l) => [l.a, l.b]),
      [
        [1, 3],
        [3, 2],
        [2, 4],
        [4, 0],
      ],
    );
    // From the middle the tree grows both ways, nearest first, ties by room order.
    assert.deepEqual(
      treeLinks(row, 2).map((l) => [l.a, l.b]),
      [
        [2, 3],
        [3, 1],
        [2, 4],
        [4, 0],
      ],
    );
  });

  test("an extra way round is a short link whose way round the tree is at least twice as long", () => {
    // A ring of four rooms: the tree is three sides of the square, and the fourth side saves the walk round.
    const ring = [rect(5, 5, 4, 4), rect(25, 5, 4, 4), rect(25, 25, 4, 4), rect(5, 25, 4, 4)];
    const tree = treeLinks(ring, 0);
    assert.equal(tree.length, 3);
    const loops = loopLinks(ring, tree, 1, () => true);
    assert.equal(loops.length, 1);
    const l = loops[0]!;
    const missing = [0, 1, 2, 3].flatMap((a) => [0, 1, 2, 3].map((b) => [a, b])).find(([a, b]) => a! < b! && !tree.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a)) && middleDistance(ring[a!]!, ring[b!]!) === 40);
    assert.deepEqual([l.a, l.b], missing);
    // A diagonal saves too little: its way round is under twice as long.
    const line = [rect(5, 5, 4, 4), rect(25, 5, 4, 4), rect(45, 5, 4, 4)];
    assert.deepEqual(loopLinks(line, treeLinks(line, 0), 1, () => true), []);
    // The count and the door cap both stop them.
    assert.deepEqual(loopLinks(ring, tree, 0, () => true), []);
    assert.deepEqual(loopLinks(ring, tree, 1, () => false), []);
  });
});

describe("doorways", () => {
  test("face the other room across the larger gap", () => {
    assert.deepEqual(facingSides(rect(10, 10, 5, 5), rect(30, 12, 5, 5)), ["e", "s"]);
    assert.deepEqual(facingSides(rect(10, 10, 5, 5), rect(11, 30, 5, 5)), ["s", "e"]);
    assert.deepEqual(facingSides(rect(30, 30, 5, 5), rect(10, 5, 5, 5)), ["n", "w"]);
  });

  test("sit nearest the other room's middle, never at a corner, a square clear of each other", () => {
    const room = rect(10, 10, 6, 6);
    const board = new Board(40, 40, [room]);
    // Aimed at the room's own corner column, the first doorway still keeps off the corner.
    const a = placeDoorway(board, 0, ["n"], rect(10, 0, 1, 1), 1, 0)!;
    assert.equal(a.at, 1);
    assert.deepEqual(a.inside, [board.cell(11, 10)]);
    assert.deepEqual(a.outside, [board.cell(11, 9)]);
    const b = placeDoorway(board, 0, ["n"], rect(10, 0, 1, 1), 1, 1)!;
    assert.equal(b.at, 3);
    const c = placeDoorway(board, 0, ["n"], rect(10, 0, 1, 1), 1, 2);
    // Squares 1 to 4 can hold two doorways a square apart, so a third goes to the next side.
    assert.equal(c, null);
    const d = placeDoorway(board, 0, ["n", "e"], rect(10, 0, 1, 1), 1, 3)!;
    assert.equal(d.side, "e");
  });

  test("a Wide doorway is two squares, and a side too short for one takes none", () => {
    const board = new Board(40, 40, [rect(10, 10, 4, 4), rect(30, 10, 3, 6)]);
    const wide = placeDoorway(board, 0, ["s"], rect(20, 30, 1, 1), 2, 0)!;
    assert.equal(wide.width, 2);
    assert.deepEqual(wide.inside, [board.cell(11, 13), board.cell(12, 13)]);
    assert.equal(placeDoorway(board, 1, ["n"], rect(30, 0, 1, 1), 2, 1), null);
  });

  test("need open rock outside: a doorway facing the margin closely takes none, but the entrance stub's may", () => {
    const board = new Board(40, 40, [rect(3, 10, 5, 5)]);
    assert.equal(placeDoorway(board, 0, ["w"], rect(0, 12, 1, 1), 1, 0), null);
    assert.ok(placeDoorway(board, 0, ["w"], rect(0, 12, 1, 1), 1, -1, true));
  });

  test("need the row out clear of other rooms and the squares touching them", () => {
    // A room 2 squares east: the row out from an east doorway touches it.
    const board = new Board(40, 40, [rect(10, 10, 5, 5), rect(17, 8, 5, 9)]);
    assert.equal(placeDoorway(board, 0, ["e"], rect(30, 12, 1, 1), 1, 0), null);
    assert.ok(placeDoorway(board, 0, ["e", "s"], rect(30, 12, 1, 1), 1, 0)?.side === "s");
  });

  test("door edges name the edge between the inside and outside squares", () => {
    assert.equal(doorEdge(4, 7, "n"), "4,7,n");
    assert.equal(doorEdge(4, 7, "s"), "4,8,n");
    assert.equal(doorEdge(4, 7, "w"), "4,7,w");
    assert.equal(doorEdge(4, 7, "e"), "5,7,w");
  });
});
