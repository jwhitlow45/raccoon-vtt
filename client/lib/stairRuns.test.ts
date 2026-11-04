import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { FogTile, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import type { Compass, Facing } from "#shared/rules/heights.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, env, room, scene } from "#shared/testutil.ts";
import { viewToScreen } from "./camera.ts";
import { stairRuns, treadAt, treadHeight, TREADS, type StairStep } from "./stairRuns.ts";
import { drawnHeights, drawnStandBase, heightsDetail, isometric, pickWalk, standSurface, surfaceAt, toView, type DrawnHeights, type DrawnSource, type Turn } from "./view.ts";

/*
 * Stairs as steps (docs/design/design-v1-iso-depth.md 5.2 and 5.4): which runs
 * step and their spans, the stand surface over them, and a press walking
 * their treads, on the generator's run shapes and the builder's.
 */

/** A small world of stairs by cell: its stairs' directions, every cell's drawn ground in cells, and the cells this viewer has seen. */
function world(spec: { stairs: Record<string, Facing | null>; ground: Record<string, number>; unseen?: string[]; w?: number; h?: number }) {
  const w = spec.w ?? 20;
  const h = spec.h ?? 20;
  const unseen = new Set(spec.unseen ?? []);
  const cells = Object.keys(spec.stairs).map((k) => ({ x: Number(k.split(",")[0]), y: Number(k.split(",")[1]) }));
  return stairRuns(
    cells,
    (x, y) => (`${x},${y}` in spec.stairs ? spec.stairs[`${x},${y}`] : undefined),
    (x, y) => spec.ground[`${x},${y}`] ?? 0,
    (x, y) => x >= 0 && y >= 0 && x < w && y < h && !unseen.has(`${x},${y}`),
  );
}

const span = (d: Compass, lo: number, hi: number): StairStep => ({ d, lo, hi });

describe("which runs climb in steps, and their spans (5.2)", () => {
  test("a raised run to a 10 ft room: treads 0 to 4 ft on the lower stair, 5 to 9 on the upper, then the landing", () => {
    // Stairs at 0 and 5 ft pointing north, the corridor at 0 below, the room's landing at 10 ft above.
    const runs = world({ stairs: { "5,7": "n", "5,6": "n" }, ground: { "5,7": 0, "5,6": 1, "5,5": 2, "5,8": 0 } });
    assert.deepEqual(runs.at(5, 7), span("n", 0, 1));
    assert.deepEqual(runs.at(5, 6), span("n", 1, 2));
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => treadHeight(runs.at(5, 7)!, k) * 5), [0, 1, 2, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => Math.round(treadHeight(runs.at(5, 6)!, k) * 5)), [5, 6, 7, 8, 9]);
  });

  test("a sunk run to a -10 ft room, as the generator lays it: no cliff, treads from -10 at the room to -1 by the corridor", () => {
    // runFor puts the stairs at -5 and 0 ft, pointing up away from the room: the room's landing is the foot, the far landing the head.
    const runs = world({ stairs: { "6,11": "e", "7,11": "e" }, ground: { "5,11": -2, "6,11": -1, "7,11": 0, "8,11": 0 } });
    assert.deepEqual(runs.at(6, 11), span("e", -2, -1));
    assert.deepEqual(runs.at(7, 11), span("e", -1, 0));
    assert.deepEqual([0, 4].map((k) => Math.round(treadHeight(runs.at(7, 11)!, k) * 5)), [-5, -1], "the 0 ft stair steps from -5 to -1, not flat at 0");
  });

  test("a sunk run to a -5 ft room, a dais stair and the builder's stair at 5 ft between 0 and 10 ft", () => {
    assert.deepEqual(world({ stairs: { "3,3": "e" }, ground: { "2,3": 0, "3,3": 0, "4,3": -1 } }).at(3, 3), undefined, "pointing the wrong way, its head lower: today's look");
    assert.deepEqual(world({ stairs: { "3,3": "e" }, ground: { "2,3": -1, "3,3": 0, "4,3": 0 } }).at(3, 3), span("e", -1, 0));
    assert.deepEqual(world({ stairs: { "3,3": "s" }, ground: { "3,2": 0, "3,3": 0, "3,4": 1 } }).at(3, 3), span("s", 0, 1), "a dais stair at the room floor, one span up to the dais");
    const builder = world({ stairs: { "3,3": "n" }, ground: { "3,4": 0, "3,3": 1, "3,2": 2 } }).at(3, 3)!;
    assert.deepEqual(builder, span("n", 0, 2));
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => Math.round(treadHeight(builder, k) * 5)), [0, 2, 4, 6, 8], "2 ft steps, its stored 5 ft inside");
  });

  test("today's look for equal ends, a stair with no direction, a turn in the stairs, a stair outside its span, and an end unseen or off the scene", () => {
    const ground = { "5,8": 0, "5,7": 0, "5,6": 1, "5,5": 2 };
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n" }, ground: { ...ground, "5,5": 0 } }).size, 0, "equal foot and head");
    assert.equal(world({ stairs: { "5,7": null, "5,6": "n" }, ground }).at(5, 7), undefined, "no direction");
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n", "5,5": "e" }, ground }).size, 0, "its head is another stair: a turn");
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n", "5,8": "w" }, ground }).size, 0, "its foot is another stair");
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n" }, ground: { ...ground, "5,6": 3, "5,5": 2 } }).size, 0, "a stair at 15 ft between 0 and 10");
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n" }, ground, unseen: ["5,5"] }).size, 0, "the head unseen");
    assert.equal(world({ stairs: { "5,7": "n", "5,6": "n" }, ground, unseen: ["5,6"] }).size, 0, "a stair unseen");
    assert.equal(world({ stairs: { "5,0": "s" }, ground: { "5,1": 1 } }).size, 0, "the foot off the scene");
  });

  test("each chunk's entries come as one string, its stairs in row order, so a bucket's signature compares them by value", () => {
    const runs = world({ stairs: { "15,7": "e", "16,7": "e" }, ground: { "14,7": 0, "15,7": 0, "16,7": 1, "17,7": 2 }, w: 40 });
    assert.equal(runs.chunkSig(0, 0), "15,7,e,0,1;");
    assert.equal(runs.chunkSig(1, 0), "16,7,e,1,2;");
    assert.equal(runs.chunkSig(2, 0), "");
    assert.equal(runs.cells, "15,7;16,7;");
    assert.deepEqual([...runs.treads].sort((a, b) => a - b), [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8]);
  });

  test("property: a run's spans tile its foot to its head with no gap or overlap, and its treads rise strictly along it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: -8, max: 8 }), fc.integer({ min: 1, max: 8 }), fc.constantFrom<Compass>("n", "e", "s", "w"), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 6, maxLength: 6 }), (n, foot, rise, d, where) => {
        const step = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[d];
        const at = (i: number) => `${10 + step[0]! * i},${10 + step[1]! * i}`;
        const stairs: Record<string, Facing> = {};
        const ground: Record<string, number> = { [at(-1)]: foot, [at(n)]: foot + rise };
        // Each stair's own ground somewhere inside its span, as the rule asks.
        for (let i = 0; i < n; i++) {
          stairs[at(i)] = d;
          ground[at(i)] = foot + ((i + where[i]!) * rise) / n;
        }
        const runs = world({ stairs, ground });
        assert.equal(runs.size, n);
        let top = foot;
        let last = -Infinity;
        for (let i = 0; i < n; i++) {
          const [x, y] = at(i).split(",").map(Number) as [number, number];
          const s = runs.at(x, y)!;
          assert.ok(Math.abs(s.lo - top) < 1e-9, `stair ${i} starts where the last ended`);
          top = s.hi;
          for (let k = 0; k < TREADS; k++) {
            assert.ok(treadHeight(s, k) > last, "each tread above the one before");
            last = treadHeight(s, k);
          }
        }
        assert.ok(Math.abs(top - (foot + rise)) < 1e-9, "the last span ends at the head");
      }),
    );
  });

  test("a point's tread: the fifth of the square it lies in along the climb, the higher on a line between two, held to the square", () => {
    const s = span("e", 0, 1);
    assert.equal(treadAt(s, 3, 3, { x: 3.5, y: 3.5 }), 2, "a Medium's middle stands on tread 2");
    assert.equal(treadAt(s, 3, 3, { x: 3.01, y: 3.5 }), 0);
    assert.equal(treadAt(s, 3, 3, { x: 3.99, y: 3.5 }), 4);
    assert.equal(treadAt(s, 3, 3, { x: 9, y: 3.5 }), 4, "past its head side");
    assert.equal(treadAt(span("w", 0, 1), 3, 3, { x: 3.01, y: 3.5 }), 4, "climbing west, its west side is its head");
    assert.equal(treadAt(span("n", 0, 1), 3, 3, { x: 3.5, y: 3.1 }), 4);
    assert.equal(treadAt(span("s", 0, 1), 3, 3, { x: 3.5, y: 3.1 }), 0);
  });
});

