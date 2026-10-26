import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type BuildChunk } from "#shared/model.ts";
import { computeCoverage, coverageCacheKey, creaturesInArea, defaultIncludeOrigin, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { placedOnHex } from "#shared/rules/footprint.ts";
import { sceneGrid, SQUARES } from "#shared/rules/grid.ts";
import { cornerAt, hexCorners, type HexGrid } from "#shared/rules/hex.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { areaContext, cachedCoverage, caughtTokens, contextFrom } from "./coverage.ts";

describe("area coverage follows the scene's walls", () => {
  // A water channel running east out of a stone room: under "all" it is walled from the unpainted ground beside it, under "floor" it is not.
  const cells: BuildChunk["cells"] = { "2,2": "stone", "2,3": "stone", "3,2": "stone", "3,3": "stone", "4,2": "water", "5,2": "water" };
  const buildChunks: Record<string, BuildChunk> = { c: { sceneId: "cov", cx: 0, cy: 0, rev: 1, cells, edges: {} } };
  const fireball: AreaTemplateInput = { id: "f", rev: 1, shape: "sphere", size: 10, origin: { x: 5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: defaultIncludeOrigin("sphere") };
  const inputs = { tokens: {}, buildChunks, settings: DEFAULT_SETTINGS };
  const covers = (autoWalls: "all" | "floor", x: number, y: number) =>
    cachedCoverage(fireball, contextFrom(inputs, scene("cov", { autoWalls }))).cells.some((c) => c.x === x && c.y === y);

  test("changing automatic walls, and changing it back, refreshes the cached shading", () => {
    const all = contextFrom(inputs, scene("cov", { autoWalls: "all" }));
    const floor = contextFrom(inputs, scene("cov", { autoWalls: "floor" }));
    assert.notEqual(all.walls?.version, floor.walls?.version);
    assert.notEqual(coverageCacheKey(fireball, all), coverageCacheKey(fireball, floor));
    // The ground north of the channel is behind its wall under "all" and open under "floor".
    assert.ok(!covers("all", 5, 1));
    assert.ok(covers("floor", 5, 1));
    assert.ok(!covers("all", 5, 1), "an undo back to 'all' brings the wall back");
    assert.equal(contextFrom(inputs, scene("cov", { autoWalls: "all" })).walls, all.walls);
  });

  test("the same walls version number over different chunks never serves the old shading", () => {
    const before = contextFrom(inputs, scene("cov", { autoWalls: "floor", wallsVersion: 4 }));
    const sealed = { c: { ...buildChunks.c!, edges: { "5,2,n": { kind: "wall" as const } } } };
    const after = contextFrom({ ...inputs, buildChunks: sealed }, scene("cov", { autoWalls: "floor", wallsVersion: 4 }));
    assert.notEqual(coverageCacheKey(fireball, before), coverageCacheKey(fireball, after));
    assert.ok(!cachedCoverage(fireball, after).cells.some((c) => c.x === 5 && c.y === 1));
  });
});

describe("areas on a hex scene draw what the rules return (docs/design-v1-hex-grids.md HX-D11)", () => {
  for (const orient of ["rows", "columns"] as const) {
    test(`${orient}: the client's context reads the scene's grid, so its shading and who it catches are the rules' own hexes`, async () => {
      const g: HexGrid = { shape: "hex", orient };
      const goblin = token("g1", { ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 9, row: 9 }) });
      const ogre = token("o1", { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 12, row: 9 }) });
      const state = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 30 }, gridShape: orient === "rows" ? "hexRows" : "hexColumns" }) }, tokens: { g1: goblin, o1: ogre } });
      const ctx = areaContext(state, state.scenes.s1!);
      assert.deepEqual(ctx.grid, g);
      // A 20 ft fireball on a hex corner between the two.
      const corner = cornerAt(g, { hex: { col: 10, row: 9 }, k: 1 });
      const fireball = { id: "f", rev: 1, sceneId: "s1", shape: "sphere" as const, size: 20, origin: { ...corner, z: 0 }, yaw: 0, includeOrigin: true };
      const cov = cachedCoverage(fireball, ctx);
      const rules = computeCoverage(fireball, { ...ctx, grid: sceneGrid(state.scenes.s1!) });
      assert.deepEqual(cov.hexes, rules.hexes, "the same hexes the rules grade");
      assert.equal(cov.cells.length, 0, "and no square cells");
      assert.deepEqual(caughtTokens(fireball, ctx, "s1").sort(), creaturesInArea(fireball, Object.values(state.tokens), { ...ctx, grid: g }).sort());
      // The board shades each covered hex as one closed hexagon round its own center.
      await import("../../components/testing/register.ts");
      const { shadeHexes, shadedPieces } = await import("./draw.tsx");
      const pieces = shadedPieces(cov, sceneGrid(state.scenes.s1!));
      assert.ok("hexes" in pieces && pieces.hexes === cov.hexes, "a hex scene shades the rules' hexes");
      assert.ok("cells" in shadedPieces(cov, SQUARES), "and squares their cells");
      const polys: { x: number; y: number }[][] = [];
      shadeHexes(g, pieces.hexes, { moveTo: (x, y) => polys.push([{ x, y }]), lineTo: (x, y) => polys[polys.length - 1]!.push({ x, y }), closePath: () => {} });
      assert.equal(polys.length, cov.hexes!.length);
      for (const [i, poly] of polys.entries()) {
        const h = cov.hexes![i]!;
        const corners = hexCorners(g, h).map((k) => cornerAt(g, k));
        assert.equal(poly.length, 6);
        for (const p of poly) assert.ok(corners.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 1 / 64), `${h.col},${h.row}: ${p.x},${p.y} is one of its corners`);
      }
    });
  }
});
