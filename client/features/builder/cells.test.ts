import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, FreeWall, RoomState } from "#shared/model.ts";
import { clientOpSchema, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { apply, room } from "#shared/testutil.ts";
import {
  brushCells,
  edgeDistance,
  edgeInBounds,
  edgeRun,
  freeWallPutOp,
  freeWallRemoveOp,
  nearestFreeWall,
  nextFreeDoor,
  nearestEdge,
  nextDoor,
  paintOps,
  polygonCells,
  polyOps,
  rectBetween,
  rectOps,
  runFeature,
  secretDoor,
  SECOND_FINGER_MS,
  strokeCells,
  strokeMaySend,
} from "./cells.ts";

const BOUNDS = { w: 40, h: 30 };

function floorCells(state: RoomState, sceneId = "s1"): string[] {
  const out: string[] = [];
  for (const chunk of Object.values(state.buildChunks)) if (chunk.sceneId === sceneId) out.push(...Object.keys(chunk.cells));
  return out.sort();
}

function applyAll(state: RoomState, ops: ClientOp[]): RoomState {
  let s = state;
  ops.forEach((op, i) => {
    assert.ok(clientOpSchema.safeParse(op).success, `${op.t} must pass the schema`);
    s = apply(s, op, undefined, i + 1);
  });
  return s;
}

describe("brush cells", () => {
  test("odd brushes center on the cell under the finger, even ones on the nearest corner", () => {
    assert.deepEqual(brushCells({ x: 5.5, y: 5.5 }, 1, BOUNDS), ["5,5"]);
    assert.deepEqual(brushCells({ x: 5.5, y: 5.5 }, 3, BOUNDS).length, 9);
    assert.ok(brushCells({ x: 5.5, y: 5.5 }, 3, BOUNDS).includes("4,4"));
    assert.deepEqual(brushCells({ x: 5.8, y: 5.9 }, 2, BOUNDS).sort(), ["5,5", "5,6", "6,5", "6,6"]);
    assert.deepEqual(brushCells({ x: 5.2, y: 5.1 }, 2, BOUNDS).sort(), ["4,4", "4,5", "5,4", "5,5"]);
  });

  test("cells outside the scene are never collected", () => {
    assert.deepEqual(brushCells({ x: 0.2, y: 0.2 }, 3, BOUNDS).sort(), ["0,0", "0,1", "1,0", "1,1"]);
    assert.deepEqual(brushCells({ x: -3, y: 2 }, 1, BOUNDS), []);
  });

  test("a fast stroke still covers every cell between samples, each once", () => {
    const seen = new Set<string>();
    const first = strokeCells(null, { x: 0.5, y: 0.5 }, 1, BOUNDS, seen);
    const rest = strokeCells({ x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 }, 1, BOUNDS, seen);
    assert.deepEqual(first, ["0,0"]);
    assert.deepEqual(rest, ["1,0", "2,0", "3,0", "4,0", "5,0", "6,0", "7,0", "8,0", "9,0"]);
    // Going back over painted cells adds nothing.
    assert.deepEqual(strokeCells({ x: 9.5, y: 0.5 }, { x: 2.5, y: 0.5 }, 1, BOUNDS, seen), []);
  });

  test("a diagonal stroke leaves no gaps", () => {
    const seen = new Set<string>();
    strokeCells(null, { x: 0.5, y: 0.5 }, 1, BOUNDS, seen);
    strokeCells({ x: 0.5, y: 0.5 }, { x: 6.5, y: 6.5 }, 1, BOUNDS, seen);
    for (let i = 0; i <= 6; i++) assert.ok(seen.has(`${i},${i}`));
  });
});

describe("paint ops", () => {
  test("strokes split into ops of at most 2,000 cells that the reducer accepts", () => {
    const big = { w: 200, h: 200 };
    const cells: string[] = [];
    for (let y = 0; y < 30; y++) for (let x = 0; x < 200; x++) cells.push(`${x},${y}`);
    const ops = paintOps("s1", cells, "stone", () => undefined);
    assert.equal(ops.length, 3);
    for (const op of ops) {
      assert.equal(op.t, "build.paint");
      if (op.t === "build.paint") assert.ok(op.cells.length <= MAX_BUILD_CELLS);
    }
    const state = room();
    state.scenes.s1!.bounds = big;
    const after = applyAll(state, ops);
    assert.equal(floorCells(after).length, 6000);
  });

  test("cells that already have the terrain are skipped, and erase skips empty cells", () => {
    const current = (key: string) => (key === "1,1" ? ("stone" as const) : undefined);
    assert.deepEqual(paintOps("s1", ["1,1", "2,2"], "stone", current), [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["2,2"] }]);
    assert.deepEqual(paintOps("s1", ["1,1", "2,2"], null, current), [{ t: "build.erase", sceneId: "s1", cells: ["1,1"] }]);
    assert.deepEqual(paintOps("s1", ["1,1"], "stone", current), []);
  });
});

