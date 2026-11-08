import type { TerrainId } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { MEMBER_COLORS } from "../../lib/theme.ts";
import { builderScene, type SceneInput } from "../scenes/create.ts";
import { blockPlaceholder, buildOps, lightPlaceholder, PAGE_PLACEHOLDER, pinPlaceholder, stampPlaceholder, stonePlaceholder, trapOps } from "./ops.ts";
import type { DungeonPlan, PlanRoom } from "./plan.ts";
import { landAll, scratchRoom } from "./scratch.ts";
import { GENERATOR_VERSION } from "./settings.ts";

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

/**
 * The 100-op hand plan's ops as Make sends them, the stamps, lights,
 * stones, key page and pins written out here so section 6's measure runs
 * before the landing writes them itself. Each key block is about as long
 * as a generated room's line.
 */
export function hundredOps(scene: SceneInput): ClientOp[] {
  const plan = hundredPlan();
  const sceneId = scene.id;
  const build = buildOps(plan, scene);
  const stamps = plan.stamps.map((s, i) => ({ id: stampPlaceholder(i), art: { key: s.key }, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation, z: i, visibility: "all" as const }));
  const dress: ClientOp[] = [
    { t: "build.stamps", sceneId, put: stamps.slice(0, 100) },
    { t: "build.stamps", sceneId, put: stamps.slice(100) },
    { t: "build.lights", sceneId, put: plan.lights.map((l, i) => ({ id: lightPlaceholder(i), x: l.x, y: l.y, bright: 20, dim: 20, on: true, walls: true, label: l.label })) },
    ...plan.stones.map(([x, y], i): ClientOp => ({
      t: "token.create",
      token: { id: stonePlaceholder(i), sceneId, kind: "object", name: "Rolling stone", size: "large", x, y, visibility: "dm", hpVisibility: "hidden", actor: { inline: { hp: { cur: 100, max: 100, temp: 0 }, life: "alive", ac: 17, speeds: { walk: 60 }, initBonus: 8, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } },
    })),
  ];
  const built = landAll(scratchRoom(), [...build, ...dress]);
  if (!built.ok) throw new Error(built.why);
  const line = (n: number) => `**${n}.** 8 × 8 squares (40 by 40 ft). Doors: north to ${n + 1}, east to ${n + 8} (locked). A dais 5 ft up. Lit by a fire pit. Trap: Hidden Pit. Trinket: A tiny silver icon of a raven.`;
  const blocks = [{ id: blockPlaceholder(0), text: "A generated Dungeon of 40 rooms on 100 × 100 squares (500 by 500 ft). Room 1 is the way in. Each room's pin carries its number." }, ...plan.rooms.map((_, i) => ({ id: blockPlaceholder(i + 1), text: line(i + 1) }))];
  const key: ClientOp[] = [
    { t: "journal.create", page: { id: PAGE_PLACEHOLDER, title: `${scene.name} key`, folder: "Dungeon keys", access: "dm", blocks } },
    ...plan.rooms.map((r, i): ClientOp => ({ t: "pin.put", pin: { id: pinPlaceholder(i), sceneId, x: r.pin[0] + 0.5, y: r.pin[1] + 0.5, label: String(i + 1), pageId: PAGE_PLACEHOLDER, color: MEMBER_COLORS[0]!, visibility: "dm" } })),
  ];
  // A Rolling Stone's one action shows its stone.
  const traps = trapOps(plan, built.room.buildChunks, "11-16", sceneId).map((op, i): ClientOp => {
    const stone = plan.traps[i]?.stone;
    if (op.t !== "trap.create" || stone === undefined) return op;
    return { ...op, trap: { ...op.trap, rig: { ...op.trap.rig, actions: [{ show: { tokenId: stonePlaceholder(stone) } }] } } };
  });
  return [...build, ...dress, ...traps, ...key];
}
