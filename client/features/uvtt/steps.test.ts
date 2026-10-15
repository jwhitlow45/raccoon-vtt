import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImportOptions } from "./convert.ts";
import { GRID_PROBLEM, MAX_POLYLINES, NOT_UVTT } from "./limits.ts";
import { readUvtt, type UvttMap } from "./schema.ts";
import { checkFile, planScene } from "./steps.ts";
import { uvttFile, type FileInput } from "./synthetic.ts";

const p = (x: number, y: number) => ({ x, y });
const OPTIONS: ImportOptions = { objects: true, portals: "window", feetPerCell: 5 };

function mapOf(input: FileInput): UvttMap {
  const read = readUvtt(uvttFile(input));
  assert.ok(read.ok, read.ok ? "" : read.error);
  return read.map;
}

describe("what the worker checks, by what the import makes", () => {
  test("a new scene is refused past 200 squares, and a phase takes the same file's image", () => {
    const file = uvttFile({ size: p(201, 20) });
    assert.deepEqual(checkFile(file, "scene"), { ok: false, error: "This map is 201 squares wide. Scenes can be at most 200." });
    const phase = checkFile(file, "phase");
    assert.ok(phase.ok, phase.ok ? "" : phase.error);
    assert.equal(phase.map.image, file.image);
  });

  test("walls far outside the map refuse a new scene, not a phase", () => {
    const file = uvttFile({ size: p(10, 10), walls: [[p(0, 0), p(40, 0)]], lights: [{ at: p(-30, 2), range: 4 }] });
    assert.deepEqual(checkFile(file, "scene"), { ok: false, error: "This file has walls, doors or lights far outside its map." });
    assert.equal(checkFile(file, "phase").ok, true);
  });

  test("a phase still needs a Universal VTT file within the counts", () => {
    assert.deepEqual(checkFile({ hello: "world" }, "phase"), { ok: false, error: NOT_UVTT });
    const many = uvttFile({ walls: Array.from({ length: MAX_POLYLINES + 1 }, () => [p(0, 0), p(1, 0)]) });
    assert.equal(checkFile(many, "phase").ok, false);
  });
});

describe("the grid, before the upload", () => {
  test("a grid finer than a pixel per cell or coarser than 16,384 is refused on the summary sheet", () => {
    const asIs = { kind: "as-is" } as const;
    const fine = planScene(mapOf({ size: p(20, 20), ppg: 0.5 }), OPTIONS, { width: 10, height: 10, plan: asIs });
    assert.deepEqual(fine, { plan: null, problem: GRID_PROBLEM });
    const coarse = planScene(mapOf({ size: p(2, 2), ppg: 20_000 }), OPTIONS, { width: 8000, height: 8000, plan: asIs });
    assert.deepEqual(coarse, { plan: null, problem: GRID_PROBLEM });
    const fits = planScene(mapOf({ size: p(20, 20), ppg: 70 }), OPTIONS, { width: 1400, height: 1400, plan: asIs });
    assert.equal(fits.problem, null);
    assert.equal(fits.plan?.pixelsPerGrid, 70);
  });

  test("the cell is measured at the size the upload keeps: a resize shrinks it", () => {
    // 2 file pixels per square on a 30,000 px image: 0.55 px once drawn down to 8,192.
    const map = mapOf({ size: p(15, 1), ppg: 2 });
    const resized = planScene(map, OPTIONS, { width: 30_000, height: 2, plan: { kind: "resize", width: 8192, height: 1 } });
    assert.deepEqual(resized, { plan: null, problem: GRID_PROBLEM });
    assert.equal(planScene(map, OPTIONS, { width: 30_000, height: 2, plan: { kind: "as-is" } }).problem, null);
  });

  test("a map the conversion refuses keeps the conversion's sentence", () => {
    const wide = { ...mapOf({ size: p(20, 20) }), size: p(250, 20) };
    assert.deepEqual(planScene(wide, OPTIONS, { width: 1400, height: 1400, plan: { kind: "as-is" } }), {
      plan: null,
      problem: "This map is 250 squares wide. Scenes can be at most 200.",
    });
  });
});
