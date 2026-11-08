import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { BuildChunk, EdgeFeature, RoomState } from "#shared/model.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { MAX_BUILD_CELLS } from "#shared/protocol.ts";
import { FLOOR_TERRAINS } from "#shared/rules/autoWalls.ts";
import { groundAt, markIn } from "#shared/rules/heights.ts";
import { legStop, ownWalk } from "#shared/rules/movement.ts";
import { findRoute, WalkSearch, WalkWorld, type WalkInput } from "#shared/rules/walk.ts";
import { floodRoom, indexBuild, LEDGE, sceneWalls } from "#shared/rules/walls.ts";
import { LEVEL_BANDS } from "#shared/srd/traps.ts";
import { builderScene } from "../scenes/create.ts";
import { SCENE_PLACEHOLDER } from "./ops.ts";
import type { DungeonPlan, PlanRoom } from "./plan.ts";
import { previewOf } from "./scratch.ts";
import { newSeed } from "./seed.ts";
import { clampRooms, DEFAULT_CONTEXT, DEFAULT_SETTINGS, DRESSINGS, HEIGHTS_MAX, HEIGHTS_STEP, LIT_MAX, LIT_STEP, MAX_SIDE, MIN_SIDE, roomCap, SECRETS_MAX, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * A generated dungeon as it lands (docs/design/design-v1-dungeon-generator.md
 * section 13), read from the scratch room the preview draws, so every rule
 * here is a rule of the room the DM gets: every prefix of its ops taken
 * with the server's checks, every room walked to from the entrance with the
 * drag's own route rules once its doors are open, unsqueezed by the
 * creatures its corridors are sized for, no ledge between corridor
 * squares, each stair facing up its run with both its edges along it
 * linked, every dais walked onto, and Reveal room taking exactly the room.
 */

const settings: fc.Arbitrary<DungeonSettings> = fc
  .record({
    w: fc.integer({ min: MIN_SIDE, max: MAX_SIDE }),
    h: fc.integer({ min: MIN_SIDE, max: MAX_SIDE }),
    rooms: fc.integer({ min: 2, max: 40 }),
    density: fc.constantFrom("sparse", "normal", "dense"),
    corridors: fc.constantFrom("straight", "bending", "winding"),
    wide: fc.boolean(),
    loops: fc.boolean(),
    theme: fc.constantFrom("dungeon", "crypt"),
    heights: fc.integer({ min: 0, max: HEIGHTS_MAX / HEIGHTS_STEP }).map((n) => n * HEIGHTS_STEP),
    traps: fc.integer({ min: 0, max: TRAPS_MAX }),
    band: fc.constantFrom(...LEVEL_BANDS),
    deadEnds: fc.boolean(),
    secrets: fc.integer({ min: 0, max: SECRETS_MAX }),
    lit: fc.integer({ min: 0, max: LIT_MAX / LIT_STEP }).map((n) => n * LIT_STEP),
    dressing: fc.constantFrom(...DRESSINGS),
    key: fc.boolean(),
  })
  .map((s) => ({ ...s, rooms: clampRooms(s.rooms, s.w, s.h) }));

const seed = fc.uint8Array({ minLength: 15, maxLength: 15 }).map((bytes) => newSeed((b) => b.set(bytes)));

const S = SCENE_PLACEHOLDER;
const key = (x: number, y: number) => `${x},${y}`;
const inRoom = (r: Pick<PlanRoom, "x" | "y" | "w" | "h">, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function cellsOf(room: RoomState): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of Object.values(room.buildChunks)) if (c.sceneId === S) for (const [k, t] of Object.entries(c.cells)) out.set(k, t);
  return out;
}

/** The room with every door open, as a party that opened each would walk it. */
function opened(room: RoomState): RoomState {
  const open = (f: EdgeFeature): EdgeFeature => (f.kind === "door" ? { ...f, state: "open" } : f);
  const chunks: Record<string, BuildChunk> = {};
  for (const [k, c] of Object.entries(room.buildChunks)) chunks[k] = { ...c, edges: Object.fromEntries(Object.entries(c.edges).map(([e, f]) => [e, open(f)])) };
  return { ...room, buildChunks: chunks };
}

/** Every grid edge a ledge runs along, as "x,y,n" or "x,y,w" keys. */
function ledges(room: RoomState): Set<string> {
  const scene = room.scenes[S]!;
  const segs = sceneWalls(scene, room.buildChunks).segmentsWith(LEDGE);
  const out = new Set<string>();
  for (let i = 0; i < segs.length; i += 4) {
    const [ax, ay, bx, by] = [segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!];
    if (ay === by) for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) out.add(`${x},${ay},n`);
    else if (ax === bx) for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) out.add(`${ax},${y},w`);
  }
  return out;
}

const STEP: Record<string, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
/** The edge between a cell and its neighbor one step that way. */
function edgeToward(x: number, y: number, [dx, dy]: [number, number]): string {
  if (dx === 1) return `${x + 1},${y},w`;
  if (dx === -1) return `${x},${y},w`;
  if (dy === 1) return `${x},${y + 1},n`;
  return `${x},${y},n`;
}

