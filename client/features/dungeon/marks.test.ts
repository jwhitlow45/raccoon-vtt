import assert from "node:assert/strict";
import { test } from "node:test";
import { latticeFor } from "./lattice.ts";
import { drawMarks, lightMarks, numberMarks, pickRoom, roomBox } from "./marks.ts";
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

/* Phase 3 (design 2.1, 4.1): room boxes on the plan's lattice, and the tap's nearest room within 22 px. */
test("DG3: on squares a room's box is its rectangle, and on hexes the box round its hexes", () => {
  assert.deepEqual(roomBox({ w: 30, h: 30 }, { x: 2, y: 3, w: 4, h: 5 }, 7), { room: 7, x: 2, y: 3, w: 4, h: 5 });
  const hex = roomBox({ w: 30, h: 30, grid: "hexRows" }, { x: 2, y: 3, w: 4, h: 5 });
  const lattice = latticeFor("hexRows", { w: 30, h: 30 });
  for (const [x, y] of [
    [2, 3],
    [5, 3],
    [2, 7],
    [5, 7],
  ] as const) {
    const [px, py] = lattice.pointOf(x, y);
    assert.ok(px > hex.x && px < hex.x + hex.w && py > hex.y && py < hex.y + hex.h, `hex ${x},${y} inside`);
  }
  const columns = roomBox({ w: 30, h: 30, grid: "hexColumns" }, { x: 2, y: 3, w: 4, h: 5 });
  const mirrored = latticeFor("hexColumns", { w: 30, h: 30 }).pointOf(5, 7);
  assert.ok(mirrored[0] > columns.x && mirrored[0] < columns.x + columns.w && mirrored[1] > columns.y && mirrored[1] < columns.y + columns.h);
});

test("DG3: a tap picks the room it falls in, the nearest within 22 px, and nothing past that", () => {
  const boxes = [
    { room: 0, x: 0, y: 0, w: 4, h: 4 },
    { room: 3, x: 10, y: 0, w: 4, h: 4 },
  ];
  assert.equal(pickRoom(boxes, { x: 2, y: 2 }, 10), 0);
  assert.equal(pickRoom(boxes, { x: 12, y: 1 }, 10), 3);
  // 2 cells past room 3's west wall at 10 px a cell is 20 px: picked. 2.3 cells is 23 px: not.
  assert.equal(pickRoom(boxes, { x: 8, y: 2 }, 10), 3);
  assert.equal(pickRoom(boxes, { x: 6.2, y: 2 }, 10), 0);
  assert.equal(pickRoom(boxes, { x: 7, y: 2 }, 10), null);
  assert.equal(pickRoom([], { x: 0, y: 0 }, 10), null);
});

test("DG3: Edit rooms numbers every kept room whatever DM key says, at its pin through the lattice", () => {
  assert.deepEqual(numberMarks(twoRooms(), [{ n: 1, room: 1 }]), [{ n: 1, x: 18.5, y: 6.5 }]);
});
