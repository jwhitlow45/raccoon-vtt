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
import { viewToScreen } from "../../lib/camera.ts";
import { stairRuns, type StairStep } from "../../lib/stairRuns.ts";
import { drawnHeights, isometric, pickWalk, standSurface, toView, type DrawnHeights, type DrawnSource, type Turn } from "../../lib/view.ts";
import { groupWalls, ReliefIndex } from "./buckets.ts";
import { drawRun, tonedBoxes, type DrawContext } from "./drawRelief.ts";
import { boundsOf, cellPieces, facesOf, risersOf, type CellPiece, type PieceSource, type VBox } from "./pieces.ts";
import { standeeShape } from "./standee.ts";

/*
 * Stairs that climb in steps in the relief (docs/design/design-v1-iso-depth.md
 * 5.2, 6 and 8): the faces between cells read both cells' edge profiles, the
 * pit regions join through sunk stairs, every bucket whose steps or whose
 * neighbors' steps change rebuilds, a stair copies the tops held before it,
 * each tread tones by its own lift, every drawn point lies inside its piece's
 * bounds with the detail on and off, and hidden cells change nothing a player
 * gets.
 */

const TURNS = [0, 1, 2, 3] as const satisfies readonly Turn[];

/** A room built by the reducer's own ops, on scene s1 with no automatic walls. */
function built(ops: readonly Op[], bounds = { w: 20, h: 16 }): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds, autoWalls: "off" }) } });
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
const RUNS: Op[] = [
  { t: "build.height", sceneId: "s1", cells: cellsOf(8, 2, 12, 6), height: 10 },
  { t: "build.height", sceneId: "s1", cells: ["9,6"], height: 5 },
  { t: "build.stairs", sceneId: "s1", cells: ["9,7", "9,6"], up: "n" },
  { t: "build.height", sceneId: "s1", cells: cellsOf(2, 10, 6, 14), height: -10 },
  { t: "build.height", sceneId: "s1", cells: ["6,11"], height: -5 },
  { t: "build.stairs", sceneId: "s1", cells: ["6,11", "7,11"], up: "e" },
] as Op[];

type Drawn = { src: DrawnSource; heights: DrawnHeights; pieces: PieceSource };

function drawnOf(state: RoomState, opts: { fog?: Record<string, FogTile> | null; detail?: boolean } = {}): Drawn {
  const bounds = state.scenes.s1!.bounds;
  const src: DrawnSource = { chunks: state.buildChunks, sceneId: "s1", bounds, grid: { shape: "squares" }, fog: opts.fog ?? null, stand: true, detail: opts.detail ?? true };
  const heights = drawnHeights(src, 5, sceneWalls(state.scenes.s1!, state.buildChunks));
  const pieces: PieceSource = { ground: (x, y) => heights.at(x, y), terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds, runs: heights.runs, detail: heights.detail };
  return { src, heights, pieces };
}

function index(state: RoomState, d: Drawn = drawnOf(state)): ReliefIndex {
  const relief = new ReliefIndex();
  sync(relief, state, d);
  return relief;
}

function sync(relief: ReliefIndex, state: RoomState, d: Drawn): void {
  const bounds = state.scenes.s1!.bounds;
  relief.sync({ sceneId: "s1", bounds, chunks: state.buildChunks, tiles: null, walls: groupWalls([], null, bounds), global: d.heights.detail, src: d.pieces });
}

const span = (d: Compass, lo: number, hi: number): StairStep => ({ d, lo, hi });

/** A Medium standee's boxes at turn 0, its corner at x, y on its base, as the board makes them. */
function standeeBoxes(x: number, y: number, base: number): { bounds: VBox; art: VBox } {
  const shape = standeeShape(0, { x, y, w: 1, h: 1 }, base, base, 40, 800);
  return { bounds: shape.bounds, art: shape.art };
}

