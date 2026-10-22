import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type EdgeFeature, type FreeWall, type Scene, type StairMark, type TerrainId, type WallFeature } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import { computeCoverage, creaturesInArea, defaultIncludeOrigin, type AreaTemplateInput } from "./aoe.ts";
import { boxDistanceFt, tokenCellBox } from "./distance.ts";
import { encodeHeights } from "./heights.ts";
import { coreBlocked, coreSize, crossesInterior, landing, legStop, lineClear, ownWalk, previewSqueezed, resizeLegStop, resizeStands, squeezeFits, sweptTouches, type MovingToken } from "./movement.ts";
import { sceneWalls } from "./walls.ts";

type Spec = {
  w?: number;
  h?: number;
  autoWalls?: AutoWalls;
  blockMovement?: boolean;
  cells?: Record<string, TerrainId>;
  edges?: Record<string, EdgeFeature>;
  walls?: FreeWall[];
  heights?: Record<string, number>;
  marks?: Record<string, StairMark>;
};

let sceneSerial = 0;

/** A one-scene state from global cell and edge keys, split into stored chunks as the reducer stores them. */
function world(spec: Spec): BuildState & { sceneId: string } {
  const sceneId = `move-${sceneSerial++}`;
  const chunks: Record<string, BuildChunk> = {};
  const feet = new Map<string, number[]>();
  const ups = new Map<string, string[]>();
  const at = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = `${sceneId}:${cx},${cy}`;
    return { key, chunk: (chunks[key] ??= { sceneId, cx, cy, rev: 1, cells: {}, edges: {} }), k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS) };
  };
  const split = (key: string) => key.split(",").map(Number) as [number, number];
  for (const [key, t] of Object.entries(spec.cells ?? {})) at(...split(key)).chunk.cells[key] = t;
  for (const [key, f] of Object.entries(spec.edges ?? {})) {
    const [x, y] = split(key);
    at(Math.min(x, (spec.w ?? 30) - 1), Math.min(y, (spec.h ?? 30) - 1)).chunk.edges[key] = f;
  }
  for (const wall of spec.walls ?? []) (at(Math.floor((wall.a[0] + wall.b[0]) / 2), Math.floor((wall.a[1] + wall.b[1]) / 2)).chunk.walls ??= []).push(wall);
  for (const [key, v] of Object.entries(spec.heights ?? {})) {
    const c = at(...split(key));
    if (!feet.has(c.key)) feet.set(c.key, new Array(256).fill(0));
    feet.get(c.key)![c.k] = v;
  }
  for (const [key, m] of Object.entries(spec.marks ?? {})) {
    const c = at(...split(key));
    if (!ups.has(c.key)) ups.set(c.key, new Array(256).fill("."));
    ups.get(c.key)![c.k] = m;
  }
  for (const [key, f] of feet) chunks[key]!.heights = encodeHeights(f);
  for (const [key, u] of ups) chunks[key]!.up = u.join("");
  const scene = { id: sceneId, bounds: { w: spec.w ?? 30, h: spec.h ?? 30 }, autoWalls: spec.autoWalls ?? "off", blockMovement: spec.blockMovement ?? true } as Scene;
  return { sceneId, scenes: { [sceneId]: scene }, buildChunks: chunks };
}

function tok(state: { sceneId: string }, over: Partial<MovingToken>): MovingToken {
  return { sceneId: state.sceneId, size: "medium", x: 0, y: 0, elevation: 0, ...over };
}

/** Edge walls along a line of cells: "n" edges from (x0, y) to (x1, y), or "w" edges from (x, y0) to (x, y1). */
function line(side: "n" | "w", fixed: number, from: number, to: number, feature: WallFeature = { kind: "wall" }): Record<string, EdgeFeature> {
  const out: Record<string, EdgeFeature> = {};
  for (let v = from; v < to; v++) out[side === "n" ? `${v},${fixed},n` : `${fixed},${v},w`] = feature;
  return out;
}

function free(id: string, ax: number, ay: number, bx: number, by: number, f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  return { id, a: [ax, ay], b: [bx, by], f };
}

const open: WallFeature = { kind: "door", state: "open", secret: false, discovered: false };
const closed: WallFeature = { kind: "door", state: "closed", secret: false, discovered: false };

const go = (x: number, y: number, elevation = 0) => ({ x, y, elevation });

