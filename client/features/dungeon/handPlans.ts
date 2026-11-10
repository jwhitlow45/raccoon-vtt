import type { CellRect, RoomState, TerrainId } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import { MEMBER_COLORS } from "../../lib/theme.ts";
import { builderScene, type SceneInput } from "../scenes/create.ts";
import type { KeyInput } from "./keyPage.ts";
import { endsKey, hexSide, hexWalls, NO_SPACE } from "./hexWalls.ts";
import { latticeFor } from "./lattice.ts";
import type { DungeonPlan, PlanRoom, WingBase } from "./plan.ts";
import { landAll, landDungeon, scratchRoom } from "./scratch.ts";
import { clampSettings, DEFAULT_SETTINGS, GENERATOR_VERSION, type DungeonSettings } from "./settings.ts";
import { wingHash } from "./wing.ts";

/*
 * Plans written by hand for the landing tests, so the ops, the scratch room
 * and the send are tested apart from the generator. Not a test file itself:
 * node --test runs only `*.test.ts`.
 */

function rect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

/**
 * Two rooms on a 30 by 30 map: the entrance A (3, 3, 5 by 5, stone) with a
 * stub west to the map's edge through a closed door, and B (15, 3, 6 by 6,
 * wood) raised 5 ft, reached from A's east door by a corridor that ends in
 * B's run: the far landing at (12, 5), a stair at (13, 5) facing east, up
 * the run toward the room, and the near landing at (14, 5) at 5 ft before
 * B's locked door. One rubble square in the corridor, a Hidden Pit in B and
 * a Poisoned Needle on B's locked door.
 */
export function twoRooms(): DungeonPlan {
  const a: PlanRoom = { x: 3, y: 3, w: 5, h: 5, ground: 0, floor: "stone", pin: [5, 5], entrance: true };
  const b: PlanRoom = { x: 15, y: 3, w: 6, h: 6, ground: 5, floor: "wood", pin: [18, 6] };
  const corridor = ["0,5", "1,5", "2,5", "8,5", "9,5", "11,5", "12,5", "13,5", "14,5"];
  const paint: Partial<Record<TerrainId, string[]>> = { stone: [...rect(3, 3, 5, 5), ...corridor], wood: rect(15, 3, 6, 6), rubble: ["10,5"] };
  return {
    version: GENERATOR_VERSION,
    theme: "dungeon",
    w: 30,
    h: 30,
    asked: 2,
    rooms: [a, b],
    paint,
    doors: [
      { edge: "3,5,w", state: "closed" },
      { edge: "8,5,w", state: "closed" },
      { edge: "15,5,w", state: "locked" },
    ],
    heights: [{ ft: 5, cells: [...rect(15, 3, 6, 6), "14,5"] }],
    stairs: [
      { up: "e", cells: ["13,5"] },
      { up: "w", cells: ["0,5"] },
    ],
    traps: [
      { preset: "hidden-pit", zone: { cells: [{ x: 17, y: 4, w: 2, h: 2 }] } },
      { preset: "poisoned-needle", zone: { door: { edge: "15,5,w" } } },
    ],
    stamps: [],
    lights: [],
    stones: [],
    entrance: { x: 3, y: 3, w: 5, h: 5 },
    key: null,
  };
}

/**
 * The largest Wide topology's doors (section 8): 39 tree links and 10 loop
 * links, each with a two-square doorway at both ends, and the entrance's
 * own, 198 door edges in all, laid in rows of rooms 2 squares wide so each
 * doorway's two edges touch end to end.
 */