describe("faces read both cells' edge profiles (5.2, ISODEPTH-ASTRA-09)", () => {
  const relief = index(built(RUNS));
  const at = (x: number, y: number) => relief.cellAt(x, y)!;

  test("a sunk run's room landing draws no face across the entrance to its lowest stair, at any turn", () => {
    for (const turn of TURNS) {
      const east = facesOf(at(5, 11), turn).filter((f) => f.side === 1);
      assert.deepEqual(east, [], `turn ${turn}: the landing at -10 ft meets the stair's lowest tread at -10 ft`);
    }
  });

  test("two stairs of one run meet at one step, the lower's top tread to the upper's first", () => {
    // At turn 0 the run climbs north, away from the viewer: the upper stair's south side faces it.
    const foot = facesOf(at(9, 6), 0).filter((f) => f.side === 2);
    assert.equal(foot.length, 1);
    assert.ok(Math.abs(foot[0]!.z0 - 0.8) < 1e-9 && foot[0]!.z1 === 1, JSON.stringify(foot));
    assert.equal(foot[0]!.tread, 0);
    assert.deepEqual(facesOf(at(9, 7), 0).filter((f) => f.side === 2), [], "the lower stair's lowest tread meets the corridor at 0");
    // The landing's side down to the upper stair's top tread: the last riser.
    const head = facesOf(at(9, 5), 0).filter((f) => f.side === 2);
    assert.equal(head.length, 1);
    assert.ok(Math.abs(head[0]!.z0 - 1.8) < 1e-9 && head[0]!.z1 === 2, JSON.stringify(head));
  });

  test("a column beside a stair whose span starts below its ground steps down to each tread, leaving no hole above the low ones", () => {
    // The builder's stair at 5 ft between 0 and 10 ft, a 10 ft column beside its east side.
    const relief2 = index(
      built([
        { t: "build.height", sceneId: "s1", cells: ["5,4", "6,5"], height: 10 },
        { t: "build.height", sceneId: "s1", cells: ["5,5"], height: 5 },
        { t: "build.stairs", sceneId: "s1", cells: ["5,5"], up: "n" },
      ] as Op[]),
    );
    assert.deepEqual(relief2.cellAt(5, 5)!.span, span("n", 0, 2));
    // The column's west side faces the viewer at turns 2 and 3.
    for (const turn of [2, 3] as Turn[]) {
      const west = facesOf(relief2.cellAt(6, 5)!, turn).filter((f) => f.side === 3);
      assert.deepEqual(west.map((f) => Math.round(f.z0 * 5)).sort((a, b) => a - b), [0, 2, 4, 6, 8], `turn ${turn}: one face a tread`);
      assert.ok(west.every((f) => f.z1 === 2));
    }
  });

  test("risers face down the stair, only where that faces the viewer, each with its upper tread", () => {
    const upper = at(9, 6);
    assert.deepEqual(risersOf(upper, 0).map((f) => f.tread), [1, 2, 3, 4], "turn 0: the run climbs away");
    assert.deepEqual(risersOf(upper, 1), [], "turn 1: it climbs toward the viewer");
    const r = risersOf(upper, 0)[1]!;
    assert.ok(Math.abs(r.z0 - 1.2) < 1e-9 && Math.abs(r.z1 - 1.4) < 1e-9 && r.ay === 6.6 && r.by === 6.6, JSON.stringify(r));
  });

  test("a sunk run's stairs are openings joined to the room's pit region, and a standee on them is clipped by it", () => {
    const pit = at(3, 11);
    assert.equal(at(6, 11).kind, "steps");
    assert.ok(pit.region && at(6, 11).region === pit.region && at(7, 11).region === pit.region, "one region through the stairs");
    assert.equal(at(9, 7).region, undefined, "the raised run is no opening");
    const items = relief.layout(0, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, [{ id: "t", x: 7.5, y: 11.5, cells: [{ col: 7, row: 11 }], base: -0.6, holder: null, ...standeeBoxes(7, 11, -0.6) }]);
    const standee = items.find((i) => i.kind === "standee");
    assert.ok(standee && standee.kind === "standee" && standee.pits.length > 0, "clipped by its region's openings");
  });

  test("mutation guard: with the detail off the stairs are plain columns and pits, as today", () => {
    const off = index(built(RUNS), drawnOf(built(RUNS), { detail: false }));
    assert.equal(off.cellAt(9, 6)!.kind, "column");
    assert.equal(off.cellAt(6, 11)!.kind, "pit");
    assert.equal(off.cellAt(7, 11), undefined, "a 0 ft stair has no piece");
    assert.deepEqual(facesOf(off.cellAt(5, 11)!, 2).filter((f) => f.side === 1).map((f) => [f.z0, f.z1]), [[-2, -1]], "today's face across the entrance, to the stair's stored -5 ft");
  });
});

