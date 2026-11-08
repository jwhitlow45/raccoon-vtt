import assert from "node:assert/strict";
import { test } from "node:test";
import { drawMarks, lightMarks, numberMarks } from "./marks.ts";
import { twoRooms } from "./handPlans.ts";
import type { DungeonPlan } from "./plan.ts";
import { scratchRoom } from "./scratch.ts";

/*
 * The DM marks (phase 2, 4.2): a ring on each light, and with DM key on a
 * number at each room's pin. The same data feeds the preview's overlay and
 * Look closer's canvas.
 */

function withKey(): DungeonPlan {
  const plan = twoRooms();
  return {
    ...plan,
    lights: [{ x: 5.5, y: 5.5, preset: "Torch", label: "Fire pit", stamp: "fire-pit" }],
    key: [
      { n: 1, room: 0, doors: [], traps: [], trinket: 0 },
      { n: 2, room: 1, doors: [], traps: [], trinket: 1 },
    ],
  };
}

test("each light gets a ring at its place", () => {
  assert.deepEqual(lightMarks(withKey()), [{ x: 5.5, y: 5.5 }]);
  assert.deepEqual(lightMarks(twoRooms()), []);
});

test("room numbers stand at the middle of each room's pin square, and none with DM key off", () => {
  assert.deepEqual(numberMarks(withKey()), [
    { n: 1, x: 5.5, y: 5.5 },
    { n: 2, x: 18.5, y: 6.5 },
  ]);
  assert.deepEqual(numberMarks(twoRooms()), []);
});

test("numbers follow the key's own numbering, not the room order", () => {
  const plan = withKey();
  plan.key = [
    { n: 2, room: 0, doors: [], traps: [], trinket: 0 },
    { n: 1, room: 1, doors: [], traps: [], trinket: 1 },
  ];
  assert.deepEqual(numberMarks(plan).map((m) => [m.n, m.x]), [
    [2, 5.5],
    [1, 18.5],
  ]);
});

test("drawMarks writes a ring and a number for each mark and one entrance ring", () => {
  const calls: string[] = [];
  const g = new Proxy({}, { get: (_t, name: string) => (name === "measureText" ? () => ({ width: 1 }) : (...args: unknown[]) => calls.push(`${name}:${args.join(",")}`)), set: () => true }) as unknown as CanvasRenderingContext2D;
  drawMarks(g, withKey(), scratchRoom(), "scene", 40);
  assert.equal(calls.filter((c) => c.startsWith("arc:")).length, 1, "one light ring");
  assert.deepEqual(calls.filter((c) => c.startsWith("fillText:")), ["fillText:1,5.5,5.5", "fillText:2,18.5,6.5"]);
  assert.equal(calls.filter((c) => c.startsWith("roundRect:")).length, 1, "the entrance ring");
});
