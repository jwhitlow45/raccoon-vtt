import assert from "node:assert/strict";
import { test } from "node:test";
import { boardViewsOf, pillsExcept } from "./boardView.ts";

test("an area's name keeps off every other layer's pill, never off another area's, so the two never chase each other", () => {
  const marker = { x: 2, y: 3, value: "Moved 20 ft\n10 ft left", size: "screen" as const, small: true, below: true };
  const other = { x: 9, y: 1, name: "Fireball", size: "map" as const, small: true, above: true };
  const pills = { turnStart: [marker], "area:a1": [other] };
  assert.deepEqual(pillsExcept(pills, "area:"), [marker]);
  assert.deepEqual(pillsExcept({}, "area:"), []);
});

test("the board's two views: the clear part leaves out the bars, the canvas holds them, both in cells", () => {
  // A 390 x 844 phone at 20 px a cell, the top bar 52 px and the toolbar with the tool's options and its line 113 px.
  const views = boardViewsOf({ x: 0, y: 100, scale: 20 }, { width: 390, height: 844 }, { top: 52, right: 0, bottom: 113, left: 0 });
  assert.deepEqual(views.canvas, { x0: 0, y0: -5, x1: 19.5, y1: 37.2 });
  assert.deepEqual(views.clear, { x0: 0, y0: (52 - 100) / 20, x1: 19.5, y1: (844 - 113 - 100) / 20 });
});
