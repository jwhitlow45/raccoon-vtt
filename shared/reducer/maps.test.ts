import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, keys } from "../keys.ts";
import { checkLimits, LIMITS } from "../limits.ts";
import type { FreeWall, Light, RoomState, Scene, Stamp } from "../model.ts";
import { clientOpSchema, type Op, type StampInput } from "../protocol.ts";
import { hashValue } from "../project.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, actor, apply, comparable, drawing, effect, env, refused, room, scene, template, token } from "../testutil.ts";
import { derivedId } from "./duplicate.ts";
import { CHANGED_SINCE } from "./misc.ts";
import { GRID_DOES_NOT_FIT, NOT_SAME_SHAPE, TOO_SMALL } from "./phases.ts";
import { guardHash } from "./tx.ts";

/** Applies an op and returns the whole result, for its inverse and its flags. */
function run(state: RoomState, op: Op, seq = 1): Applied {
  const result = applyOp(state, op, DM, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result;
}

/** Takes an applied op back through its inverse, as the DM's undo does. */
function undo(state: RoomState, applied: Applied, seq = 50): Applied {
  assert.ok(applied.inverse, "the op has an inverse");
  return run(state, { t: "sys.restore", entries: applied.inverse, from: "undo", deps: true }, seq);
}

const wall = (id: string, a: [number, number], b: [number, number], f: FreeWall["f"] = { kind: "wall" }): FreeWall => ({ id, a, b, f });
const W1 = "aaaaaaaaaaaa";
const W2 = "bbbbbbbbbbbb";
const W3 = "cccccccccccc";

function stampInput(id: string, overrides: Partial<StampInput> = {}): StampInput {
  return { id, art: { key: "oak-tree" }, x: 2.5, y: 2.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", ...overrides };
}

function lightInput(id: string, overrides: Partial<Omit<Light, "rev" | "sceneId">> = {}): Omit<Light, "rev" | "sceneId"> {
  return { id, x: 3, y: 3, bright: 20, dim: 20, on: true, walls: true, ...overrides };
}

describe("edges on the scene's border", () => {
  test("all four borders of a 20 x 20 scene take edges, and nothing past them", () => {
    const state = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 20 } }) } });
    const wallEdge = (key: string) => ({ key, feature: { kind: "wall" as const } });
    const next = apply(state, { t: "build.edge", sceneId: "s1", edges: ["0,5,w", "5,0,n", "20,0,w", "20,19,w", "0,20,n", "19,20,n"].map(wallEdge) });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 1, 0)]?.edges, { "20,0,w": { kind: "wall" } });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 1, 1)]?.edges, { "20,19,w": { kind: "wall" }, "19,20,n": { kind: "wall" } });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 0, 1)]?.edges, { "0,20,n": { kind: "wall" } });
    for (const key of ["21,0,w", "20,0,n", "0,21,n", "0,20,w", "-1,0,w"]) {
      assert.equal(refused(state, { t: "build.edge", sceneId: "s1", edges: [wallEdge(key)] }).message, "edge outside the scene", key);
    }
  });

  test("erasing the cell beside a border edge leaves the edge, as stored erases did", () => {
    const state = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 20 } }) } });
    let next = apply(state, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["19,3"] });
    next = apply(next, { t: "build.edge", sceneId: "s1", edges: [{ key: "20,3,w", feature: { kind: "wall" } }, { key: "19,3,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    next = apply(next, { t: "build.erase", sceneId: "s1", cells: ["19,3"] });
    assert.deepEqual(next.buildChunks[chunkKey("s1", 1, 0)]?.edges, { "20,3,w": { kind: "wall" } });
  });
});