export function widestDoors(): DungeonPlan {
  const doors: DungeonPlan["doors"] = [];
  for (let i = 0; doors.length < 198; i++) {
    const x = 2 + (i % 24) * 4;
    const y = 2 + Math.floor(i / 24) * 6;
    doors.push({ edge: `${x},${y},n`, state: i % 7 === 0 ? "locked" : "closed" }, { edge: `${x + 1},${y},n`, state: i % 7 === 0 ? "locked" : "closed" });
  }
  const cells = new Set<string>();
  for (const d of doors) {
    const [x, y] = d.edge.split(",").map(Number) as [number, number];
    cells.add(`${x},${y}`).add(`${x},${y - 1}`);
  }
  return {
    version: GENERATOR_VERSION,
    theme: "dungeon",
    w: 100,
    h: 100,
    asked: 40,
    rooms: [],
    paint: { stone: [...cells] },
    doors,
    heights: [],
    stairs: [],
    traps: [],
    stamps: [],
    lights: [],
    stones: [],
    entrance: { x: 0, y: 0, w: 2, h: 2 },
    key: null,
  };
}

/** The scene a dialog sends for a plan: a Builder scene of its size, under fog. */
export function dialogScene(plan: Pick<DungeonPlan, "w" | "h">, id = "chosen-id"): SceneInput {
  return builderScene({ id, name: "Crypt", w: plan.w, h: plan.h });
}

/** Stamps of the hand plans, by catalog key at the catalog's size (shared/stamps.ts). */
const PROPS = [
  { key: "barrel", w: 0.5, h: 0.5 },
  { key: "crate", w: 0.75, h: 0.5 },
  { key: "chest", w: 0.75, h: 0.5 },
] as const;

/**
 * The 100-op hand plan (phase 2, section 6): 40 rooms of 8 by 8 squares on
 * a 100 by 100 map in 5 rows of 8, each joined to the next in its row and
 * the one below by a corridor with a door at both ends, under ten
 * terrains, 18 heights and four stair facings, so its ground takes 32 ops
 * as the largest generated dungeons' do. Every room holds a lit fire pit
 * and three props (160 stamps, 40 lights), two Rolling Stones stand in
 * corridors, 20 traps of every kind lie about, and every room is in the
 * key with its pin: the scene, 31 ground ops, 2 stamp ops, a light op, 2
 * stones, 20 traps, the key page and 40 pins make exactly 100 (MAX_OPS).
 */
