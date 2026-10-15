import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, checkLimits, serializedBytes } from "#shared/limits.ts";
import type { FreeWall, RoomState, WallFeature } from "#shared/model.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { apply, room } from "#shared/testutil.ts";
import { splitCheck } from "#shared/rules/walls.ts";
import { importOps, importScene, OP_BYTES, placeMap } from "./batch.ts";
import { convertUvtt, frameOf, splitProblem, type ImportOptions, type ImportPlan } from "./convert.ts";
import { readUvtt } from "./schema.ts";
import { uvttFile, type FileInput } from "./synthetic.ts";

const OPTIONS: ImportOptions = { objects: true, portals: "window", feetPerCell: 5 };
const WALL: WallFeature = { kind: "wall" };
const DOOR: WallFeature = { kind: "door", state: "closed", secret: false, discovered: false };
const OPEN: WallFeature = { kind: "door", state: "open", secret: false, discovered: false };
const WINDOW: WallFeature = { kind: "window" };

const p = (x: number, y: number) => ({ x, y });

function convert(input: FileInput, options: Partial<ImportOptions> = {}) {
  const read = readUvtt(uvttFile(input));
  assert.ok(read.ok, read.ok ? "" : read.error);
  return convertUvtt(read.map, { ...OPTIONS, ...options });
}

function plan(input: FileInput, options: Partial<ImportOptions> = {}): ImportPlan {
  const result = convert(input, options);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.plan;
}

function edgeMap(plan: ImportPlan): Record<string, WallFeature> {
  return Object.fromEntries(plan.edges.map((e) => [e.key, e.feature]));
}

/** A free wall's ends as "ax,ay-bx,by" with the smaller end first, so tests need not know which way it runs. */
function seg(w: { a: [number, number]; b: [number, number] }): string {
  const [p0, p1] = w.a[0] < w.b[0] || (w.a[0] === w.b[0] && w.a[1] < w.b[1]) ? [w.a, w.b] : [w.b, w.a];
  return `${p0[0]},${p0[1]}-${p1[0]},${p1[1]}`;
}

function onLattice(v: number): boolean {
  return Number.isInteger(v * 64);
}

/** Sends every op of the plan through the client schema and the reducer, as a DM, into a fresh room. */
function applied(plan: ImportPlan, sceneId = "imp"): { state: RoomState; ops: ClientOp[] } {
  const map = placeMap(plan, { assetId: "a1", width: plan.frame.w * 70, height: plan.frame.h * 70, fileImageWidth: plan.frame.w * 70 });
  assert.ok(map);
  const scene = importScene(plan, map, { id: sceneId, name: "Import", fog: true });
  let n = 0;
  const ops = importOps(scene, plan, () => `light-${++n}`);
  let state = room();
  let seq = 1;
  for (const op of ops) {
    const parsed = clientOpSchema.safeParse(op);
    assert.ok(parsed.success, parsed.success ? "" : `${op.t}: ${parsed.error.message}`);
    state = apply(state, parsed.data, undefined, ++seq);
    const limits = checkLimits(state, sceneId);
    assert.ok(limits.ok, limits.ok ? "" : limits.message);
    const split = splitCheck(state, sceneId);
    assert.ok(split.ok, split.ok ? "" : split.message);
  }
  return { state, ops };
}

function storedWalls(state: RoomState, sceneId = "imp"): FreeWall[] {
  return Object.values(state.buildChunks)
    .filter((c) => c.sceneId === sceneId)
    .flatMap((c) => c.walls ?? []);
}