describe("the exact touch test", () => {
  test("a swept core touches a segment it reaches, ends and edges included, and misses one just past it", () => {
    // A Large core (half sides 31/64) swept east along y = 6, and walls above it.
    const h = 31 / 64;
    assert.equal(sweptTouches(8, 6, 12, 6, h, h, 10, 0, 10, 6 - h), true, "the wall's end on the core's top edge");
    assert.equal(sweptTouches(8, 6, 12, 6, h, h, 10, 0, 10, 6 - h - 1 / 64), false);
    assert.equal(sweptTouches(8, 6, 12, 6, h, h, 12 + h, 0, 12 + h, 10), true, "the end core's side");
    assert.equal(sweptTouches(8, 6, 12, 6, h, h, 12 + h + 1 / 64, 0, 12 + h + 1 / 64, 10), false);
    // Diagonal: the hexagon's slanted side.
    assert.equal(sweptTouches(0, 0, 4, 4, h, h, 2 - h, 2 + h + 1 / 64, 0, 4 + 2 * h + 1 / 64), false);
    assert.equal(sweptTouches(0, 0, 4, 4, h, h, 2, 2 + 2 * h, 0, 4 + 2 * h), true);
    // A point core is a segment: touching its end counts, and parallel neighbors miss.
    assert.equal(sweptTouches(0, 0, 2, 2, 0, 0, 2, 2, 3, 0), true);
    assert.equal(sweptTouches(0, 0, 2, 2, 0, 0, 0, 1 / 64, 2, 2 + 1 / 64), false);
    assert.equal(sweptTouches(1, 1, 1, 1, 0, 0, 0, 0, 2, 2), true);
  });

  test("agrees with a dense sampling on random lattice cases", () => {
    let seed = 5;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const q = (v: number) => Math.round(v * 16) / 16;
    let touches = 0;
    for (let n = 0; n < 3000; n++) {
      const [px, py, qx, qy, ax, ay, bx, by] = Array.from({ length: 8 }, () => q(rand() * 6));
      const hx = [0, 31 / 64, 63 / 64][Math.floor(rand() * 3)]!;
      const hy = rand() < 0.5 ? hx : [0, 31 / 64][Math.floor(rand() * 2)]!;
      if (ax === bx && ay === by) continue;
      const got = sweptTouches(px!, py!, qx!, qy!, hx, hy, ax!, ay!, bx!, by!);
      // The minimum over the path of the box distance to the segment, sampled finely, near zero when they touch.
      let best = Infinity;
      for (let i = 0; i <= 400; i++) {
        const t = i / 400;
        const cx = px! + (qx! - px!) * t;
        const cy = py! + (qy! - py!) * t;
        for (let j = 0; j <= 400; j++) {
          const s = j / 400;
          const x = ax! + (bx! - ax!) * s;
          const y = ay! + (by! - ay!) * s;
          best = Math.min(best, Math.max(Math.abs(x - cx) - hx, Math.abs(y - cy) - hy, 0));
        }
        if (best === 0) break;
      }
      if (best > 0.03) assert.equal(got, false, `${[px, py, qx, qy, hx, hy, ax, ay, bx, by]}`);
      if (got) touches++;
      if (best === 0 && !got) assert.fail(`sampled a touch the test missed: ${[px, py, qx, qy, hx, hy, ax, ay, bx, by]}`);
    }
    assert.ok(touches > 300);
  });

  test("a segment through the open rectangle crosses its interior, and one along its edge does not", () => {
    assert.equal(crossesInterior(0, 0, 2, 2, 1, -1, 1, 3), true);
    assert.equal(crossesInterior(0, 0, 2, 2, 2, -1, 2, 3), false);
    assert.equal(crossesInterior(0, 0, 2, 2, 0, 0, 2, 0), false);
    assert.equal(crossesInterior(0, 0, 2, 2, -1, 1, 1, 3), false, "touches only the corner");
    assert.equal(crossesInterior(0, 0, 2, 2, -1, 0.5, 1, 2.5), true);
    assert.equal(crossesInterior(0, 0, 2, 2, -1, 1.5, 1, 3.5), false, "its box overlaps, the segment misses");
  });
});

describe("the core", () => {
  test("is one size smaller per axis, never negative and never rounded", () => {
    const at = { sceneId: "s" };
    assert.deepEqual(coreSize(tok(at, { size: "medium" })), { w: 0, h: 0 });
    assert.deepEqual(coreSize(tok(at, { size: "tiny" })), { w: 0, h: 0 });
    assert.deepEqual(coreSize(tok(at, { size: "large" })), { w: 0.96875, h: 0.96875 });
    assert.deepEqual(coreSize(tok(at, { size: "huge" })), { w: 1.96875, h: 1.96875 });
    assert.deepEqual(coreSize(tok(at, { size: "gargantuan" })), { w: 2.96875, h: 2.96875 });
    assert.deepEqual(coreSize(tok(at, { size: "custom", w: 1.01, h: 1.01 })), { w: 0, h: 0 });
    assert.deepEqual(coreSize(tok(at, { size: "custom", w: 1.99, h: 1.99 })), { w: 1.99 - 1.03125, h: 1.99 - 1.03125 });
    assert.equal(coreSize(tok(at, { size: "custom", w: 1.99, h: 1.99 })).w.toFixed(5), "0.95875");
    assert.deepEqual(coreSize(tok(at, { size: "custom", w: 1, h: 3 })), { w: 0, h: 1.96875 });
  });
});

describe("doors and openings (section 4.1)", () => {
  // A wall along x = 10 from y = 0 to 20 with a 5 ft opening at y 5 to 6 holding a door.
  const wallWith = (door: EdgeFeature, width = 1) => world({ edges: { ...line("w", 10, 0, 20), ...line("w", 10, 5, 5 + width, door as WallFeature) } });

  test("a Medium creature passes an open door on its center path and stops at a closed one", () => {
    const s = wallWith(open);
    assert.equal(legStop(s, ownWalk(tok(s, { x: 7, y: 5 })), go(12, 5)), null);
    const shut = wallWith(closed);
    assert.deepEqual(legStop(shut, ownWalk(tok(shut, { x: 7, y: 5 })), go(12, 5)), { blocker: "wall", door: { edge: "10,5,w" } });
    // Past the door's frame, the wall stops it.
    assert.deepEqual(legStop(s, ownWalk(tok(s, { x: 7, y: 7 })), go(12, 7)), { blocker: "wall", door: null });
  });

  test("a Large creature passes a 5 ft door by a shifted path, though its snapped centers sit on the door's frame", () => {
    const s = wallWith(open);
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 7, y: 5 })), go(11, 5)), null);
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 7, y: 4 })), go(11, 4)), null);
    // Closed, it is stopped like anyone.
    const shut = wallWith(closed);
    assert.equal(legStop(shut, ownWalk(tok(shut, { size: "large", x: 7, y: 5 })), go(11, 5))?.blocker, "wall");
  });

  test("a Huge creature passes 10 ft and not 5 ft, a Gargantuan one 15 ft and not 10 ft", () => {
    for (const [size, passes, fails] of [
      ["huge", 2, 1],
      ["gargantuan", 3, 2],
    ] as const) {
      const wide = wallWith(open, passes);
      const narrow = wallWith(open, fails);
      let passed = false;
      for (const y of [3, 4, 5, 6]) {
        if (legStop(wide, ownWalk(tok(wide, { size, x: 5, y })), go(12, y)) === null) passed = true;
        assert.notEqual(legStop(narrow, ownWalk(tok(narrow, { size, x: 5, y })), go(12, y)), null, `${size} through ${fails} cells from y ${y}`);
      }
      assert.ok(passed, `${size} through ${passes} cells`);
    }
  });

  test("a Medium creature keeps the center path: a leg grazing a wall's end is stopped, with no shifts", () => {
    const s = wallWith(open);
    // From (8.5, 4.5) to (11.5, 5.5) passes through the door frame's end at (10, 5).
    assert.notEqual(legStop(s, ownWalk(tok(s, { x: 8, y: 4 })), go(11, 5)), null);
  });
});

