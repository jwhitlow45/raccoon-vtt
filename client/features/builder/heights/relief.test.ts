import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type StairMark, type TerrainId } from "#shared/model.ts";
import { encodeHeights, type Compass } from "#shared/rules/heights.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { reliefPaths, shadowLength, stairCells, stairPaths, tintOf, TREADS, type ReliefSource } from "./relief.ts";

/** Records what a path is given, in place of a Path2D, which Node lacks. */
class Recorder {
  readonly ops: (string | number)[][] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(["M", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(["L", x, y]);
  }
  closePath(): void {
    this.ops.push(["Z"]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["R", x, y, w, h]);
  }
  rects(): number[][] {
    return this.ops.filter((o) => o[0] === "R").map((o) => (o.slice(1) as number[]).map(round));
  }
  /** Each moveTo and lineTo pair as one line, for paths of separate lines. */
  lines(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i + 1 < this.ops.length; i += 2) out.push([...(this.ops[i]!.slice(1) as number[]), ...(this.ops[i + 1]!.slice(1) as number[])].map(round));
    return out;
  }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const make = () => new Recorder();

/** One chunk at the origin with heights and stair marks set cell by cell. */
function chunk(opts: { heights?: Record<string, number>; marks?: Record<string, StairMark>; cells?: Record<string, TerrainId> }): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(opts.heights ?? {})) {
    const [x, y] = key.split(",").map(Number);
    feet[y! * CHUNK_CELLS + x!] = v;
  }
  const marks = new Array<string>(CHUNK_CELLS * CHUNK_CELLS).fill(".");
  for (const [key, m] of Object.entries(opts.marks ?? {})) {
    const [x, y] = key.split(",").map(Number);
    marks[y! * CHUNK_CELLS + x!] = m;
  }
  const out: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: opts.cells ?? {}, edges: {} };
  const heights = encodeHeights(feet);
  if (heights) out.heights = heights;
  if (marks.some((m) => m !== ".")) out.up = marks.join("");
  return out;
}

const BOUNDS = { w: 10, h: 10 };

function relief(c: BuildChunk, bounds: { w: number; h: number } | null = BOUNDS) {
  const walls = deriveWalls(indexBuild([c]), "test", { bounds: bounds ?? undefined });
  return reliefPaths<Recorder>([c], walls, bounds, make);
}

