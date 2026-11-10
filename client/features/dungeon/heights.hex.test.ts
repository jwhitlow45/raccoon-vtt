import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mouthCounts, runDirections, runFits, runFor } from "./heights.ts";
import { latticeFor } from "./lattice.ts";
import { Board, placeDoorway, type Rect, type Side } from "./layout.ts";

/*
 * Runs on hexes (phase 3, 2.3, D-261110-087): along the row from east and
 * west doorways, on the slant away from the room's middle from north and
 * south ones, then the other slant, a Wide run's two lanes the same way,
 * each stair facing along the axis, and nothing beside a run's landing or
 * stairs open to a corridor. A corridor keeps off a room's six sides.
 */

const L = latticeFor("hexRows", { w: 40, h: 40 });
const ROOM: Rect = { x: 14, y: 14, w: 10, h: 8 };

function doorAt(side: Side, along: number, width: 1 | 2 = 1) {
  const board = new Board(L.W, L.H, [ROOM], L);
  const target: Rect =
    side === "n" ? { x: ROOM.x + along, y: 0, w: 1, h: 1 } : side === "s" ? { x: ROOM.x + along, y: L.H - 1, w: 1, h: 1 } : side === "w" ? { x: 0, y: ROOM.y + along, w: 1, h: 1 } : { x: L.W - 1, y: ROOM.y + along, w: 1, h: 1 };
  const d = placeDoorway(board, 0, [side], target, width, 0)!;
  return { board, d };
}

const xy = (k: number): [number, number] => [k % L.W, Math.floor(k / L.W)];

describe("hex runs", () => {
  test("east and west doorways run along the row, north and south ones on the slant away from the room's middle first", () => {
    assert.deepEqual(runDirections(doorAt("e", 3).board, doorAt("e", 3).d), [0]);
    assert.deepEqual(runDirections(doorAt("w", 3).board, doorAt("w", 3).d), [3]);
    const ne = doorAt("n", 7);
    assert.deepEqual(runDirections(ne.board, ne.d), [5, 4], "east of the middle: north-east first");
    const nw = doorAt("n", 2);
    assert.deepEqual(runDirections(nw.board, nw.d), [4, 5], "west of the middle: north-west first");
    const se = doorAt("s", 7);
    assert.deepEqual(runDirections(se.board, se.d), [1, 2]);
    const sw = doorAt("s", 2);
    assert.deepEqual(runDirections(sw.board, sw.d), [2, 1]);
  });

  for (const ground of [10, -10, 5, -5]) {
    for (const width of [1, 2] as const) {
      test(`${ground > 0 ? "+" : ""}${ground} ft on ${width === 1 ? "Narrow" : "Wide"}: every lane steps along its hex axis, each stair facing along it`, () => {
        for (const side of ["n", "e", "s", "w"] as const) {
          const { board, d } = doorAt(side, 3, width);
          for (const dir of runDirections(board, d)) {
            const run = runFor(board, d, ground, dir);
            const n = Math.abs(ground) / 5;
            assert.equal(run.dir, dir);
            assert.deepEqual(run.near, d.outside);
            assert.equal(run.stairs.length, n * width);
            for (let lane = 0; lane < width; lane++) {
              const chain = [run.near[lane]!, ...run.stairs.filter((_, j) => j % width === lane).map((s) => s.cell), run.far[lane]!];
              for (let i = 0; i + 1 < chain.length; i++) assert.equal(L.step(chain[i]!, dir, 1), chain[i + 1], `${side} lane ${lane} step ${i}`);
            }
            const up = String(ground > 0 ? (dir + 3) % 6 : dir);
            assert.ok(run.stairs.every((s) => s.up === up), `${side} stairs face ${up}`);
            assert.equal(run.stairs.at(-1)!.ground, 0);
            const own = new Set([...run.near, ...run.stairs.map((s) => s.cell), ...run.far]);
            for (const k of run.beside) {
              assert.ok(!own.has(k) && board.roomAt[k] === 0, "beside is outside the run and the room");
            }
            for (const k of [...run.near, ...run.stairs.map((s) => s.cell)]) for (const b of L.halo(k)) assert.ok(own.has(b) || board.roomAt[b] !== 0 || run.beside.includes(b), `${side}: ${xy(b)} beside the run is closed`);
          }
        }
      });
    }
  }

  test("a north run that does not fit on its first slant takes the other", () => {
    // A second room north-east of the doorway, so the north-east slant runs into its halo and the north-west one is clear.
    const blocker: Rect = { x: ROOM.x + 9, y: ROOM.y - 8, w: 5, h: 4 };
    const board = new Board(L.W, L.H, [ROOM, blocker], L);
    const d = placeDoorway(board, 0, ["n"], { x: ROOM.x + 7, y: 0, w: 1, h: 1 }, 1, 0)!;
    const mouths = mouthCounts(board);
    const [first, second] = runDirections(board, d);
    assert.equal(first, 5);
    assert.equal(runFits(board, d, runFor(board, d, 10, first), mouths), false);
    assert.ok(runFits(board, d, runFor(board, d, 10, second), mouths));
  });

  test("a corridor keeps off a room's slanted sides too: a hex that touches the room only on a slant is in its halo", () => {
    const board = new Board(L.W, L.H, [ROOM], L);
    // The room's corner hex at 14, 14 sits on an even row, so the hex north-west of it, 13, 13, touches it only on a slant.
    const corner = ROOM.y * L.W + ROOM.x;
    const slant = [4, 5].map((d) => L.step(corner, d, 1)!).find((k) => k % L.W !== ROOM.x)!;
    assert.ok(board.halo(slant), "a slant neighbor is beside the room");
    assert.ok(!board.halo(slant - 2 * L.W), "two rows up is not");
  });
});
