import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run, tower, UPPER } from "#shared/floorLinksTestutil.ts";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { boardTheme, theme } from "../../lib/theme.ts";
import { holeFloors, NO_HOLE_FLOORS, type DrawnSource, type Hole, type HoleFloors } from "../../lib/view.ts";
import { ReliefIndex, type Item } from "./buckets.ts";
import { drawRun, holeTone, tonedBoxes, type DrawContext, type TonedBox } from "./drawRelief.ts";
import type { CellPiece, PieceSource } from "./pieces.ts";

/*
 * Isometric's floors below (docs/design/design-v1-floors.md phase 4, 9.1):
 * each opening's hole on the floor shown draws as a drop, its squares
 * lowered by the drop so the relief draws a pit's sides, its bottom a copy
 * of the ground stage's window, black where the device does not hold the
 * floor below, and the floor below's background where the copy runs out.
 */

const BOUNDS = { w: 48, h: 48 };
const FEET = 5;

/** Drawn ground in cells, keyed "x,y", 0 elsewhere. */
function source(ground: Record<string, number> = {}): PieceSource {
  return { ground: (x, y) => ground[`${x},${y}`] ?? 0, terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds: BOUNDS };
}

const drawn: DrawnSource = { chunks: {}, sceneId: "up", bounds: BOUNDS, grid: SQUARES, fog: null, stand: true };

function hole(over: Partial<Hole> = {}): Hole {
  return { id: "o1", rect: { x: 4, y: 4, w: 3, h: 2 }, drop: 10, below: "#123456", ...over };
}

function sync(relief: ReliefIndex, holes: HoleFloors, ground: Record<string, number> = {}, global: unknown = GLOBAL): void {
  relief.sync({ sceneId: "up", bounds: BOUNDS, chunks: {}, tiles: null, walls: new Map(), global, src: source(ground), holes });
}

const GLOBAL = {};
const EVERYTHING = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };

function cellsOf(relief: ReliefIndex): CellPiece[] {
  return relief.layout(0, EVERYTHING, []).flatMap((i: Item) => (i.kind === "run" ? i.pieces : [])).filter((p): p is CellPiece => p.kind !== "volume" && p.kind !== "wall");
}