describe("where the file lands in the scene", () => {
  test("world 0 is the grid line at or before the image, for a positive and a negative fractional origin", () => {
    assert.deepEqual(frameOf({ origin: p(0.25, 0.5), size: p(10, 8) }), { ok: true, frame: { shift: p(0, 0), image: p(0.25, 0.5), w: 11, h: 9 } });
    assert.deepEqual(frameOf({ origin: p(-0.75, -2.25), size: p(10, 8) }), { ok: true, frame: { shift: p(-1, -3), image: p(0.25, 0.75), w: 11, h: 9 } });
    assert.deepEqual(frameOf({ origin: p(3, -4), size: p(30, 20) }), { ok: true, frame: { shift: p(3, -4), image: p(0, 0), w: 30, h: 20 } });
  });

  test("a map over 200 squares a side is refused, the leading partial square counted", () => {
    assert.deepEqual(frameOf({ origin: p(0, 0), size: p(260, 20) }), { ok: false, error: "This map is 260 squares wide. Scenes can be at most 200." });
    assert.deepEqual(frameOf({ origin: p(0, 0.5), size: p(20, 199.6) }), { ok: false, error: "This map is 201 squares tall. Scenes can be at most 200." });
    assert.ok(frameOf({ origin: p(0, 0), size: p(200, 200) }).ok);
  });

  test("the image's grid scales to the canonical size, and the image starts where the frame says", () => {
    const framed = plan({ origin: p(-0.75, -2.25), size: p(10, 8), ppg: 100 });
    // The file's image is 1000 px wide and the server kept 800.
    const map = placeMap(framed, { assetId: "a", width: 800, height: 640, fileImageWidth: 1000 });
    assert.deepEqual(map, { assetId: "a", widthPx: 800, heightPx: 640, cellPx: 80, originPx: { x: -20, y: -60 } });
    // The image's corner, world (0.25, 0.75), is its pixel (0, 0).
    assert.equal(0.25 * map!.cellPx + map!.originPx.x, 0);
    assert.equal(0.75 * map!.cellPx + map!.originPx.y, 0);
    assert.equal(placeMap(framed, { assetId: "a", width: 5, height: 4, fileImageWidth: 1000 }), null);
  });
});

describe("walls on the grid become edges", () => {
  test("all four borders, east and south included", () => {
    const border = plan({ size: p(20, 20), walls: [[p(0, 0), p(20, 0), p(20, 20), p(0, 20), p(0, 0)]] });
    const edges = edgeMap(border);
    assert.equal(border.edges.length, 80);
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(edges[`${i},0,n`], WALL);
      assert.deepEqual(edges[`20,${i},w`], WALL);
      assert.deepEqual(edges[`${i},20,n`], WALL);
      assert.deepEqual(edges[`0,${i},w`], WALL);
    }
    assert.equal(border.walls.length, 0);
    assert.equal(border.summary.gridWalls, 80);
    const { state } = applied(border);
    const stored = Object.values(state.buildChunks).filter((c) => c.sceneId === "imp");
    assert.equal(stored.reduce((n, c) => n + Object.keys(c.edges).length, 0), 80);
    assert.equal(state.scenes.imp!.autoWalls, "off");
    // A new scene, so its walls stop players' moves (docs/design-v1-maps-vision.md 4.1).
    assert.equal(state.scenes.imp!.blockMovement, true);
  });

  test("a wall within a tenth of a square of the grid is put on it", () => {
    const near = plan({ walls: [[p(2.04, 5.03), p(6.97, 4.95)]] });
    assert.deepEqual(near.edges.map((e) => e.key), ["2,5,n", "3,5,n", "4,5,n", "5,5,n", "6,5,n"]);
    const off = plan({ walls: [[p(2.2, 5), p(7, 5)]] });
    assert.equal(off.edges.length, 0);
    assert.deepEqual(off.walls.map(seg), ["2.203125,5-7,5"]);
  });

  test("a negative fractional origin moves walls, portals and lights by the same whole squares", () => {
    const moved = plan({
      origin: p(-0.75, -2.25),
      size: p(10, 8),
      walls: [[p(0, 0), p(5, 0)]],
      portals: [{ a: p(-0.5, 1), b: p(-0.5, 2) }],
      lights: [{ at: p(2, 2), range: 4 }],
    });
    assert.deepEqual(moved.edges.map((e) => e.key), ["1,3,n", "2,3,n", "3,3,n", "4,3,n", "5,3,n"]);
    assert.deepEqual(moved.walls.map(seg), ["0.5,4-0.5,5"]);
    assert.deepEqual(moved.walls[0]!.f, DOOR);
    assert.deepEqual([moved.lights[0]!.x, moved.lights[0]!.y], [3, 5]);
  });

  test("a positive fractional origin keeps the file's squares, off the grid where they are off it", () => {
    const moved = plan({
      origin: p(0.25, 0.5),
      size: p(10, 8),
      walls: [[p(1, 3), p(5, 3)], [p(0.25, 0.5), p(4.25, 0.5)]],
      portals: [{ a: p(6.25, 2), b: p(7.25, 2) }],
      lights: [{ at: p(3.3, 4.7), range: 4 }],
    });
    assert.deepEqual(moved.edges.map((e) => e.key), ["1,3,n", "2,3,n", "3,3,n", "4,3,n"]);
    assert.deepEqual(moved.walls.map(seg).sort(), ["0.25,0.5-4.25,0.5", "6.25,2-7.25,2"]);
    const light = moved.lights[0]!;
    assert.ok(onLattice(light.x) && onLattice(light.y));
    assert.ok(Math.abs(light.x - 3.3) <= 1 / 128 && Math.abs(light.y - 4.7) <= 1 / 128);
    applied(moved);
  });
});

