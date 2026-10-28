import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, StairDirection } from "#shared/model.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { cornerAt, hexCenter, hexCorners, hexKey, hexNeighbors, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, env, room, scene } from "#shared/testutil.ts";
import { HEX_LIMITS } from "../../grid/words.ts";
import { hexEraseOps } from "../hexBuild.ts";
import { hexFacingName, stairChoiceOn, stairChoiceValues } from "./facings.ts";
import { readoutOf, seenGround } from "./ground.ts";
import { heightHint } from "./hint.ts";
import { paintCells } from "./ops.ts";
import { heightRegions } from "./regions.ts";
import { reliefPaths, stairCells, stairPaths } from "./relief.ts";

/**
 * Height mode on a hex scene (docs/design-v1-hex-grids.md H3): six facings
 * in words and arrows, painting by hex keys, the relief drawn along hex
 * sides, a stair's symbol turned to its facing, the regions' numbers on hex
 * centers, and the readout's words.
 */

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
  /** Each moveTo and its lineTo as one line. */
  lines(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i + 1 < this.ops.length; i += 2) out.push([...(this.ops[i]!.slice(1) as number[]), ...(this.ops[i + 1]!.slice(1) as number[])]);
    return out;
  }
}
const make = () => new Recorder();

let seq = 1;
function painted(g: HexGrid, heights: [Hex, number][], stairs: [Hex, StairDirection][] = []): RoomState {
  let s = room({ scenes: { s1: scene("s1", { gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", bounds: { w: 20, h: 14 } }) } });
  const run = (op: Op) => {
    const r = applyOp(s, opSchema.parse(op), DM, env(seq++));
    assert.ok(r.ok, r.ok ? "" : r.message);
    s = r.state;
  };
  for (const [h, height] of heights) run({ t: "build.height", sceneId: "s1", cells: [hexKey(h)], height });
  for (const [h, up] of stairs) run({ t: "build.stairs", sceneId: "s1", cells: [hexKey(h)], up });
  return s;
}

const chunksOf = (s: RoomState) => Object.values(s.buildChunks);

for (const g of [gridOfShape("hexRows") as HexGrid, gridOfShape("hexColumns") as HexGrid]) {
  const H: Hex = { col: 6, row: 6 };
  describe(`${g.orient}: Height mode on hexes`, () => {
    test("the stairs choices are Auto, six facings and Remove, and a compass choice reads as Auto here", () => {
      assert.deepEqual(stairChoiceValues(g), ["a", "0", "1", "2", "3", "4", "5", "remove"]);
      assert.equal(stairChoiceOn(g, "n"), "a");
      assert.equal(stairChoiceOn(g, "4"), "4");
      assert.equal(stairChoiceOn(gridOfShape(undefined), "4"), "a");
      assert.equal(hexFacingName(g.orient, 0), g.orient === "rows" ? "east" : "south");
      assert.equal(hexFacingName(g.orient, 2), g.orient === "rows" ? "south-west" : "north-east");
    });

    test("a gesture's hex keys paint heights and stairs, leaving out what already looks so", () => {
      const s = painted(g, [[H, 10]]);
      assert.deepEqual(paintCells(s, "s1", ["6,6", "7,6"], { paint: "height", height: 10, stairs: "a" }), [{ t: "build.height", sceneId: "s1", cells: ["7,6"], height: 10 }]);
      assert.deepEqual(paintCells(s, "s1", ["7,6"], { paint: "stairs", height: 10, stairs: "3" }), [{ t: "build.stairs", sceneId: "s1", cells: ["7,6"], up: "3" }]);
      // Erase goes for a hex holding only a height or a stair, which the reducer clears with it.
      const marked = painted(g, [[H, 10]], [[{ col: 9, row: 6 }, "2"]]);
      assert.deepEqual(hexEraseOps(marked, g, "s1", ["6,6", "8,6", "9,6"]), [{ t: "build.erase", sceneId: "s1", cells: ["6,6", "9,6"] }]);
    });

    test("the relief washes each raised hex, rims the sides facing the light, darkens the far ones, and skips a stair's way up", () => {
      const s = painted(g, [[H, 10]]);
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      const r = reliefPaths(chunksOf(s), walls, s.scenes.s1!.bounds, make, g);
      assert.equal(r.tints.length, 1);
      assert.equal(r.tints[0]!.path.ops.filter((o) => o[0] === "Z").length, 1, "one hexagon");
      assert.equal(r.rims.lines().length + r.ledges.lines().length, 6);
      assert.equal(r.rims.lines().length, 3, "the three sides facing up and left");
      const cs = hexCorners(g, H).map((c) => cornerAt(g, c));
      for (const [ax, ay, bx, by] of [...r.rims.lines(), ...r.ledges.lines()]) {
        assert.ok(cs.some((p) => p.x === ax && p.y === ay) && cs.some((p) => p.x === bx && p.y === by), "along the hex's own sides");
      }
      for (const [ax, ay, bx, by] of r.rims.lines()) assert.ok((ax! + bx!) / 2 + (ay! + by!) / 2 < hexCenter(g, H).x + hexCenter(g, H).y, "up and to the left of the middle");
      assert.ok(r.shadows.every((p) => p.ops.filter((o) => o[0] === "Z").length === 3), "a shadow off each far side");
      const below = hexNeighbors(g, H)[3]!;
      const stair = painted(g, [[H, 10]], [[below, "0"]]);
      const linked = reliefPaths(chunksOf(stair), sceneWalls(stair.scenes.s1!, stair.buildChunks), stair.scenes.s1!.bounds, make, g);
      assert.equal(linked.rims.lines().length + linked.ledges.lines().length, 5, "the stair's way up draws no edge");
    });

    test("a stair's symbol sits in its hexagon, its chevron toward the side it faces", () => {
      const s = painted(g, [], [[H, "1"]]);
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      const cells = stairCells(chunksOf(s), walls);
      assert.deepEqual(cells.map((c) => [c.x, c.y, c.dir]), [[6, 6, "1"]]);
      const paths = stairPaths(cells, make, g);
      const c = hexCenter(g, H);
      const up = hexCenter(g, hexNeighbors(g, H)[1]!);
      const tip = paths.chevrons.ops[1]!.slice(1) as number[];
      const along = (tip[0]! - c.x) * (up.x - c.x) + (tip[1]! - c.y) * (up.y - c.y);
      assert.ok(along > 0.2, "the chevron's tip lies toward the up side");
      for (const op of paths.treads.flatMap((p) => p.ops).filter((o) => o[0] !== "Z")) {
        const [x, y] = op.slice(1) as number[];
        assert.ok(Math.hypot(x! - c.x, y! - c.y) < 0.5, "inside the hexagon's flats");
      }
    });

    test("a region's number goes on a hex center, and touching hexes across any side are one region", () => {
      const s = painted(g, [[H, 10], [hexNeighbors(g, H)[1]!, 10], [{ col: 12, row: 3 }, 10]]);
      const regions = heightRegions(chunksOf(s), s.scenes.s1!.bounds, g);
      assert.deepEqual(regions.map((r) => r.size), [2, 1]);
      const spot = regions[1]!.spots[0]!;
      const center = hexCenter(g, { col: 12, row: 3 });
      assert.deepEqual([spot.x, spot.y], [center.x, center.y]);
    });

    test("the readout names a hex stair's facing, and reads a hex's ground by its key", () => {
      const s = painted(g, [[H, 10]]);
      assert.equal(seenGround({ chunks: s.buildChunks, sceneId: "s1", bounds: s.scenes.s1!.bounds, grid: g, fog: null }, { x: 6, y: 6 }), 10);
      assert.equal(readoutOf(5, "1", g)?.spoken, "Stairs, 5 ft up, up to the south-east.");
      assert.equal(readoutOf(0, "2", g)?.spoken, `Stairs, up to the ${g.orient === "rows" ? "south-west" : "north-east"}.`);
    });

    test("the hint and the builder's line on hexes", () => {
      const hint = heightHint({ paint: "stairs", shape: 1, stairs: "a", height: 10 }, "all", g);
      assert.equal(hint, "Drag to mark stairs. Auto points them uphill. Use an arrow where a ? shows.", "no walls toward unpainted squares on hexes");
      assert.equal(HEX_LIMITS.builder, "On hexes the builder draws wall lines, paints heights and stairs, marks difficult ground, and places lights, stamps and labels. Painted ground needs squares.");
    });
  });
}