// ---------------------------------------------------------------- through the drawn heights

const BOUNDS = { w: 20, h: 16 };

/** A room built by the reducer's own ops, on scene s1 with no automatic walls. */
function built(ops: readonly Op[]): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds: BOUNDS, autoWalls: "off" }) } });
  ops.forEach((op, i) => {
    const r = applyOp(s, op, DM, env(i + 1));
    if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
    s = r.state;
  });
  return s;
}

const cellsOf = (x0: number, y0: number, x1: number, y1: number) => {
  const out: string[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(`${x},${y}`);
  return out;
};

/** A 10 ft platform reached by a raised run from the south, and a room sunk 10 ft reached by a sunk run from the east, as the generator lays them. */
const STAIRS_ROOM = built([
  { t: "build.height", sceneId: "s1", cells: cellsOf(8, 2, 12, 6), height: 10 },
  { t: "build.height", sceneId: "s1", cells: ["9,6"], height: 5 },
  { t: "build.stairs", sceneId: "s1", cells: ["9,7", "9,6"], up: "n" },
  { t: "build.height", sceneId: "s1", cells: cellsOf(2, 10, 6, 14), height: -10 },
  { t: "build.height", sceneId: "s1", cells: ["6,11"], height: -5 },
  { t: "build.stairs", sceneId: "s1", cells: ["6,11", "7,11"], up: "e" },
] as Op[]);

function heightsOf(state: RoomState, opts: { fog?: Record<string, FogTile> | null; detail?: boolean; stand?: boolean } = {}): { src: DrawnSource; heights: DrawnHeights } {
  const src: DrawnSource = { chunks: state.buildChunks, sceneId: "s1", bounds: BOUNDS, grid: { shape: "squares" }, fog: opts.fog ?? null, stand: opts.stand ?? true, detail: opts.detail ?? true };
  return { src, heights: drawnHeights(src, 5, sceneWalls(state.scenes.s1!, state.buildChunks)) };
}

/** Fog tiles with only the given rectangles revealed. */
function revealed(rects: readonly { x: number; y: number; w: number; h: number }[]): Record<string, FogTile> {
  const change = rasterizeFogOps({}, "s1", BOUNDS, rects.map((r, i) => ({ id: `r${i}`, mode: "reveal" as const, shape: { kind: "rect" as const, ...r } })));
  return Object.fromEntries(Object.entries(change).filter((e): e is [string, FogTile] => e[1] !== null));
}

describe("the drawn heights carry the runs (5.2, D-261102-884)", () => {
  test("the raised and sunk runs step, read with the walls' directions", () => {
    const { heights } = heightsOf(STAIRS_ROOM);
    assert.deepEqual(heights.runs!.at(9, 7), span("n", 0, 1));
    assert.deepEqual(heights.runs!.at(9, 6), span("n", 1, 2));
    assert.deepEqual(heights.runs!.at(6, 11), span("e", -2, -1));
    assert.deepEqual(heights.runs!.at(7, 11), span("e", -1, 0));
    assert.equal(heights.runs!.size, 4);
  });

  test("security: a player's sunk run whose head is unseen, or a stair unseen, does not step, though its stairs show", () => {
    // Everything but the far landing at (8, 11) revealed: its 0 ft reads 0 to this viewer whatever lies there, so the run must not step toward it.
    const all = { x: 0, y: 0, w: 20, h: 16 };
    assert.equal(heightsOf(STAIRS_ROOM, { fog: revealed([all]) }).heights.runs!.size, 4, "all seen, all step");
    const noHead = revealed([{ x: 0, y: 0, w: 8, h: 16 }, { x: 9, y: 0, w: 11, h: 16 }, { x: 8, y: 0, w: 1, h: 11 }, { x: 8, y: 12, w: 1, h: 4 }]);
    const runs = heightsOf(STAIRS_ROOM, { fog: noHead }).heights.runs!;
    assert.equal(runs.at(6, 11), undefined);
    assert.equal(runs.at(7, 11), undefined);
    assert.ok(runs.at(9, 7) && runs.at(9, 6), "the raised run, wholly seen, still steps");
  });

  test("the runs are found whatever the zoom, but read as steps only with the detail, and below the stand threshold none are", () => {
    assert.equal(heightsOf(STAIRS_ROOM, { detail: false }).heights.runs!.size, 4, "found with the detail off, so bounds never change with it");
    assert.equal(heightsOf(STAIRS_ROOM, { stand: false }).heights.runs, undefined);
  });
});

describe("the detail flag (7, D-261102-883)", () => {
  test("from 24 px a cell, 48 in Low power", () => {
    assert.equal(heightsDetail(23, false), false);
    assert.equal(heightsDetail(24, false), true);
    assert.equal(heightsDetail(47, true), false);
    assert.equal(heightsDetail(48, true), true);
  });
});

describe("the stand surface (5.4, D-261102-882)", () => {
  const { src, heights } = heightsOf(STAIRS_ROOM);
  const cell = (col: number, row: number) => ({ col, row });

  test("a Medium on a stair stands on the tread under its middle, tread 2", () => {
    assert.equal(standSurface(heights, [cell(9, 6)]), 1.4);
    assert.equal(drawnStandBase(src, heights, [cell(9, 6)], 5, 5), 1.4, "standing on the ground: its elevation is its stored 5 ft");
    assert.equal(standSurface(heights, [cell(6, 11)]), -1.6, "below its stored -5 ft on a sunk span");
  });

  test("a Large straddling a stair and the higher landing keeps the landing", () => {
    assert.equal(standSurface(heights, [cell(9, 5), cell(10, 5), cell(9, 6), cell(10, 6)]), 2);
  });

  test("a Large across two side by side squares of plain ground and a stair reads the stair's tread nearest its middle", () => {
    // Its middle on the stair's west side, half way up: the tread there, 2.
    assert.equal(standSurface(heights, [cell(8, 7), cell(9, 7)]), 0.4);
  });

  test("a flier keeps its elevation, and a token inside the ground its base: the rules' ground decides, never the tread", () => {
    assert.equal(drawnStandBase(src, heights, [cell(9, 6)], 6, 5), 1.2, "a flier 1 ft over its stored 5 ft, below the 7 ft tread: accepted (5.4)");
    assert.equal(drawnStandBase(src, heights, [cell(9, 6)], 0, 5), 0, "inside the ground");
  });

  test("with the detail off every reader reads the plain ground", () => {
    const off = heightsOf(STAIRS_ROOM, { detail: false });
    assert.equal(standSurface(off.heights, [cell(9, 6)]), 1);
    assert.equal(drawnStandBase(off.src, off.heights, [cell(9, 6)], 5, 5), 1);
    assert.equal(surfaceAt(off.heights, { x: 9.5, y: 6.5 }), 1);
    assert.equal(surfaceAt(heights, { x: 9.5, y: 6.5 }), 1.4);
  });
});

describe("a press walks a stair's treads (5.4, Picks)", () => {
  const camera = { x: 400, y: 300, scale: 40 };
  const pick = (heights: DrawnHeights, turn: Turn) => ({ camera, view: isometric(turn), grid: { shape: "squares" } as const, heights });
  const at = (turn: Turn, p: { x: number; y: number }, z: number) => viewToScreen(camera, toView(isometric(turn), p, z));

  test("a press on a tread's middle, on a riser and beside the stair land on that stair, that stair, and the square beside it", () => {
    const { heights } = heightsOf(STAIRS_ROOM);
    // At turns 0 and 3 the stair climbs away from the viewer, its risers facing it, so nothing nearer covers its middle tread.
    for (const turn of [0, 3] as Turn[]) {
      // The upper raised stair's tread 2: a fifth of the square wide along the climb, at 7 ft.
      const tread = pickWalk(pick(heights, turn), at(turn, { x: 9.5, y: 6.5 }, 1.4));
      assert.deepEqual(tread.cell, { col: 9, row: 6 }, `turn ${turn}`);
      assert.ok(Math.abs(tread.z - 1.4) < 1e-9, `turn ${turn}: met on the tread's top, ${tread.z}`);
      // The riser between treads 2 and 3, half way up it.
      const riser = pickWalk(pick(heights, turn), at(turn, { x: 9.5, y: 6.4 }, 1.5));
      assert.deepEqual(riser.cell, { col: 9, row: 6 }, `turn ${turn}`);
      assert.ok(Math.abs(riser.z - 1.5) < 1e-6, `turn ${turn}: met on the riser's face, ${riser.z}`);
    }
    // The square east of the lower stair, at 0 ft, with only flat ground nearer the viewer.
    const beside = pickWalk(pick(heights, 0), at(0, { x: 10.5, y: 7.5 }, 0));
    assert.deepEqual(beside.cell, { col: 10, row: 7 });
    // At turn 1 the stair climbs toward the viewer: nearer, higher ground covers its middle tread, as it draws.
    const covered = pickWalk(pick(heights, 1), at(1, { x: 9.5, y: 6.5 }, 1.4));
    assert.ok(covered.z > 1.4 + 1e-9, `met higher, nearer: ${covered.z} in ${JSON.stringify(covered.cell)}`);
  });

  test("mutation: the same press read without the detail lands on the stair's plain top, not its tread", () => {
    const off = heightsOf(STAIRS_ROOM, { detail: false }).heights;
    const flat = pickWalk(pick(off, 0), at(0, { x: 9.5, y: 6.5 }, 1.4));
    assert.notEqual(flat.z, 1.4);
  });
});
