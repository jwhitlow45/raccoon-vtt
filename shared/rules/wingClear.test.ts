import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FreeWall, RoomState, Scene } from "../model.ts";
import type { Op, OpOf } from "../protocol.ts";
import { apply, room, scene, token } from "../testutil.ts";
import { cornerAt, hexCenter, hexCorners, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { joinChanged, wingClash, wingFootprint, type WingClear } from "./wingClear.ts";

/*
 * The server's checks of a wing's asks (docs/design: dungeon generator
 * phase 3, 3.4 and 3.6): the join as planned, and the wing's footprint
 * clear of everything but the joined room's own structure near its
 * approach.
 */

type MapOp = OpOf<"build.ask">["ops"][number];
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** s1 on squares, a stone room over x 10 to 19, y 10 to 19, its west wall the join at "10,14,w". */
function squareRoom(over: Partial<Scene> = {}): RoomState {
  const cells = range(10, 19).flatMap((y) => range(10, 19).map((x) => `${x},${y}`));
  return apply(room({ scenes: { s1: scene("s1", { bounds: { w: 40, h: 30 }, ...over }) } }), { t: "build.paint", sceneId: "s1", terrain: "stone", cells });
}

const squareClear = (over: Partial<WingClear> = {}): WingClear => ({ margin: 2, join: { grid: "squares", edges: [{ key: "10,14,w", feature: null, ground: 0 }] }, autoWalls: "all", ...over });

/** A corridor west from the join and the closed door the join becomes. */
const corridor: MapOp[] = [
  { t: "build.paint", sceneId: "s1", terrain: "stone", cells: range(3, 9).map((x) => `${x},14`) },
  { t: "build.edge", sceneId: "s1", edges: [{ key: "10,14,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] },
];

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const hk = (h: Hex) => `${h.col},${h.row}`;

/** One free wall on each side between a hex of the set and one outside it, ids numbered from `from`. */
function wallsAround(hexes: readonly Hex[], from = 0): FreeWall[] {
  const inSet = new Set(hexes.map(hk));
  const out: FreeWall[] = [];
  for (const h of hexes) {
    const corners = hexCorners(ROWS, h);
    hexNeighbors(ROWS, h).forEach((n, d) => {
      if (inSet.has(hk(n))) return;
      const a = cornerAt(ROWS, corners[(d + 1) % 6]!);
      const b = cornerAt(ROWS, corners[(d + 2) % 6]!);
      out.push({ id: `w${String(from + out.length).padStart(11, "0")}`, a: [a.x, a.y], b: [b.x, b.y], f: { kind: "wall" } });
    });
  }
  return out;
}

/** s1 on hex rows, a closed room of hexes cols 10 to 14 on rows 10 to 14, raised `ground` ft, and its west wall on row 12 the join. */
function hexRoom(ground = 0): { state: RoomState; clear: WingClear; join: FreeWall; inside: Hex; outside: Hex } {
  const hexes = range(10, 14).flatMap((row) => range(10, 14).map((col) => ({ col, row })));
  const walls = wallsAround(hexes);
  let state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 40, h: 30 } }) } });
  for (let i = 0; i < walls.length; i += 200) state = apply(state, { t: "build.walls", sceneId: "s1", put: walls.slice(i, i + 200) });
  if (ground !== 0) state = apply(state, { t: "build.height", sceneId: "s1", cells: hexes.map(hk), height: ground });
  const inside = { col: 10, row: 12 };
  const outside = hexNeighbors(ROWS, inside)[3]!;
  const corners = hexCorners(ROWS, inside);
  const a = cornerAt(ROWS, corners[4]!);
  const b = cornerAt(ROWS, corners[5]!);
  const join = walls.find((w) => w.a[0] === a.x && w.a[1] === a.y && w.b[0] === b.x && w.b[1] === b.y)!;
  assert.ok(join, "the room's west wall on row 12");
  const chunk = Object.values(state.buildChunks).find((c) => c?.walls?.some((w) => w.id === join.id))!;
  const clear: WingClear = { margin: 2, join: { grid: "hex", walls: [{ cx: chunk.cx, cy: chunk.cy, id: join.id, a: join.a, b: join.b, f: join.f }], ground }, autoWalls: "all", inside: [hk(inside)] };
  return { state, clear, join, inside, outside };
}