describe("free walls", () => {
  const base = () => room({ scenes: { s1: scene("s1", { bounds: { w: 40, h: 30 } }) } });

  test("each lands in its midpoint's chunk, a put replaces its id there, and the walls version moves", () => {
    let state = base();
    const r = run(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [14, 2], [18, 2]), wall(W2, [12, 2], [15.5, 2.25])] });
    state = r.state;
    assert.deepEqual(state.buildChunks[chunkKey("s1", 1, 0)]?.walls, [wall(W1, [14, 2], [18, 2])]);
    assert.deepEqual(state.buildChunks[chunkKey("s1", 0, 0)]?.walls, [wall(W2, [12, 2], [15.5, 2.25])]);
    assert.equal(state.scenes.s1!.wallsVersion, 1);
    const door = { kind: "door" as const, state: "closed" as const, secret: true, discovered: false };
    state = apply(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [14, 2], [18, 2], door)] });
    assert.deepEqual(state.buildChunks[chunkKey("s1", 1, 0)]?.walls, [wall(W1, [14, 2], [18, 2], door)]);
    assert.equal(state.scenes.s1!.wallsVersion, 2);
  });

  test("removing a chunk's last free wall removes the chunk, and a removal of a wall not there changes nothing", () => {
    let state = apply(base(), { t: "build.walls", sceneId: "s1", put: [wall(W1, [1, 1], [3, 3])] });
    const missing = run(state, { t: "build.walls", sceneId: "s1", remove: [{ cx: 0, cy: 0, id: W2 }] });
    assert.equal(missing.touched.filter((k) => k.startsWith("chunk:")).length, 0);
    state = apply(state, { t: "build.walls", sceneId: "s1", remove: [{ cx: 0, cy: 0, id: W1 }] });
    assert.equal(state.buildChunks[chunkKey("s1", 0, 0)], undefined);
  });

  test("ends past the scene and a wall put twice are refused", () => {
    const state = base();
    assert.equal(refused(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [39, 1], [41, 1])] }).message, "wall outside the scene");
    assert.equal(refused(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [1, 1], [2, 1]), wall(W1, [1, 2], [2, 2])] }).message, "a wall appears twice");
    // The border itself is part of the scene.
    apply(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [40, 0], [40, 5])] });
  });

  test("an undo takes the walls back, and a chunk keeps its floor when only its walls change", () => {
    const state = apply(base(), { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] });
    const r = run(state, { t: "build.walls", sceneId: "s1", put: [wall(W1, [0.5, 0.5], [2.5, 0.5])] }, 2);
    assert.deepEqual(r.state.buildChunks[chunkKey("s1", 0, 0)]?.cells, { "1,1": "stone" });
    const back = undo(r.state, r).state;
    assert.deepEqual(comparable(back.buildChunks as unknown as RoomState), comparable(state.buildChunks as unknown as RoomState));
    assert.ok(back.scenes.s1!.wallsVersion > r.state.scenes.s1!.wallsVersion, "the walls version never goes back");
  });

  test("an erase takes the free walls whose midpoint is in an erased cell, and Clear takes them all", () => {
    let state = apply(base(), {
      t: "build.walls",
      sceneId: "s1",
      put: [wall(W1, [1, 1], [3, 1]), wall(W2, [5, 5], [5, 7]), wall(W3, [20, 20], [21, 21])],
    });
    state = apply(state, { t: "build.erase", sceneId: "s1", cells: ["2,1", "4,6"] });
    // W1's midpoint (2, 1) is in cell 2,1. W2's (5, 6) sits on the line between cells 4,6 and 5,6, and belongs to 5,6.
    assert.deepEqual(state.buildChunks[chunkKey("s1", 0, 0)]?.walls, [wall(W2, [5, 5], [5, 7])]);
    state = apply(state, { t: "build.erase", sceneId: "s1", cells: ["5,6"] });
    assert.equal(state.buildChunks[chunkKey("s1", 0, 0)], undefined);
    state = apply(state, { t: "build.clear", sceneId: "s1" });
    assert.equal(Object.keys(state.buildChunks).length, 0);
  });

  test("the room limits count free walls per scene", () => {
    const state = base();
    const walls: FreeWall[] = [];
    for (let i = 0; i <= LIMITS.freeWallsPerScene; i++) walls.push(wall(`w${String(i).padStart(11, "0")}`, [0, 0], [1, 1]));
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls };
    assert.deepEqual(checkLimits(state, "s1"), { ok: false, code: "quota", message: `this scene can hold at most ${LIMITS.freeWallsPerScene.toLocaleString("en-US")} free walls` });
    walls.pop();
    assert.deepEqual(checkLimits(state, "s1"), { ok: true });
  });
});