describe("no path crosses a wall (section 4.1)", () => {
  // A free wall at x = 10.25, a quarter cell east of a Large creature centered at x = 10.
  const s = world({ walls: [free("q", 10.25, 2, 10.25, 10)] });
  const west = tok(s, { size: "large", x: 9, y: 5 });
  const east = tok(s, { size: "large", x: 9.5, y: 5 });

  test("a Large creature a quarter cell from a free wall may step away from it", () => {
    assert.equal(legStop(s, ownWalk(west), go(8, 5)), null);
    assert.equal(legStop(s, ownWalk(east), go(10.5, 5)), null);
  });

  test("and is refused a one-cell move toward and across it, from either side, by every path", () => {
    assert.equal(legStop(s, ownWalk(west), go(10, 5))?.blocker, "wall");
    assert.equal(legStop(s, ownWalk(east), go(8.5, 5))?.blocker, "wall");
    assert.notEqual(legStop(s, ownWalk(west), go(10, 6)), null);
    assert.notEqual(legStop(s, ownWalk(west), go(9, 6)), null, "sliding along it keeps it in the test");
  });

  test("a token centered exactly on a wall may step off to either side but not slide along it", () => {
    const on = world({ walls: [free("on", 10.5, 2, 10.5, 10)] });
    const t = tok(on, { x: 10, y: 5 });
    assert.equal(legStop(on, ownWalk(t), go(11, 5)), null);
    assert.equal(legStop(on, ownWalk(t), go(9, 5)), null);
    assert.notEqual(legStop(on, ownWalk(t), go(10, 6)), null);
    assert.notEqual(legStop(on, ownWalk(t), go(10, 4)), null);
    // Off it diagonally is a step off, to either side.
    assert.equal(legStop(on, ownWalk(t), go(11, 6)), null);
  });

  test("a token the DM placed over a wall steps off on its own side only", () => {
    // A Large creature centered at (10, 6) over a wall at y = 5.75 from x 8 to 12 steps off it to the south, its own side, and not to the north.
    const over = world({ walls: [free("h", 8, 5.75, 12, 5.75)] });
    const t = tok(over, { size: "large", x: 9, y: 5 });
    assert.equal(legStop(over, ownWalk(t), go(9, 6)), null);
    assert.notEqual(legStop(over, ownWalk(t), go(9, 4)), null);
  });

  test("random legs among free walls never end across a long grid wall, shifted paths included", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 20; trial++) {
      const walls: FreeWall[] = [];
      for (let k = 0; k < 12; k++) {
        const ax = Math.round(rand() * 20 * 4) / 4;
        const ay = Math.round(rand() * 20 * 4) / 4;
        const bx = Math.max(0, Math.min(20, ax + Math.round((rand() * 8 - 4) * 4) / 4));
        const by = Math.max(0, Math.min(20, ay + Math.round((rand() * 8 - 4) * 4) / 4));
        if ((ax !== bx || ay !== by) && (bx - ax) ** 2 + (by - ay) ** 2 <= 64) walls.push(free(`r${k}`, ax, ay, bx, by));
      }
      const st = world({ walls, edges: line("n", 10, 0, 20), w: 22, h: 22 });
      const stored = sceneWalls(st.scenes[st.sceneId]!, st.buildChunks).stored;
      for (let n = 0; n < 60; n++) {
        const size = (["medium", "large", "huge"] as const)[n % 3];
        const t = tok(st, { size, x: Math.floor(rand() * 18), y: Math.floor(rand() * 18) });
        const to = go(Math.floor(rand() * 18), Math.floor(rand() * 18));
        if (legStop(st, ownWalk(t), to) !== null) continue;
        // An allowed leg never ends on the far side of a wall that spans its whole width, unless its core started over that wall.
        const side = { w: t.size === "medium" ? 1 : t.size === "large" ? 2 : 3 };
        const c0 = { x: t.x + side.w / 2, y: t.y + side.w / 2 };
        const c1 = { x: to.x + side.w / 2, y: to.y + side.w / 2 };
        for (let k = 0; k < stored.n; k++) {
          const [ax, ay, bx, by] = [stored.xy[4 * k]!, stored.xy[4 * k + 1]!, stored.xy[4 * k + 2]!, stored.xy[4 * k + 3]!];
          if (ay === by && ax <= Math.min(c0.x, c1.x) - side.w && bx >= Math.max(c0.x, c1.x) + side.w) {
            assert.ok((c0.y - ay) * (c1.y - ay) > 0 || Math.abs(c0.y - ay) < side.w / 2, `trial ${trial}: ${size} from ${c0.x},${c0.y} to ${c1.x},${c1.y} across y = ${ay}`);
          }
        }
      }
    }
  });
});