describe("free walls", () => {
  test("crossing walls are stored as they are, unsplit, on the lattice", () => {
    const x = plan({ walls: [[p(1.5, 1.5), p(5.5, 5.5)], [p(1.5, 5.5), p(5.5, 1.5)]] });
    assert.deepEqual(x.walls.map(seg).sort(), ["1.5,1.5-5.5,5.5", "1.5,5.5-5.5,1.5"]);
    const { state } = applied(x);
    assert.deepEqual(storedWalls(state).map(seg).sort(), ["1.5,1.5-5.5,5.5", "1.5,5.5-5.5,1.5"]);
  });

  test("a long diagonal wall is cut into equal parts with every end on the lattice", () => {
    const end: [number, number] = [1023 / 64, 45 / 64];
    const long = plan({ walls: [[p(0, 0), p(end[0], end[1])]] });
    // Two equal parts would round to 8.008 squares, so it takes three.
    assert.equal(long.walls.length, 3);
    const points = new Map<string, number>();
    for (const w of long.walls) {
      assert.ok((w.b[0] - w.a[0]) ** 2 + (w.b[1] - w.a[1]) ** 2 <= 64);
      for (const q of [w.a, w.b]) {
        assert.ok(onLattice(q[0]) && onLattice(q[1]));
        points.set(q.join(), (points.get(q.join()) ?? 0) + 1);
      }
    }
    // A chain: the two outer ends once, the two inner joints twice.
    assert.deepEqual([...points.values()].sort(), [1, 1, 2, 2]);
    assert.equal(points.get("0,0"), 1);
    assert.equal(points.get(end.join()), 1);
    applied(long);
  });

  test("wall ends within a tenth of a square are welded, onto an end or onto a wall's middle, and counted", () => {
    const welded = plan({
      walls: [
        [p(1.3, 1.7), p(4.3, 2.7)],
        [p(4.35, 2.75), p(6.1, 5.3)],
        [p(2.8, 4.0), p(2.8, 2.27)],
      ],
    });
    assert.equal(welded.summary.welded, 2);
    // The first wall is split where the third meets its middle.
    assert.equal(welded.walls.length, 4);
    const uses = new Map<string, number>();
    for (const w of welded.walls) for (const q of [w.a, w.b]) uses.set(q.join(), (uses.get(q.join()) ?? 0) + 1);
    const joints = [...uses].filter(([, n]) => n >= 2).map(([k, n]) => [k, n]);
    assert.equal(joints.length, 2);
    assert.ok(joints.some(([, n]) => n === 3), "three walls meet where the third one was welded");
    applied(welded);
  });

  test("an end that is not near anything stays where it is", () => {
    const apart = plan({ walls: [[p(1.3, 1.7), p(4.3, 2.7)], [p(4.5, 2.75), p(6.1, 5.3)]] });
    assert.equal(apart.summary.welded, 0);
  });
});