describe("stamps and lights", () => {
  test("a put places or replaces a stamp on its scene, and one from another scene is refused", () => {
    let state = room();
    state = apply(state, { t: "build.stamps", sceneId: "s1", put: [stampInput("st1"), stampInput("st2", { art: { assetId: "a1" }, tint: "#aa5500", flip: true })] });
    assert.deepEqual(state.stamps.st1, { ...stampInput("st1"), rev: 1, sceneId: "s1" } satisfies Stamp);
    state = apply(state, { t: "build.stamps", sceneId: "s1", put: [stampInput("st1", { x: 7, rotation: 45 })] });
    assert.equal(state.stamps.st1!.x, 7);
    assert.equal(state.stamps.st1!.rev, 2);
    assert.equal(refused(state, { t: "build.stamps", sceneId: "s2", put: [stampInput("st1")] }).message, "stamp belongs to another scene");
    assert.equal(refused(state, { t: "build.stamps", sceneId: "s2", remove: ["st1"] }).message, "stamp belongs to another scene");
    assert.equal(refused(state, { t: "build.stamps", sceneId: "s1", put: [stampInput("st3"), stampInput("st3")] }).message, "a stamp appears twice");
    state = apply(state, { t: "build.stamps", sceneId: "s1", remove: ["st1", "gone"] });
    assert.deepEqual(Object.keys(state.stamps), ["st2"]);
  });

  test("a light stands in the scene, and lights are counted per scene", () => {
    let state = room({ scenes: { s1: scene("s1", { bounds: { w: 10, h: 10 } }), s2: scene("s2", { order: 1 }) } });
    state = apply(state, { t: "build.lights", sceneId: "s1", put: [lightInput("l1", { x: 10, y: 10 })] });
    assert.deepEqual(state.lights.l1, { ...lightInput("l1", { x: 10, y: 10 }), rev: 1, sceneId: "s1" });
    assert.equal(refused(state, { t: "build.lights", sceneId: "s1", put: [lightInput("l2", { x: 10.015625 })] }).message, "light outside the scene");
    for (let i = 0; i < LIMITS.lightsPerScene; i++) state.lights[`x${i}`] = { ...lightInput(`x${i}`), rev: 0, sceneId: "s1" };
    assert.equal(checkLimits(state, "s1").ok, false);
    assert.equal(checkLimits(state, "s2").ok, true);
  });

  test("an erase takes the stamps and lights whose center is in an erased cell, Clear and scene delete take them all", () => {
    let state = room();
    state = apply(state, { t: "build.stamps", sceneId: "s1", put: [stampInput("st1", { x: 2.5, y: 2.5 }), stampInput("st2", { x: 4, y: 2.5 })] });
    state = apply(state, { t: "build.lights", sceneId: "s1", put: [lightInput("l1", { x: 2.25, y: 2.75 }), lightInput("l2", { x: 8, y: 8 })] });
    state = apply(state, { t: "build.erase", sceneId: "s1", cells: ["2,2", "3,2"] });
    assert.deepEqual(Object.keys(state.stamps), ["st2"], "a center on a grid line belongs to the cell after it");
    assert.deepEqual(Object.keys(state.lights), ["l2"]);
    const cleared = apply(state, { t: "build.clear", sceneId: "s1" });
    assert.deepEqual(cleared.stamps, {});
    assert.deepEqual(cleared.lights, {});
    const deleted = apply(state, { t: "scene.delete", sceneId: "s1" });
    assert.deepEqual(deleted.stamps, {});
    assert.deepEqual(deleted.lights, {});
  });

  test("undoing a scene's creation is refused while a stamp or a light stands on it", () => {
    const created = run(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 10, h: 10 } } });
    for (const op of [
      { t: "build.stamps", sceneId: "s3", put: [stampInput("st1")] },
      { t: "build.lights", sceneId: "s3", put: [lightInput("l1")] },
    ] as Op[]) {
      const state = apply(created.state, op, DM, 2);
      const result = applyOp(state, { t: "sys.restore", entries: created.inverse!, from: "undo", deps: true }, DM, env(3));
      assert.ok(!result.ok && result.message === "other work depends on it", op.t);
    }
  });
});