describe("squeezing (decided 2026-10-14, section 4.1)", () => {
  // A room west of x = 10 and a 5 ft corridor running east from it between y = 5 and y = 6.
  const corridor = world({
    edges: { ...line("w", 10, 0, 5), ...line("w", 10, 6, 12), ...line("n", 5, 10, 25), ...line("n", 6, 10, 25) },
  });
  const large = tok(corridor, { size: "large", x: 6, y: 4 });

  test("a Large creature in a corridor squeezes half a cell off the grid, its squeezed footprint on the corridor's cells", () => {
    assert.equal(squeezeFits(corridor, ownWalk(large), { x: 13.5, y: 4.5 }), true);
    // Its snapped spot leaves its core on a corridor wall, and half a cell off on one axis only misses the cell boundaries.
    assert.equal(coreBlocked(corridor, ownWalk(large), { x: 13, y: 5 }), true);
    assert.equal(squeezeFits(corridor, ownWalk(large), { x: 13, y: 4.5 }), false);
  });

  test("a squeeze is refused in the open, flush against a room wall, and for a token with no side of 2 cells", () => {
    assert.equal(squeezeFits(corridor, ownWalk(large), { x: 4.5, y: 2.5 }), false, "in the room, half a cell off the grid");
    assert.equal(squeezeFits(corridor, ownWalk(large), { x: 8, y: 1 }), false, "flush against the room's east wall");
    // Flush against a wall half a cell off the grid: its squeezed footprint lies on cell boundaries and its core fits, but the wall runs only along its edge.
    const flush = world({ walls: [free("half", 10.5, 0, 10.5, 8)] });
    assert.equal(squeezeFits(flush, ownWalk(tok(flush, { size: "large" })), { x: 8.5, y: 3.5 }), false);
    const grid = world({ edges: line("w", 10, 0, 20) });
    assert.equal(squeezeFits(grid, ownWalk(tok(grid, { size: "large" })), { x: 8, y: 3 }), false, "flush against it, on the grid");
    assert.equal(squeezeFits(corridor, ownWalk(tok(corridor, { x: 13, y: 5 })), { x: 13, y: 5 }), false, "a Medium creature");
    assert.equal(squeezeFits(corridor, ownWalk(tok(corridor, { size: "custom", w: 1.99, h: 1.99 })), { x: 13.5, y: 4.5 }), false);
  });

  test("a drop into the corridor lands on the first half-cell shift where the core fits, the leg is allowed and the squeeze holds", () => {
    assert.deepEqual(landing(corridor, ownWalk(large), go(12, 5), "walk"), { x: 11.5, y: 4.5, squeeze: true, stopped: null });
    // The DM's drop lands the same way, and so does "Teleport here".
    assert.deepEqual(landing(corridor, ownWalk(large), go(12, 5), "free"), { x: 11.5, y: 4.5, squeeze: true, stopped: null });
    assert.deepEqual(landing(corridor, ownWalk(large), go(16, 5), "teleport"), { x: 15.5, y: 4.5, squeeze: true, stopped: null });
  });

  test("a squeezed Large creature walks along the corridor and stops inside it", () => {
    const inside = tok(corridor, { size: "large", x: 11.5, y: 4.5, squeeze: true });
    assert.equal(legStop(corridor, ownWalk(inside), go(20.5, 4.5)), null);
    assert.equal(squeezeFits(corridor, ownWalk(inside), { x: 20.5, y: 4.5 }), true);
    assert.deepEqual(landing(corridor, ownWalk(inside), go(20.5, 4.5), "walk"), { x: 20.5, y: 4.5, squeeze: true, stopped: null });
    // Back out into the room, where it stands unsqueezed.
    assert.deepEqual(landing(corridor, ownWalk(inside), go(6, 4), "walk"), { x: 6, y: 4, squeeze: false, stopped: null });
  });

  test("a custom 1 by 3 token squeezes by its own rectangle, to 1 by 2", () => {
    // A gap two cells tall between walls at y = 5 and y = 7.
    const gap = world({ edges: { ...line("n", 5, 0, 20), ...line("n", 7, 0, 20) } });
    const long = tok(gap, { size: "custom", w: 1, h: 3, x: 3, y: 4.5 });
    assert.equal(squeezeFits(gap, ownWalk(long), { x: 3, y: 4.5 }), true);
    assert.equal(legStop(gap, ownWalk(long), go(12, 4.5)), null);
    assert.equal(squeezeFits(gap, ownWalk(long), { x: 3, y: 4 }), false);
  });

  test("a Large creature dragged along a corridor is judged squeezed at any fractional point, and by its full footprint in the open", () => {
    for (const x of [11.5, 12.13, 14.77, 19.9]) assert.equal(previewSqueezed(corridor, ownWalk(large), { x, y: 4.5 }), true, `${x}`);
    assert.equal(previewSqueezed(corridor, ownWalk(large), { x: 12.3, y: 4.51 }), true);
    assert.equal(previewSqueezed(corridor, ownWalk(large), { x: 12.3, y: 4.62 }), false, "its core touches the corridor's south wall");
    assert.equal(previewSqueezed(corridor, ownWalk(large), { x: 4.3, y: 2.2 }), false);
    assert.equal(previewSqueezed(corridor, ownWalk(large), { x: 8.9, y: 1.1 }), false, "flush against a wall is no squeeze");
  });

  test("a squeezed Large creature is listed by an area only for the corridor's cells, and measured from there", () => {
    const inside = { id: "big", rev: 1, ...tok(corridor, { size: "large", x: 13.5, y: 4.5, squeeze: true }) };
    // A 5 ft cube on the cell north of the corridor, beyond its wall: the full footprint would reach it.
    const cube: AreaTemplateInput = { id: "c", rev: 1, shape: "cube", size: 5, origin: { x: 14, y: 4, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("cube") };
    const context = { settings: { feetPerCell: 5, aoeCoverage: "half" as const, aoeInclusion: "anyCell" as const }, bounds: { w: 30, h: 30 } };
    assert.ok(computeCoverage(cube, context).cells.some((c) => c.x === 14 && c.y === 4));
    assert.deepEqual(creaturesInArea(cube, [inside], context), []);
    assert.deepEqual(creaturesInArea(cube, [{ ...inside, squeeze: undefined, x: 14, y: 4 }], context), ["big"]);
    const north = tok(corridor, { x: 14, y: 2 });
    assert.equal(boxDistanceFt(tokenCellBox(inside, 5), tokenCellBox(north, 5), { feetPerCell: 5, diagonal: "five" }), 15);
  });
});

describe("a squeeze needs a real narrow space (the owner's rule after the build, section 4.1)", () => {
  const large = (st: { sceneId: string }, over: Partial<MovingToken> = {}) => tok(st, { size: "large", x: 3, y: 3, ...over });

  test("one wall in the open never squeezes, half over it or beside it, whatever the mode", () => {
    for (const s of [world({ edges: line("w", 10, 0, 20) }), world({ walls: [free("diag", 10, 0, 10, 8), free("diag2", 10, 8, 10, 16)] })]) {
      const t = large(s);
      // Half over the wall: the squeezed footprint (9..10) lies on cell boundaries and the core is clear of it, but nothing is on its west side.
      assert.equal(squeezeFits(s, ownWalk(t), { x: 8.5, y: 3.5 }), false);
      assert.equal(previewSqueezed(s, ownWalk(t), { x: 8.5, y: 3.5 }), false);
      assert.equal(previewSqueezed(s, ownWalk(t), { x: 8.47, y: 3.83 }), false);
      // A drop with the core on the wall finds no squeezed spot among its shifts, in any mode.
      for (const mode of ["free", "teleport"] as const) assert.deepEqual(landing(s, ownWalk(t), go(9, 4), mode), { x: 9, y: 4, squeeze: false, stopped: null }, mode);
      assert.equal(landing(s, ownWalk(t), go(9, 4), "walk").squeeze, false);
    }
    // A wall across the squeezed footprint's way, with open ground on its far side, is one wall too.
    const across = world({ edges: line("n", 4, 0, 20) });
    assert.equal(squeezeFits(across, ownWalk(large(across)), { x: 3.5, y: 3.5 }), false);
  });

  test("a corridor's outside wall is open ground on one side", () => {
    const corridor = world({ edges: { ...line("n", 5, 10, 25), ...line("n", 6, 10, 25) } });
    const t = large(corridor, { x: 6, y: 2 });
    // North of the corridor, half over its north wall.
    assert.equal(squeezeFits(corridor, ownWalk(t), { x: 11.5, y: 3.5 }), false);
    assert.equal(previewSqueezed(corridor, ownWalk(t), { x: 11.5, y: 3.5 }), false);
    // South of it, half over its south wall.
    assert.equal(squeezeFits(corridor, ownWalk(t), { x: 11.5, y: 5.5 }), false);
    // A drop straddling the north wall lands squeezed inside the corridor, never outside it.
    assert.deepEqual(landing(corridor, ownWalk(t), go(12, 4), "teleport"), { x: 11.5, y: 4.5, squeeze: true, stopped: null });
    // The DM's drop needs a leg to the spot, from the corridor's mouth here.
    const mouth = large(corridor, { x: 6, y: 4.5 });
    assert.deepEqual(landing(corridor, ownWalk(mouth), go(12, 4), "free"), { x: 11.5, y: 4.5, squeeze: true, stopped: null });
    assert.deepEqual(landing(corridor, ownWalk(mouth), go(12, 4), "walk"), { x: 11.5, y: 4.5, squeeze: true, stopped: null });
  });

  test("a real 5 ft corridor takes a Large creature and a 10 ft one a Huge creature, and not the other way", () => {
    const five = world({ edges: { ...line("n", 5, 10, 25), ...line("n", 6, 10, 25) } });
    assert.equal(squeezeFits(five, ownWalk(large(five)), { x: 13.5, y: 4.5 }), true);
    assert.equal(previewSqueezed(five, ownWalk(large(five)), { x: 13.77, y: 4.5 }), true);
    const ten = world({ edges: { ...line("n", 5, 10, 25), ...line("n", 7, 10, 25) } });
    const huge = tok(ten, { size: "huge", x: 3, y: 4.5 });
    assert.equal(squeezeFits(ten, ownWalk(huge), { x: 13.5, y: 4.5 }), true);
    assert.equal(squeezeFits(five, ownWalk(tok(five, { size: "huge", x: 3, y: 3 })), { x: 13.5, y: 4 }), false, "a Huge creature's core does not fit 5 ft");
    assert.equal(squeezeFits(ten, ownWalk(large(ten)), { x: 13.5, y: 5 }), false, "a Large creature in 10 ft has room and is not pinched");
    // The squeezed spot under the finger: a drop on the corridor's snapped spots finds it.
    assert.deepEqual(landing(ten, ownWalk(huge), go(13, 5), "free"), { x: 12.5, y: 4.5, squeeze: true, stopped: null });
  });

  test("a door frame pinches, in a wall running north and south and in one running east and west", () => {
    const upright = world({ edges: { ...line("w", 10, 0, 5), "10,5,w": open, ...line("w", 10, 6, 20) } });
    assert.equal(squeezeFits(upright, ownWalk(large(upright)), { x: 8.5, y: 4.5 }), true, "west of the door");
    assert.equal(squeezeFits(upright, ownWalk(large(upright)), { x: 9.5, y: 4.5 }), true, "east of the door");
    assert.equal(previewSqueezed(upright, ownWalk(large(upright)), { x: 9, y: 4.5 }), true, "in the doorway");
    const level = world({ edges: { ...line("n", 5, 0, 10), "10,5,n": open, ...line("n", 5, 11, 20) } });
    assert.equal(squeezeFits(level, ownWalk(large(level)), { x: 9.5, y: 3.5 }), true, "north of the door");
    assert.equal(squeezeFits(level, ownWalk(large(level)), { x: 9.5, y: 4.5 }), true, "south of the door");
    // A closed door fills the frame: the frame and the door are one wall beside open ground, however the line is cut into segments.
    const shut = world({ edges: { ...line("w", 10, 0, 5), "10,5,w": closed, ...line("w", 10, 6, 20) } });
    assert.equal(previewSqueezed(shut, ownWalk(large(shut)), { x: 9, y: 4.5 }), false);
    assert.equal(squeezeFits(shut, ownWalk(large(shut)), { x: 8.5, y: 4.5 }), false);
    const pieces = world({ walls: [free("p1", 10, 0, 10, 5), free("p2", 10, 5, 10, 6), free("p3", 10, 6, 10, 12)] });
    assert.equal(squeezeFits(pieces, ownWalk(large(pieces)), { x: 8.5, y: 4.5 }), false);
    // A wall that ends level with the creature leaves one side open.
    const stub = world({ edges: line("w", 10, 0, 5) });
    assert.equal(squeezeFits(stub, ownWalk(large(stub)), { x: 8.5, y: 4.5 }), false);
  });

  test("a corridor's dead end and a room's corner", () => {
    const dead = world({ edges: { ...line("n", 5, 10, 25), ...line("n", 6, 10, 25), "10,5,w": { kind: "wall" } } });
    assert.equal(squeezeFits(dead, ownWalk(large(dead)), { x: 9.5, y: 4.5 }), true, "against the dead end, the corridor's walls still pinch");
    const corner = world({ edges: { ...line("w", 10, 0, 10), ...line("n", 10, 10, 20) } });
    assert.equal(squeezeFits(corner, ownWalk(large(corner)), { x: 8.5, y: 8.5 }), false);
  });

  test("ledges pinch a walking creature on a 5 ft raised walkway, and no flier above them", () => {
    const walkway: Spec = { heights: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`${k},5`, 10])) };
    const s = world(walkway);
    assert.equal(squeezeFits(s, ownWalk(large(s, { x: 5, y: 4.5, elevation: 10, squeeze: true })), { x: 9.5, y: 4.5 }), true);
    assert.equal(squeezeFits(s, ownWalk(large(s, { x: 5, y: 1, elevation: 30 })), { x: 9.5, y: 4.5 }), false);
  });
});

