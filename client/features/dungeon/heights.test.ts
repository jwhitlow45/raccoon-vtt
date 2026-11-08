import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import type { BuildChunk, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { deriveWalls, indexBuild, LEDGE, RAISED, sceneChunks } from "#shared/rules/walls.ts";
import { apply, room } from "#shared/testutil.ts";
import { builderScene } from "../scenes/create.ts";
import { mouthCounts, raiseRooms, runFits, runFor, RAISES } from "./heights.ts";
import { Board, doorEdge, OPPOSITE, placeDoorway, type Doorway, type Rect, type Side } from "./layout.ts";
import { Stream } from "./random.ts";

/*
 * The eight height and width fixtures (docs/design/design-v1-dungeon-generator.md
 * 5.3 step 5, section 13): +5, +10, -5 and -10 ft on Narrow and Wide, a
 * doorway on each side so every facing is met, landed through the shared
 * reducer and read back with the shared walls rule.
 */

const W = 40;
const H = 40;
const ROOM: Rect = { x: 14, y: 14, w: 10, h: 8 };
const SIDES: readonly Side[] = ["n", "e", "s", "w"];

/** A target off each side of the room, so its doorway sits mid-side. */
function toward(side: Side): Rect {
  const mx = ROOM.x + 4;
  const my = ROOM.y + 3;
  return side === "n" ? { x: mx, y: 0, w: 1, h: 1 } : side === "s" ? { x: mx, y: H - 1, w: 1, h: 1 } : side === "w" ? { x: 0, y: my, w: 1, h: 1 } : { x: W - 1, y: my, w: 1, h: 1 };
}

function fixture(width: 1 | 2, rects: Rect[] = [ROOM]): { board: Board; doors: Doorway[] } {
  const board = new Board(W, H, rects);
  const doors = SIDES.map((side, i) => placeDoorway(board, 0, [side], toward(side), width, i)!);
  return { board, doors };
}

const xy = (board: Board, k: number): [number, number] => [k % board.W, Math.floor(k / board.W)];
const key = (board: Board, k: number) => xy(board, k).join(",");

/** The room and its runs as the landing lane will send them, through the shared reducer. */
function landed(board: Board, doors: readonly Doorway[], ground: number): RoomState {
  const sceneId = "dg";
  let state = room();
  const send = (op: ClientOp) => (state = apply(state, op as never));
  send({ t: "scene.create", scene: builderScene({ id: sceneId, name: "Fixture", w: W, h: H }) });
  const cells: string[] = [];
  for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) for (let x = ROOM.x; x < ROOM.x + ROOM.w; x++) cells.push(`${x},${y}`);
  const runCells = doors.flatMap((d) => [...d.run!.near, ...d.run!.stairs.map((s) => s.cell), ...d.run!.far]);
  send({ t: "build.paint", sceneId, terrain: "stone", cells: [...cells, ...runCells.map((k) => key(board, k))] });
  send({ t: "build.edge", sceneId, edges: doors.flatMap((d) => d.inside.map((k) => ({ key: doorEdge(...xy(board, k), d.side), feature: { kind: "door" as const, state: "closed" as const, secret: false, discovered: false } }))) });
  send({ t: "build.height", sceneId, cells: [...cells, ...doors.flatMap((d) => d.run!.near.map((k) => key(board, k)))], height: ground });
  for (const d of doors) {
    for (const s of d.run!.stairs) {
      if (s.ground !== 0) send({ t: "build.height", sceneId, cells: [key(board, s.cell)], height: s.ground });
      send({ t: "build.stairs", sceneId, cells: [key(board, s.cell)], up: s.up });
    }
  }
  return state;
}

/** Whether the shared walls rule reads a ledge, linked or not, on the edge between two neighbor squares. */
function raisedOn(chunks: Readonly<Record<string, BuildChunk>>, a: [number, number], b: [number, number]): "flat" | "linked" | "ledge" {
  const walls = deriveWalls(indexBuild(sceneChunks(chunks, "dg")), 1, { bounds: { w: W, h: H } });
  const s = walls.stored;
  const vertical = a[0] === b[0];
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  for (let k = 0; k < s.n; k++) {
    if ((s.tags[k]! & RAISED) === 0) continue;
    const [ax, ay, bx, by] = [s.xy[4 * k]!, s.xy[4 * k + 1]!, s.xy[4 * k + 2]!, s.xy[4 * k + 3]!];
    const on = vertical ? ay === y && by === y && Math.min(ax, bx) <= x && x + 1 <= Math.max(ax, bx) : ax === x && bx === x && Math.min(ay, by) <= y && y + 1 <= Math.max(ay, by);
    if (on) return s.tags[k]! & LEDGE ? "ledge" : "linked";
  }
  return "flat";
}