describe("rectangle rooms", () => {
  test("a drag between two cells includes both", () => {
    assert.deepEqual(rectBetween({ x: 5.9, y: 2.1 }, { x: 2.2, y: 4.4 }), { x: 2, y: 2, w: 4, h: 3 });
  });

  test("large rooms split into bands under 2,000 cells and clip to the scene", () => {
    const ops = rectOps("s1", { x: -5, y: 0, w: 300, h: 50 }, "wood", { w: 200, h: 200 });
    for (const op of ops) {
      assert.equal(op.t, "build.rect");
      if (op.t === "build.rect") {
        assert.ok(op.w * op.h <= MAX_BUILD_CELLS);
        assert.equal(op.x, 0);
        assert.equal(op.w, 200);
      }
    }
    const state = room();
    state.scenes.s1!.bounds = { w: 200, h: 200 };
    assert.equal(floorCells(applyAll(state, ops)).length, 200 * 50);
    assert.deepEqual(rectOps("s1", { x: 50, y: 50, w: 3, h: 3 }, "wood", BOUNDS), []);
  });
});

describe("polygon rooms", () => {
  const triangle = [2, 2, 12, 2, 2, 12];

  test("cells whose centers are inside become floor", () => {
    const cells = new Set(polygonCells(triangle, BOUNDS));
    // The hypotenuse is x + y = 14, so a cell's center is inside when
    // x + y + 1 < 14. Centers exactly on it (x + y = 13) follow the shared
    // tie rule and are left out of the check.
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const inside = x >= 2 && y >= 2 && x + y <= 12;
        const outside = x < 2 || y < 2 || x + y >= 14;
        if (inside) assert.ok(cells.has(`${x},${y}`), `${x},${y} should be floor`);
        if (outside) assert.ok(!cells.has(`${x},${y}`), `${x},${y} should stay empty`);
      }
    }
  });

  test("the client picks exactly the cells the reducer does", () => {
    const shapes = [
      triangle,
      [0.5, 0.5, 9.25, 1, 14, 7.5, 6, 13.75, 1, 8],
      [10, 2, 20, 2, 20, 12, 15, 7, 10, 12],
      [-5, -5, 8, -5, 8, 8],
    ];
    for (const points of shapes) {
      const ops = polyOps("s1", points, "cave", BOUNDS);
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.t, "build.poly");
      const after = applyAll(room(), ops);
      assert.deepEqual(floorCells(after), polygonCells(points, BOUNDS).sort());
    }
  });

  test("polygons past 2,000 cells become several paint ops", () => {
    const points = [0, 0, 100, 0, 100, 60, 0, 60];
    const bounds = { w: 200, h: 200 };
    const ops = polyOps("s1", points, "grass", bounds);
    assert.equal(ops.length, 3);
    assert.ok(ops.every((op) => op.t === "build.paint"));
    const state = room();
    state.scenes.s1!.bounds = bounds;
    assert.equal(floorCells(applyAll(state, ops)).length, 6000);
  });

  test("a polygon with no cell centers inside makes no op", () => {
    assert.deepEqual(polyOps("s1", [1, 1, 1.2, 1, 1.1, 1.2], "stone", BOUNDS), []);
  });
});