describe("portals", () => {
  test("a wall along a door is cut back exactly to the door's ends, off the grid and on it", () => {
    const free = plan({ walls: [[p(0.5, 5.5), p(6.5, 5.5)]], portals: [{ a: p(3.5, 5.5), b: p(2.5, 5.5) }] });
    assert.deepEqual(free.walls.filter((w) => w.f.kind === "wall").map(seg).sort(), ["0.5,5.5-2.5,5.5", "3.5,5.5-6.5,5.5"]);
    assert.deepEqual(free.walls.filter((w) => w.f.kind === "door").map(seg), ["2.5,5.5-3.5,5.5"]);
    assert.equal(free.summary.doors, 1);

    const grid = plan({ walls: [[p(0, 8), p(6, 8)]], portals: [{ a: p(2, 8), b: p(4, 8) }] });
    assert.deepEqual(edgeMap(grid), { "0,8,n": WALL, "1,8,n": WALL, "2,8,n": DOOR, "3,8,n": DOOR, "4,8,n": WALL, "5,8,n": WALL });
    assert.equal(grid.summary.doors, 2);
    applied(grid);
  });

  test("a door in a gap is joined to the walls beside it", () => {
    const gap = plan({ walls: [[p(0.5, 10.5), p(2.45, 10.5)], [p(3.55, 10.5), p(6.5, 10.5)]], portals: [{ a: p(2.5, 10.5), b: p(3.5, 10.5) }] });
    assert.equal(gap.summary.welded, 2);
    assert.deepEqual(gap.walls.map(seg).sort(), ["0.5,10.5-2.5,10.5", "2.5,10.5-3.5,10.5", "3.5,10.5-6.5,10.5"]);
  });

  test("a portal that does not block light is a window, or an open door when the DM says so", () => {
    const input: FileInput = { portals: [{ a: p(2, 3), b: p(3, 3), closed: false }, { a: p(5.5, 1.5), b: p(6.5, 1.5), closed: false }] };
    const windows = plan(input);
    assert.deepEqual(edgeMap(windows), { "2,3,n": WINDOW });
    assert.deepEqual(windows.walls[0]!.f, WINDOW);
    assert.equal(windows.summary.windows, 2);
    const open = plan(input, { portals: "open" });
    assert.deepEqual(edgeMap(open), { "2,3,n": OPEN });
    assert.deepEqual(open.walls[0]!.f, OPEN);
    assert.equal(open.summary.doors, 2);
    assert.equal(open.summary.windows, 0);
  });
});

describe("objects", () => {
  test("object outlines become walls only while the DM keeps them on", () => {
    const input: FileInput = { objects: [[p(4.5, 4.5), p(5.5, 4.5), p(5.5, 5.5), p(4.5, 5.5), p(4.5, 4.5)]] };
    assert.equal(plan(input).walls.length, 4);
    assert.equal(plan(input, { objects: false }).walls.length, 0);
  });
});

describe("clipping", () => {
  test("walls and lights past the scene's edge are cut or dropped, and counted", () => {
    const clipped = plan({ size: p(10, 10), walls: [[p(-0.5, 5.5), p(4.5, 5.5)]], lights: [{ at: p(10.5, 3), range: 2 }, { at: p(4, 4), range: 2 }] });
    assert.deepEqual(clipped.walls.map(seg), ["0,5.5-4.5,5.5"]);
    assert.equal(clipped.lights.length, 1);
    assert.equal(clipped.summary.clipped, 2);
  });
});