describe("raised and sunk rooms' runs", () => {
  for (const width of [1, 2] as const) {
    for (const ground of RAISES) {
      test(`${ground > 0 ? "+" : ""}${ground} ft on ${width === 1 ? "Narrow" : "Wide"}: the room keeps its height and every stair faces along its run`, () => {
        const { board, doors } = fixture(width);
        const mouths = mouthCounts(board);
        const n = Math.abs(ground) / 5;
        for (const d of doors) {
          const run = runFor(board, d, ground);
          assert.ok(runFits(board, d, run, mouths), `the ${d.side} run fits`);
          board.reserve(d, run);
          // The near landing is the doorway's outside squares, at the room's ground.
          assert.deepEqual(run.near, d.outside);
          // Each stair: one row out per step, its ground G x (n - i) / n, facing up the run.
          assert.equal(run.stairs.length, n * width);
          run.stairs.forEach((s, j) => {
            const i = Math.floor(j / width) + 1;
            // Strictly: the last stair is at 0 ft, never -0.
            assert.equal(s.ground, i === n ? 0 : (ground * (n - i)) / n);
            assert.equal(s.up, ground > 0 ? OPPOSITE[d.side] : d.side, `stair ${i} on the ${d.side} side`);
          });
          assert.equal(run.stairs.at(-1)!.ground, 0);
          // The far landing is one row past the last stair.
          const [fx, fy] = xy(board, run.far[0]!);
          const [ox, oy] = xy(board, d.outside[0]!);
          assert.equal(Math.abs(fx - ox) + Math.abs(fy - oy), n + 1);
          // The squares beside the near landing and the stairs, two per row.
          assert.equal(run.beside.length, 2 * (n + 1));
        }

        const state = landed(board, doors, ground);
        const chunks = state.buildChunks;
        for (const d of doors) {
          const run = d.run!;
          // The near landing touches its own room only, through its door, and nothing else is painted round it.
          for (const k of run.near) {
            const [x, y] = xy(board, k);
            for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
              const n2 = board.cell(x + dx, y + dy);
              const painted = chunks[chunkKey("dg", Math.floor((x + dx) / 16), Math.floor((y + dy) / 16))]?.cells[`${x + dx},${y + dy}`] !== undefined;
              const inRun = [...run.stairs.map((s) => s.cell), ...run.near].includes(n2);
              if (painted) assert.ok(board.roomAt[n2] === 1 || inRun, `near landing ${x},${y} touches ${x + dx},${y + dy}`);
            }
          }
          // Walking the run: door edge flat, each step linked by its stair, the last stair to the far landing flat.
          for (let lane = 0; lane < width; lane++) {
            const chain = [d.inside[lane]!, d.outside[lane]!, ...run.stairs.filter((_, j) => j % width === lane).map((s) => s.cell), run.far[lane]!];
            for (let i = 0; i + 1 < chain.length; i++) {
              const got = raisedOn(chunks, xy(board, chain[i]!), xy(board, chain[i + 1]!));
              assert.notEqual(got, "ledge", `${d.side} run lane ${lane} step ${i}`);
            }
            // A stair's sides are rock, walled, so no square meets them.
            for (const s of run.stairs.filter((_, j) => j % width === lane)) {
              const [x, y] = xy(board, s.cell);
              const [ax, ay] = d.side === "n" || d.side === "s" ? [1, 0] : [0, 1];
              for (const sign of [-1, 1]) {
                const sx = x + ax * sign;
                const sy = y + ay * sign;
                const side = board.cell(sx, sy);
                if (run.stairs.some((o) => o.cell === side)) continue;
                assert.equal(chunks[chunkKey("dg", Math.floor(sx / 16), Math.floor(sy / 16))]?.cells[`${sx},${sy}`], undefined);
              }
            }
          }
        }
      });
    }
  }

  test("a run that would touch another room leaves the room flat, and a near landing may touch only its own", () => {
    // A second room 3 squares north of the first: a +10 run north needs 4 squares, and its far landing would touch it.
    const north: Rect = { x: ROOM.x, y: ROOM.y - 3 - 5, w: 8, h: 5 };
    const { board, doors } = fixture(1, [ROOM, north]);
    const mouths = mouthCounts(board);
    const up = doors.find((d) => d.side === "n")!;
    assert.equal(runFits(board, up, runFor(board, up, 10), mouths), false);
    // +5 needs 3 squares: near landing, one stair and the far landing, the last of which touches the room north.
    assert.equal(runFits(board, up, runFor(board, up, 5), mouths), false);
    // The other sides have room.
    for (const d of doors.filter((d) => d.side !== "n")) assert.ok(runFits(board, d, runFor(board, d, 10), mouths));
  });

  test("a run beside another doorway's way out, or across another run, leaves its room flat", () => {
    // Two rooms side by side, 5 apart, a doorway each facing the other: their runs would meet in the middle.
    const left: Rect = { x: 4, y: 10, w: 6, h: 6 };
    const right: Rect = { x: 15, y: 10, w: 6, h: 6 };
    const board = new Board(W, H, [left, right]);
    const a = placeDoorway(board, 0, ["e"], right, 1, 0)!;
    const b = placeDoorway(board, 1, ["w"], left, 1, 0)!;
    const mouths = mouthCounts(board);
    // The left room's +10 run east reaches the right doorway's way out.
    assert.equal(runFits(board, a, runFor(board, a, 10), mouths), false);
    // +5 stops short of it.
    const short = runFor(board, a, 5);
    assert.ok(runFits(board, a, short, mouths));
    board.reserve(a, short);
    // Now the right room's own +5 run west meets the left run's far landing.
    assert.equal(runFits(board, b, runFor(board, b, 5), mouths), false);
  });

  test("a run whose stair would meet another run's square at its side leaves its room flat", () => {
    // A west room's run east along row 10 ends in a far landing at (14, 10). A south room's run north up column 15 would pass beside it.
    const west: Rect = { x: 4, y: 7, w: 7, h: 7 };
    const south: Rect = { x: 13, y: 13, w: 6, h: 6 };
    const board = new Board(W, H, [west, south]);
    const a = placeDoorway(board, 0, ["e"], { x: 30, y: 10, w: 1, h: 1 }, 1, 0)!;
    const b = placeDoorway(board, 1, ["n"], { x: 15, y: 0, w: 1, h: 1 }, 1, 1)!;
    assert.deepEqual([a.outside, b.outside], [[board.cell(11, 10)], [board.cell(15, 12)]]);
    const mouths = mouthCounts(board);
    const east = runFor(board, a, 10);
    assert.deepEqual(east.far, [board.cell(14, 10)]);
    assert.ok(runFits(board, a, east, mouths));
    board.reserve(a, east);
    const north = runFor(board, b, 10);
    assert.ok(north.beside.includes(board.cell(14, 10)));
    assert.equal(runFits(board, b, north, mouths), false);
  });

  test("a room tries each ground in its drawn order and stays flat with no run kept when none fits, and Flat raises nothing", () => {
    const north: Rect = { x: ROOM.x, y: ROOM.y - 3 - 5, w: 8, h: 5 };
    const { board } = fixture(1, [ROOM, north]);
    // Every draw is 0: the grounds' order comes out +10, -5, -10, +5.
    const zeros = () =>
      new (class extends Stream {
        override next32(): number {
          return 0;
        }
      })(new Uint8Array(32), new Uint8Array(12));
    raiseRooms(zeros(), board, 1, 75);
    assert.equal(board.rooms[0]!.ground, 0, "no run fits the 3 squares of rock to the room north");
    assert.ok(board.doorways.every((d) => d.run === null));
    assert.ok(board.runAt.every((v) => v === 0) && board.besideAt.every((v) => v === 0));
    // With the other room far off in a corner, the same draws raise it to the first ground of its order.
    const corner: Rect = { x: 2, y: 2, w: 3, h: 3 };
    const open = fixture(1, [ROOM, corner]);
    raiseRooms(zeros(), open.board, 1, 75);
    assert.equal(open.board.rooms[0]!.ground, 10);
    assert.ok(open.board.doorways.every((d) => d.run !== null));
    const flat = fixture(1, [ROOM, corner]);
    raiseRooms(zeros(), flat.board, 1, 0);
    assert.equal(flat.board.rooms[0]!.ground, 0);
  });

  test("DGOPTS-O7: a room whose first drawn ground does not fit takes a later one that does (D-832)", () => {
    // 4 squares of rock to the room north: a 10 ft run needs 4 and its far landing would touch that room, a 5 ft run needs 3 and clears it.
    const north: Rect = { x: ROOM.x, y: ROOM.y - 4 - 5, w: 8, h: 5 };
    const { board, doors } = fixture(1, [ROOM, north]);
    const up = doors.find((d) => d.side === "n")!;
    const mouths = mouthCounts(board);
    assert.equal(runFits(board, up, runFor(board, up, 10), mouths), false, "the first ground, +10, does not fit");
    assert.ok(runFits(board, up, runFor(board, up, -5), mouths), "the second, -5, does");
    const zeros = new (class extends Stream {
      override next32(): number {
        return 0;
      }
    })(new Uint8Array(32), new Uint8Array(12));
    raiseRooms(zeros, board, 1, 75);
    assert.equal(board.rooms[0]!.ground, -5, "not left flat, and not +10");
    assert.ok(board.doorways.filter((d) => d.room === 0).every((d) => d.run !== null));
  });
});