describe("edges", () => {
  test("a tap picks the nearest cell edge", () => {
    assert.equal(nearestEdge({ x: 3.5, y: 4.1 }, BOUNDS), "3,4,n");
    assert.equal(nearestEdge({ x: 3.5, y: 4.9 }, BOUNDS), "3,5,n");
    assert.equal(nearestEdge({ x: 3.05, y: 4.5 }, BOUNDS), "3,4,w");
    assert.equal(nearestEdge({ x: 3.95, y: 4.5 }, BOUNDS), "4,4,w");
    // The scene's east and south borders hold walls too.
    assert.equal(nearestEdge({ x: 39.95, y: 4.5 }, BOUNDS), "40,4,w");
    assert.equal(nearestEdge({ x: 7.5, y: 29.9 }, BOUNDS), "7,30,n");
    // Past them there is nothing to hold one.
    assert.equal(nearestEdge({ x: 40.95, y: 4.5 }, BOUNDS), null);
    assert.equal(nearestEdge({ x: 7.5, y: -0.9 }, BOUNDS), null);
  });

  test("an edge is in the scene on all four borders and not past them", () => {
    // West and north borders.
    assert.equal(edgeInBounds("0,5,w", BOUNDS), true);
    assert.equal(edgeInBounds("5,0,n", BOUNDS), true);
    // East and south borders: a west edge at the width, a north edge at the height.
    assert.equal(edgeInBounds("40,0,w", BOUNDS), true);
    assert.equal(edgeInBounds("40,29,w", BOUNDS), true);
    assert.equal(edgeInBounds("0,30,n", BOUNDS), true);
    assert.equal(edgeInBounds("39,30,n", BOUNDS), true);
    // A west edge below the south border, or a north edge right of the east border, runs off the scene.
    assert.equal(edgeInBounds("40,30,w", BOUNDS), false);
    assert.equal(edgeInBounds("40,30,n", BOUNDS), false);
    assert.equal(edgeInBounds("41,3,w", BOUNDS), false);
    assert.equal(edgeInBounds("3,31,n", BOUNDS), false);
    assert.equal(edgeInBounds("-1,3,w", BOUNDS), false);
    assert.equal(edgeInBounds("3,3,x", BOUNDS), false);
    assert.equal(edgeInBounds("3.5,3,n", BOUNDS), false);
  });

  test("a wall dragged along the east or south border keeps every edge", () => {
    assert.deepEqual(edgeRun({ x: 40, y: 26.2 }, { x: 40.1, y: 29.8 }, BOUNDS), ["40,26,w", "40,27,w", "40,28,w", "40,29,w"]);
    assert.deepEqual(edgeRun({ x: 37.2, y: 30 }, { x: 40.4, y: 30.2 }, BOUNDS), ["37,30,n", "38,30,n", "39,30,n"]);
  });

  test("a dragged wall follows one grid line along the longer axis", () => {
    assert.deepEqual(edgeRun({ x: 2.1, y: 3.2 }, { x: 5.8, y: 3.9 }, BOUNDS), ["2,3,n", "3,3,n", "4,3,n", "5,3,n"]);
    assert.deepEqual(edgeRun({ x: 4.2, y: 6 }, { x: 3.6, y: 3.1 }, BOUNDS), ["4,3,w", "4,4,w", "4,5,w"]);
  });

  test("tapping a door cycles closed, open, locked and back, and never makes it secret or takes it off", () => {
    const closed = { kind: "door", state: "closed", secret: false, discovered: false } as const;
    let door = nextDoor(undefined);
    const states = [door.state];
    for (let i = 0; i < 6; i++) {
      door = nextDoor(door);
      states.push(door.state);
      assert.equal(door.secret, false);
    }
    assert.deepEqual(states, ["closed", "open", "locked", "closed", "open", "locked", "closed"]);
    assert.deepEqual(nextDoor({ kind: "wall" }), closed);
    // A found secret door opens and closes like any door, and stays found.
    assert.deepEqual(nextDoor({ kind: "door", state: "closed", secret: true, discovered: true }), { kind: "door", state: "open", secret: true, discovered: true });
  });

  test("a secret door tap places it hidden or found, switches between them, and takes it off when it already matches", () => {
    const hidden = { kind: "door", state: "closed", secret: true, discovered: false } as const;
    const found = { kind: "door", state: "closed", secret: true, discovered: true } as const;
    assert.deepEqual(secretDoor(undefined, false), hidden);
    assert.deepEqual(secretDoor({ kind: "wall" }, false), hidden);
    assert.equal(secretDoor(hidden, false), null);
    assert.deepEqual(secretDoor(hidden, true), found);
    assert.equal(secretDoor(found, true), null);
    // Hiding an open door closes it, since players see a wall there.
    assert.deepEqual(secretDoor({ kind: "door", state: "open", secret: false, discovered: false }, false), hidden);
    assert.deepEqual(secretDoor({ kind: "door", state: "open", secret: true, discovered: false }, true), { ...found, state: "open" });
  });

  test("a dragged run leaves alone the edges that already have what it puts down", () => {
    const door = { kind: "door", state: "open", secret: false, discovered: false } as const;
    const hidden = { kind: "door", state: "closed", secret: true, discovered: false } as const;
    assert.deepEqual(runFeature("door", undefined, false), { kind: "door", state: "closed", secret: false, discovered: false });
    assert.equal(runFeature("door", door, false), undefined);
    assert.equal(runFeature("door", hidden, false), undefined);
    assert.deepEqual(runFeature("secret", { kind: "wall" }, false), hidden);
    assert.equal(runFeature("secret", hidden, false), undefined);
    assert.deepEqual(runFeature("wall", door, false), { kind: "wall" });
    assert.equal(runFeature("wall", { kind: "wall" }, false), undefined);
    assert.equal(runFeature("clear", door, false), null);
    assert.equal(runFeature("clear", undefined, false), undefined);
  });
});