export function hundredPlan(): DungeonPlan {
  const rooms: PlanRoom[] = [];
  const cells = new Map<string, TerrainId>();
  const paint = (keys: readonly string[], t: TerrainId) => keys.forEach((k) => cells.set(k, t));
  const floors: readonly TerrainId[] = ["stone", "wood", "dirt", "cave", "grass"];
  const doors: DungeonPlan["doors"] = [];
  const at = (i: number) => ({ x: 3 + (i % 8) * 12, y: 3 + Math.floor(i / 8) * 19 });
  for (let i = 0; i < 40; i++) {
    const { x, y } = at(i);
    rooms.push({ x, y, w: 8, h: 8, ground: 0, floor: floors[i % 5]!, pin: [x + 4, y + 4], ...(i === 0 ? { entrance: true as const } : {}) });
    paint(rect(x, y, 8, 8), floors[i % 5]!);
    if (i % 8 < 7) {
      paint(rect(x + 8, y + 3, 4, 1), "stone");
      doors.push({ edge: `${x + 8},${y + 3},w`, state: i % 6 === 0 ? "locked" : "closed" }, { edge: `${x + 12},${y + 3},w`, state: "closed" });
    }
    if (i < 32) {
      paint(rect(x + 3, y + 8, 1, 11), "stone");
      doors.push({ edge: `${x + 3},${y + 8},n`, state: "closed" }, { edge: `${x + 3},${y + 19},n`, state: "closed" });
    }
    // An overlay in each room, one of five, on a square off its middle row.
    paint([`${x + 1},${y + 1}`], (["water", "difficult", "rubble", "pit", "pillar"] as const)[i % 5]!);
  }
  paint(rect(0, 6, 3, 1), "stone");
  doors.push({ edge: "3,6,w", state: "closed" });
  const byTerrain: Partial<Record<TerrainId, string[]>> = {};
  for (const [k, t] of cells) (byTerrain[t] ??= []).push(k);
  // Rooms 1 to 18 each at their own height, so the heights take one op a value.
  const heights = Array.from({ length: 18 }, (_, k) => {
    const room = rooms[k + 1]!;
    const ft = (k % 2 === 0 ? 1 : -1) * 5 * (1 + Math.floor(k / 2));
    room.ground = ft;
    return { ft, cells: rect(room.x, room.y, room.w, room.h) };
  });
  const stairs: DungeonPlan["stairs"] = [
    { up: "w", cells: ["0,6"] },
    { up: "e", cells: ["13,6"] },
    { up: "n", cells: ["6,12"] },
    { up: "s", cells: ["18,12"] },
  ];
  const stamps: DungeonPlan["stamps"] = [];
  const lights: DungeonPlan["lights"] = [];
  for (const r of rooms) {
    stamps.push({ key: "fire-pit", x: r.x + 6.5, y: r.y + 6.5, w: 1, h: 1, rotation: 0 });
    lights.push({ x: r.x + 6.5, y: r.y + 6.5, preset: "Torch", label: "Fire pit", stamp: "fire-pit" });
    for (const [k, p] of PROPS.entries()) stamps.push({ key: p.key, x: r.x + 1.5 + 2 * k, y: r.y + 5.5, w: p.w, h: p.h, rotation: k % 2 === 0 ? 0 : 90 });
  }
  const traps: DungeonPlan["traps"] = [];
  for (let k = 0; k < 20; k++) {
    const r = rooms[k + 1]!;
    switch (k % 5) {
      case 0:
        traps.push({ preset: "hidden-pit", zone: { cells: [{ x: r.x + 3, y: r.y + 2, w: 2, h: 2 }] } });
        break;
      case 1:
        traps.push({ preset: "poisoned-needle", zone: { door: { edge: `${r.x + 3},${r.y + 8},n` } } });
        break;
      case 2:
        traps.push({ preset: "collapsing-roof", zone: { wire: { a: [r.x + 9, r.y + 3], b: [r.x + 9, r.y + 4] } }, hits: [{ x: r.x + 8, y: r.y + 3, w: 3, h: 1 }] });
        break;
      case 3:
        traps.push({ preset: "fire-casting-statue", zone: { cells: [{ x: r.x + 4, y: r.y + 5, w: 1, h: 1 }] }, cone: { origin: [r.x + 4.5, r.y + 6.5], yaw: 270 } });
        break;
      default:
        traps.push({ preset: k < 10 ? "rolling-stone" : "poisoned-darts", zone: { cells: [{ x: r.x + 3, y: r.y + 11, w: 1, h: 1 }] }, ...(k < 10 ? { stone: k === 4 ? 0 : 1 } : { hits: [{ x: r.x + 3, y: r.y + 9, w: 1, h: 5 }] }) });
    }
  }
  const sides = ["n", "e", "s", "w"] as const;
  const key: DungeonPlan["key"] = rooms.map((r, i) => ({
    n: i + 1,
    room: i,
    doors: [{ side: sides[i % 4]!, to: i === 0 ? "edge" : i, state: i % 6 === 0 ? "locked" : "closed" }, { side: sides[(i + 1) % 4]!, to: ((i + 1) % 40) + 1, state: "closed" }],
    light: "Fire pit",
    traps: i >= 1 && i <= 20 ? [["Hidden Pit", "Poisoned Needle", "Collapsing Roof", "Fire-Casting Statue", "Rolling Stone"][(i - 1) % 5]!] : [],
    trinket: (i * 7) % 100,
    ...(r.ground !== 0 ? {} : { dais: true as const }),
  }));
  return {
    version: GENERATOR_VERSION,
    theme: "dungeon",
    w: 100,
    h: 100,
    asked: 40,
    rooms,
    paint: byTerrain,
    doors,
    heights,
    stairs,
    stamps,
    lights,
    stones: [
      [rooms[5]!.x + 3, rooms[5]!.y + 12],
      [rooms[10]!.x + 3, rooms[10]!.y + 12],
    ],
    traps,
    entrance: { x: 3, y: 3, w: 8, h: 8 },
    key,
  };
}