/** Every spot in the room where a creature of `side` squares stands on plain floor at the room's ground, top-left corners first by row. */
function spotsIn(r: PlanRoom, cells: Map<string, string>, room: RoomState, side: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = r.y; y + side <= r.y + r.h; y++) {
    for (let x = r.x; x + side <= r.x + r.w; x++) {
      let ok = true;
      for (let j = 0; j < side && ok; j++) for (let i = 0; i < side && ok; i++) {
        const t = cells.get(key(x + i, y + j));
        ok = t !== undefined && FLOOR_TERRAINS.has(t as never) && groundAt(room.buildChunks, S, x + i, y + j) === r.ground && markAt(room, x + i, y + j) === ".";
      }
      if (ok) out.push({ x, y });
    }
  }
  return out;
}

function markAt(room: RoomState, x: number, y: number): string {
  return markIn(room.buildChunks[`${S}:${Math.floor(x / 16)},${Math.floor(y / 16)}`], x, y);
}

/**
 * Walks from the entrance to every room as a creature of this size, its
 * doors open: some spot in each room is reached a whole square at a time
 * with the full footprint, never squeezed, and the drag's own route finds
 * its way to that spot too.
 */
function walksEverywhere(plan: DungeonPlan, room: RoomState, size: "medium" | "large"): void {
  const side = size === "large" ? 2 : 1;
  const open = opened(room);
  const cells = cellsOf(room);
  const entrance = plan.rooms.find((r) => r.entrance)!;
  // The party comes in by a door, so the walk starts on a spot over a doorway's inside square, which stays clear.
  const inside = plan.doors.flatMap(({ edge }) => {
    const [x, y, side] = edge.split(",") as [string, string, "n" | "w"];
    const a = { x: Number(x), y: Number(y) };
    const b = side === "w" ? { x: a.x - 1, y: a.y } : { x: a.x, y: a.y - 1 };
    return [a, b].filter((c) => inRoom(entrance, c.x, c.y));
  });
  const spots = spotsIn(entrance, cells, room, side);
  const from = spots.find((p) => inside.some((c) => c.x >= p.x && c.x < p.x + side && c.y >= p.y && c.y < p.y + side));
  assert.ok(from, `a ${size} creature stands inside the entrance's door`);
  const token = ownWalk({ sceneId: S, size, x: from.x, y: from.y, elevation: entrance.ground });
  const input: WalkInput = { build: open, token, rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
  const search = new WalkSearch(new WalkWorld(input));
  const reached = unsqueezedReach(open, token, from, side, plan.w, plan.h);
  for (const target of plan.rooms) {
    const to = spotsIn(target, cells, room, side).find((p) => reached.has(key(p.x, p.y)));
    if (!to) assert.fail(`a ${size} creature walks from the entrance into the room at ${target.x}, ${target.y} without squeezing`);
    assert.notEqual(findRoute(input, to, search), "none", `the drag's route reaches the room at ${target.x}, ${target.y}`);
  }
}

/**
 * Where a creature of `side` squares gets to from `from` a whole square at
 * a time, never squeezed: each step must pass the leg test every route's
 * pieces pass (movement.ts `legStop`) with the full footprint, landing on
 * the highest ground under it as a walker does.
 */
function unsqueezedReach(room: RoomState, token: ReturnType<typeof ownWalk>, from: { x: number; y: number }, side: number, w: number, h: number): Set<string> {
  const top = (x: number, y: number) => {
    let g = -Infinity;
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) g = Math.max(g, groundAt(room.buildChunks, S, x + i, y + j));
    return g;
  };
  const seen = new Set([key(from.x, from.y)]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const [dx, dy] of Object.values(STEP)) {
      const x = at.x + dx;
      const y = at.y + dy;
      if (x < 0 || y < 0 || x + side > w || y + side > h || seen.has(key(x, y))) continue;
      const walker = { ...token, x: at.x, y: at.y, elevation: top(at.x, at.y), squeeze: undefined };
      if (legStop(room, walker, { x, y, elevation: top(x, y), squeeze: false }) !== null) continue;
      seen.add(key(x, y));
      queue.push({ x, y });
    }
  }
  return seen;
}