/** A clear joined on the hex room's given sides, each a room hex and the hex direction out of it, with the room's hexes on those sides inside. */
function hexJoinOn(state: RoomState, sides: readonly [Hex, number][], ground = 0, margin: 2 | 3 = 2): WingClear {
  const walls = sides.map(([h, d]) => {
    const corners = hexCorners(ROWS, h);
    const a = cornerAt(ROWS, corners[(d + 1) % 6]!);
    const b = cornerAt(ROWS, corners[(d + 2) % 6]!);
    for (const c of Object.values(state.buildChunks)) {
      const w = c?.walls?.find((x) => (x.a[0] === a.x && x.a[1] === a.y && x.b[0] === b.x && x.b[1] === b.y) || (x.a[0] === b.x && x.a[1] === b.y && x.b[0] === a.x && x.b[1] === a.y));
      if (w) return { cx: c!.cx, cy: c!.cy, id: w.id, a: w.a, b: w.b, f: w.f };
    }
    throw new Error(`no wall on side ${d} of ${hk(h)}`);
  });
  return { margin, join: { grid: "hex", walls, ground }, autoWalls: "all", inside: [...new Set(sides.map(([h]) => hk(h)))] };
}

/** Floor runs over the given hexes, one run per hex. */
const runsOf = (hexes: readonly Hex[]): [number, number, number][] => hexes.map((h) => [h.row, h.col, h.col]);

/** Hexes west of `from` along its row, `n` of them, and the floor runs that hold them. */
function westRun(from: Hex, n: number): { hexes: Hex[]; floor: [number, number, number][] } {
  const hexes = range(1, n).map((i) => ({ col: from.col - i + 1, row: from.row }));
  return { hexes, floor: [[from.row, from.col - n + 1, from.col]] };
}

const put = (state: RoomState, id: string, x: number, y: number): RoomState => ({ ...state, tokens: { ...state.tokens, [id]: token(id, { sceneId: "s1", x, y }) } });
/** A Medium token standing on a hex: its box centered on the hex's center. */
const putOnHex = (state: RoomState, id: string, h: Hex): RoomState => {
  const c = hexCenter(ROWS, h);
  return put(state, id, c.x - 0.5, c.y - 0.5);
};

describe("joinChanged on squares", () => {
  test("a join as planned stands, an automatic wall, a drawn wall or a door", () => {
    assert.equal(joinChanged(squareRoom(), "s1", squareClear()), false);
    const drawn = apply(squareRoom(), { t: "build.edge", sceneId: "s1", edges: [{ key: "10,14,w", feature: { kind: "wall" } }] });
    assert.equal(joinChanged(drawn, "s1", squareClear({ join: { grid: "squares", edges: [{ key: "10,14,w", feature: { kind: "wall" }, ground: 0 }] } })), false);
    const door = { kind: "door" as const, state: "locked" as const, secret: false, discovered: false };
    const doored = apply(squareRoom(), { t: "build.edge", sceneId: "s1", edges: [{ key: "10,14,w", feature: door }] });
    assert.equal(joinChanged(doored, "s1", squareClear({ join: { grid: "squares", edges: [{ key: "10,14,w", feature: door, ground: 0 }] } })), false);
    assert.equal(joinChanged(doored, "s1", squareClear({ join: { grid: "squares", edges: [{ key: "10,14,w", feature: { ...door, state: "closed" }, ground: 0 }] } })), true, "the door's state changed");
  });

  test("erased, replaced, painted over, raised or a changed wall rule reads as changed", () => {
    const changes: [string, Op][] = [
      ["inside erased", { t: "build.erase", sceneId: "s1", cells: ["10,14"] }],
      ["outside painted", { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["9,14"] }],
      ["drawn over", { t: "build.edge", sceneId: "s1", edges: [{ key: "10,14,w", feature: { kind: "wall" } }] }],
      ["opened", { t: "build.edge", sceneId: "s1", edges: [{ key: "10,14,w", feature: { kind: "none" } }] }],
      ["inside raised", { t: "build.height", sceneId: "s1", cells: ["10,14"], height: 5 }],
      ["rule off", { t: "scene.update", sceneId: "s1", patch: { autoWalls: "off" } }],
    ];
    for (const [what, op] of changes) assert.equal(joinChanged(apply(squareRoom(), op), "s1", squareClear()), true, what);
    assert.equal(joinChanged(squareRoom(), "s1", squareClear({ join: { grid: "squares", edges: [{ key: "10,14,w", feature: null, ground: 5 }] } })), true, "planned at another ground");
    assert.equal(joinChanged(squareRoom(), "s1", squareClear({ autoWalls: "floor" })), true, "planned under another rule");
    assert.equal(joinChanged(squareRoom(), "gone", squareClear()), true, "no scene");
  });
});