/** The choices the hand plans were "made" with: the largest, with the key, at levels 11 to 16 so a Rolling Stone stands. */
export const HAND_SETTINGS: DungeonSettings = { ...DEFAULT_SETTINGS, w: 100, h: 100, rooms: 40, density: "dense", corridors: "winding", wide: true, band: "11-16", dressing: "full", lit: 100, key: true };

/** The key's room facts for a hand plan's preview: the dialog's name, a DM's color, 5 ft squares. */
export function handKey(name = "Crypt"): KeyInput {
  return { name, color: MEMBER_COLORS[0]!, feetPerCell: 5 };
}

/** The 100-op hand plan's ops as Make sends them, landed through the scratch room as the worker lands a plan. */
export function hundredOps(scene: SceneInput): ClientOp[] {
  const landed = landDungeon(hundredPlan(), scene, HAND_SETTINGS.band, { input: handKey(scene.name), settings: HAND_SETTINGS });
  if (!landed.ok) throw new Error(landed.why);
  return landed.ops;
}

/**
 * twoRooms dressed (phase 2): a fire pit and its Torch in A, a bed and a
 * chest in B, a hidden Rolling stone in the corridor that a Rolling Stone
 * trap on its plate shows, Poisoned Darts with hits along the corridor, a
 * Fire-Casting Statue's cone from B's statue, and the key for both rooms,
 * B lit, trapped and raised.
 */
export function dressedRooms(): DungeonPlan {
  const plan = twoRooms();
  plan.stamps = [
    { key: "fire-pit", x: 4.5, y: 4.5, w: 1, h: 1, rotation: 0 },
    { key: "bed", x: 19.5, y: 4.75, w: 1, h: 1.5, rotation: 0 },
    { key: "chest", x: 16.5, y: 8.5, w: 0.75, h: 0.5, rotation: 90 },
    { key: "ph-statue", x: 20.5, y: 8.375, w: 1, h: 1.25, rotation: 270 },
  ];
  plan.lights = [{ x: 4.5, y: 4.5, preset: "Torch", label: "Fire pit", stamp: "fire-pit" }];
  plan.stones = [[8, 4]];
  plan.traps = [
    ...plan.traps,
    { preset: "rolling-stone", zone: { cells: [{ x: 11, y: 5, w: 1, h: 1 }] }, stone: 0 },
    { preset: "poisoned-darts", zone: { cells: [{ x: 9, y: 5, w: 1, h: 1 }] }, hits: [{ x: 8, y: 5, w: 4, h: 1 }] },
    { preset: "fire-casting-statue", zone: { cells: [{ x: 19, y: 7, w: 1, h: 1 }] }, cone: { origin: [20.5, 8.5], yaw: 225 } },
  ];
  plan.key = [
    { n: 1, room: 0, doors: [{ side: "w", to: "edge", state: "closed" }, { side: "e", to: 2, state: "closed" }], light: "Fire pit", traps: [], trinket: 0 },
    { n: 2, room: 1, doors: [{ side: "w", to: 1, state: "locked" }], traps: ["Hidden Pit", "Poisoned Needle", "Fire-Casting Statue"], trinket: 99, dais: true },
  ];
  return plan;
}

/** The scene the wing bases stand on. */
export const WING_SCENE = "wing-scene";

/** A wing's choices for the landing tests: a few rooms, the key on. */
export const WING_SETTINGS: DungeonSettings = clampSettings({ ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 4, key: true, traps: 12, dressing: "full", lit: 100 });