describe("raised areas and stairs (section 4.2)", () => {
  // A 10 ft platform over x 10 to 19 and y 0 to 4, a stair one cell wide at (12, 5) pointing up north by the rule.
  const spec: Spec = { heights: Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`${10 + (k % 10)},${Math.floor(k / 10)}`, 10])), marks: { "12,5": "a" } };
  const s = world(spec);

  test("a walking token is stopped at a ledge in either direction", () => {
    assert.deepEqual(legStop(s, ownWalk(tok(s, { x: 15, y: 7 })), go(15, 3, 10)), { blocker: "ledge", door: null });
    assert.equal(legStop(s, ownWalk(tok(s, { x: 15, y: 3, elevation: 10 })), go(15, 7, 0))?.blocker, "ledge");
    assert.equal(legStop(s, ownWalk(tok(s, { x: 8, y: 2 })), go(11, 2, 10))?.blocker, "ledge");
  });

  test("and passes along the stair, a Large creature up a stair one cell wide", () => {
    assert.equal(legStop(s, ownWalk(tok(s, { x: 12, y: 8 })), go(12, 2, 10)), null);
    assert.equal(legStop(s, ownWalk(tok(s, { x: 12, y: 2, elevation: 10 })), go(12, 8, 0)), null);
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 11, y: 7 })), go(11.5, 2, 10)), null);
    // Off the stair's side edges, it is still a ledge.
    assert.equal(legStop(s, ownWalk(tok(s, { x: 11, y: 8 })), go(11, 2, 10))?.blocker, "ledge");
  });

  test("a flier crosses a ledge only above its top, and a token inside the ground is not tested against ledges", () => {
    assert.equal(legStop(s, ownWalk(tok(s, { x: 15, y: 7, elevation: 15 })), go(15, 3, 15)), null);
    assert.equal(legStop(s, ownWalk(tok(s, { x: 15, y: 7, elevation: 5 })), go(15, 3, 10))?.blocker, "ledge");
    assert.equal(legStop(s, ownWalk(tok(s, { x: 15, y: 7, elevation: 15 })), go(15, 3, 5))?.blocker, "ledge", "the lower of start and end");
    assert.equal(legStop(s, ownWalk(tok(s, { x: 15, y: 7, elevation: -10 })), go(15, 3, -10)), null);
    const walled = world({ ...spec, edges: line("n", 6, 0, 20) });
    assert.equal(legStop(walled, ownWalk(tok(walled, { x: 15, y: 8, elevation: -10 })), go(15, 3, -10))?.blocker, "wall");
  });

  test("ledges stop nothing while the scene's blockMovement is off, and walls still answer the test", () => {
    const off = world({ ...spec, blockMovement: false, edges: line("n", 6, 0, 9) });
    assert.equal(legStop(off, ownWalk(tok(off, { x: 15, y: 7 })), go(15, 3, 10)), null);
    assert.equal(legStop(off, ownWalk(tok(off, { x: 5, y: 8 })), go(5, 3))?.blocker, "wall");
  });

  test("the blocker met first names the stop", () => {
    const both = world({ ...spec, edges: line("n", 2, 0, 20) });
    assert.equal(legStop(both, ownWalk(tok(both, { x: 15, y: 7 })), go(15, 0, 10))?.blocker, "ledge");
    assert.equal(legStop(both, ownWalk(tok(both, { x: 5, y: 7 })), go(5, 0))?.blocker, "wall");
  });

  test("a walker's drop at a ledge stops at the last clear spot before it", () => {
    assert.deepEqual(landing(s, ownWalk(tok(s, { x: 15, y: 9 })), go(15, 2, 10), "walk"), { x: 15, y: 5, squeeze: false, stopped: { blocker: "ledge", door: null } });
    // Stopped at its very first step, it stays where it stood.
    assert.deepEqual(landing(s, ownWalk(tok(s, { x: 15, y: 5 })), go(15, 2, 10), "walk"), { x: 15, y: 5, squeeze: false, stopped: { blocker: "ledge", door: null } });
  });
});