describe("strokes", () => {
  test("a finger's stroke sends nothing until a late second finger can no longer turn it into a pinch", () => {
    assert.equal(strokeMaySend(true, 1000, 1000), false);
    assert.equal(strokeMaySend(true, 1000, 1000 + 250), false);
    assert.equal(strokeMaySend(true, 1000, 1000 + SECOND_FINGER_MS), true);
    assert.ok(SECOND_FINGER_MS > 150, "a second finger 150 ms behind the first still counts as a pinch");
    // A mouse or a pen sends at once.
    assert.equal(strokeMaySend(false, 1000, 1000), true);
  });
});


describe("free walls", () => {
  const door = (state: "open" | "closed" | "locked", secret = false, discovered = false) => ({ kind: "door", state, secret, discovered }) as const;
  const wall = (id: string, a: [number, number], b: [number, number], f: FreeWall["f"] = { kind: "wall" }): FreeWall => ({ id, a, b, f });
  const chunkWith = (cx: number, cy: number, walls: FreeWall[]): BuildChunk => ({ sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {}, walls });

  test("a tap picks the nearest free wall within reach, and names the chunk that holds it", () => {
    const near = wall("aaaaaaaaaaaa", [2, 2], [4, 3]);
    const far = wall("bbbbbbbbbbbb", [2, 4], [4, 4]);
    const other = wall("cccccccccccc", [17, 1], [18.5, 1.25]);
    const chunks = [chunkWith(0, 0, [near, far]), chunkWith(1, 0, [other])];
    const hit = nearestFreeWall(chunks, { x: 3, y: 2.6 }, 0.5);
    assert.equal(hit?.wall.id, near.id);
    assert.equal(hit?.cx, 0);
    assert.ok(Math.abs(hit!.distance - 0.1 / Math.sqrt(1.25)) < 1e-12);
    assert.equal(nearestFreeWall(chunks, { x: 17.75, y: 1.2 }, 0.5)?.cx, 1);
    // Past a wall's end the distance is to the end itself.
    assert.equal(nearestFreeWall(chunks, { x: 4.4, y: 3 }, 0.5)?.wall.id, near.id);
    assert.equal(nearestFreeWall(chunks, { x: 4.6, y: 3 }, 0.5), null);
    // Only the walls `accept` takes count.
    assert.equal(nearestFreeWall(chunks, { x: 3, y: 2.6 }, 2, (w) => w.id !== near.id)?.wall.id, far.id);
    assert.equal(nearestFreeWall([chunkWith(0, 0, [])], { x: 3, y: 2.6 }, 2), null);
  });

  test("a Door tap steps a free door through closed, open and locked, keeping its id and ends", () => {
    let w = wall("dddddddddddd", [1.25, 1], [2.5, 1.75], door("closed"));
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      w = nextFreeDoor(w);
      assert.equal(w.f.kind, "door");
      states.push(w.f.kind === "door" ? w.f.state : "");
    }
    assert.deepEqual(states, ["open", "locked", "closed", "open"]);
    assert.equal(w.id, "dddddddddddd");
    assert.deepEqual([w.a, w.b], [[1.25, 1], [2.5, 1.75]]);
    // A found secret door stays found.
    assert.deepEqual(nextFreeDoor(wall("eeeeeeeeeeee", [0, 0], [1, 0.5], door("open", true, true))).f, door("locked", true, true));
  });

  test("the ops for a door tap and a removal pass the protocol", () => {
    const w = wall("ffffffffffff", [17.015625, 3], [18, 3.5], door("closed"));
    const put = freeWallPutOp("s1", nextFreeDoor(w));
    assert.deepEqual(put, { t: "build.walls", sceneId: "s1", put: [{ id: w.id, a: [17.015625, 3], b: [18, 3.5], f: door("open") }] });
    assert.ok(clientOpSchema.safeParse(put).success);
    const remove = freeWallRemoveOp("s1", { wall: w, cx: 1, cy: 0 });
    assert.deepEqual(remove, { t: "build.walls", sceneId: "s1", remove: [{ cx: 1, cy: 0, id: w.id }] });
    assert.ok(clientOpSchema.safeParse(remove).success);
  });

  test("a door tap replaces the door in its chunk, and a removal takes it, through the reducer", () => {
    let state = applyAll(room(), [{ t: "build.walls", sceneId: "s1", put: [wall("gggggggggggg", [15.5, 2], [17, 2.5], door("closed"))] }]);
    const chunks = () => Object.values(state.buildChunks).filter((c) => c.sceneId === "s1");
    // The midpoint (16.25, 2.25) puts it in the second chunk.
    const hit = nearestFreeWall(chunks(), { x: 16.2, y: 2.3 }, 0.5);
    assert.equal(hit?.cx, 1);
    state = applyAll(state, [freeWallPutOp("s1", nextFreeDoor(hit!.wall))]);
    assert.deepEqual(
      chunks().flatMap((c) => c.walls ?? []),
      [wall("gggggggggggg", [15.5, 2], [17, 2.5], door("open"))],
    );
    state = applyAll(state, [freeWallRemoveOp("s1", nearestFreeWall(chunks(), { x: 16.2, y: 2.3 }, 0.5)!)]);
    assert.deepEqual(chunks(), []);
  });

  test("an edge's distance from a point, to weigh a tap between it and a free wall", () => {
    assert.equal(edgeDistance("3,4,n", { x: 3.5, y: 4.25 }), 0.25);
    assert.equal(edgeDistance("3,4,w", { x: 2.5, y: 4.5 }), 0.5);
    assert.equal(edgeDistance("3,4,w", { x: 3, y: 6 }), 1);
  });
});