describe("automatic walls and thumbnails on a scene", () => {
  test("a new rule bumps the walls version and re-projects everything, and so does its undo", () => {
    const state = room();
    const r = run(state, { t: "scene.update", sceneId: "s1", patch: { autoWalls: "floor" } });
    assert.equal(r.state.scenes.s1!.autoWalls, "floor");
    assert.equal(r.state.scenes.s1!.wallsVersion, 1);
    assert.equal(r.global, true);
    const back = undo(r.state, r);
    assert.equal(back.state.scenes.s1!.autoWalls, undefined);
    assert.equal(back.state.scenes.s1!.wallsVersion, 2, "a restore keeps the higher version, one more for the walls it moves");
    assert.equal(back.global, true);
    // "all" is what an absent rule reads as, so naming it moves no wall.
    const same = run(state, { t: "scene.update", sceneId: "s1", patch: { autoWalls: "all" } });
    assert.equal(same.state.scenes.s1!.wallsVersion, 0);
    assert.equal(same.global, false);
  });

  test("a scene made with a rule or a folder keeps them, and one made without stays on today's rule", () => {
    const made = apply(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 10, h: 10 }, autoWalls: "off", folder: "Act 1" } });
    assert.equal(made.scenes.s3!.autoWalls, "off");
    assert.equal(made.scenes.s3!.folder, "Act 1");
    const plain = apply(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 10, h: 10 }, map: { assetId: "m1", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } } } });
    assert.equal("autoWalls" in plain.scenes.s3!, false);
  });

  test("a Universal VTT import's mark comes only with the scene, and stays through a change of its walls rule", () => {
    let state = apply(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 10, h: 10 }, autoWalls: "off", gridFromFile: true } });
    assert.equal(state.scenes.s3!.gridFromFile, true);
    state = apply(state, { t: "scene.update", sceneId: "s3", patch: { autoWalls: "floor" } });
    assert.equal(state.scenes.s3!.gridFromFile, true);
    assert.equal(clientOpSchema.safeParse({ t: "scene.update", sceneId: "s3", patch: { gridFromFile: true } }).success, false, "no patch sets it");
    assert.equal(clientOpSchema.safeParse({ t: "scene.create", scene: { id: "s4", name: "Crypt", bounds: { w: 10, h: 10 }, gridFromFile: false } }).success, false, "it is a mark, never false");
    const plain = apply(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 10, h: 10 } } });
    assert.equal("gridFromFile" in plain.scenes.s3!, false);
  });

  test("a Universal VTT import's mark stays through new art and through the image's removal, since its walls stay", () => {
    const map = { assetId: "m1", widthPx: 1400, heightPx: 1000, cellPx: 70, originPx: { x: 0, y: 0 } };
    let state = apply(room(), { t: "scene.create", scene: { id: "s3", name: "Crypt", bounds: { w: 20, h: 14 }, map, autoWalls: "off", gridFromFile: true } });
    state = apply(state, { t: "scene.setMap", sceneId: "s3", map: { ...map, assetId: "m2", heightPx: 1400, cellPx: 47 } });
    assert.equal(state.scenes.s3!.gridFromFile, true, "other art of another shape");
    state = apply(state, { t: "scene.setMap", sceneId: "s3", map: null });
    assert.equal(state.scenes.s3!.gridFromFile, true, "no image at all");
  });

  test("folders are set and cleared", () => {
    let state = apply(room(), { t: "scene.update", sceneId: "s1", patch: { folder: "Act 1" } });
    assert.equal(state.scenes.s1!.folder, "Act 1");
    state = apply(state, { t: "scene.update", sceneId: "s1", patch: { folder: null } });
    assert.equal("folder" in state.scenes.s1!, false);
  });

  test("a thumbnail landing between a rename and its undo leaves the undo working, and the undo keeps the new thumbnail", () => {
    const renamed = run(room(), { t: "scene.update", sceneId: "s1", patch: { name: "Crypt" } });
    const thumbed = apply(renamed.state, { t: "scene.update", sceneId: "s1", patch: { thumb: "t1" } }, DM, 2);
    const back = undo(thumbed, renamed);
    assert.equal(back.state.scenes.s1!.name, "s1");
    assert.equal(back.state.scenes.s1!.thumb, "t1");
    const scene = thumbed.scenes.s1!;
    assert.equal(guardHash(keys.scene("s1"), scene), guardHash(keys.scene("s1"), { ...scene, thumb: "t2" }));
    const { thumb: _t, ...without } = scene;
    assert.equal(guardHash(keys.scene("s1"), scene), guardHash(keys.scene("s1"), without));
  });

  test("a scene from before thumbnails hashes as stored guards hashed it", () => {
    const s = scene("s1", { rev: 4, wallsVersion: 9, name: "Old" });
    const { rev: _rev, wallsVersion: _version, ...rest } = s;
    assert.equal(guardHash(keys.scene("s1"), s), hashValue(rest));
  });

  test("a scene a restore brings back from nothing keeps the thumbnail it had", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1, thumb: "t1" }) } });
    const deleted = run(state, { t: "scene.delete", sceneId: "s2" });
    assert.equal(undo(deleted.state, deleted).state.scenes.s2!.thumb, "t1");
  });
});

