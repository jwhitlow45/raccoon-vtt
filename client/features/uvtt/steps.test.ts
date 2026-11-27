import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImportOptions } from "./convert.ts";
import { GRID_PROBLEM, MAX_POLYLINES, NOT_UVTT } from "./limits.ts";
import { readUvtt, type UvttMap } from "./schema.ts";
import { checkExport, checkFile, planScene } from "./steps.ts";
import { chunksOf, door, WALL, WINDOW, type BuildInput } from "./exportTestutil.ts";
import { uvttGeometry } from "./write.ts";
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
    assert.deepEqual(checkFile(file, "scene"), { ok: false, error: "This file has walls or doors far outside its map." });
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

describe("the export's import check", () => {
  const head = (build: BuildInput, bounds = { w: 20, h: 20 }) => uvttGeometry({ scene: { bounds }, chunks: chunksOf(build), rule: "off", lights: [], feetPerCell: 5, pxPerCell: 70 }, "dm").json;

  test("a grid wall run of three squares imports as three unit edges, with no note", () => {
    assert.deepEqual(checkExport(head({ edges: { "1,2,n": WALL, "2,2,n": WALL, "3,2,n": WALL } }), 5), { changes: false, portalCut: false });
  });

  test("a free wall, door or window along a grid line between intersections imports as grid edges, with no note", () => {
    const walls: BuildInput["walls"] = [
      { a: [1, 6], b: [4, 6], f: WALL },
      { a: [6, 2], b: [6, 3], f: door() },
      { a: [8, 4], b: [9, 4], f: WINDOW },
    ];
    assert.deepEqual(checkExport(head({ walls }), 5), { changes: false, portalCut: false });
  });

  test("a door very close to a wall cuts it on import: the file is still checked, with the note's flag", () => {
    const walls: BuildInput["walls"] = [
      { a: [1.5, 1.5], b: [4.5, 1.5], f: WALL },
      { a: [2.5, 1.59375], b: [3.5, 1.59375], f: door() },
    ];
    assert.deepEqual(checkExport(head({ walls }), 5), { changes: true, portalCut: true });
  });

  test("two doors a 64th apart weld into one on import: within the cover, but a door is lost, so the note's flag", () => {
    const walls: BuildInput["walls"] = [
      { a: [2.25, 2.25], b: [3.25, 2.25], f: door() },
      { a: [2.25, 2.265625], b: [3.25, 2.265625], f: door() },
    ];
    assert.deepEqual(checkExport(head({ walls }), 5), { changes: true, portalCut: false });
  });

  test("a wall pinned to the grid changes with no door to blame: the flag, without the portal cut (UVTT-O-2)", () => {
    // Ends within a tenth of the intersections (1, 4) and (4, 4), which the import pins onto them.
    const walls: BuildInput["walls"] = [{ a: [1 + 3 / 64, 4 + 2 / 64], b: [4 - 3 / 64, 4 + 1 / 64], f: WALL }];
    assert.deepEqual(checkExport(head({ walls }), 5), { changes: true, portalCut: false });
  });

  test("20,001 separate grid walls: the schema's count refuses, before any conversion", () => {
    const edges: Record<string, typeof WALL> = {};
    let n = 0;
    for (let y = 0; y <= 200 && n < 20_001; y++) for (let x = 0; x < 200 && n < 20_001; x += 2, n++) edges[`${x},${y},n`] = WALL;
    assert.deepEqual(checkExport(head({ edges }, { w: 200, h: 200 }), 5), { refused: "This file has 20,001 wall lines. An import takes at most 20,000." });
  });

  test("900 pillars and 500 free walls: the conversion refuses past a scene's 4,000 free walls", () => {
    const cells: Record<string, "pillar"> = {};
    for (let i = 0; i < 900; i++) cells[`${(i % 60) * 2},${Math.floor(i / 60) * 2}`] = "pillar";
    const walls: BuildInput["walls"] = Array.from({ length: 500 }, (_, i) => ({ a: [130 + (i % 25) * 2 + 0.25, 2 + Math.floor(i / 25) * 2 + 0.25] as [number, number], b: [131 + (i % 25) * 2 + 0.5, 2 + Math.floor(i / 25) * 2 + 0.75] as [number, number], f: WALL }));
    const check = checkExport(head({ cells, walls }, { w: 200, h: 200 }), 5);
    assert.deepEqual(check, { refused: "This map has 4,100 walls off the grid even simplified, more than a scene holds (4,000)." });
  });
});