describe("each bucket's signature holds its own and its four neighbors' spans (5.2, D-261102-884)", () => {
  /**
   * A long run up column 16 across three rows of chunks: 45 stairs from
   * (16, 46) to (16, 2) pointing north, each stored at the middle of its
   * 4 ft span, the foot at (16, 47) in chunk (1, 2) at 0 and the head at
   * (16, 1) in chunk (1, 0) at 180 ft. A 200 ft column at (15, 5), in chunk
   * (0, 0), stands beside the outer side of the stair at (16, 5).
   */
  const LONG: Op[] = [
    ...Array.from({ length: 45 }, (_, i) => ({ t: "build.height", sceneId: "s1", cells: [`16,${46 - i}`], height: 4 * i + 2 })),
    { t: "build.height", sceneId: "s1", cells: ["16,1"], height: 180 },
    { t: "build.stairs", sceneId: "s1", cells: cellsOf(16, 2, 17, 47), up: "n" },
    { t: "build.height", sceneId: "s1", cells: ["15,5"], height: 200 },
  ] as Op[];
  const BOUNDS = { w: 40, h: 56 };
  /** The foot lowered 1 ft, applied to the room as it stands, so every chunk but (1, 2) keeps its object: every span grows by a 45th, each stair still inside its own. */
  const lowered = (state: RoomState): RoomState => {
    const r = applyOp(state, { t: "build.height", sceneId: "s1", cells: ["16,47"], height: -1 } as Op, DM, env(900));
    if (!r.ok) throw new Error(r.message);
    return r.state;
  };

  test("an edit at a run's far end, two chunks off, rebuilds the far stairs' bucket and the bucket whose column reads their spans", () => {
    const before = built(LONG, BOUNDS);
    const relief = index(before);
    assert.deepEqual(relief.cellAt(16, 3)!.span, span("n", 172 / 5, 176 / 5));
    assert.deepEqual(relief.cellAt(15, 5)!.aroundSteps?.[1], relief.cellAt(16, 5)!.span);
    const after = lowered(before);
    assert.equal(after.buildChunks["s1:1,0"], before.buildChunks["s1:1,0"], "the near chunks keep their objects");
    assert.equal(after.buildChunks["s1:0,0"], before.buildChunks["s1:0,0"]);
    sync(relief, after, drawnOf(after));
    const now = relief.cellAt(16, 3)!.span!;
    const want = (k: number) => (-1 + (k * 181) / 45) / 5;
    assert.ok(Math.abs(now.lo - want(43)) < 1e-9 && Math.abs(now.hi - want(44)) < 1e-9, `the stair by the head, in chunk (1, 0): ${JSON.stringify(now)}`);
    assert.deepEqual(relief.cellAt(15, 5)!.aroundSteps?.[1], relief.cellAt(16, 5)!.span, "the column in chunk (0, 0) reads the stair in chunk (1, 0) anew");
    assert.ok(Math.abs(relief.cellAt(16, 5)!.span!.lo - want(41)) < 1e-9);
  });

  test("a sync that moves no span rebuilds nothing", () => {
    const state = built(LONG, BOUNDS);
    const relief = index(state);
    sync(relief, state, drawnOf(state));
    assert.equal(relief.rebuilt, 0);
  });
});

/** A canvas that writes down its fills and strokes, each path's points in device pixels. */
function canvas(): { g: CanvasRenderingContext2D; ops: { name: string; style: string; pts: { x: number; y: number }[] }[] } {
  const ops: { name: string; style: string; pts: { x: number; y: number }[] }[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let path: { x: number; y: number }[] = [];
  let fill: unknown = "";
  const tx = (x: number, y: number) => ({ x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! });
  const g = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: unknown) {
      fill = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    save: () => stack.push([...m]),
    restore: () => {
      m = stack.pop()!;
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      m = [a, b, c, d, e, f];
    },
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push(tx(x, y)),
    lineTo: (x: number, y: number) => path.push(tx(x, y)),
    closePath: () => {},
    clip: () => ops.push({ name: "clip", style: "", pts: [...path] }),
    fill: () => ops.push({ name: "fill", style: typeof fill === "string" ? fill : "pattern", pts: [...path] }),
    stroke: () => ops.push({ name: "stroke", style: "", pts: [...path] }),
    createPattern: () => ({ setTransform() {} }),
  };
  return { g: g as unknown as CanvasRenderingContext2D, ops };
}