describe("map phases", () => {
  const MAP = { assetId: "day", widthPx: 2000, heightPx: 1000, cellPx: 100, originPx: { x: 20, y: 10 } };
  const phase = (id: string, assetId: string, widthPx: number, heightPx: number) => ({ id, name: id, assetId, widthPx, heightPx });
  const DAY = phase("p1", "day", 2000, 1000);
  const NIGHT = phase("p2", "night", 1000, 500);
  const FIRE = phase("p3", "fire", 4000, 2001);
  const withMap = () => room({ scenes: { s1: scene("s1", { map: MAP }), s2: scene("s2", { order: 1 }) } });

  /** Where grid line k falls across the image, as a fraction of its width: the same on every phase when the grid is on the same cells. */
  const lineAt = (s: Scene, k: number) => (s.map!.originPx.x + k * s.map!.cellPx) / s.map!.widthPx;
  const rowAt = (s: Scene, k: number) => (s.map!.originPx.y + k * s.map!.cellPx) / s.map!.heightPx;
  const sameCells = (a: Scene, b: Scene) => {
    for (const k of [0, 7, 19]) {
      assert.ok(Math.abs(lineAt(a, k) - lineAt(b, k)) < 1e-9, `column ${k}`);
      assert.ok(Math.abs(rowAt(a, k) - rowAt(b, k)) < 1e-3, `row ${k}`);
    }
  };

  test("a scene's first phases take its grid as the reference, and a switch scales it to the image", () => {
    let state = apply(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, NIGHT] } });
    const day = state.scenes.s1!;
    assert.deepEqual(day.phaseGrid, { refWidthPx: 2000, refHeightPx: 1000, cellPx: 100, originPx: { x: 20, y: 10 } });
    assert.equal(day.phaseId, "p1");
    assert.deepEqual(day.map, MAP);
    state = apply(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    const night = state.scenes.s1!;
    assert.deepEqual(night.map, { assetId: "night", widthPx: 1000, heightPx: 500, cellPx: 50, originPx: { x: 10, y: 5 } });
    sameCells(day, night);
    assert.equal(refused(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "nope" }).code, "gone");
  });

  test("reordering, replacing and removing the reference phase keep the grid on the same cells, and each undoes", () => {
    let state = apply(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, NIGHT] } });
    const reference = state.scenes.s1!;
    const steps: Op[] = [
      { t: "scene.update", sceneId: "s1", patch: { phases: [NIGHT, DAY] } },
      { t: "scene.update", sceneId: "s1", patch: { phases: [{ ...DAY, assetId: "dawn" }, NIGHT] } },
      { t: "scene.update", sceneId: "s1", patch: { phases: [NIGHT] } },
      { t: "scene.update", sceneId: "s1", patch: { phases: [NIGHT, FIRE] } },
      { t: "scene.setPhase", sceneId: "s1", phaseId: "p3" },
    ];
    let seq = 2;
    for (const op of steps) {
      const r = run(state, op, seq++);
      sameCells(reference, r.state.scenes.s1!);
      assert.deepEqual(r.state.scenes.s1!.phaseGrid, reference.phaseGrid, "the reference never moves");
      const back = undo(r.state, r, seq++);
      assert.deepEqual(back.state.scenes.s1!.map, state.scenes.s1!.map);
      assert.deepEqual(back.state.scenes.s1!.phases, state.scenes.s1!.phases);
      state = r.state;
    }
    // Removing the active phase switched to the first one left.
    assert.equal(state.scenes.s1!.phaseId, "p3");
    const removed = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: [NIGHT] } });
    assert.equal(removed.scenes.s1!.phaseId, "p2");
    assert.equal(removed.scenes.s1!.map!.assetId, "night");
  });

  test("an image of another shape or one too small for the grid is refused", () => {
    const state = withMap();
    assert.equal(refused(state, { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, phase("p2", "sq", 1000, 1000)] } }).message, NOT_SAME_SHAPE);
    assert.equal(refused(state, { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, phase("p2", "tiny", 10, 5)] } }).message, TOO_SMALL);
    assert.equal(refused(room(), { t: "scene.update", sceneId: "s1", patch: { phases: [DAY] } }).message, "the scene has no map to add phases to");
  });

  test("a grid lined up on one phase is stored in reference pixels, and one that would put a phase under a pixel is refused", () => {
    let state = apply(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, NIGHT] } });
    state = apply(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    state = apply(state, { t: "scene.setGrid", sceneId: "s1", cellPx: 40, originPx: { x: 3, y: 4 } });
    assert.deepEqual(state.scenes.s1!.phaseGrid, { refWidthPx: 2000, refHeightPx: 1000, cellPx: 80, originPx: { x: 6, y: 8 } });
    assert.deepEqual(state.scenes.s1!.map, { assetId: "night", widthPx: 1000, heightPx: 500, cellPx: 40, originPx: { x: 3, y: 4 } });
    // Lined up on the day image at 1.5 pixels a cell, the night image, half as wide, would get 0.75.
    state = apply(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p1" });
    assert.equal(refused(state, { t: "scene.setGrid", sceneId: "s1", cellPx: 1.5, originPx: { x: 0, y: 0 } }).message, GRID_DOES_NOT_FIT);
  });

  test("a switch that would put the map's grid outside the protocol's bounds is refused, as a hand-made backup could ask", () => {
    // Every field is within its own bounds, but the second phase scales the grid to 26,843,545,600 pixels a cell.
    const state = room({
      scenes: {
        s1: scene("s1", {
          map: { assetId: "day", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } },
          phases: [phase("p1", "day", 1, 1), phase("p2", "night", 100, 100)],
          phaseId: "p1",
          phaseGrid: { refWidthPx: 1, refHeightPx: 1, cellPx: 16_384 * 16_384, originPx: { x: 0, y: 0 } },
        }),
      },
    });
    assert.deepEqual(refused(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" }), { ok: false, code: "invalid", message: TOO_SMALL });
  });

  test("a new map replaces the active phase's image on the reference grid, and no map clears the phases", () => {
    let state = apply(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [DAY, NIGHT] } });
    state = apply(state, { t: "scene.setMap", sceneId: "s1", map: { assetId: "dusk", widthPx: 4000, heightPx: 2000, cellPx: 1, originPx: { x: 0, y: 0 } } });
    assert.deepEqual(state.scenes.s1!.phases![0], { ...DAY, assetId: "dusk", widthPx: 4000, heightPx: 2000 });
    assert.deepEqual(state.scenes.s1!.map, { assetId: "dusk", widthPx: 4000, heightPx: 2000, cellPx: 200, originPx: { x: 40, y: 20 } });
    assert.equal(refused(state, { t: "scene.setMap", sceneId: "s1", map: { ...MAP, heightPx: 1500 } }).message, NOT_SAME_SHAPE);
    state = apply(state, { t: "scene.setMap", sceneId: "s1", map: null });
    for (const field of ["map", "phases", "phaseId", "phaseGrid"]) assert.equal(field in state.scenes.s1!, false, field);
  });
});

