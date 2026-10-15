import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type BuildChunk } from "#shared/model.ts";
import { coverageCacheKey, defaultIncludeOrigin, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { scene } from "#shared/testutil.ts";
import { cachedCoverage, contextFrom } from "./coverage.ts";

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
