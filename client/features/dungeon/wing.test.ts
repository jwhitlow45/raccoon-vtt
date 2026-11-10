import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AutoWalls, CellRect, EdgeFeature, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import { builderScene } from "../scenes/create.ts";
import { endsKey, hexSide, hexWalls, NO_SPACE } from "./hexWalls.ts";
import { latticeFor } from "./lattice.ts";
import type { Rect } from "./layout.ts";
import { planFitted, type WingBase } from "./plan.ts";
import { landAll, scratchRoom } from "./scratch.ts";
import { clampSettings, DEFAULT_SETTINGS, type DungeonSettings } from "./settings.ts";
import { readJoin, wingAllowance, wingSetup, wingWorld, type WingProblem } from "./wing.ts";

/*
 * Add a wing (phase 3, 3.2 to 3.4): the join a DM taps, the open ground
 * the planning flood reaches beyond it, the joined room's own structure
 * excused for the approach while every object and other build still
 * counts, and the scene's allowances.
 */

const S = "s";
const SETTINGS = (over: Partial<DungeonSettings> = {}) => clampSettings({ ...DEFAULT_SETTINGS, w: 30, h: 30, rooms: 4, ...over });

/** A square scene 70 by 40 with one painted room, landed through the scratch room. */
function squareRoom(room: Rect, rule: AutoWalls = "all", more: ClientOp[] = []): RoomState {
  const cells: string[] = [];
  for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) cells.push(`${x},${y}`);
  const ops: ClientOp[] = [{ t: "scene.create", scene: { ...builderScene({ id: S, name: "Old", w: 70, h: 40 }), autoWalls: rule } }, { t: "build.paint", sceneId: S, terrain: "stone", cells }, ...more];
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  return landed.room;
}

function squareBase(state: RoomState, area: CellRect, edges: { key: string; feature?: EdgeFeature | null }[], ground = 0): Omit<WingBase, "hash"> {
  const join: JoinExpect = { grid: "squares", edges: edges.map((e) => ({ key: e.key, feature: e.feature ?? null, ground })) };
  return { scene: state.scenes[S]!, state, area, join };
}

const ROOM: Rect = { x: 10, y: 12, w: 10, h: 10 };
const EAST: CellRect = { x: 30, y: 2, w: 36, h: 36 };