/** A context at 1 view unit a pixel with no offset, so a drawn point in device pixels is its view point. */
function dcAt(turn: Turn, ground: HTMLCanvasElement | null = { width: 4000, height: 4000 } as HTMLCanvasElement, view: VBox = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }): DrawContext {
  return { turn, camera: { x: 0, y: 0, scale: 1 }, pixelRatio: 1, ground, textures: {}, view };
}

describe("drawing a stair's steps (5.2, ISOD-08)", () => {
  const relief = index(built(RUNS));

  test("a stair after held tops copies them first: a column's top before any of the stair's fills", () => {
    const column = relief.cellAt(10, 6) ?? cellPieces({ ground: (x, y) => (x === 10 && y === 7 ? 1.4 : 0), terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds: { w: 20, h: 16 } }, 0, 0, undefined).find((p) => p.x === 10 && p.y === 7)!;
    const steps = relief.cellAt(9, 6)!;
    const alone = (pieces: CellPiece[]) => {
      const { g, ops } = canvas();
      drawRun(g, pieces, dcAt(0));
      return ops;
    };
    const both = alone([column, steps]);
    assert.deepEqual(both, [...alone([column]), ...alone([steps])], "the column's whole drawing, its top included, then the stair's");
  });

  test("each tread tones by its own lift: a canvas whose margin holds the stair's stored height but not its top tread's tones the stair", () => {
    // The builder's stair at 5 ft between 0 and 10 ft: treads from 0 to 8 ft, against a plain 5 ft column on the same square.
    const state = built([
      { t: "build.height", sceneId: "s1", cells: ["5,4"], height: 10 },
      { t: "build.height", sceneId: "s1", cells: ["5,5"], height: 5 },
      { t: "build.stairs", sceneId: "s1", cells: ["5,5"], up: "n" },
    ] as Op[]);
    const steps = index(state).cellAt(5, 5)!;
    const plain = index(state, drawnOf(state, { detail: false })).cellAt(5, 5)!;
    assert.equal(steps.kind, "steps");
    assert.equal(plain.kind, "column");
    let differs = 0;
    // The view's bottom across the square's rows, the ground canvas 1.1 cells of lift taller: past the stored 1 cell, short of the top tread's 1.6.
    for (let bottom = 0; bottom < 12; bottom += 0.05) {
      const ground = { width: 4000, height: (bottom + 1.1 * 0.8660254037844386) * 1 } as HTMLCanvasElement;
      const dc = dcAt(0, ground, { x0: -1e6, y0: -1e6, x1: 1e6, y1: bottom });
      const a: VBox[] = [];
      const b: VBox[] = [];
      tonedBoxes([steps], dc, a);
      tonedBoxes([plain], dc, b);
      if (a.length > 0 && b.length === 0) differs++;
      assert.ok(!(b.length > 0 && a.length === 0), `at ${bottom}: no tread lower than the top tread tones where the stored height does not`);
    }
    assert.ok(differs > 0, "somewhere the top tread reaches past the ground canvas where the stored height does not");
  });
});

type Pt = { x: number; y: number };

/**
 * A canvas that writes down each fill's polygons and the clips in force as
 * it was made, each clip the polygons of its path, so a test can say what
 * shows at a point: the last fill over it that every clip lets through.
 */
