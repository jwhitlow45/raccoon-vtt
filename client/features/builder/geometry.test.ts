import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, TerrainId } from "#shared/model.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { buildDrawing, mergeRects, swingSide, wallRuns, type CellRect } from "./geometry.ts";

function cellsOf(rects: CellRect[]): string[] {
  const out: string[] = [];
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
  return out.sort();
}

function grid(rows: string[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && out.push({ x, y })));
  return out;
}

function chunk(cells: Record<string, TerrainId>, edges: BuildChunk["edges"] = {}): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells, edges };
}

describe("terrain path merging", () => {
  test("a filled rectangle becomes one rectangle", () => {
    const cells = grid(["####", "####", "####"]);
    assert.deepEqual(mergeRects(cells), [{ x: 0, y: 0, w: 4, h: 3 }]);
  });

  test("rectangles cover the cells exactly, with no overlap", () => {
    const shapes = [
      ["##..", "##..", "####", "####"],
      ["#.#.", ".#.#", "#.#."],
      ["####", "#..#", "####"],
      ["..##", "####", "##..", "...#"],
    ];
    for (const rows of shapes) {
      const cells = grid(rows);
      const rects = mergeRects(cells);
      const covered = cellsOf(rects);
      assert.deepEqual(covered, cells.map((c) => `${c.x},${c.y}`).sort(), rows.join("|"));
      assert.equal(new Set(covered).size, covered.length);
    }
  });

  test("an L-shaped room needs two rectangles, not one per cell", () => {
    const rects = mergeRects(grid(["##...", "##...", "#####", "#####"]));
    assert.equal(rects.length, 2);
  });

  test("a large room stays a handful of rectangles however many cells it has", () => {
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) cells.push({ x, y });
    assert.equal(mergeRects(cells).length, 1);
  });

  test("cells group into one path per texture, and symbols sit on a stone floor", () => {
    const drawing = buildDrawing([
      chunk({ "0,0": "stone", "1,0": "stone", "2,0": "wood", "0,1": "pit", "1,1": "pillar", "2,1": "stairs", "3,3": "water" }),
    ]);
    assert.deepEqual([...drawing.floors.keys()].sort(), ["stone", "water", "wood"]);
    assert.deepEqual(cellsOf(drawing.floors.get("stone")!), ["0,0", "0,1", "1,0", "1,1", "2,1"]);
    assert.deepEqual(drawing.symbols.pit, [{ x: 0, y: 1 }]);
    assert.deepEqual(drawing.symbols.pillar, [{ x: 1, y: 1 }]);
    assert.deepEqual(drawing.symbols.stairs, [{ x: 2, y: 1 }]);
    assert.equal(drawing.count, 7);
    // The whole floor merges across terrains, for the base fill and grid.
    assert.equal(cellsOf(drawing.all).length, 7);
  });

  test("malformed cell keys are dropped", () => {
    const drawing = buildDrawing([chunk({ "1,1": "stone", nonsense: "stone", "2,x": "wood" })]);
    assert.equal(drawing.count, 1);
  });
});

describe("wall runs", () => {
  test("a room's walls join into four straight runs", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 2; y < 5; y++) for (let x = 3; x < 7; x++) cells[`${x},${y}`] = "stone";
    const walls = deriveWalls(indexBuild([chunk(cells)]), 1);
    const runs = wallRuns(walls.edges, (e) => e.feature.kind === "wall");
    assert.equal(runs.length, 4 * 4);
    const segments: string[] = [];
    for (let i = 0; i < runs.length; i += 4) segments.push(runs.slice(i, i + 4).join(","));
    assert.deepEqual(segments.sort(), ["3,2,7,2", "3,2,3,5", "3,5,7,5", "7,2,7,5"].sort());
  });

  test("a door splits a wall run around its gap", () => {
    const cells: Record<string, TerrainId> = {};
    for (let x = 0; x < 5; x++) cells[`${x},0`] = "stone";
    const door = { kind: "door" as const, state: "closed" as const, secret: false, discovered: false };
    const walls = deriveWalls(indexBuild([chunk(cells, { "2,0,n": door })]), 1);
    const runs = wallRuns(walls.edges, (e) => e.feature.kind === "wall");
    const segments: string[] = [];
    for (let i = 0; i < runs.length; i += 4) segments.push(runs.slice(i, i + 4).join(","));
    assert.ok(segments.includes("0,0,2,0"));
    assert.ok(segments.includes("3,0,5,0"));
  });
});

describe("open doors", () => {
  test("swing into floor, never into rock", () => {
    // A room on rows 2 to 4: its north wall at y = 2, its south wall at y = 5, its west wall at x = 1.
    const floor = new Set(grid(["", "", ".####", ".####", ".####"]).map((c) => `${c.x},${c.y}`));
    const isFloor = (x: number, y: number) => floor.has(`${x},${y}`);
    assert.equal(swingSide({ x: 2, y: 2, side: "n" }, isFloor), 1);
    assert.equal(swingSide({ x: 2, y: 5, side: "n" }, isFloor), -1);
    assert.equal(swingSide({ x: 1, y: 3, side: "w" }, isFloor), 1);
    assert.equal(swingSide({ x: 5, y: 3, side: "w" }, isFloor), -1);
    // Between two floors, or in the rock, a door keeps to the south or east.
    assert.equal(swingSide({ x: 3, y: 3, side: "n" }, isFloor), 1);
    assert.equal(swingSide({ x: 9, y: 9, side: "w" }, isFloor), 1);
  });
});