describe("lights", () => {
  test("range is the dim radius in squares, bright at half, in feet at the room's scale and capped", () => {
    const lit = plan({
      lights: [
        { at: p(3, 3.5), range: 8, color: "ffeccd8b", shadows: false },
        { at: p(5.5, 5.5), range: 100, color: "#123ABC" },
        { at: p(7.5, 7.5), range: 3, color: "warm" },
      ],
    });
    assert.deepEqual(lit.lights[0], { x: 3, y: 3.5, bright: 20, dim: 20, on: true, walls: false, color: "#eccd8b" });
    assert.deepEqual(lit.lights[1], { x: 5.5, y: 5.5, bright: 120, dim: 120, on: true, walls: true, color: "#123abc" });
    assert.deepEqual(lit.lights[2], { x: 7.5, y: 7.5, bright: 7.5, dim: 7.5, on: true, walls: true });
    const tenFoot = plan({ lights: [{ at: p(3, 3), range: 8 }] }, { feetPerCell: 10 });
    assert.equal(tenFoot.lights[0]!.bright, 40);
  });

  test("a torch on a wall moves a tenth of a square off it, to the side it lights more, on the lattice", () => {
    // A strip one square deep above the wall at y = 3, open ground below it.
    const torch = plan({ size: p(10, 10), walls: [[p(0, 2), p(10, 2)], [p(0, 3), p(10, 3)]], lights: [{ at: p(5, 3.02), range: 6 }] });
    const light = torch.lights[0]!;
    assert.equal(light.x, 5);
    assert.equal(light.y, 198 / 64);
    assert.equal(torch.summary.lightsMoved, 1);
  });

  test("a light in a corner is checked again after its first step and moves off the second wall too", () => {
    const corner = plan({ size: p(10, 10), walls: [[p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(0, 0)]], lights: [{ at: p(0.03, 0.02), range: 6 }] });
    const light = corner.lights[0]!;
    assert.ok(onLattice(light.x) && onLattice(light.y));
    assert.ok(light.x >= 0.09 && light.y >= 0.09, `${light.x}, ${light.y}`);
  });

  test("a light off the lattice after the transform is snapped onto it", () => {
    const off = plan({ origin: p(0.3, 0.7), size: p(10, 10), lights: [{ at: p(2.3456, 4.7891), range: 2 }] });
    const light = off.lights[0]!;
    assert.ok(onLattice(light.x) && onLattice(light.y));
    assert.ok(Math.abs(light.x - 2.3456) <= 1 / 128 && Math.abs(light.y - 4.7891) <= 1 / 128);
  });

  test("past 100 lights, the 100 with the largest range stay and the summary counts the rest", () => {
    const many = plan({ size: p(50, 50), lights: Array.from({ length: 120 }, (_, i) => ({ at: p(1 + (i % 40), 1 + Math.floor(i / 40) * 10), range: i + 1 })) });
    assert.equal(many.lights.length, 100);
    assert.equal(many.summary.lightsLeftOut, 20);
    assert.ok(many.lights.every((l) => l.bright >= 21 * 2.5));
    const { state } = applied(many);
    assert.equal(Object.values(state.lights).filter((l) => l.sceneId === "imp").length, 100);
  });
});

