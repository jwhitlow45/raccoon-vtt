import assert from "node:assert/strict";
import { test } from "node:test";
import { visionRules } from "../shared/ruleHooks.ts";

/*
 * The server bench times holders' rasters through a wrapper on the vision
 * hook, which only its run puts in place (review PV2-BENCH-PROXY): a file
 * that imports the bench keeps the hook every other module reads.
 */

test("importing the server bench leaves the holder sight hook as it was", async () => {
  const before = visionRules.holderSight;
  await import("./bench-server4.ts");
  assert.equal(visionRules.holderSight, before);
});

const REVISION = "3113e75800000000000000000000000000000000";

test("benchmark provenance requires a complete commit id when supplied", async () => {
  const { benchRevision } = await import("./bench-server4.ts");
  assert.equal(benchRevision([]), undefined);
  assert.equal(benchRevision(["--revision", REVISION]), REVISION);
  for (const args of [["--revision"], ["--revision", "3113e758"], ["--revision", "main"], ["--revision", REVISION, "--revision", REVISION]]) assert.throws(() => benchRevision(args), /full 40-character commit id/);
});

test("each discovery row keeps its target and its whole-party or per-player result under the documented machine scaling", async () => {
  const { formatServerBench } = await import("./bench-server4.ts");
  const rows = [
    { row: "build, whole party", budget: 25, ms: { median: 16.6, max: 80 }, covers: "paint" },
    { row: "build, per player", budget: 25, ms: { median: 16.7, max: 30 }, covers: "paint" },
    { row: "routed walk, per player", budget: 30, ms: { median: 20, max: 25 }, covers: "walk" },
    { row: "fan-out, whole party", budget: 10, ms: { median: 7, max: 9 }, covers: "fan-out" },
    { row: "global, whole party", budget: 250, ms: { median: 167, max: 190 }, covers: "global" },
    { row: "ask turn, per player", budget: 25, ms: { median: 34, max: 40 }, covers: "ask" },
    { row: "near twice, whole party", budget: 25, ms: { median: 100 / 3 + 0.0001, max: 40 }, covers: "paint" },
    { row: "ask answer, per player", budget: 5_000, ms: { median: 3_000, max: 6_000 }, covers: "ask" },
  ];
  const laptop = formatServerBench(rows, false, REVISION);
  assert.ok(laptop.includes(`Revision: ${REVISION}`));
  assert.ok(laptop.includes("laptop measurement, server budgets divided by 1.5"));
  assert.ok(laptop.includes("build, whole party | 16.6 / 80.0 | 25 | 16.7 | 1.00 | yes"));
  assert.ok(laptop.includes("build, per player | 16.7 / 30.0 | 25 | 16.7 | 1.00 | NO"), "the rounded displayed limit must not loosen the comparison");
  assert.ok(laptop.includes("routed walk, per player | 20.0 / 25.0 | 30 | 20.0 | 1.00 | yes"));
  assert.ok(laptop.includes("fan-out, whole party | 7.0 / 9.0 | 10 | 6.7 | 1.05 | NO"));
  assert.ok(laptop.includes("global, whole party | 167.0 / 190.0 | 250 | 166.7 | 1.00 | NO"));
  assert.ok(laptop.includes("ask turn, per player | 34.0 / 40.0 | 25 | 16.7 | 2.04 | NO"), "deploy's two-times condition can be read without changing the target");
  assert.ok(laptop.includes("ask answer, per player | 3000.0 / 6000.0 | 5000 | 3333.3 | 0.90 | yes"));
  assert.ok(laptop.includes("near twice, whole party | 33.3 / 40.0 | 25 | 16.7 | 2.00 | NO | yes"), "rounded timing and ratios must not hide a result above twice the limit");
  const server = formatServerBench(rows, true, REVISION);
  assert.ok(server.includes("server-box measurement, unscaled server budgets"));
  assert.ok(server.includes("build, per player | 16.7 / 30.0 | 25 | 25.0 | 0.67 | yes"));
  assert.ok(server.includes("ask turn, per player | 34.0 / 40.0 | 25 | 25.0 | 1.36 | NO"));
  assert.ok(formatServerBench([], false).includes("Revision: unrecorded"), "a legacy invocation must not claim commit provenance");
});

test("both ask fixtures are unexplored Explore scenes, including every per-player layer", async () => {
  const { askBenchRoom } = await import("./bench-server4.ts");
  for (const perPlayer of [false, true]) {
    const room = askBenchRoom(perPlayer);
    const scene = room.scenes.bench!;
    assert.equal(scene.fogEnabled, true);
    assert.equal(scene.vision?.on, true);
    assert.equal(scene.vision?.perPlayer === true, perPlayer);
    if (perPlayer) assert.equal(room.holders.bench!.entries.filter((e) => e.on).length, 6);
    for (const layer of [room.fogTiles, room.exploredTiles, room.exploredBy, room.memory, room.memoryBy, room.buildChunks]) assert.deepEqual(layer, {}, "a pre-explored layer would skip the ask's worst-case work");
  }
});