function withHash(base: Omit<WingBase, "hash">, s: DungeonSettings): WingBase {
  return { ...base, hash: wingHash(base, s) };
}

/**
 * A square wing's base (phase 3, 3.2): a 70 by 40 Builder scene with one
 * stone room of 10 by 10 at (10, 12), raised `ground` ft, the area east of
 * it, and the join on its east wall, an automatic wall, `wide` taking the
 * edge below it too.
 */
export function squareWingBase(opts: { ground?: number; wide?: boolean; rule?: "all" | "floor" } = {}): WingBase {
  const { ground = 0, wide = false, rule = "all" } = opts;
  const cells = rect(10, 12, 10, 10);
  const ops: ClientOp[] = [
    { t: "scene.create", scene: { ...builderScene({ id: WING_SCENE, name: "Keep", w: 70, h: 40 }), autoWalls: rule } },
    { t: "build.paint", sceneId: WING_SCENE, terrain: "stone", cells },
    ...(ground !== 0 ? [{ t: "build.height", sceneId: WING_SCENE, cells, height: ground } as ClientOp] : []),
  ];
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  const keys = wide ? ["20,16,w", "20,17,w"] : ["20,16,w"];
  const join: JoinExpect = { grid: "squares", edges: keys.map((key) => ({ key, feature: null, ground })) };
  return withHash({ scene: landed.room.scenes[WING_SCENE]!, state: landed.room, area: { x: 30, y: 2, w: 36, h: 36 }, join }, { ...WING_SETTINGS, wide });
}

/**
 * A hex wing's base: a 70 by 50 hex scene with one closed room of free
 * walls over lattice cells (10, 12) to (19, 21), raised `ground` ft, the
 * area east of it, and the join on its east side at row 16 (mirrored on
 * Hex columns).
 */