describe("a hole in the relief (9.1)", () => {
  test("each cell of it is a pit at its bottom, the hole's own, and the ground beside it reads the bottom", () => {
    const relief = new ReliefIndex();
    sync(relief, holeFloors(drawn, [hole()], FEET));
    const pits = cellsOf(relief);
    assert.deepEqual(pits.map((p) => `${p.id}:${p.kind}:${p.z}`).sort(), ["c4,4", "c5,4", "c6,4", "c4,5", "c5,5", "c6,5"].map((id) => `${id}:pit:-2`).sort());
    for (const p of pits) assert.equal(relief.holeOf(p)?.id, "o1");
    // A pit's far sides reach up to the ground beside it at 0, and a hole's cell beside another sees its bottom.
    const corner = relief.cellAt(4, 4)!;
    assert.deepEqual(corner.around, [0, -2, -2, 0], "north and west the floor at 0, east and south the hole");
    assert.equal(relief.regions.length, 1, "one region, so it clips as one opening");
  });

  test("on raised ground the bottom is a column's top, still the hole's, and its neighbors' sides go down to it", () => {
    const relief = new ReliefIndex();
    const up: Record<string, number> = {};
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) up[`${x},${y}`] = 4;
    // A platform 20 ft up with the hole's ground at 20 ft: its bottom 10 ft up.
    const raised = holeFloors({ ...drawn, chunks: platform(20) }, [hole()], FEET);
    sync(relief, raised, up);
    const bottom = relief.cellAt(5, 4)!;
    assert.equal(bottom.kind, "column");
    assert.equal(bottom.z, 2);
    assert.equal(relief.holeOf(bottom)?.id, "o1");
    assert.equal(relief.cellAt(5, 3)!.around[2], 2, "the platform north of it faces down to the bottom");
    assert.equal(relief.holeOf(relief.cellAt(5, 3)!), undefined);
  });

  test("an ordinary pit beside a hole is no hole's", () => {
    const relief = new ReliefIndex();
    sync(relief, holeFloors(drawn, [hole()], FEET), { "10,10": -2 });
    assert.equal(relief.holeOf(relief.cellAt(10, 10)!), undefined);
  });

  test("no hole changes nothing: the same pieces as a sync without them", () => {
    const ground = { "3,3": 2, "10,10": -2 };
    const a = new ReliefIndex();
    const b = new ReliefIndex();
    sync(a, NO_HOLE_FLOORS, ground);
    b.sync({ sceneId: "up", bounds: BOUNDS, chunks: {}, tiles: null, walls: new Map(), global: GLOBAL, src: source(ground) });
    const shape = (r: ReliefIndex) => cellsOf(r).map((p) => `${p.id}:${p.kind}:${p.z}:${p.around.join(",")}`);
    assert.deepEqual(shape(a), shape(b));
  });

  test("on hexes, each hex of it a pit at its bottom, one region, on both orientations", () => {
    for (const shape of ["hexRows", "hexColumns"] as const) {
      const grid = gridOfShape(shape);
      const bounds = { w: 20, h: 20 };
      const relief = new ReliefIndex();
      const floors = holeFloors({ ...drawn, grid, bounds }, [hole()], FEET);
      relief.sync({ sceneId: "up", bounds, chunks: {}, tiles: null, walls: new Map(), global: GLOBAL, src: { ...source(), bounds, grid }, grid, holes: floors });
      const pits = cellsOf(relief);
      assert.equal(pits.length, 6, shape);
      assert.ok(pits.every((p) => p.kind === "pit" && p.z === -2 && p.poly.length === 6 && relief.holeOf(p)?.id === "o1"), shape);
      assert.equal(relief.regions.length, 1, shape);
    }
  });

  test("a hole's change rebuilds only the buckets around it: deeper, its floor below come into hold, moved, gone", () => {
    const relief = new ReliefIndex();
    // 48 by 48 is three buckets a side, and a hole in the first touches the four of the north-west corner's block.
    sync(relief, holeFloors(drawn, [hole()], FEET));
    assert.equal(relief.rebuilt, 9);
    sync(relief, holeFloors(drawn, [hole()], FEET));
    assert.equal(relief.rebuilt, 0, "the same holes anew rebuild nothing");
    sync(relief, holeFloors(drawn, [hole({ drop: 15 })], FEET));
    assert.equal(relief.rebuilt, 4);
    assert.equal(relief.cellAt(5, 5)!.z, -3);
    sync(relief, holeFloors(drawn, [hole({ drop: 15, below: null })], FEET));
    assert.equal(relief.rebuilt, 4, "the floor below's hold");
    assert.equal(relief.holeOf(relief.cellAt(5, 5)!)?.below, null);
    sync(relief, holeFloors(drawn, [hole({ drop: 15, below: null, rect: { x: 40, y: 40, w: 2, h: 2 } })], FEET));
    assert.equal(relief.rebuilt, 7, "the four buckets it left and the four it came to, the middle one among both");
    assert.equal(relief.cellAt(5, 5), undefined);
    sync(relief, NO_HOLE_FLOORS);
    assert.equal(relief.rebuilt, 4);
    assert.equal(relief.cellAt(40, 40), undefined);
  });
});

/** Upper floor's chunks with the 7 by 7 platform at 2, 2 raised by `feet`, as the builder stores them. */
function platform(feet: number): DrawnSource["chunks"] {
  const cells: string[] = [];
  for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) cells.push(`${x},${y}`);
  return run(tower(), { t: "build.height", sceneId: UPPER, cells, height: feet }).buildChunks;
}

type Call = { name: "fill" | "stroke" | "clip"; color: string };

/** A canvas that writes down each fill's color, as drawRelief.test.ts's does. */
function canvas(): { g: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state = { color: "" };
  const stack: (typeof state)[] = [];
  const g = {
    set globalAlpha(_: number) {},
    set lineWidth(_: number) {},
    set fillStyle(v: string) {
      state.color = v;
    },
    set strokeStyle(_: string) {},
    setLineDash: () => {},
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    clip: () => calls.push({ name: "clip", color: state.color }),
    fill: () => calls.push({ name: "fill", color: state.color }),
    stroke: () => calls.push({ name: "stroke", color: state.color }),
    setTransform: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    createPattern: () => null,
  };
  return { g: g as unknown as CanvasRenderingContext2D, calls };
}