describe("where a drop lands (section 4.1)", () => {
  const room = world({ edges: { ...line("w", 10, 0, 5), ...line("w", 10, 6, 20), "10,5,w": closed } });

  test("a walk into a wall stops at the last clear spot, and names a closed door it stopped at", () => {
    assert.deepEqual(landing(room, ownWalk(tok(room, { x: 2, y: 5 })), go(15, 5), "walk"), { x: 9, y: 5, squeeze: false, stopped: { blocker: "wall", door: { edge: "10,5,w" } } });
    assert.deepEqual(landing(room, ownWalk(tok(room, { x: 2, y: 2 })), go(16, 9), "walk").stopped, { blocker: "wall", door: null });
    const at = landing(room, ownWalk(tok(room, { x: 2, y: 2 })), go(16, 9), "walk");
    assert.ok(at.x <= 9 && legStop(room, ownWalk(tok(room, { x: 2, y: 2 })), go(at.x, at.y)) === null);
  });

  test("the DM's drop is never stopped, and an allowed walk lands where it was dropped", () => {
    assert.deepEqual(landing(room, ownWalk(tok(room, { x: 2, y: 5 })), go(15, 5), "free"), { x: 15, y: 5, squeeze: false, stopped: null });
    assert.deepEqual(landing(room, ownWalk(tok(room, { x: 2, y: 5 })), go(8, 3), "walk"), { x: 8, y: 3, squeeze: false, stopped: null });
  });
});

