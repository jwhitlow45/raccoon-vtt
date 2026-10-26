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