describe("limits", () => {
  test("free walls over a scene's limit are simplified again more coarsely", () => {
    // Wiggles of 0.07 square survive Douglas-Peucker at 0.05 and vanish at 0.1.
    const wiggly = Array.from({ length: 60 }, (_, k) =>
      Array.from({ length: 200 }, (_, i) => p(10.3 + i * 0.15, 10.3 + k * 2 + (i % 2 === 0 ? 0 : 0.07))),
    );
    const coarse = plan({ size: p(80, 150), walls: wiggly });
    assert.equal(coarse.summary.tolerance, 0.1);
    assert.ok(coarse.walls.length <= LIMITS.freeWallsPerScene);
  });

  test("more free walls than a scene holds, even simplified, are refused with the count", () => {
    const walls = [];
    for (let i = 0; i < 65; i++) for (let j = 0; j < 65; j++) walls.push([p(2.3 + i * 3, 2.3 + j * 3), p(3.7 + i * 3, 3.2 + j * 3)]);
    const result = convert({ size: p(200, 200), walls });
    assert.deepEqual(result, { ok: false, error: "This map has 4,225 walls off the grid even simplified, more than a scene holds (4,000)." });
  });

  test("walls that cross too often for the split are refused before anything is sent", () => {
    const walls = [];
    for (let k = 0; k < 200; k++) {
      walls.push([p(20.37, 20.13 + k * 0.15), p(49.63, 20.13 + k * 0.15)]);
      walls.push([p(20.13 + k * 0.15, 20.37), p(20.13 + k * 0.15, 49.63)]);
    }
    const result = convert({ size: p(60, 60), walls });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok([splitProblem("pairs"), splitProblem("pieces")].includes(result.error), result.error);
  });

  test("more grid edges than a scene holds are refused before anything is sent", () => {
    // One more full grid line than the cap holds, each line 200 edges.
    const walls = Array.from({ length: LIMITS.drawnEdgesPerScene / 200 + 1 }, (_, k) => [p(0, 1 + k), p(200, 1 + k)]);
    const result = convert({ size: p(200, 200), walls });
    const edges = (LIMITS.drawnEdgesPerScene / 200 + 1) * 200;
    assert.deepEqual(result, { ok: false, error: `This map has ${edges.toLocaleString("en-US")} walls, doors and windows on the grid, more than a scene holds (${LIMITS.drawnEdgesPerScene.toLocaleString("en-US")}).` });
  });

  test("more doors and windows than a scene holds are refused before anything is sent", () => {
    // 1,000 portals, within what a file may hold, each three cells along a grid line: 3,000 door and window edges.
    const portals = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 25; j++) portals.push({ a: p(1 + i * 5, 2 + j * 8), b: p(4 + i * 5, 2 + j * 8), closed: j % 2 === 0 });
    const result = convert({ size: p(200, 200), portals });
    assert.deepEqual(result, { ok: false, error: `This map has 3,000 doors and windows, more than a scene holds (${LIMITS.doorsAndWindowsPerScene.toLocaleString("en-US")}).` });
  });

  test("the counting pass reads what would be stored, and its answer refuses", () => {
    const read = readUvtt(uvttFile({ walls: [[p(1.5, 1.5), p(5.5, 5.5)]] }));
    assert.ok(read.ok);
    let seen = 0;
    const refused = convertUvtt(read.map, OPTIONS, {
      countSplit: (chunks, rule) => {
        assert.equal(rule, "off");
        for (const c of chunks) seen += c.walls?.length ?? 0;
        return { pairs: 0, pieces: 10_001, over: "pieces" };
      },
    });
    assert.equal(seen, 1);
    assert.deepEqual(refused, { ok: false, error: splitProblem("pieces") });
  });
});

describe("the ops an import sends", () => {
  test("doors and edges at a scene's caps go out in batches under 48 KiB, and the room takes every one", () => {
    const portals = [];
    for (let i = 0; i < LIMITS.doorsAndWindowsPerScene / 50; i++) for (let j = 0; j < 50; j++) portals.push({ a: p(2.5 + i * 4, 2.25 + j * 3), b: p(2.5 + i * 4, 3.25 + j * 3) });
    const walls = Array.from({ length: LIMITS.drawnEdgesPerScene / 200 }, (_, k) => [p(0, k * 2), p(200, k * 2)]);
    const big = plan({ size: p(200, 200), walls, portals });
    assert.equal(big.walls.length, LIMITS.doorsAndWindowsPerScene);
    assert.equal(big.edges.length, LIMITS.drawnEdgesPerScene);
    const { state, ops } = applied(big);
    for (const op of ops) {
      if (op.t === "scene.create") continue;
      assert.ok(serializedBytes(op) <= OP_BYTES, `${op.t} is ${serializedBytes(op)} bytes`);
      if (op.t === "build.walls") assert.ok((op.put?.length ?? 0) <= LIMITS.freeWallsPerOp);
      if (op.t === "build.edge") assert.ok(op.edges.length <= 500);
    }
    assert.equal(ops[0]!.t, "scene.create");
    assert.ok(ops.filter((o) => o.t === "build.walls").length >= 3, "doors are too large for 500 to an op");
    assert.equal(storedWalls(state).length, LIMITS.doorsAndWindowsPerScene);
    assert.ok(storedWalls(state).every((w) => w.f.kind === "door"));
  });
});
