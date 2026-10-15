import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DIFFICULTIES, MAX_LEVEL, MIN_LEVEL, XP_BUDGET } from "./xp-budget.ts";

describe("XP Budget per Character", () => {
  test("has one row per level, 1 to 20, in order", () => {
    assert.deepEqual(
      XP_BUDGET.map((r) => r.level),
      Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) => i + MIN_LEVEL),
    );
    for (const row of XP_BUDGET) assert.deepEqual(Object.keys(row).sort(), ["high", "level", "low", "moderate"]);
  });

  test("every budget grows with the difficulty and with the level", () => {
    XP_BUDGET.forEach((row, i) => {
      assert.ok(row.low < row.moderate && row.moderate < row.high, `level ${row.level}`);
      const prev = XP_BUDGET[i - 1];
      if (prev) for (const d of DIFFICULTIES) assert.ok(prev[d] < row[d], `level ${row.level} ${d}`);
    });
  });

  test("matches the SRD's worked examples: 50 × 4, 225 × 5 and 7,800 × 6", () => {
    assert.equal(XP_BUDGET[0]?.low, 50);
    assert.equal(XP_BUDGET[2]?.moderate, 225);
    assert.equal(XP_BUDGET[14]?.high, 7_800);
  });
});
