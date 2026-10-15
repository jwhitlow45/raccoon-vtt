import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { areaCells, heightOps, paintCells, stairOps } from "./ops.ts";

const flat = () => 0;

describe("height ops", () => {
  test("paints only cells not already at the height", () => {
    const ground = (x: number) => (x === 1 ? 10 : 0);
    assert.deepEqual(heightOps("s1", ["0,0", "1,0", "2,0"], 10, ground), [{ t: "build.height", sceneId: "s1", cells: ["0,0", "2,0"], height: 10 }]);
  });

  test("a stroke over ground already at the height sends nothing", () => {
    assert.deepEqual(heightOps("s1", ["0,0"], 0, flat), []);
  });

  test("splits into ops of at most 2,000 cells, each one the protocol takes", () => {
    const cells = areaCells({ x: 0, y: 0 }, { x: 99, y: 44 }, { w: 200, h: 200 });
    assert.equal(cells.length, 4500);
    const ops = heightOps("s1", cells, -20, flat);
    assert.deepEqual(
      ops.map((op) => (op.t === "build.height" ? op.cells.length : 0)),
      [2000, 2000, 500],
    );
    for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("an area keeps to the scene, both corners included, whichever way it was dragged", () => {
    assert.deepEqual(areaCells({ x: 3.7, y: 1.2 }, { x: 2.1, y: 0.4 }, { w: 10, h: 10 }), ["2,0", "3,0", "2,1", "3,1"]);
    assert.deepEqual(areaCells({ x: -3, y: -3 }, { x: 0.5, y: 0.5 }, { w: 10, h: 10 }), ["0,0"]);
    assert.deepEqual(areaCells({ x: 12, y: 12 }, { x: 15, y: 15 }, { w: 10, h: 10 }), []);
  });
});

describe("stair ops", () => {
  test("marks cells that do not already carry the mark", () => {
    const mark = (x: number) => (x === 0 ? "a" : ".");
    assert.deepEqual(stairOps("s1", ["0,0", "1,0"], "a", mark), [{ t: "build.stairs", sceneId: "s1", cells: ["1,0"], up: "a" }]);
    assert.deepEqual(stairOps("s1", ["0,0", "1,0"], "n", mark), [{ t: "build.stairs", sceneId: "s1", cells: ["0,0", "1,0"], up: "n" }]);
  });

  test("remove takes marks away with null, and only where there are marks", () => {
    const mark = (x: number) => (x === 0 ? "e" : ".");
    const ops = stairOps("s1", ["0,0", "1,0"], "remove", mark);
    assert.deepEqual(ops, [{ t: "build.stairs", sceneId: "s1", cells: ["0,0"], up: null }]);
    assert.ok(clientOpSchema.safeParse(ops[0]).success);
  });
});

describe("reading the view", () => {
  function view(): RoomState {
    const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
    feet[0] = 10;
    const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet)!, up: "n" + ".".repeat(255) };
    return { buildChunks: { "s1:0,0": chunk } } as unknown as RoomState;
  }

  test("heights compare against the painted ground", () => {
    assert.deepEqual(paintCells(view(), "s1", ["0,0", "1,0"], { paint: "height", height: 10, stairs: "a" }), [{ t: "build.height", sceneId: "s1", cells: ["1,0"], height: 10 }]);
  });

  test("stairs compare against the stored marks", () => {
    assert.deepEqual(paintCells(view(), "s1", ["0,0", "1,0"], { paint: "stairs", height: 10, stairs: "n" }), [{ t: "build.stairs", sceneId: "s1", cells: ["1,0"], up: "n" }]);
  });

  test("with no view yet, every cell is flat and unmarked", () => {
    assert.deepEqual(paintCells(null, "s1", ["0,0"], { paint: "height", height: 0, stairs: "a" }), []);
  });
});