/** A hex scene with one closed room of free walls, and the wall on its side toward `dir` from the room hex at `at`. */
function hexRoom(grid: "hexRows" | "hexColumns", room: Rect, others: Rect[] = []) {
  const bounds = { w: 70, h: 50 };
  const L = latticeFor(grid, bounds);
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  [room, ...others].forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) space[y * L.W + x] = i;
  });
  const { walls } = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] });
  const put = walls.map((w, i) => ({ id: `wl${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" as const } }));
  const ops: ClientOp[] = [{ t: "scene.create", scene: builderScene({ id: S, name: "Old", w: bounds.w, h: bounds.h, gridShape: grid }) }];
  for (let i = 0; i < put.length; i += 300) ops.push({ t: "build.walls", sceneId: S, put: put.slice(i, i + 300) });
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  const state = landed.room;
  const wallAt = (k: number, dir: number) => {
    const key = endsKey(...hexSide(L, k, dir));
    for (const c of Object.values(state.buildChunks)) for (const w of c?.walls ?? []) if (endsKey(w.a, w.b) === key) return { cx: c!.cx, cy: c!.cy, id: w.id, a: w.a, b: w.b, f: w.f };
    throw new Error(`no wall at ${k} toward ${dir}`);
  };
  return { L, state, wallAt };
}

/** The area beyond a side of a hex room, in the scene's keys. */
function hexArea(grid: "hexRows" | "hexColumns", room: Rect, side: "n" | "e" | "s" | "w"): CellRect {
  const lattice: CellRect =
    side === "e" ? { x: room.x + room.w + 6, y: 2, w: 28, h: 44 } : side === "w" ? { x: 1, y: 2, w: room.x - 8, h: 44 } : side === "n" ? { x: 2, y: 1, w: 60, h: room.y - 8 } : { x: 2, y: room.y + room.h + 6, w: 60, h: 20 };
  return grid === "hexColumns" ? { x: lattice.y, y: lattice.x, w: lattice.h, h: lattice.w } : lattice;
}

const hexBase = (state: RoomState, area: CellRect, walls: Extract<JoinExpect, { grid: "hex" }>["walls"]): Omit<WingBase, "hash"> => ({ scene: state.scenes[S]!, state, area, join: { grid: "hex", walls, ground: 0 } });

/** A wing planned on a base, with its problem. */
function planned(base: Omit<WingBase, "hash">, s: DungeonSettings = SETTINGS()) {
  return planFitted(s, "1Q8V2DR4HJ0Y7ZB3", { feetPerCell: 5 }, { wing: { ...base, hash: "base" } });
}

describe("square joins", () => {
  test("an automatic wall, a drawn wall and a door are taken, a wall becoming a closed door and a door keeping its state", () => {
    const join = `${ROOM.x + ROOM.w},${ROOM.y + 4},w`;
    const door: EdgeFeature = { kind: "door", state: "open", secret: false, discovered: false };
    for (const [feature, more] of [
      [null, []],
      [{ kind: "wall" }, [{ t: "build.edge", sceneId: S, edges: [{ key: join, feature: { kind: "wall" } }] }]],
      [door, [{ t: "build.edge", sceneId: S, edges: [{ key: join, feature: door }] }]],
    ] as [EdgeFeature | null, ClientOp[]][]) {
      const state = squareRoom(ROOM, "all", more);
      const p = planned(squareBase(state, EAST, [{ key: join, feature }]));
      assert.equal(p.wing?.problem, null, `${feature?.kind ?? "automatic"}`);
      assert.ok(p.plan.rooms.length >= 2);
      const joinDoor = p.plan.doors.find((d) => d.edge === join);
      if (feature?.kind === "door") assert.equal(joinDoor, undefined, "a door keeps its state");
      else assert.equal(joinDoor?.state, "closed");
      assert.deepEqual(p.plan.join, squareBase(state, EAST, [{ key: join, feature }]).join);
      // The wing lands on the scene beside the room.
      const landed = landAll(state, [...(p.plan.paint.stone ? [{ t: "build.paint", sceneId: S, terrain: "stone", cells: p.plan.paint.stone } as ClientOp] : [])]);
      assert.ok(landed.ok);
    }
  });

  test("a Wide join takes two edges of one wall, and an edge between two painted or two empty cells is refused", () => {
    const state = squareRoom(ROOM);
    const x = ROOM.x + ROOM.w;
    const wide = planned(squareBase(state, EAST, [{ key: `${x},${ROOM.y + 4},w` }, { key: `${x},${ROOM.y + 5},w` }]), SETTINGS({ wide: true }));
    assert.equal(wide.wing?.problem, null);
    assert.equal(wide.plan.doors.filter((d) => d.edge.startsWith(`${x},`)).length, 2);
    assert.equal(planned(squareBase(state, EAST, [{ key: `${x},${ROOM.y + 4},w` }]), SETTINGS({ wide: true })).wing?.problem, "wideShape");
    assert.equal(planned(squareBase(state, EAST, [{ key: `${x - 3},${ROOM.y + 4},w` }])).wing?.problem, "noGround", "both sides painted");
    assert.equal(planned(squareBase(state, EAST, [{ key: `${x + 5},${ROOM.y + 4},w` }])).wing?.problem, "noGround", "both sides empty");
  });

  test("a raised join gets a run of stairs out to the corridor, and on a \"floor\" scene a raised or sunk join is refused", () => {
    const join = `${ROOM.x + ROOM.w},${ROOM.y + 4},w`;
    const cells: string[] = [];
    for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) for (let x = ROOM.x; x < ROOM.x + ROOM.w; x++) cells.push(`${x},${y}`);
    const raised = squareRoom(ROOM, "all", [{ t: "build.height", sceneId: S, cells, height: 10 }]);
    const p = planned(squareBase(raised, EAST, [{ key: join }], 10));
    assert.equal(p.wing?.problem, null);
    assert.ok(p.plan.stairs.some((st) => st.cells.includes(`${ROOM.x + ROOM.w + 1},${ROOM.y + 4}`)), "a stair just outside the join");
    for (const ground of [5, -5, -10]) {
      const floor = squareRoom(ROOM, "floor", [{ t: "build.height", sceneId: S, cells, height: ground }]);
      assert.equal(planned(squareBase(floor, EAST, [{ key: join }], ground)).wing?.problem, "raised", `${ground} ft`);
    }
    const flat = squareRoom(ROOM, "floor");
    assert.equal(planned(squareBase(flat, EAST, [{ key: join }])).wing?.problem, null, "0 ft on a \"floor\" scene");
  });

  test("a scene with automatic walls off takes no wing", () => {
    const state = squareRoom(ROOM, "off");
    assert.notEqual(wingSetup(squareBase(state, EAST, [{ key: `${ROOM.x + ROOM.w},${ROOM.y + 4},w` }]), { wide: false }).problem, null);
  });
});

describe("the approach and what stands near it", () => {
  const join = `${ROOM.x + ROOM.w},${ROOM.y + 4},w`;
  const jy = ROOM.y + 4;
  const ox = ROOM.x + ROOM.w;

  test("a deep joined room is excused within the margin, Narrow and Wide, on squares", () => {
    for (const wide of [false, true]) {
      const state = squareRoom(ROOM);
      const edges = wide ? [{ key: join }, { key: `${ox},${jy + 1},w` }] : [{ key: join }];
      assert.equal(wingSetup(squareBase(state, EAST, edges), { wide }).problem, null, wide ? "Wide" : "Narrow");
    }
  });

  test("each protected object within the margin of the approach, inside the joined room too, stands in the way", () => {
    const state = squareRoom(ROOM);
    const near = { x: ox + 1, y: jy - 2 };
    const inside = { x: ox - 2, y: jy };
    const cases: [string, (st: RoomState, at: { x: number; y: number }) => RoomState][] = [
      ["token", (st, at) => ({ ...st, tokens: { ...st.tokens, t1: { id: "t1", sceneId: S, x: at.x, y: at.y, size: "medium", w: 1, h: 1 } as never } })],
      ["trap", (st, at) => ({ ...st, traps: { ...st.traps, tr: { id: "tr", sceneId: S, zone: { cells: [{ x: at.x, y: at.y, w: 1, h: 1 }] } } as never } })],
      ["stamp", (st, at) => ({ ...st, stamps: { ...st.stamps, sp: { id: "sp", sceneId: S, x: at.x + 0.5, y: at.y + 0.5, w: 1, h: 1, rotation: 0 } as never } })],
      ["light", (st, at) => ({ ...st, lights: { ...st.lights, li: { id: "li", sceneId: S, x: at.x + 0.5, y: at.y + 0.5 } as never } })],
      ["label", (st, at) => ({ ...st, labels: { ...st.labels, la: { id: "la", sceneId: S, x: at.x + 0.5, y: at.y + 0.5 } as never } })],
      ["pin", (st, at) => ({ ...st, pins: { ...st.pins, pi: { id: "pi", sceneId: S, x: at.x + 0.5, y: at.y + 0.5 } as never } })],
      ["floor link", (st, at) => ({ ...st, floorLinks: { ...st.floorLinks, fl: { id: "fl", sceneId: S, rect: { x: at.x, y: at.y, w: 1, h: 1 } } as never } })],
    ];
    for (const [what, add] of cases) {
      for (const [where, at] of [
        ["beside the approach", near],
        ["inside the joined room", inside],
      ] as const) {
        assert.equal(wingSetup(squareBase(add(state, at), EAST, [{ key: join }]), { wide: false }).problem, "nearJoin", `a ${what} ${where}`);
      }
    }
    const stair = squareRoom(ROOM, "all", [{ t: "build.stairs", sceneId: S, cells: [`${inside.x},${inside.y}`], up: "e" }]);
    assert.equal(wingSetup(squareBase(stair, EAST, [{ key: join }]), { wide: false }).problem, "nearJoin", "a stair mark in the joined room");
    const wall = squareRoom(ROOM, "all", [{ t: "build.edge", sceneId: S, edges: [{ key: `${ox + 2},${jy - 1},n`, feature: { kind: "wall" } }] }]);
    assert.equal(wingSetup(squareBase(wall, EAST, [{ key: join }]), { wide: false }).problem, "nearJoin", "an unrelated wall");
    const far = { x: ox + 8, y: jy - 8 };
    assert.equal(wingSetup(squareBase(cases[0]![1](state, far), EAST, [{ key: join }]), { wide: false }).problem, null, "a token well away");
  });

  test("on squares the joined room is only its side of the join's wall line, so a corridor through a doorless opening is not excused", () => {
    // A corridor out of the room's north-east corner through an opening, east past the wall and down beside the approach: painted and joined to the room, but not the room.
    const corridor = [`${ox - 1},${ROOM.y - 1}`, `${ox},${ROOM.y - 1}`, `${ox + 1},${ROOM.y - 1}`, `${ox + 2},${ROOM.y - 1}`, ...[0, 1, 2].map((dy) => `${ox + 2},${ROOM.y + dy}`)];
    const state = squareRoom(ROOM, "all", [{ t: "build.paint", sceneId: S, terrain: "stone", cells: corridor }]);
    const base = squareBase(state, EAST, [{ key: join }]);
    assert.equal(wingSetup(base, { wide: false }).problem, "nearJoin", "the corridor stands near the approach");
    assert.equal(wingSetup(squareBase(squareRoom(ROOM), EAST, [{ key: join }]), { wide: false }).problem, null, "without it the join is clear");
  });
});

describe("hex joins", () => {
  for (const grid of ["hexRows", "hexColumns"] as const) {
    for (const y of [24, 25]) {
      const room: Rect = { x: 20, y, w: 8, h: 6 };
      const { L, state, wallAt } = hexRoom(grid, room);
      const cases: [string, "n" | "e" | "s" | "w", number, number][] = [
        ["east", "e", (room.y + 2) * L.W + room.x + room.w - 1, 0],
        ["west", "w", (room.y + 2) * L.W + room.x, 3],
        ["top", "n", room.y * L.W + room.x + 3, 5],
        ["bottom", "s", (room.y + room.h - 1) * L.W + room.x + 3, 1],
      ];
      for (const [name, side, k, dir] of cases) {
        test(`${grid === "hexRows" ? "Hex rows" : "Hex columns"}, ${name} side, room on ${y % 2 ? "an odd" : "an even"} row: taken, and a wing lands with a leaf where the wall was`, () => {
          const base = hexBase(state, hexArea(grid, room, side), [wallAt(k, dir)]);
          const read = readJoin(base, base.join, base.area, false);
          assert.ok(read.ok, read.ok ? "" : read.problem);
          assert.deepEqual(read.facts.inside, [k]);
          assert.equal(read.facts.dir, dir);
          const p = planned(base);
          assert.equal(p.wing?.problem, null);
          assert.ok(p.plan.walls!.some((w) => w.f === "closed" && endsKey(w.a, w.b) === endsKey(...hexSide(L, k, dir))), "a closed leaf on the join's side");
          assert.ok(!p.plan.walls!.some((w) => w.f === "wall" && endsKey(w.a, w.b) === endsKey(...hexSide(L, k, dir === 0 ? 1 : 0))), "no wall doubled against the room");
        });
      }
    }
  }

  test("a join the area's ground does not reach, a room open elsewhere, and a wall longer than a side are refused", () => {
    const room: Rect = { x: 20, y: 12, w: 8, h: 6 };
    const vault: Rect = { x: 44, y: 30, w: 10, h: 10 };
    const { L, state, wallAt } = hexRoom("hexRows", room, [vault]);
    const east = (room.y + 2) * L.W + room.x + room.w - 1;
    const wall = wallAt(east, 0);
    assert.equal(readJoin(hexBase(state, hexArea("hexRows", room, "e"), [wall]), { grid: "hex", walls: [wall], ground: 0 }, hexArea("hexRows", room, "e"), false).ok, true);
    // An area inside another closed room: neither side of the join reaches it.
    const shut = hexBase(state, { x: vault.x + 2, y: vault.y + 2, w: 5, h: 5 }, [wall]);
    const problem = (b: Omit<WingBase, "hash">): WingProblem | null => wingSetup(b, { wide: false }).problem;
    assert.equal(problem(shut), "noGround");
    // Open the room on its west side: its flood reaches the outside.
    const west = wallAt((room.y + 2) * L.W + room.x, 3);
    const opened = { ...state, buildChunks: Object.fromEntries(Object.entries(state.buildChunks).map(([key, c]) => [key, c && { ...c, walls: c.walls?.filter((w) => w.id !== west.id) }])) } as RoomState;
    assert.equal(problem(hexBase(opened, hexArea("hexRows", room, "e"), [wall])), "openRoom");
    const long = { ...wall, b: [wall.b[0], wall.b[1] + 1] as [number, number] };
    assert.equal(problem(hexBase(state, hexArea("hexRows", room, "e"), [long])), "longWall");
  });

  test("a Wide hex join is three sides between two inside hexes and two outside, east and west at both parities", () => {
    for (const y of [12, 13]) {
      const room: Rect = { x: 20, y, w: 8, h: 6 };
      const { L, state, wallAt } = hexRoom("hexRows", room);
      for (const [side, x, dir] of [
        ["e", room.x + room.w - 1, 0],
        ["w", room.x, 3],
      ] as const) {
        const a = (room.y + 2) * L.W + x;
        const b = a + L.W;
        const outA = L.step(a, dir, 1)!;
        const middle = [0, 1, 2, 3, 4, 5].map((d) => [a, d] as const).concat([0, 1, 2, 3, 4, 5].map((d) => [b, d] as const)).find(([k, d]) => {
          const n = L.step(k, d, 1);
          return n !== null && n !== L.step(k, dir, 1) && (n === outA || n === L.step(b, dir, 1)) && n !== a && n !== b;
        })!;
        const walls = [wallAt(a, dir), wallAt(...middle), wallAt(b, dir)];
        const base = hexBase(state, hexArea("hexRows", room, side), walls);
        const read = readJoin(base, base.join, base.area, true);
        assert.ok(read.ok, `${side} at row ${y}: ${read.ok ? "" : read.problem}`);
        assert.deepEqual(read.facts.inside, [a, b]);
        assert.equal(wingSetup(base, { wide: true }).problem, null);
        assert.equal(readJoin(base, { grid: "hex", walls: walls.slice(0, 2), ground: 0 }, base.area, true).ok, false, "two sides are not a Wide join");
      }
    }
  });
});

describe("the scene's allowances", () => {
  test("a wing adds at most 90% of each cap less what the scene holds", () => {
    const state = squareRoom(ROOM);
    const traps = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${i}`, { id: `t${i}`, sceneId: S, zone: { cells: [{ x: 60, y: 30, w: 1, h: 1 }] } }]));
    const full = { ...state, traps: traps as never };
    const base = squareBase(full, EAST, [{ key: `${ROOM.x + ROOM.w},${ROOM.y + 4},w` }]);
    const a = wingAllowance(wingWorld(base), base);
    assert.equal(a.traps, 5);
    assert.equal(a.stamps, 450);
    assert.equal(a.lights, 90);
    assert.equal(a.pins, 180);
    const p = planned(base, SETTINGS({ traps: 6, rooms: 8 }));
    assert.ok(p.plan.traps.length <= 5);
    assert.equal(p.wing?.allowance.traps, 5);
  });
});