describe("duplicating a scene", () => {
  function setup(): RoomState {
    const state = room({ scenes: { s1: scene("s1", { folder: "Act 1", thumb: "t1", autoWalls: "floor" }), s2: scene("s2", { order: 1 }) } });
    state.characters.c1 = { id: "c1", rev: 0, ownerIds: ["p1"], name: "Ayla", size: "medium", actor: actor() };
    state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
    const blessed = effect("e1", { key: "blessed", duration: { remaining: 4, boundary: "turnEnd", anchor: { entryId: "row1" } } });
    state.tokens.gob1 = token("gob1", { name: "Goblin", x: 5, y: 5, fogExemptAuto: true, path: { turn: 3, stops: [{ x: 4, y: 5, elevation: 0 }, { x: 5, y: 5, elevation: 0 }] }, actor: { inline: actor({ effects: [blessed] }) } });
    state.tokens.other = token("other", { sceneId: "s2" });
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 3, cells: { "1,1": "stone" }, edges: {}, walls: [wall(W1, [1, 1], [2, 2])] };
    state.labels.lab1 = { id: "lab1", rev: 0, sceneId: "s1", x: 1, y: 1, text: "Trap", size: 1 };
    state.stamps.st1 = { ...stampInput("st1"), rev: 0, sceneId: "s1" };
    state.lights.l1 = { ...lightInput("l1"), rev: 0, sceneId: "s1" };
    state.fogTiles[`s1:0,0`] = { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: "A".repeat(684) };
    state.drawings.ruler = drawing("ruler", { kind: "ruler", points: [1, 1, 5, 5], anchors: ["pc1", "gob1"] });
    state.templates.aura = template("aura", { attachedTo: "pc1" });
    state.templates.fire = template("fire", { casterId: "pc1" });
    state.templates.web = template("web", { casterId: "gob1" });
    state.encounter = { rev: 0, round: 1, activeEntryId: "row1", entries: [{ id: "row1", tokenId: "gob1", value: 12, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }] };
    return state;
  }
  const all = { creatures: true, characters: true, fog: true, drawings: true };
  const none = { creatures: false, characters: false, fog: false, drawings: false };
  const id = (old: string) => derivedId("s3", old);

  test("the map, build, labels, stamps and lights always come along, under derived ids, right after the original", () => {
    const r = run(setup(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "s1 (copy)", include: none });
    const s = r.state;
    assert.deepEqual(s.scenes.s3, { ...setup().scenes.s1!, id: "s3", rev: 1, name: "s1 (copy)", order: 1, wallsVersion: 0 });
    assert.equal(s.scenes.s2!.order, 2);
    assert.deepEqual(s.buildChunks[chunkKey("s3", 0, 0)], { ...setup().buildChunks[chunkKey("s1", 0, 0)]!, sceneId: "s3", rev: 1 });
    assert.equal(s.labels[id("lab1")]?.sceneId, "s3");
    assert.equal(s.stamps[id("st1")]?.sceneId, "s3");
    assert.equal(s.lights[id("l1")]?.sceneId, "s3");
    assert.match(id("st1"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(Object.values(s.tokens).filter((t) => t.sceneId === "s3").length, 0);
    assert.equal(s.fogTiles["s3:0,0"], undefined);
    assert.equal(Object.values(s.drawings).length + Object.values(s.templates).length, 4);
    // One undo takes it all back.
    assert.deepEqual(comparable(undo(s, r).state), comparable(setup()));
  });

  test("creatures, characters, fog and drawings come along when asked, with nothing of the original's fight", () => {
    const s = apply(setup(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: all });
    const gob = s.tokens[id("gob1")]!;
    assert.equal(gob.sceneId, "s3");
    assert.equal(gob.fogExemptAuto, false);
    assert.equal(gob.path, undefined);
    assert.deepEqual("inline" in gob.actor && gob.actor.inline.effects[0]?.duration, { remaining: 4, boundary: "turnEnd", anchor: { tokenId: id("gob1") } });
    // The original's row and its own effect are untouched.
    assert.equal(s.encounter!.entries.length, 1);
    assert.deepEqual("inline" in s.tokens.gob1!.actor && s.tokens.gob1!.actor.inline.effects[0]?.duration?.anchor, { entryId: "row1" });
    assert.deepEqual(s.tokens[id("pc1")]!.actor, { ref: "c1" });
    assert.equal(s.fogTiles["s3:0,0"]?.sceneId, "s3");
    assert.deepEqual(s.drawings[id("ruler")]?.anchors, [id("pc1"), id("gob1")]);
    assert.equal(s.templates[id("aura")]?.attachedTo, id("pc1"));
    assert.equal(s.templates[id("fire")]?.casterId, id("pc1"));
  });

  test("a ruler on a token left behind keeps a free stop, an area attached to one stays behind, and a caster left behind is dropped", () => {
    const s = apply(setup(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { ...all, characters: false } });
    assert.equal(s.tokens[id("pc1")], undefined);
    assert.deepEqual(s.drawings[id("ruler")]?.anchors, [null, id("gob1")]);
    assert.equal(s.drawings[id("ruler")]?.visibility, "all");
    assert.equal(s.templates[id("aura")], undefined);
    assert.equal("casterId" in s.templates[id("fire")]!, false);
    assert.equal(s.templates[id("web")]?.casterId, id("gob1"));
  });

  test("left off, Fog gives a map scene's copy fog like any new map scene, its original's setting on a blank mat, and copied it keeps the setting", () => {
    const map = { assetId: "m", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    const copyFog = (original: Partial<Scene>, fog: boolean) => {
      const state = room({ scenes: { s1: scene("s1", original) } });
      return apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { ...none, fog } }).scenes.s3!.fogEnabled;
    };
    assert.equal(copyFog({ map, fogEnabled: false }, false), true, "a map scene with fog off");
    assert.equal(copyFog({ map, fogEnabled: true }, false), true);
    assert.equal(copyFog({ map, fogEnabled: false }, true), false, "fog copied as it is");
    assert.equal(copyFog({ fogEnabled: false }, false), false, "a blank mat");
    assert.equal(copyFog({ fogEnabled: true }, false), true);
  });

  test("a ruler's stop on a token left behind is where that token stands now, not where it stood when the ruler was kept", () => {
    const moved = apply(setup(), { t: "token.move", tokenId: "pc1", x: 6, y: 6 });
    const s = apply(moved, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { ...all, characters: false } }, DM, 2);
    const ruler = s.drawings[id("ruler")]!;
    assert.deepEqual(ruler.points, [6.5, 6.5, 5, 5], "the middle of the token's footprint, and the copied token's stop as kept");
    assert.deepEqual(ruler.anchors, [null, id("gob1")]);
    assert.equal(ruler.visibility, "all", "players see where the party's token stands anyway");
  });

  test("a ruler with a stop left behind on a token players could not see is the DM's alone on the copy", () => {
    const copyOf = (state: RoomState, include = { ...all, creatures: false }) =>
      apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include }, DM, 2).drawings[id("ruler")]!;
    const hidden = setup();
    hidden.tokens.gob1 = { ...hidden.tokens.gob1!, visibility: "dm" };
    assert.deepEqual(copyOf(hidden), { ...hidden.drawings.ruler!, id: id("ruler"), rev: 1, sceneId: "s3", points: [1, 1, 5.5, 5.5], anchors: [id("pc1"), null], visibility: "dm" });
    const fogged = setup();
    fogged.scenes.s1 = { ...fogged.scenes.s1!, fogEnabled: true };
    fogged.tokens.gob1 = { ...fogged.tokens.gob1!, fogExemptAuto: false };
    delete fogged.fogTiles["s1:0,0"];
    assert.equal(copyOf(fogged).visibility, "dm", "under fog");
    // Copied with the creatures, the stop stays on the copy of the token, and the copy's own projection decides.
    assert.equal(copyOf(hidden, all).visibility, "all");
    // A token that is gone, or on another scene, has no place here: its stop keeps the stored point.
    const gone = setup();
    delete gone.tokens.gob1;
    gone.encounter = null;
    assert.deepEqual([copyOf(gone).points, copyOf(gone).visibility], [[1, 1, 5, 5], "dm"]);
    const away = setup();
    away.tokens.gob1 = { ...away.tokens.gob1!, sceneId: "s2" };
    assert.deepEqual([copyOf(away).points, copyOf(away).visibility], [[1, 1, 5, 5], "dm"]);
  });

  test("the copy moves every later scene down one, like a reorder, so its undo and an older undo on a later scene each refuse after the other", () => {
    const duplicate: Op = { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: none };
    const rename: Op = { t: "scene.update", sceneId: "s2", patch: { name: "Crypt" } };
    const undoRefused = (state: RoomState, applied: Applied) => {
      const result = applyOp(state, { t: "sys.restore", entries: applied.inverse!, from: "undo", deps: true }, DM, env(9));
      return result.ok ? "applied" : result.message;
    };
    // A later scene edited after the copy was made.
    const copied = run(setup(), duplicate);
    const renamedAfter = run(copied.state, rename, 2);
    assert.equal(undoRefused(renamedAfter.state, copied), CHANGED_SINCE);
    // A later scene edited before the copy was made: its older undo step refuses once the copy has moved it.
    const renamedBefore = run(setup(), rename);
    const copiedAfter = run(renamedBefore.state, duplicate, 2);
    assert.equal(undoRefused(copiedAfter.state, renamedBefore), CHANGED_SINCE);
    // Undone newest first, as the stack does, both go back.
    const back = undo(undo(copiedAfter.state, copiedAfter, 3).state, renamedBefore, 4);
    assert.deepEqual(comparable(back.state), comparable(setup()));
  });

  test("a taken id or scene id refuses the copy", () => {
    const state = setup();
    assert.equal(refused(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s2", name: "Copy", include: none }).message, "scene already exists");
    state.stamps[id("st1")] = { ...stampInput(id("st1")), rev: 0, sceneId: "s2" };
    assert.equal(refused(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: none }).message, "a copied id is taken");
  });
});
