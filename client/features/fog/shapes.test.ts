import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, TerrainId } from "#shared/model.ts";
import { clientOpSchema, MAX_FOG_CELLS, MAX_STROKE_POINTS } from "#shared/protocol.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { indexBuild } from "#shared/rules/walls.ts";
import { apply, room } from "#shared/testutil.ts";
import { brushLabel, cellsOutline, fogOps, polyShape, publishLabel, rectShape, roomShapes, simplify, strokeShapes, type Point } from "./shapes.ts";

let ids = 0;
const newId = () => `f${++ids}`;

function floor(cells: Record<string, TerrainId>, edges: BuildChunk["edges"] = {}): BuildChunk[] {
  // One chunk is enough for the index, whatever the coordinates.
  return [{ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells, edges }];
}

describe("fog shapes", () => {
  test("rectangles snap to quarter cells and need an area", () => {
    assert.deepEqual(rectShape({ x: 5.1, y: 2.9 }, { x: 1.26, y: 1 }), { kind: "rect", x: 1.25, y: 1, w: 3.75, h: 2 });
    assert.equal(rectShape({ x: 1, y: 1 }, { x: 1.05, y: 4 }), null);
  });

  test("polygons need three points and keep at most 200", () => {
    assert.equal(polyShape([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
    const many = Array.from({ length: 250 }, (_, i) => ({ x: Math.cos(i / 40) * 10 + 20, y: Math.sin(i / 40) * 10 + 20 }));
    const shape = polyShape(many);
    assert.ok(shape);
    assert.equal(shape.points.length, 400);
  });

  test("simplification drops points on a straight line and keeps the corners", () => {
    const line: Point[] = [];
    for (let i = 0; i <= 100; i++) line.push({ x: i / 10, y: 0 });
    for (let i = 1; i <= 100; i++) line.push({ x: 10, y: i / 10 });
    const simple = simplify(line, 0.05);
    assert.deepEqual(simple, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  test("a brush stroke becomes ops of at most 500 points that join up", () => {
    // A zigzag that simplification cannot shorten much.
    const zigzag: Point[] = Array.from({ length: 1300 }, (_, i) => ({ x: i * 0.1, y: i % 2 === 0 ? 0 : 1 }));
    const shapes = strokeShapes(zigzag, 2);
    assert.ok(shapes.length >= 3);
    for (let i = 0; i < shapes.length; i++) {
      const pts = shapes[i]!.points;
      assert.ok(pts.length / 2 <= MAX_STROKE_POINTS);
      if (i > 0) {
        const prev = shapes[i - 1]!.points;
        assert.deepEqual(pts.slice(0, 2), prev.slice(-2), "each piece starts where the last ended");
      }
    }
    const ops = fogOps(shapes, "reveal", newId);
    assert.ok(clientOpSchema.safeParse({ t: "fog.draft", sceneId: "s1", add: ops }).success);
  });

  test("a tap is a one-point stroke the schema accepts", () => {
    const [shape] = strokeShapes([{ x: 3, y: 3 }], 1);
    assert.ok(shape);
    assert.deepEqual(shape.points, [3, 3]);
    assert.ok(clientOpSchema.safeParse({ t: "fog.live", sceneId: "s1", ops: fogOps([shape], "reveal", newId) }).success);
  });
});

describe("reveal room", () => {
  test("a room bounded by walls and a closed door is revealed, and nothing past it", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells[`${x},${y}`] = "stone";
    // A corridor east of the room, through a closed door.
    for (let x = 4; x < 8; x++) cells[`${x},1`] = "stone";
    const door = { kind: "door" as const, state: "closed" as const, secret: false, discovered: false };
    const build = indexBuild(floor(cells, { "4,1,w": door }));
    const { shapes, cells: count } = roomShapes(build, { x: 1.5, y: 1.5 }, { w: 40, h: 30 });
    assert.equal(count, 16);
    assert.equal(shapes.length, 1);

    const state = room();
    state.scenes.s1!.fogEnabled = true;
    const after = apply(state, { t: "fog.live", sceneId: "s1", ops: fogOps(shapes, "reveal", newId) });
    assert.equal(isCellFullyFogged(after.fogTiles, "s1", { x: 2, y: 2 }), false);
    assert.equal(isCellFullyFogged(after.fogTiles, "s1", { x: 5, y: 1 }), true);
  });

  test("an open door joins the corridor to the room", () => {
    const cells: Record<string, TerrainId> = { "0,0": "stone", "1,0": "stone", "2,0": "stone" };
    const open = { kind: "door" as const, state: "open" as const, secret: false, discovered: false };
    const { cells: count } = roomShapes(indexBuild(floor(cells, { "1,0,w": open })), { x: 0.5, y: 0.5 }, { w: 10, h: 10 });
    assert.equal(count, 3);
  });

  test("a tap off the build reveals nothing", () => {
    const { shapes } = roomShapes(indexBuild(floor({ "0,0": "stone" })), { x: 5.5, y: 5.5 }, { w: 10, h: 10 });
    assert.deepEqual(shapes, []);
  });

  test("a room over 2,000 cells splits into several ops that reveal all of it", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) cells[`${x},${y}`] = "cave";
    const bounds = { w: 100, h: 100 };
    const { shapes, cells: count } = roomShapes(indexBuild(floor(cells)), { x: 10.5, y: 10.5 }, bounds);
    assert.equal(count, 4800);
    assert.equal(shapes.length, 3);
    for (const s of shapes) assert.ok(s.cells.length <= MAX_FOG_CELLS);
    assert.equal(new Set(shapes.flatMap((s) => s.cells)).size, 4800);

    const state = room();
    state.scenes.s1!.bounds = bounds;
    const ops = fogOps(shapes, "reveal", newId);
    const drafted = apply(state, { t: "fog.draft", sceneId: "s1", add: ops });
    const published = apply(drafted, { t: "fog.publish", sceneId: "s1" }, undefined, 2);
    for (const [x, y] of [
      [0, 0],
      [79, 59],
      [40, 30],
    ] as const) {
      assert.equal(isCellFullyFogged(published.fogTiles, "s1", { x, y }), false, `${x},${y}`);
    }
    assert.equal(isCellFullyFogged(published.fogTiles, "s1", { x: 80, y: 0 }), true);
  });

  test("the cap on the fill is the scene's area, so a room never truncates", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) cells[`${x},${y}`] = "stone";
    // Floor outside the scene bounds is not part of the room.
    cells["12,0"] = "stone";
    const { cells: count } = roomShapes(indexBuild(floor(cells)), { x: 0.5, y: 0.5 }, { w: 10, h: 10 });
    assert.equal(count, 100);
  });
});

describe("draft outlines", () => {
  test("a block of cells outlines as its perimeter only", () => {
    const segments = cellsOutline(["0,0", "1,0", "0,1", "1,1"]);
    // 8 unit sides around a 2 x 2 block, 4 numbers each.
    assert.equal(segments.length, 8 * 4);
  });
});

describe("fog wording", () => {
  test("the publish button says what the draft does to the players' view", () => {
    assert.equal(publishLabel([{ mode: "reveal" }, { mode: "reveal" }]), "Reveal to players (2)");
    assert.equal(publishLabel([{ mode: "hide" }]), "Fog for players (1)");
    assert.equal(publishLabel([{ mode: "reveal" }, { mode: "hide" }, { mode: "reveal" }]), "Show players the changes (3)");
  });

  test("brush widths are in feet, as the room measures", () => {
    assert.equal(brushLabel(1, 5), "5 ft");
    assert.equal(brushLabel(4, 5), "20 ft");
    assert.equal(brushLabel(2, 10), "20 ft");
  });
});