describe("reaching a door (section 4.1)", () => {
  const s = world({ edges: { ...line("w", 10, 0, 5), ...line("w", 10, 6, 20), "10,5,w": closed, ...line("n", 8, 0, 10) } });
  const mid = { x: 10, y: 5.5 };

  test("a straight line to the door's middle that meets nothing but the door, or only meets something there, is clear", () => {
    assert.equal(lineClear(s, tok(s, { x: 9, y: 5 }), mid, { edge: "10,5,w" }), true);
    assert.equal(lineClear(s, tok(s, { x: 10, y: 5 }), mid, { edge: "10,5,w" }), true);
    assert.equal(lineClear(s, tok(s, { x: 9, y: 4 }), mid, { edge: "10,5,w" }), true);
  });

  test("a wall between, or the wall beside the door, blocks the line", () => {
    assert.equal(lineClear(s, tok(s, { x: 9, y: 8 }), mid, { edge: "10,5,w" }), false, "behind the wall at y = 8");
    assert.equal(lineClear(s, tok(s, { x: 11, y: 7 }), mid, { edge: "10,5,w" }), true, "from the door's far side");
    const pillar = world({ edges: { ...line("w", 10, 0, 5), ...line("w", 10, 6, 20), "10,5,w": closed }, cells: { "8,5": "pillar" } });
    assert.equal(lineClear(pillar, tok(pillar, { x: 6, y: 5 }), mid, { edge: "10,5,w" }), false, "a pillar between");
  });
});

describe("the wall set across moves", () => {
  test("a token's move leaves the build untouched, so the next leg test reuses the derived walls", async () => {
    const { applyOp } = await import("../reducer.ts");
    const { DM, env, room, scene, token } = await import("../testutil.ts");
    const state = room({ scenes: { s1: scene("s1", { bounds: { w: 40, h: 40 } }) }, tokens: { t1: token("t1", { sceneId: "s1", x: 1, y: 1 }) } });
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone" }, edges: { "3,3,n": { kind: "wall" } } };
    const before = sceneWalls(state.scenes.s1!, state.buildChunks);
    const moved = applyOp(state, { t: "token.move", tokenId: "t1", x: 2, y: 2 }, DM, env(1));
    assert.ok(moved.ok);
    assert.equal(sceneWalls(moved.state.scenes.s1!, moved.state.buildChunks), before);
  });
});

describe("after a resize (docs/design-v1-token-window.md 8.3 and 8.5)", () => {
  test("the next leg is judged at the new size", () => {
    // A wall along x = 10 with a 10 ft opening at y 5 to 7.
    const s = world({ edges: { ...line("w", 10, 0, 5), ...line("w", 10, 7, 20) } });
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 7, y: 5 })), go(12, 5)), null, "a Large creature passes");
    assert.equal(legStop(s, ownWalk(tok(s, { size: "huge", x: 6, y: 5 })), go(12, 5)), null, "grown to Huge, it still fits");
    assert.equal(legStop(s, ownWalk(tok(s, { size: "gargantuan", x: 5, y: 4.5 })), go(12, 4.5))?.blocker, "wall", "grown to Gargantuan, it does not");
  });

  test("a footprint the DM grew over a wall steps off only toward its middle's side", () => {
    const s = world({ edges: line("w", 4, 0, 20) });
    const huge = tok(s, { size: "huge", x: 3, y: 3 });
    assert.equal(coreBlocked(s, ownWalk(huge), { x: 3, y: 3 }), true, "its core lies over the wall at x 4");
    assert.equal(legStop(s, ownWalk(huge), go(4, 3)), null, "its middle at x 4.5 is right of the wall, so it steps off to the right");
    assert.equal(legStop(s, ownWalk(huge), go(2, 3))?.blocker, "wall", "and never crosses to the left");
  });

  test("a resize's own tests: the new core standing, and its leg from the middle now, naming a ledge as a move does", () => {
    const s = world({ edges: line("w", 5, 0, 20) });
    const medium = tok(s, { x: 4, y: 4 });
    assert.equal(resizeStands(s, medium, { size: "large", x: 4, y: 4 }), false);
    assert.equal(resizeStands(s, medium, { size: "large", x: 3, y: 4 }), true);
    assert.equal(resizeLegStop(s, medium, { size: "large", x: 3, y: 4 }), null);
    assert.equal(resizeLegStop(s, tok(s, { size: "large", x: 4, y: 4 }), { size: "tiny", x: 5, y: 4 }), null, "a shrink whose middle stays on the wall's line steps off either way");
    const ledge = world({ heights: Object.fromEntries(Array.from({ length: 100 }, (_, k) => [`${5 + (k % 10)},${Math.floor(k / 10)}`, 10])) });
    // A Huge creature standing at 10 ft over the ledge's edge at x 5, its middle left of it.
    const walker = tok(ledge, { size: "huge", x: 3, y: 3, elevation: 10 });
    assert.equal(resizeLegStop(ledge, walker, { size: "medium", x: 5, y: 4 }), "ledge", "its middle would cross the ledge's edge");
    assert.equal(resizeLegStop(ledge, walker, { size: "medium", x: 4, y: 4 }), null, "a shrink that keeps its middle");
    assert.equal(resizeLegStop(ledge, { ...walker, elevation: 20 }, { size: "medium", x: 5, y: 4 }), null, "a flier above it");
  });
});