describe("raised areas", () => {
  test("a build without heights draws no relief", () => {
    const r = relief(chunk({ cells: { "1,1": "stone" } }));
    assert.deepEqual(r.tints, []);
    for (const band of r.shadows) assert.deepEqual(band.ops, []);
    assert.deepEqual(r.rims.ops, []);
    assert.deepEqual(r.ledges.ops, []);
  });

  test("higher ground is lighter and lower ground darker, 4% per 5 ft and at most 20%", () => {
    assert.equal(tintOf(5), "rgba(255, 255, 255, 0.04)");
    assert.equal(tintOf(10), "rgba(255, 255, 255, 0.08)");
    assert.equal(tintOf(-15), "rgba(0, 0, 0, 0.12)");
    assert.equal(tintOf(200), "rgba(255, 255, 255, 0.2)");
    assert.equal(tintOf(-100), "rgba(0, 0, 0, 0.2)");
  });

  test("each level is one path of merged rectangles", () => {
    const r = relief(chunk({ heights: { "2,2": 10, "3,2": 10, "2,3": 10, "3,3": 10, "6,6": -5 } }));
    assert.deepEqual(
      r.tints.map((t) => [t.color, t.path.rects()]),
      [
        ["rgba(0, 0, 0, 0.04)", [[6, 6, 1, 1]]],
        ["rgba(255, 255, 255, 0.08)", [[2, 2, 2, 2]]],
      ],
    );
  });

  test("a shadow falls 0.08 cell per 5 ft of difference, at most half a cell", () => {
    assert.equal(shadowLength(5), 0.08);
    assert.equal(round(shadowLength(10)), 0.16);
    assert.equal(shadowLength(40), 0.5);
    assert.equal(shadowLength(200), 0.5);
  });

  test("past 30 ft the look stays the same: the stepper's 100 ft tints and shades as 30 ft does", () => {
    assert.equal(tintOf(100), tintOf(30));
    assert.equal(shadowLength(100), 0.5);
  });

  test("a raised cell's shadow falls on its lower east, south and south-east neighbors, in bands that fade outward", () => {
    const r = relief(chunk({ heights: { "2,2": 10 } }));
    const e = 0.16;
    // The farthest band first: the whole length.
    assert.deepEqual(r.shadows[0]!.rects(), [
      [3, 2 + e, e, 1 - e],
      [2 + e, 3, 1 - e, e],
      [3, 3, e, e],
    ].map((v) => v.map(round)));
    // The nearest band reaches a third as far.
    const n = e / 3;
    assert.deepEqual(r.shadows[2]!.rects(), [
      [3, 2 + n, n, 1 - n],
      [2 + n, 3, 1 - n, n],
      [3, 3, n, n],
    ].map((v) => v.map(round)));
  });

  test("each lower neighbor gets the length of its own difference", () => {
    const r = relief(chunk({ heights: { "2,2": 20, "3,2": 10 } }));
    const far = r.shadows[0]!.rects();
    // East onto 10 ft: 10 ft of difference. South onto the ground: 20 ft.
    assert.ok(far.some((v) => v[0] === 3 && v[1] === round(2 + 0.16) && v[2] === 0.16));
    assert.ok(far.some((v) => v[0] === round(2 + 0.32) && v[1] === 3 && v[3] === 0.32));
  });

  test("a raised area's lit edges get a pale rim and its far edges a dark line, joined into runs", () => {
    const r = relief(chunk({ heights: { "2,2": 10, "3,2": 10 } }));
    assert.deepEqual(r.rims.lines().sort(), [
      [2, 2, 4, 2],
      [2, 2, 2, 3],
    ].sort());
    assert.deepEqual(r.ledges.lines().sort(), [
      [2, 3, 4, 3],
      [4, 2, 4, 3],
    ].sort());
  });

  test("a pit is dark on its north and west lips and pale on its south and east ones, with the shadow inside it", () => {
    const r = relief(chunk({ heights: { "4,4": -10 } }));
    assert.deepEqual(r.ledges.lines().sort(), [
      [4, 4, 5, 4],
      [4, 4, 4, 5],
    ].sort());
    assert.deepEqual(r.rims.lines().sort(), [
      [4, 5, 5, 5],
      [5, 4, 5, 5],
    ].sort());
    const e = 0.16;
    assert.deepEqual(r.shadows[0]!.rects().sort(), [
      // From the cell north-west, north and west of the pit.
      [4, 4, e, e],
      [4 + e, 4, 1 - e, e],
      [4, 4 + e, e, 1 - e],
    ].map((v) => v.map(round)).sort());
  });

  test("the edges a directed stair connects draw no rim or line", () => {
    // A platform at 10 ft with a stair below it pointing up north to it.
    const r = relief(chunk({ heights: { "2,2": 10 }, marks: { "2,3": "a" } }));
    const all = [...r.rims.lines(), ...r.ledges.lines()];
    assert.ok(!all.some(([ax, ay, bx, by]) => ay === 3 && by === 3 && ax! <= 2 && bx! >= 3), "no line across the top of the stair");
    // The platform's other edges still draw.
    assert.ok(r.rims.lines().length > 0);
  });

  test("heights outside the scene draw nothing", () => {
    const r = relief(chunk({ heights: { "12,2": 10 } }));
    assert.deepEqual(r.tints, []);
    assert.deepEqual(r.rims.ops, []);
    for (const band of r.shadows) assert.deepEqual(band.ops, []);
  });

  test("the scene's edge casts and takes no shadow beyond it", () => {
    const r = relief(chunk({ heights: { "9,9": 10 } }));
    for (const band of r.shadows) assert.deepEqual(band.ops, []);
    assert.deepEqual(r.ledges.ops, []);
  });
});