function clippingCanvas(): { g: CanvasRenderingContext2D; fills: { polys: Pt[][]; clips: Pt[][][] }[] } {
  const fills: { polys: Pt[][]; clips: Pt[][][] }[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  let clips: Pt[][][] = [];
  const stack: { m: number[]; clips: Pt[][][] }[] = [];
  let polys: Pt[][] = [];
  const tx = (x: number, y: number) => ({ x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! });
  const g = {
    fillStyle: "" as unknown,
    strokeStyle: "",
    lineWidth: 1,
    save: () => stack.push({ m: [...m], clips }),
    restore: () => {
      ({ m, clips } = stack.pop()!);
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      m = [a, b, c, d, e, f];
    },
    beginPath: () => {
      polys = [];
    },
    moveTo: (x: number, y: number) => polys.push([tx(x, y)]),
    lineTo: (x: number, y: number) => polys[polys.length - 1]!.push(tx(x, y)),
    closePath: () => {},
    clip: () => {
      clips = [...clips, polys.map((p) => [...p])];
    },
    fill: () => fills.push({ polys: polys.map((p) => [...p]), clips }),
    stroke: () => {},
    createPattern: () => ({ setTransform() {} }),
  };
  return { g: g as unknown as CanvasRenderingContext2D, fills };
}

/** Whether a point lies inside a polygon, by the crossings of a ray from it. */
function insidePoly(poly: readonly Pt[], q: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether two polygons have the same corners, in any order. */
function sameCorners(a: readonly Pt[], b: readonly Pt[]): boolean {
  const key = (p: readonly Pt[]) => p.map((q) => `${q.x.toFixed(6)},${q.y.toFixed(6)}`).sort().join(" ");
  return key(a) === key(b);
}

describe("a stair from a pit up to a dais keeps its treads above 0 (ISOBUILD-ASTRA-01)", () => {
  // An east-facing stair at (5, 5), stored at 0, between a 5 ft pit at (4, 5) and a 5 ft dais at (6, 5): one span from -5 to +5 ft.
  const state = built([
    { t: "build.height", sceneId: "s1", cells: ["4,5"], height: -5 },
    { t: "build.height", sceneId: "s1", cells: ["6,5"], height: 5 },
    { t: "build.stairs", sceneId: "s1", cells: ["5,5"], up: "e" },
  ] as Op[]);
  const d = drawnOf(state);
  const relief = index(state, d);
  const stair = relief.cellAt(5, 5)!;
  const camera = { x: 0, y: 0, scale: 1 };
  const treadZ = (k: number) => -1 + (2 * k) / 5;
  /** Tread k's top, as it draws at a turn. */
  const topOf = (turn: Turn, k: number) => [5 + k / 5, 5 + (k + 1) / 5].flatMap((x) => [5, 6].map((y) => toView(isometric(turn), { x, y }, treadZ(k))));

  test("the stair spans the pit's floor to the dais and is an opening of the pit's region", () => {
    assert.equal(stair.kind, "steps");
    assert.deepEqual(stair.span, span("e", -1, 1));
    assert.ok(stair.region && stair.region === relief.cellAt(4, 5)!.region);
  });

  test("at every turn, wherever pickWalk hits a tread above 0, that tread's top is what the stair shows there", () => {
    let hits = 0;
    for (const turn of TURNS) {
      const { g, fills } = clippingCanvas();
      drawRun(g, [stair], dcAt(turn));
      for (const k of [3, 4]) {
        for (const [u, v] of [[0.5, 0.5], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]] as const) {
          const at = { x: 5 + (k + u) / 5, y: 5 + v };
          const screen = viewToScreen(camera, toView(isometric(turn), at, treadZ(k)));
          const hit = pickWalk({ camera, view: isometric(turn), grid: { shape: "squares" }, heights: d.heights }, screen);
          if (hit.cell.col !== 5 || hit.cell.row !== 5 || Math.abs(hit.z - treadZ(k)) > 1e-9) continue;
          hits++;
          const shown = fills.findLast((f) => f.polys.some((p) => insidePoly(p, screen)) && f.clips.every((c) => c.some((p) => insidePoly(p, screen))));
          assert.ok(shown && shown.polys.length === 1 && sameCorners(shown.polys[0]!, topOf(turn, k)), `turn ${turn}, tread ${k} at ${JSON.stringify(at)}: the stair shows ${JSON.stringify(shown?.polys)}`);
        }
      }
    }
    // The reviewer's case among them: the top tread at turn 2, where the pick finds it at +3 ft.
    const top = viewToScreen(camera, toView(isometric(2), { x: 5.9, y: 5.5 }, treadZ(4)));
    const hit = pickWalk({ camera, view: isometric(2), grid: { shape: "squares" }, heights: d.heights }, top);
    assert.deepEqual([hit.cell.col, hit.cell.row, Math.round(hit.z * 5)], [5, 5, 3]);
    assert.ok(hits >= 10, `the picks found the treads ${hits} times`);
  });

  test("the riser that crosses 0 draws its part below 0 inside the pit's openings and its part above 0 outside them", () => {
    // East climbs away from the viewer at turns 2 and 3, so the risers face it there.
    for (const turn of [2, 3] as Turn[]) {
      const { g, fills } = clippingCanvas();
      drawRun(g, [stair], dcAt(turn));
      const face = (z0: number, z1: number) => [5, 6].flatMap((y) => [z0, z1].map((z) => toView(isometric(turn), { x: 5.6, y }, z)));
      const below = fills.filter((f) => f.polys.some((p) => sameCorners(p, face(-0.2, 0))));
      const above = fills.filter((f) => f.polys.some((p) => sameCorners(p, face(0, 0.2))));
      assert.ok(below.length > 0 && below.every((f) => f.clips.length === 1), `turn ${turn}: below 0, clipped`);
      assert.ok(above.length > 0 && above.every((f) => f.clips.length === 0), `turn ${turn}: above 0, not clipped`);
      assert.ok(!fills.some((f) => f.polys.some((p) => sameCorners(p, face(-0.2, 0.2)))), `turn ${turn}: never whole`);
    }
  });
});

/** Every point a draw of one piece puts on the canvas, in view units. */
function drawnPoints(p: CellPiece, turn: Turn): { x: number; y: number }[] {
  const { g, ops } = canvas();
  drawRun(g, [p], dcAt(turn));
  return ops.filter((o) => o.name !== "clip").flatMap((o) => o.pts);
}

function inside(box: VBox, q: { x: number; y: number }): boolean {
  const e = 1e-9;
  return q.x >= box.x0 - e && q.x <= box.x1 + e && q.y >= box.y0 - e && q.y <= box.y1 + e;
}

describe("bounds hold every drawn point, the detail on and off (6, ISOD-03)", () => {
  test("property: random runs, spans and neighbors, every piece at every turn", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: -4, max: 3 }),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom<Compass>("n", "e", "s", "w"),
        fc.array(fc.integer({ min: -6, max: 6 }), { minLength: 25, maxLength: 25 }),
        (n, foot, rise, d, around) => {
          const step = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[d];
          const key = (i: number) => `${6 + step[0]! * i},${6 + step[1]! * i}`;
          const ground: Record<string, number> = {};
          // Random ground round the run, a 5 by 5 block about (6, 6) less the run.
          for (let j = 0; j < 25; j++) ground[`${4 + (j % 5)},${4 + Math.floor(j / 5)}`] = around[j]! / 2;
          const stairs: Record<string, Facing> = {};
          ground[key(-1)] = foot;
          ground[key(n)] = foot + rise;
          for (let i = 0; i < n; i++) {
            stairs[key(i)] = d;
            ground[key(i)] = foot + ((i + 0.5) * rise) / n;
          }
          const cells = Object.keys(stairs).map((k) => ({ x: Number(k.split(",")[0]), y: Number(k.split(",")[1]) }));
          const runs = stairRuns(cells, (x, y) => stairs[`${x},${y}`], (x, y) => ground[`${x},${y}`] ?? 0, (x, y) => x >= 0 && y >= 0 && x < 16 && y < 16);
          assert.equal(runs.size, n);
          const boxes = new Map<string, VBox[]>();
          for (const detail of [true, false]) {
            const src: PieceSource = { ground: (x, y) => ground[`${x},${y}`] ?? 0, terrain: () => null, look: () => ({ texture: null, color: "#777777" }), bounds: { w: 16, h: 16 }, runs, detail };
            for (const p of cellPieces(src, 0, 0, undefined)) {
              for (const turn of TURNS) {
                const box = boundsOf(p, turn);
                const list = boxes.get(`${p.id}@${turn}`) ?? [];
                list.push(box);
                boxes.set(`${p.id}@${turn}`, list);
                for (const q of drawnPoints(p, turn)) assert.ok(inside(box, q), `${p.kind} ${p.id} detail ${detail} turn ${turn}: ${JSON.stringify(q)} outside ${JSON.stringify(box)}`);
              }
            }
          }
          for (const [id, list] of boxes) if (list.length === 2) assert.deepEqual(list[0], list[1], `${id}: the same bounds with the detail on and off`);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("security: hidden cells change nothing a player's steps read (8, D-261102-881)", () => {
  const BOUNDS = { w: 20, h: 16 };
  /** Fog tiles with only the given rectangles revealed. */
  function revealed(rects: readonly { x: number; y: number; w: number; h: number }[]): Record<string, FogTile> {
    const change = rasterizeFogOps({}, "s1", BOUNDS, rects.map((r, i) => ({ id: `r${i}`, mode: "reveal" as const, shape: { kind: "rect" as const, ...r } })));
    return Object.fromEntries(Object.entries(change).filter((e): e is [string, FogTile] => e[1] !== null));
  }

  test("property: the same projected chunks and fog over different hidden heights give the same runs, pieces, picks, stand surfaces and drawing", () => {
    const camera = { x: 300, y: 200, scale: 24 };
    fc.assert(
      fc.property(
        fc.record({ x: fc.integer({ min: 0, max: 12 }), y: fc.integer({ min: 0, max: 10 }), w: fc.integer({ min: 3, max: 20 }), h: fc.integer({ min: 3, max: 16 }) }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 19 }), fc.integer({ min: 0, max: 15 }), fc.integer({ min: -4, max: 4 })), { maxLength: 12 }),
        fc.constantFrom(...TURNS),
        (rect, hidden, turn) => {
          const fog = revealed([rect]);
          const seen = (x: number, y: number) => x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
          // Heights only under the fog: cells this player has seen keep the room's.
          const extra = hidden.filter(([x, y]) => !seen(x, y)).map(([x, y, f], i) => ({ t: "build.height", sceneId: "s1", cells: [`${x},${y}`], height: f * 5 + (i % 2) * 5 }));
          const a = built(RUNS, BOUNDS);
          const b = built([...RUNS, ...extra] as Op[], BOUNDS);
          // The stairs' directions as the player's projection holds them: the same marks, pointing as the server says.
          const da = drawnOf(a, { fog });
          const db = drawnOf(b, { fog });
          const describe = (d: Drawn) => {
            const relief = index(d === da ? a : b, d);
            const out: unknown[] = [d.heights.runs!.cells];
            for (let y = 0; y < 16; y++) {
              for (let x = 0; x < 20; x++) {
                out.push(standSurface(d.heights, [{ col: x, row: y }]));
                const p = relief.cellAt(x, y);
                if (p) out.push(p.kind, p.z, p.span ?? null, p.aroundSteps ?? null, drawnOps(p, turn));
              }
            }
            for (let k = 0; k < 40; k++) out.push(pickWalk({ camera, view: isometric(turn), grid: { shape: "squares" }, heights: d.heights }, viewToScreen(camera, toView(isometric(turn), { x: (k * 7) % 20, y: (k * 3) % 16 }))));
            return out;
          };
          assert.deepEqual(describe(da), describe(db));
        },
      ),
      { numRuns: 40 },
    );
  });
});