describe("joinChanged on hexes", () => {
  test("the join's wall by chunk, id, ends and feature, and the ground inside it", () => {
    const { state, clear, join } = hexRoom(5);
    assert.equal(joinChanged(state, "s1", clear), false);
    const chunk = clear.join.grid === "hex" ? clear.join.walls[0]! : null!;
    const removed = apply(state, { t: "build.walls", sceneId: "s1", remove: [{ cx: chunk.cx, cy: chunk.cy, id: join.id }] });
    assert.equal(joinChanged(removed, "s1", clear), true, "erased");
    const doored = apply(removed, { t: "build.walls", sceneId: "s1", put: [{ ...join, f: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    assert.equal(joinChanged(doored, "s1", clear), true, "replaced by a door of the same id");
    assert.equal(joinChanged(apply(state, { t: "build.height", sceneId: "s1", cells: ["10,12"], height: 10 }), "s1", clear), true, "the ground inside");
    assert.equal(joinChanged(apply(state, { t: "scene.update", sceneId: "s1", patch: { autoWalls: "floor" } }), "s1", clear), true, "the wall rule");
  });

  test("the inside must name the join's room side, and a join without it reads as changed", () => {
    const { state, clear, outside } = hexRoom(5);
    assert.equal(joinChanged(state, "s1", { ...clear, inside: [hk(outside)] }), true, "the outside stands at 0, not the room's 5 ft");
    const { inside: _inside, ...bare } = clear;
    assert.equal(joinChanged(state, "s1", bare), true);
    assert.equal(joinChanged(state, "s1", { ...clear, inside: ["10,12", "11,12"] }), true, "a hex no join wall touches");
  });
});

describe("wingClash on squares", () => {
  test("a wing clear of everything but the joined room's own structure goes, however deep the room runs", () => {
    assert.equal(wingClash(squareRoom(), "s1", corridor, squareClear()), null);
    // Wide: the same with a margin of 3 and both lanes.
    const wide = squareClear({ margin: 3, join: { grid: "squares", edges: [{ key: "10,14,w", feature: null, ground: 0 }, { key: "10,15,w", feature: null, ground: 0 }] } });
    const lanes: MapOp[] = [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: range(3, 9).flatMap((x) => [`${x},14`, `${x},15`]) }];
    assert.equal(wingClash(squareRoom(), "s1", lanes, wide), null);
  });

  test("a token in the footprint, or in the joined room within the margin of the approach, clashes", () => {
    assert.equal(wingClash(put(squareRoom(), "t1", 5, 14), "s1", corridor, squareClear()), "5,14");
    assert.equal(wingClash(put(squareRoom(), "t1", 11, 14), "s1", corridor, squareClear()), "11,14", "objects in the joined room still count");
    assert.equal(wingClash(put(squareRoom(), "t1", 13, 14), "s1", corridor, squareClear()), null, "past the margin");
  });

  test("every protected object near the approach clashes, inside the joined room too", () => {
    const near: [string, (s: RoomState) => RoomState][] = [
      ["stair mark", (s) => apply(s, { t: "build.stairs", sceneId: "s1", cells: ["11,15"], up: "n" })],
      ["stamp", (s) => apply(s, { t: "build.stamps", sceneId: "s1", put: [{ id: "st1", art: { key: "barrel" }, x: 11.5, y: 13.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] })],
      ["light", (s) => apply(s, { t: "build.lights", sceneId: "s1", put: [{ id: "l1", x: 11.5, y: 14.5, bright: 10, dim: 10, color: "#ffcc88", on: true, walls: true }] })],
      ["label", (s) => apply(s, { t: "build.label", sceneId: "s1", labelId: "lb1", label: { x: 8.5, y: 12.5, text: "Here", size: 1 } })],
      ["unrelated wall", (s) => apply(s, { t: "build.edge", sceneId: "s1", edges: [{ key: "6,12,n", feature: { kind: "wall" } }] })],
    ];
    for (const [what, make] of near) assert.notEqual(wingClash(make(squareRoom()), "s1", corridor, squareClear()), null, what);
  });

  test("floor off the approach keeps its margin from the joined room's structure too", () => {
    const beside: MapOp[] = [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["8,11"] }];
    assert.equal(wingClash(squareRoom(), "s1", beside, squareClear()), "10,10");
  });

  test("the join's own edge grows from its outside cell only", () => {
    // A door at the join alone: its inside cell's room is excused, and a token two inward is past the margin of the outside cell.
    const door: MapOp[] = [corridor[1]!];
    assert.equal(wingClash(put(squareRoom(), "t1", 12, 14), "s1", door, squareClear()), null);
  });

  test("an earlier part's footprint is checked again with the last part", () => {
    const part0: MapOp[] = [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["4,14", "5,14"] }];
    const part1: MapOp[] = [corridor[1]!];
    const moved = put(squareRoom(), "t1", 4, 14);
    const prior = wingFootprint(squareRoom(), "s1", part0, squareClear());
    assert.equal(wingClash(moved, "s1", part1, squareClear()), null, "the last part's own ops miss it");
    assert.equal(wingClash(moved, "s1", part1, squareClear(), prior), "4,14");
  });

  test("a join no longer standing clashes at it", () => {
    assert.equal(wingClash(apply(squareRoom(), { t: "build.erase", sceneId: "s1", cells: ["10,14"] }), "s1", corridor, squareClear()), "10,14,w");
  });
});

describe("wingClash on hexes", () => {
  test("the wing's floor runs and walls clear of all but the joined room's structure", () => {
    const { state, clear, join, outside } = hexRoom();
    const { hexes, floor } = westRun(outside, 6);
    const walls = wallsAround(hexes, 900);
    const ops: MapOp[] = [{ t: "build.walls", sceneId: "s1", remove: [{ cx: (clear.join as { walls: { cx: number; cy: number }[] }).walls[0]!.cx, cy: (clear.join as { walls: { cx: number; cy: number }[] }).walls[0]!.cy, id: join.id }], put: walls }];
    assert.equal(wingClash(state, "s1", ops, { ...clear, floor }), null);
    assert.equal(wingClash(putOnHex(state, "t1", hexes[3]!), "s1", ops, { ...clear, floor }), hk(hexes[3]!), "a token in the floor");
    assert.equal(wingClash(putOnHex(state, "t1", { col: 11, row: 12 }), "s1", ops, { ...clear, floor }), "11,12", "a token one hex inside the join");
    const stairs = apply(state, { t: "build.stairs", sceneId: "s1", cells: ["10,11"], up: "0" });
    assert.equal(wingClash(stairs, "s1", ops, { ...clear, floor }), "10,11", "a stair mark in the joined room");
    assert.equal(wingClash(state, "s1", [], { ...clear, floor: [[outside.row - 4, 0, 3]] }), null, "floor far off");
  });

  test("a raised join keeps its run's depth as approach", () => {
    const { state, clear, outside } = hexRoom(10);
    const { floor } = westRun(outside, 6);
    assert.equal(wingClash(state, "s1", [], { ...clear, floor }), null);
  });

  test("an unrelated wall near the floor clashes", () => {
    const { state, clear, outside } = hexRoom();
    const { floor } = westRun(outside, 6);
    const other = wallsAround([{ col: outside.col - 3, row: outside.row - 2 }], 950).slice(0, 1);
    const walled = apply(state, { t: "build.walls", sceneId: "s1", put: other });
    assert.notEqual(wingClash(walled, "s1", [], { ...clear, floor }), null);
  });
});

describe("hex joins on every side, Narrow and Wide (DG3 review round 1)", () => {
  // The room's west side on rows 12 and 13, and its bottom row 14 on columns 11 and 12, as the planner's Wide doorways stand.
  const westA = { col: 10, row: 12 };
  const westB = { col: 10, row: 13 };
  const southA = { col: 11, row: 14 };
  const southB = { col: 12, row: 14 };
  const along = (from: Hex, dCol: number, dRow: number, n: number) => range(0, n - 1).map((i) => ({ col: from.col + dCol * i, row: from.row + dRow * i }));

  test("a Wide join is three sides whose middle one runs at a slant, the way out the one its two outer sides share", () => {
    const { state } = hexRoom(5);
    // West: lanes out of 10,12 and 10,13 facing west, the middle side 10,12's toward 9,13.
    const west = hexJoinOn(state, [[westA, 3], [westA, 2], [westB, 3]], 5, 3);
    assert.equal(joinChanged(state, "s1", west), false, "west");
    // The bottom row: lanes out of 11,14 and 12,14 facing south-east, the middle side 12,14's toward 11,15.
    const south = hexJoinOn(state, [[southA, 1], [southB, 2], [southB, 1]], 5, 3);
    assert.equal(joinChanged(state, "s1", south), false, "south-east");
    // Three sides each facing its own way have no way out most of them share.
    assert.equal(joinChanged(state, "s1", hexJoinOn(state, [[westA, 3], [westA, 2], [southA, 1]], 5, 3)), true, "no shared way out");
  });

  test("a slanted join's approach is the planner's: a run along the hex direction, then the margin a row at a time", () => {
    const { state } = hexRoom();
    // Narrow, out of 12,14 toward the south-east: the outside hex 12,15, then the stub straight down column 12.
    const narrow = hexJoinOn(state, [[southB, 1]]);
    assert.equal(joinChanged(state, "s1", narrow), false);
    assert.equal(wingClash(state, "s1", [], { ...narrow, floor: runsOf(along({ col: 12, row: 15 }, 0, 1, 7)) }), null, "Narrow");
    // Wide: both lanes' columns straight down.
    const wide = hexJoinOn(state, [[southA, 1], [southB, 2], [southB, 1]], 0, 3);
    assert.equal(wingClash(state, "s1", [], { ...wide, floor: runsOf([...along({ col: 11, row: 15 }, 0, 1, 7), ...along({ col: 12, row: 15 }, 0, 1, 7)]) }), null, "Wide");
    // A token in the joined room still stands in the way.
    assert.equal(wingClash(putOnHex(state, "t1", { col: 12, row: 13 }), "s1", [], { ...narrow, floor: runsOf(along({ col: 12, row: 15 }, 0, 1, 7)) }), "12,13");
  });

  test("a raised slanted join runs its stairs along the hex direction before the margin turns down the rows", () => {
    const { state } = hexRoom(10);
    const raised = hexJoinOn(state, [[southB, 1]], 10);
    // 12,15 then two stairs and the far landing south-east: 13,16, 13,17 and 14,18, then the stub down column 14.
    const run = [{ col: 12, row: 15 }, { col: 13, row: 16 }, { col: 13, row: 17 }, { col: 14, row: 18 }];
    assert.equal(wingClash(state, "s1", [], { ...raised, floor: runsOf([...run, ...along({ col: 14, row: 19 }, 0, 1, 5)]) }), null);
  });
});