/** A draw with no ground canvas, where every floor takes its tone alone (drawRelief.ts tonedBox). */
function context(relief: ReliefIndex): DrawContext {
  return { turn: 0, camera: { x: 0, y: 0, scale: 1 } as DrawContext["camera"], pixelRatio: 1, ground: null, textures: {}, view: EVERYTHING, hole: (p) => relief.holeOf(p) };
}

function floorFills(holes: HoleFloors, ground: Record<string, number> = {}): string[] {
  const relief = new ReliefIndex();
  sync(relief, holes, ground);
  const { g, calls } = canvas();
  for (const item of relief.layout(0, EVERYTHING, [])) if (item.kind === "run") drawRun(g, item.pieces, context(relief));
  // A pit's floor is its first fill after the clip of its openings, its shade the next, then its sides.
  return calls.filter((c) => c.name === "fill").map((c) => c.color);
}

describe("a hole's bottom drawn (9.1)", () => {
  test("where the copy runs out, the floor below's background, else the scenes' own; no shade over the window's veil", () => {
    const fills = floorFills(holeFloors(drawn, [hole({ rect: { x: 4, y: 4, w: 1, h: 1 } })], FEET));
    assert.equal(fills[0], "#123456");
    assert.ok(!fills.includes(theme.relief.pitShade), "no pit shade");
    assert.equal(holeTone(hole({ below: "" })), "#2b2b31", "a floor below with no background of its own takes the mat's");
  });

  test("over a floor the device does not hold: black, copied from nothing", () => {
    const fills = floorFills(holeFloors(drawn, [hole({ rect: { x: 4, y: 4, w: 1, h: 1 }, below: null })], FEET));
    assert.equal(fills[0], boardTheme.color.stage);
    assert.ok(!fills.includes(theme.relief.pitShade));
    assert.equal(holeTone(hole({ below: null })), boardTheme.color.stage);
  });

  test("an ordinary pit keeps its side tone and its shade", () => {
    const fills = floorFills(NO_HOLE_FLOORS, { "4,4": -2 });
    assert.equal(fills[0], theme.relief.side);
    assert.equal(fills[1], theme.relief.pitShade);
  });

  test("a raised bottom among tops at its lift takes its hole's tone, and the others theirs", () => {
    const raised = holeFloors({ ...drawn, chunks: platform(20) }, [hole({ rect: { x: 5, y: 5, w: 1, h: 1 }, below: "#123456" })], FEET);
    // The platform at 10 ft but for the hole, so the bottom at 10 ft shares the platform's lift.
    const up: Record<string, number> = {};
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) up[`${x},${y}`] = 2;
    const fills = floorFills(raised, up);
    assert.ok(fills.includes("#123456"), "the bottom's tone");
    assert.ok(fills.includes("#777777"), "the platform's own");
  });

  test("a raised black bottom among tops at its lift is black, and they keep theirs", () => {
    const raised = holeFloors({ ...drawn, chunks: platform(20) }, [hole({ rect: { x: 5, y: 5, w: 1, h: 1 }, below: null })], FEET);
    const up: Record<string, number> = {};
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) up[`${x},${y}`] = 2;
    const fills = floorFills(raised, up);
    assert.ok(fills.includes(boardTheme.color.stage), "the bottom's black");
    assert.ok(fills.includes("#777777"), "the platform's own");
  });

  test("a black bottom is no toned cell: it shows the same wherever it stands, so a scroll keeps it", () => {
    const relief = new ReliefIndex();
    sync(relief, holeFloors(drawn, [hole({ below: null }), hole({ id: "o3", rect: { x: 20, y: 20, w: 1, h: 1 } })], FEET), { "30,30": -2 });
    const out: TonedBox[] = [];
    tonedBoxes(cellsOf(relief), context(relief), out);
    assert.equal(out.length, 2, "the held hole's cell and the pit's, not the six black ones");
  });
});