function drawnOps(p: CellPiece, turn: Turn) {
  const { g, ops } = canvas();
  drawRun(g, [p], dcAt(turn));
  return ops;
}

describe("a stair's sides wear its floor (5.3, D-261102-843)", () => {
  test("Stairs terrain wears stone, a stair mark on wood wears wood, and one over the map image its map tint", () => {
    const state = built([
      { t: "build.paint", sceneId: "s1", terrain: "stairs", cells: ["2,2"] },
      { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["3,3"] },
      { t: "build.height", sceneId: "s1", cells: ["2,2", "3,3", "4,4"], height: 5 },
      { t: "build.stairs", sceneId: "s1", cells: ["3,3", "4,4"], up: "n" },
    ] as Op[]);
    const chunk = state.buildChunks["s1:0,0"]!;
    const asked = new Map<string, string | null>();
    const src: PieceSource = {
      ground: (x, y) => (["2,2", "3,3", "4,4"].includes(`${x},${y}`) ? 1 : 0),
      terrain: (x, y) => chunk.cells[`${x},${y}`] ?? null,
      look: (x, y, t) => {
        asked.set(`${x},${y}`, t);
        return { texture: null, color: "#777777" };
      },
      bounds: { w: 20, h: 16 },
    };
    cellPieces(src, 0, 0, chunk);
    assert.deepEqual(Object.fromEntries(asked), { "2,2": "stone", "3,3": "wood", "4,4": null }, "never the stairs swatch on squares");
  });
});

describe("the detail flag reaches every reader together (7, D-261102-883)", () => {
  test("at 23 px the stairs are plain columns to the drawing, the picks and the stand surface, and at 24 px all three read steps", () => {
    const state = built(RUNS);
    const camera = { x: 300, y: 200, scale: 24 };
    for (const detail of [false, true]) {
      const d = drawnOf(state, { detail });
      const relief = index(state, d);
      assert.equal(relief.cellAt(9, 6)!.kind, detail ? "steps" : "column");
      assert.equal(standSurface(d.heights, [{ col: 9, row: 6 }]), detail ? 1.4 : 1);
      const hit = pickWalk({ camera, view: isometric(0), grid: { shape: "squares" }, heights: d.heights }, viewToScreen(camera, toView(isometric(0), { x: 9.5, y: 6.5 }, 1.4)));
      assert.equal(Math.abs(hit.z - 1.4) < 1e-9, detail, `pick at detail ${detail}: ${hit.z}`);
    }
  });
});