export function hexWingBase(grid: "hexRows" | "hexColumns" = "hexRows", opts: { ground?: number } = {}): { base: WingBase; state: RoomState } {
  const { ground = 0 } = opts;
  const bounds = { w: 70, h: 50 };
  const L = latticeFor(grid, bounds);
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  const room: number[] = [];
  for (let y = 12; y < 22; y++) {
    for (let x = 10; x < 20; x++) {
      space[y * L.W + x] = 0;
      room.push(y * L.W + x);
    }
  }
  const { walls } = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] });
  const put = walls.map((w, i) => ({ id: `wl${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" as const } }));
  const ops: ClientOp[] = [{ t: "scene.create", scene: builderScene({ id: WING_SCENE, name: "Keep", w: bounds.w, h: bounds.h, gridShape: grid }) }];
  for (let i = 0; i < put.length; i += 300) ops.push({ t: "build.walls", sceneId: WING_SCENE, put: put.slice(i, i + 300) });
  if (ground !== 0) ops.push({ t: "build.height", sceneId: WING_SCENE, cells: room.map((k) => L.keyOf(k)), height: ground });
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  const state = landed.room;
  const key = endsKey(...hexSide(L, 16 * L.W + 19, 0));
  let found: Extract<JoinExpect, { grid: "hex" }>["walls"][number] | null = null;
  for (const c of Object.values(state.buildChunks)) for (const w of c?.walls ?? []) if (endsKey(w.a, w.b) === key) found = { cx: c!.cx, cy: c!.cy, id: w.id, a: w.a, b: w.b, f: w.f };
  if (!found) throw new Error("no wall on the room's east side");
  const lattice: CellRect = { x: 26, y: 2, w: 40, h: 44 };
  const area = grid === "hexColumns" ? { x: lattice.y, y: lattice.x, w: lattice.h, h: lattice.w } : lattice;
  return { base: withHash({ scene: state.scenes[WING_SCENE]!, state, area, join: { grid: "hex", walls: [found], ground } }, WING_SETTINGS), state };
}

/**
 * A hex wing's base joined on any of a room's six sides (DG3 review round
 * 1): an 80 by 80 hex scene with one closed room of free walls over 10 by
 * 10 lattice cells, raised or sunk `ground` ft, joined on the side toward
 * hex direction `dir` with its inside hex on an odd row or an even one,
 * and the area beyond that side (mirrored on Hex columns). Wide joins the
 * planner's own Wide doorway: two lanes a lattice row apart on the slanted
 * sides, an offset column apart on the east and west, and the side between
 * them that runs at a slant. `ops` make the scene and the room.
 */
export function hexWingSide(grid: "hexRows" | "hexColumns", opts: { dir: number; odd: boolean; wide?: boolean; ground?: number; sceneId?: string }): { base: WingBase; ops: ClientOp[] } {
  const { dir, odd, wide = false, ground = 0, sceneId = WING_SCENE } = opts;
  const bounds = { w: 80, h: 80 };
  const L = latticeFor(grid, bounds);
  const north = dir === 4 || dir === 5;
  const south = dir === 1 || dir === 2;
  // The room's top row sets the parity of a north join's row, and its bottom row, nine below, a south join's.
  const room = { x: 35, y: north ? (odd ? 41 : 40) : south ? (odd ? 40 : 41) : 40, w: 10, h: 10 };
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  const cells: number[] = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      space[y * L.W + x] = 0;
      cells.push(y * L.W + x);
    }
  }
  const { walls } = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] });
  const put = walls.map((w, i) => ({ id: `wl${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" as const } }));
  const ops: ClientOp[] = [{ t: "scene.create", scene: builderScene({ id: sceneId, name: "Keep", w: bounds.w, h: bounds.h, gridShape: grid }) }];
  for (let i = 0; i < put.length; i += 300) ops.push({ t: "build.walls", sceneId, put: put.slice(i, i + 300) });
  if (ground !== 0) ops.push({ t: "build.height", sceneId, cells: cells.map((k) => L.keyOf(k)), height: ground });
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  const state = landed.room;
  const row = north ? room.y : south ? room.y + room.h - 1 : room.y + 4 + (odd ? 1 : 0);
  const col = dir === 0 ? room.x + room.w - 1 : dir === 3 ? room.x : dir === 1 || dir === 5 ? room.x + 4 : room.x + 5;
  const a = row * L.W + col;
  const sides: [number, number][] = [[a, dir]];
  if (wide) {
    const b = north || south ? a + 1 : a + L.W;
    const [oa, ob] = [L.step(a, dir, 1), L.step(b, dir, 1)];
    sides.push([b, dir]);
    for (const [i, o] of [
      [a, ob],
      [b, oa],
    ] as const) {
      for (let d = 0; d < 6; d++) if (L.step(i, d, 1) === o) sides.push([i, d]);
    }
  }
  const join: Extract<JoinExpect, { grid: "hex" }>["walls"] = sides.map(([k, d]) => {
    const key = endsKey(...hexSide(L, k, d));
    for (const c of Object.values(state.buildChunks)) for (const w of c?.walls ?? []) if (endsKey(w.a, w.b) === key) return { cx: c!.cx, cy: c!.cy, id: w.id, a: w.a, b: w.b, f: w.f };
    throw new Error(`no wall on side ${d} of ${k}`);
  });
  const lattice: CellRect = dir === 0 ? { x: 51, y: 15, w: 28, h: 60 } : dir === 3 ? { x: 1, y: 15, w: 28, h: 60 } : north ? { x: 10, y: 1, w: 60, h: 32 } : { x: 10, y: 58, w: 60, h: 32 };
  const area = grid === "hexColumns" ? { x: lattice.y, y: lattice.x, w: lattice.h, h: lattice.w } : lattice;
  return { base: withHash({ scene: state.scenes[sceneId]!, state, area, join: { grid: "hex", walls: join, ground } }, { ...WING_SETTINGS, wide }), ops };
}