describe("the real rules through the core (permissions, projection)", async () => {
  const { canApply, DOOR_TOO_FAR, LEDGE_IN_THE_WAY, NOT_A_SQUEEZE, WALL_IN_THE_WAY } = await import("../permissions.ts");
  const { projectChunkForPlayer } = await import("../project.ts");
  const { P1, room, token } = await import("../testutil.ts");
  const deps = { canUseAsset: () => true };

  /** Scene s1 with a player's token, the walls of `spec` stored in its chunks. */
  function roomWith(spec: Spec, own: Partial<MovingToken>) {
    const built = world({ ...spec, w: 40, h: 30 });
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: spec.autoWalls ?? "off" };
    for (const chunk of Object.values(built.buildChunks)) state.buildChunks[`s1:${chunk.cx},${chunk.cy}`] = { ...chunk, sceneId: "s1" };
    state.tokens.own = token("own", { ownerIds: ["p1"], ...own, sceneId: "s1" });
    return state;
  }
  const decide = (state: ReturnType<typeof roomWith>, op: Parameters<typeof canApply>[0]) => {
    const d = canApply(op, P1, state, deps);
    return d.ok ? "ok" : `${d.code}: ${d.message}`;
  };

  test("a player's move through a wall or up a ledge is refused, and through an open door or up a stair allowed", () => {
    const walls = { edges: { ...line("w", 10, 0, 30), "10,5,w": closed } };
    assert.equal(decide(roomWith(walls, { x: 7, y: 5 }), { t: "token.move", tokenId: "own", x: 12, y: 5 }), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(decide(roomWith({ edges: { ...walls.edges, "10,5,w": open } }, { x: 7, y: 5 }), { t: "token.move", tokenId: "own", x: 12, y: 5 }), "ok");
    const platform = { heights: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`${k},2`, 10])), marks: { "4,3": "a" as const } };
    assert.equal(decide(roomWith(platform, { x: 8, y: 6 }), { t: "token.move", tokenId: "own", x: 8, y: 2, elevation: 10 }), `forbidden: ${LEDGE_IN_THE_WAY}`);
    assert.equal(decide(roomWith(platform, { x: 4, y: 6 }), { t: "token.move", tokenId: "own", x: 4, y: 2, elevation: 10 }), "ok");
  });

  test("a squeeze is accepted in a corridor and refused in the open", () => {
    const corridor = { edges: { ...line("n", 5, 10, 30), ...line("n", 6, 10, 30) } };
    const state = roomWith(corridor, { size: "large", x: 13.5, y: 4.5, squeeze: true });
    assert.equal(decide(state, { t: "token.move", tokenId: "own", x: 18.5, y: 4.5, squeeze: true }), "ok");
    const inOpen = roomWith(corridor, { size: "large", x: 3, y: 14 });
    assert.equal(decide(inOpen, { t: "token.move", tokenId: "own", x: 3.5, y: 14.5, squeeze: true }), `invalid: ${NOT_A_SQUEEZE}`);
    assert.equal(decide(inOpen, { t: "token.move", tokenId: "own", x: 3.5, y: 14.5 }), "ok");
  });

  test("a door within reach but behind a wall is too far", () => {
    const walls = { edges: { ...line("w", 10, 0, 30), "10,5,w": closed, "9,5,n": { kind: "wall" } as EdgeFeature } };
    assert.equal(decide(roomWith(walls, { x: 9, y: 5 }), { t: "door.set", sceneId: "s1", door: { edge: "10,5,w" }, state: "open" }), "ok");
    assert.equal(decide(roomWith(walls, { x: 9, y: 4 }), { t: "door.set", sceneId: "s1", door: { edge: "10,5,w" }, state: "open" }), `forbidden: ${DOOR_TOO_FAR}`);
  });

  test("a player's own projected build stops exactly the moves the server stops, for every secret door and lock state", () => {
    const states = ["open", "closed", "locked"] as const;
    let compared = 0;
    for (const rule of ["all", "floor", "off"] as const) {
      for (const state of states) {
        for (const discovered of [false, true]) {
          const door = { kind: "door", state, secret: true, discovered } as const;
          // Rooms on both sides of the chunk border at x = 16, joined by a secret door on the border, one beside a stair mark, and a free secret door.
          const cells: Record<string, TerrainId> = {};
          for (let y = 2; y < 10; y++) for (let x = 10; x < 22; x++) if (x !== 16) cells[`${x},${y}`] = "stone";
          const spec: Spec = {
            autoWalls: rule,
            cells,
            edges: { "16,4,w": door, "17,4,w": door, "12,2,n": door, "16,7,w": door },
            marks: { "16,7": "a", "16,4": "a" },
            walls: [free("secretfree01", 18, 9, 20, 9, door)],
          };
          const built = world({ ...spec, w: 30, h: 20 });
          const projected: Record<string, BuildChunk> = {};
          for (const [key, chunk] of Object.entries(built.buildChunks)) {
            const shown = projectChunkForPlayer(built.buildChunks, chunk, rule);
            if (shown) projected[key] = shown;
          }
          const player = { ...built, buildChunks: projected };
          for (let fx = 8; fx < 23; fx++) {
            for (let fy = 0; fy < 12; fy++) {
              for (const [tx, ty] of [
                [fx + 3, fy],
                [fx, fy + 3],
                [fx - 2, fy + 2],
              ] as const) {
                for (const size of ["medium", "large"] as const) {
                  const t = tok(built, { size, x: fx, y: fy });
                  const server = legStop(built, ownWalk(t), go(tx, ty));
                  const theirs = legStop(player, ownWalk(t), go(tx, ty));
                  assert.equal(theirs?.blocker ?? null, server?.blocker ?? null, `${rule} ${state} found ${discovered}: ${size} ${fx},${fy} to ${tx},${ty}`);
                  // A door the player cannot see as a door never names one.
                  if (theirs?.door) assert.ok(discovered || !("edge" in theirs.door) || !["16,4,w", "17,4,w", "12,2,n", "16,7,w"].includes(theirs.door.edge));
                  compared++;
                }
              }
            }
          }
        }
      }
    }
    assert.ok(compared > 10_000);
  });
});

describe("junctions and determinism", () => {
  test("a path through the point where walls meet touches them, and one beside it passes", () => {
    // An L corner at (10, 10), and a free wall ending on a grid wall's middle at (14.5, 10): a T.
    const s = world({ edges: { ...line("w", 10, 0, 10), ...line("n", 10, 10, 20) }, walls: [free("t", 14.5, 6, 14.5, 10)] });
    assert.notEqual(legStop(s, ownWalk(tok(s, { x: 9, y: 9 })), go(10, 10)), null, "through the corner");
    assert.equal(legStop(s, ownWalk(tok(s, { x: 9, y: 9 })), go(9, 10)), null, "beside it, west of the wall");
    assert.notEqual(legStop(s, ownWalk(tok(s, { size: "custom", w: 1, h: 1, x: 13.5, y: 9 })), go(14.5, 9)), null, "into the T's stem");
    // A Large creature's core swept east just south of the corner: 1/64 cell clear of it passes, touching it does not.
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 6, y: 9.5 })), go(14, 9.5)), null);
    assert.equal(legStop(s, ownWalk(tok(s, { size: "large", x: 6, y: 9 + 31 / 64 })), go(14, 9 + 31 / 64))?.blocker, "wall");
  });

  test("movement.ts calls nothing that engines may round differently", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./movement.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.equal(source.match(/Math\.(atan2|sin|cos|sqrt|hypot|pow|exp)\b|\*\*/), null);
  });
});
