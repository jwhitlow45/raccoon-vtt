import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FreeWall } from "#shared/model.ts";
import { apply, room } from "#shared/testutil.ts";
import { paintOps } from "./cells.ts";
import { erasable, labelAt, terrainAt } from "./query.ts";

describe("erasable", () => {
  test("a cell with no floor still counts when an edge on any side or a label in it would go", () => {
    let state = room();
    state = apply(state, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    state = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        { key: "5,5,n", feature: { kind: "wall" } },
        { key: "9,5,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } },
      ],
    });
    state = apply(state, { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 12.5, y: 3.2, text: "Pit", size: 0.7 } });
    const occupied = erasable(state, "s1");
    // North side of 5,5, and the south side of 5,4 above it.
    assert.equal(occupied("5,5"), true);
    assert.equal(occupied("5,4"), true);
    // West side of 9,5, and the east side of 8,5 beside it.
    assert.equal(occupied("9,5"), true);
    assert.equal(occupied("8,5"), true);
    assert.equal(occupied("12,3"), true);
    // The label's text spills into the cells beside its anchor.
    assert.equal(occupied("13,3"), true);
    assert.equal(occupied("14,3"), false);
    assert.equal(occupied("6,6"), false);
    assert.equal(erasable(state, "s2")("12,3"), false);

    const cells = ["1,1", "5,4", "6,6", "12,3"];
    const ops = paintOps("s1", cells, null, (key) => terrainAt(state, "s1", key), occupied);
    assert.deepEqual(ops, [{ t: "build.erase", sceneId: "s1", cells: ["1,1", "5,4", "12,3"] }]);
  });

  test("a cell counts when a free wall's midpoint, or a stamp's or light's center, lies in it, and the erase takes them", () => {
    let state = room();
    const wall: FreeWall = { id: "wallwallwall", a: [3, 3.5], b: [5, 4.25], f: { kind: "wall" } };
    const onLine: FreeWall = { id: "onlineonline", a: [6, 7], b: [6, 9], f: { kind: "window" } };
    state = apply(state, { t: "build.walls", sceneId: "s1", put: [wall, onLine] });
    state = apply(state, {
      t: "build.lights",
      sceneId: "s1",
      put: [{ id: "torch", x: 10.5, y: 2, bright: 20, dim: 20, on: true, walls: true }],
    });
    state = apply(state, {
      t: "build.stamps",
      sceneId: "s1",
      put: [{ id: "tree", art: { key: "tree" }, x: 15.25, y: 6.75, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }],
    });
    const occupied = erasable(state, "s1");
    // The wall's midpoint is (4, 3.875), and a midpoint on a grid line belongs to the cell after it.
    assert.equal(occupied("4,3"), true);
    assert.equal(occupied("3,3"), false);
    assert.equal(occupied("6,8"), true);
    assert.equal(occupied("5,8"), false);
    assert.equal(occupied("10,2"), true);
    assert.equal(occupied("15,6"), true);
    assert.equal(erasable(state, "s2")("10,2"), false);

    const cells = ["3,3", "4,3", "6,8", "10,2", "15,6"];
    const ops = paintOps("s1", cells, null, (key) => terrainAt(state, "s1", key), occupied);
    assert.deepEqual(ops, [{ t: "build.erase", sceneId: "s1", cells: ["4,3", "6,8", "10,2", "15,6"] }]);
    state = apply(state, ops[0]!);
    assert.deepEqual(Object.values(state.buildChunks).flatMap((c) => c.walls ?? []), []);
    assert.deepEqual(state.lights, {});
    assert.deepEqual(state.stamps, {});
  });

  test("a cell counts when a height or a stair mark is painted on it, and the erase takes them", () => {
    let state = room();
    state = apply(state, { t: "build.height", sceneId: "s1", cells: ["2,2", "18,3"], height: 10 });
    state = apply(state, { t: "build.stairs", sceneId: "s1", cells: ["4,2"], up: "a" });
    state = apply(state, { t: "build.height", sceneId: "s1", cells: ["6,2"], height: 0 });
    const occupied = erasable(state, "s1");
    assert.equal(occupied("2,2"), true);
    assert.equal(occupied("18,3"), true);
    assert.equal(occupied("4,2"), true);
    assert.equal(occupied("6,2"), false);
    assert.equal(occupied("3,2"), false);
    assert.equal(erasable(state, "s2")("2,2"), false);

    const cells = ["2,2", "3,2", "4,2", "18,3"];
    const ops = paintOps("s1", cells, null, (key) => terrainAt(state, "s1", key), occupied);
    assert.deepEqual(ops, [{ t: "build.erase", sceneId: "s1", cells: ["2,2", "4,2", "18,3"] }]);
    state = apply(state, ops[0]!);
    assert.deepEqual(
      Object.values(state.buildChunks).filter((c) => c.heights !== undefined || c.up !== undefined),
      [],
    );
  });

  test("an edge on the scene's east or south border does not count, since erasing the cell beside it leaves it", () => {
    let state = room();
    state = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        { key: "40,5,w", feature: { kind: "wall" } },
        { key: "7,30,n", feature: { kind: "wall" } },
        { key: "39,6,w", feature: { kind: "wall" } },
      ],
    });
    const occupied = erasable(state, "s1");
    assert.equal(occupied("39,5"), false);
    assert.equal(occupied("7,29"), false);
    // Inside the scene the cell on either side of an edge counts.
    assert.equal(occupied("38,6"), true);
    assert.equal(occupied("39,6"), true);
  });
});

describe("labelAt", () => {
  const state = apply(room(), { t: "build.label", sceneId: "s1", labelId: "pit", label: { x: 10, y: 10, text: "Pit", size: 0.45 } });

  test("a tap on a label's text picks it", () => {
    assert.equal(labelAt(state, "s1", { x: 10, y: 10 })?.id, "pit");
    assert.equal(labelAt(state, "s1", { x: 10.4, y: 10.2 })?.id, "pit");
  });

  test("a tap beside a small label misses it, so a new label can go there", () => {
    assert.equal(labelAt(state, "s1", { x: 10, y: 10.35 }), null);
    assert.equal(labelAt(state, "s1", { x: 10.6, y: 10 }), null);
    // A finger's slop still reaches it from just outside.
    assert.equal(labelAt(state, "s1", { x: 10, y: 10.35 }, { slop: 0.15 })?.id, "pit");
  });
});
