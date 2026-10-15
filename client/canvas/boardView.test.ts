import assert from "node:assert/strict";
import { test } from "node:test";
import { pillsExcept } from "./boardView.ts";

test("an area's name keeps off every other layer's pill, never off another area's, so the two never chase each other", () => {
  const marker = { x: 2, y: 3, value: "Moved 20 ft\n10 ft left", size: "screen" as const, small: true, below: true };
  const other = { x: 9, y: 1, name: "Fireball", size: "map" as const, small: true, above: true };
  const pills = { turnStart: [marker], "area:a1": [other] };
  assert.deepEqual(pillsExcept(pills, "area:"), [marker]);
  assert.deepEqual(pillsExcept({}, "area:"), []);
});