describe("stairs", () => {
  const fixed = (dir: Compass | null): ReliefSource => ({ stairAt: () => dir });

  test("Stairs terrain, marks on floor and marks over the art are each listed once", () => {
    const c = chunk({ cells: { "1,1": "stairs", "2,1": "stone" }, marks: { "1,1": "n", "2,1": "a", "5,5": "e" } });
    const walls = deriveWalls(indexBuild([c]), "test", { bounds: BOUNDS });
    assert.deepEqual(stairCells([c], walls), [
      { x: 1, y: 1, dir: "n", floor: true },
      { x: 2, y: 1, dir: null, floor: true },
      { x: 5, y: 5, dir: "e", floor: false },
    ]);
  });

  test("a stair points toward its one higher neighbor", () => {
    const c = chunk({ heights: { "4,2": 10 }, marks: { "3,2": "a" } });
    const walls = deriveWalls(indexBuild([c]), "test", { bounds: BOUNDS });
    assert.deepEqual(stairCells([c], walls), [{ x: 3, y: 2, dir: "e", floor: false }]);
  });

  test("a stair with no direction draws five lines across, as Stairs terrain always did", () => {
    const p = stairPaths([{ x: 1, y: 1, dir: null, floor: true }], make);
    assert.equal(p.steps.lines().length, 5);
    assert.deepEqual(p.steps.lines()[0], [1.14, 1.2, 1.86, 1.2]);
    for (const t of p.treads) assert.deepEqual(t.ops, []);
    assert.deepEqual(p.chevrons.ops, []);
  });

  /** The middle of a tread path's four corners. */
  function middle(path: Recorder): [number, number] {
    const pts = path.ops.filter((o) => o[0] === "M" || o[0] === "L").map((o) => [o[1] as number, o[2] as number]);
    return [pts.reduce((a, p) => a + p[0]!, 0) / pts.length, pts.reduce((a, p) => a + p[1]!, 0) / pts.length];
  }

  for (const [dir, ux, uy] of [
    ["n", 0, -1],
    ["e", 1, 0],
    ["s", 0, 1],
    ["w", -1, 0],
  ] as const) {
    test(`a stair pointing ${dir} climbs its treads that way, with the chevron at the high end`, () => {
      const p = stairPaths([{ x: 3, y: 3, dir, floor: false }], make);
      assert.equal(p.treads.length, TREADS);
      // Each tread lies further up than the one below it.
      const along = p.treads.map((t) => {
        const [mx, my] = middle(t);
        return (mx - 3.5) * ux + (my - 3.5) * uy;
      });
      for (let k = 1; k < along.length; k++) assert.ok(along[k]! > along[k - 1]!, `tread ${k} is above tread ${k - 1}`);
      // The chevron's tip is its middle point, and it lies further up than its arms.
      const pts = p.chevrons.ops.map((o) => [o[1] as number, o[2] as number]);
      const up = pts.map(([x, y]) => (x! - 3.5) * ux + (y! - 3.5) * uy);
      assert.ok(up[1]! > up[0]! && up[1]! > up[2]!);
      assert.ok(up[1]! > 0.35, "the chevron sits at the high end");
      assert.equal(p.risers.lines().length, TREADS - 1);
    });
  }

  test("every stair shape stays inside its cell", () => {
    for (const dir of ["n", "e", "s", "w"] as const) {
      const p = stairPaths([{ x: 7, y: 2, dir, floor: true }], make);
      for (const path of [...p.treads, p.risers, p.chevrons]) {
        for (const o of path.ops) {
          if (o[0] === "Z") continue;
          assert.ok((o[1] as number) > 7 && (o[1] as number) < 8 && (o[2] as number) > 2 && (o[2] as number) < 3, `${dir}: ${o}`);
        }
      }
    }
  });

  test("a fixed source's direction is used as given", () => {
    const c = chunk({ marks: { "1,1": "a" } });
    assert.equal(stairCells([c], fixed("w"))[0]!.dir, "w");
    assert.equal(stairCells([c], fixed(null))[0]!.dir, null);
  });
});