function checkLanded(s: DungeonSettings, seedText: string): void {
  const made = previewOf(s, seedText, builderScene({ id: "x", name: "Dungeon", w: s.w, h: s.h }), DEFAULT_CONTEXT, null);
  if (!made.ok) {
    assert.equal(made.error, "fit", `a plan the scratch room refuses is a generator bug (${JSON.stringify(s)} ${seedText})`);
    return;
  }
  const { plan, room } = made;
  assert.ok(made.ops.length <= 60, `${made.ops.length} ops fit the server's burst`);
  assert.equal(made.ops[0]?.t, "scene.create");
  const firstTrap = made.ops.findIndex((op) => op.t === "trap.create");
  if (firstTrap >= 0) assert.ok(made.ops.slice(firstTrap).every((op) => op.t === "trap.create"), "traps last");
  for (const op of made.ops) if (op.t === "build.edge") for (const e of op.edges) assert.equal(e.feature?.kind, "door", "only doors are drawn");
  // Heights merged by value, 0 left out: a value takes more than one op only once it fills an op's cells.
  const heights = made.ops.flatMap((op) => (op.t === "build.height" ? [op] : []));
  for (const ft of new Set(heights.map((h) => h.height))) {
    assert.notEqual(ft, 0);
    const parts = heights.filter((h) => h.height === ft);
    assert.ok(parts.slice(0, -1).every((h) => h.cells.length === MAX_BUILD_CELLS), `heights at ${ft} ft are one op until it is full`);
  }
  const text = JSON.stringify(made.ops);
  assert.ok(!text.includes(seedText) && !text.includes(seedText.slice(1)), "nothing of the seed is in the ops");
  const cells = cellsOf(room);
  const roomOf = (x: number, y: number) => plan.rooms.find((r) => inRoom(r, x, y));

  walksEverywhere(plan, room, s.wide ? "large" : "medium");

  // No ledge between two corridor squares.
  const ledged = ledges(room);
  for (const k of cells.keys()) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (roomOf(x, y)) continue;
    for (const dir of [STEP.e!, STEP.s!]) {
      const nx = x + dir[0];
      const ny = y + dir[1];
      if (!cells.has(key(nx, ny)) || roomOf(nx, ny)) continue;
      assert.ok(!ledged.has(edgeToward(x, y, dir)), `no ledge between the corridor squares ${k} and ${nx},${ny}`);
    }
  }

  // Each stair faces up its run or onto its dais, both edges along it linked.
  for (const k of cells.keys()) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const mark = markAt(room, x, y);
    if (mark === ".") continue;
    const step = STEP[mark];
    assert.ok(step, `the stair at ${k} faces a compass way, not ${mark}`);
    const fx = x + step[0];
    const fy = y + step[1];
    const bx = x - step[0];
    const by = y - step[1];
    // The entrance stub's last stair points out of the map.
    if (fx < 0 || fy < 0 || fx >= plan.w || fy >= plan.h) continue;
    assert.ok(cells.has(key(fx, fy)) && cells.has(key(bx, by)), `the stair at ${k} has ground before and after it`);
    assert.ok(groundAt(room.buildChunks, S, fx, fy) > groundAt(room.buildChunks, S, bx, by), `the stair at ${k} faces up`);
    assert.ok(!ledged.has(edgeToward(x, y, step)) && !ledged.has(edgeToward(x, y, [-step[0], -step[1]])), `both edges along the stair at ${k} are linked`);
    const inside = roomOf(x, y);
    if (inside) {
      // A dais's stair, the square before it and the dais square at its top stay clear.
      for (const [cx, cy] of [[x, y], [bx, by], [fx, fy]] as const) assert.ok(FLOOR_TERRAINS.has(cells.get(key(cx, cy)) as never), `${cx},${cy} by the dais's stair is clear floor`);
    }
  }

  // Every dais is walked onto from its room.
  for (const r of plan.rooms) {
    const top: { x: number; y: number }[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (groundAt(room.buildChunks, S, x, y) > r.ground && FLOOR_TERRAINS.has(cells.get(key(x, y)) as never)) top.push({ x, y });
    if (top.length === 0) continue;
    const from = spotsIn(r, cells, room, 1)[0];
    assert.ok(from);
    const input: WalkInput = { build: room, token: ownWalk({ sceneId: S, size: "medium", x: from.x, y: from.y, elevation: r.ground }), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
    const search = new WalkSearch(new WalkWorld(input));
    assert.ok(top.some((p) => findRoute(input, p, search) !== "none"), `the dais in the room at ${r.x}, ${r.y} is walked onto`);
  }

  // Reveal room in any room, the entrance included, takes exactly that room.
  const build = indexBuild(Object.values(room.buildChunks).filter((c) => c.sceneId === S));
  for (const r of plan.rooms) {
    const flood = floodRoom(build, { x: r.x + 0.5, y: r.y + 0.5 }, { bounds: { w: plan.w, h: plan.h } });
    const want: string[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) want.push(key(x, y));
    assert.deepEqual([...flood.cells].sort(), want.sort(), `Reveal room takes exactly the room at ${r.x}, ${r.y}`);
  }
}

test("DG-B: any dungeon lands whole, walks from the entrance to every room, has no corridor ledge, stairs up their runs, daises reached and Reveal room exact", () => {
  holds(fc.property(settings, seed, (s, seedText) => checkLanded(s, seedText)), 40);
});

test("DG-B: the defaults at each size, and Wide with heights, land by the same rules", () => {
  const sizes: [number, number][] = [[30, 30], [50, 50], [80, 80]];
  holds(
    fc.property(fc.constantFrom(...sizes), fc.boolean(), seed, ([w, h], wide, seedText) =>
      checkLanded({ ...DEFAULT_SETTINGS, w, h, rooms: Math.min(roomCap(w, h), w === 30 ? 6 : w === 50 ? 12 : 20), wide }, seedText),
    ),
    24,
  );
});
