import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { RoomState, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry, type TrapInput } from "../protocol.ts";
import { applyOp, type ApplyResult } from "../reducer.ts";
import { HEX_ORIGIN, OWN_SQUARE_GRID } from "../rules/grid.ts";
import { env, room, template, token, trap } from "../testutil.ts";

/*
 * A scene's grid shape in the reducer (docs/design-v1-hex-grids.md HX-D14
 * and HX-D19): a new scene's shape, the room's default and the switch.
 */

const A: Viewer = { memberId: "dmA", role: "dm" };

let seq = 1;
function step(state: RoomState, op: Op, who: Viewer = A): ApplyResult {
  return applyOp(state, opSchema.parse(op), who, env(seq++));
}

function run(state: RoomState, op: Op, who: Viewer = A): { state: RoomState; inverse: RestoreEntry[]; global: boolean } {
  const r = step(state, op, who);
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return { state: r.state, inverse: r.inverse ?? [], global: r.global };
}

function refusal(state: RoomState, op: Op, who: Viewer = A): string {
  const r = step(state, op, who);
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

const toHex = (sceneId = "s1", shape: "hexRows" | "hexColumns" | "squares" = "hexRows"): Op => ({ t: "scene.update", sceneId, patch: { gridShape: shape } });
const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });

function trapInput(id: string): TrapInput {
  const { rev: _rev, state: _state, rig, ...rest } = trap(id);
  return { ...rest, rig: rig! } as TrapInput;
}

const wall = { id: "w00000000001", a: [2, 2] as [number, number], b: [5, 2] as [number, number], f: { kind: "wall" as const } };

describe("a new scene's shape (HX-D19)", () => {
  const mat = (extra: object = {}): Op => ({ t: "scene.create", scene: { id: "mat", name: "Mat", bounds: { w: 30, h: 20 }, ...extra } });

  test("a create stores the shape it names, and squares as none", () => {
    assert.equal(run(room(), mat({ gridShape: "hexRows" })).state.scenes.mat!.gridShape, "hexRows");
    assert.equal(run(room(), mat({ gridShape: "hexColumns" })).state.scenes.mat!.gridShape, "hexColumns");
    assert.ok(!("gridShape" in run(room(), mat({ gridShape: "squares" })).state.scenes.mat!));
    assert.ok(!("gridShape" in run(room(), mat()).state.scenes.mat!));
  });

  test("a create without a shape makes squares in a room whose New scenes is hexes: only the form reads it", () => {
    const hexRoom = room({ meta: { ...room().meta, settings: { ...room().meta.settings, newScenes: "hexRows" } } });
    assert.equal(run(hexRoom, mat()).state.scenes.mat!.gridShape, undefined);
  });

  test("a scene with its own square grid from its file is never made on hexes", () => {
    assert.equal(refusal(room(), mat({ gridShape: "hexRows", gridFromFile: true })), OWN_SQUARE_GRID);
    const map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: -20, y: 0 } };
    assert.equal(refusal(room(), mat({ gridShape: "hexColumns", map })), HEX_ORIGIN);
    assert.ok(run(room(), mat({ gridShape: "hexColumns", map: { ...map, originPx: { x: 20, y: 0 } } })).state.scenes.mat!.gridShape);
    assert.ok(run(room(), mat({ map })).state.scenes.mat!.map, "a square scene keeps a negative origin, as an import's does");
  });
});

describe("a hex scene's map origin is never negative (D-261026-8)", () => {
  const map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 10, y: 10 } };
  const hexMap = (): RoomState => room({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexRows", map } } });

  test("a new map or a lined-up grid before the image is refused on hexes, and goes on squares", () => {
    const before = { x: -5, y: 10 };
    assert.equal(refusal(hexMap(), { t: "scene.setMap", sceneId: "s1", map: { ...map, originPx: before } }), HEX_ORIGIN);
    assert.equal(refusal(hexMap(), { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 10, y: -1 } }), HEX_ORIGIN);
    assert.ok(run(hexMap(), { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 0, y: 35 } }).state);
    assert.ok(run(hexMap(), { t: "scene.setMap", sceneId: "s1", map: null }).state, "taking the map away");
    const squares = room({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, map } } });
    assert.equal(run(squares, { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 10, y: -1 } }).state.scenes.s1!.map!.originPx.y, -1);
  });

  test("with phases too: a lined-up grid or a new image before the image is refused on hexes", () => {
    const phases = [
      { id: "day", name: "Day", assetId: "a1", widthPx: 700, heightPx: 700 },
      { id: "night", name: "Night", assetId: "a2", widthPx: 700, heightPx: 700 },
    ];
    const phased = run(hexMap(), { t: "scene.update", sceneId: "s1", patch: { phases } }).state;
    assert.ok(phased.scenes.s1!.phaseGrid);
    assert.equal(refusal(phased, { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: -3, y: 0 } }), HEX_ORIGIN);
    const unaligned = { ...phased, scenes: { ...phased.scenes, s1: { ...phased.scenes.s1!, phaseGrid: { ...phased.scenes.s1!.phaseGrid!, originPx: { x: -4, y: 0 } } } } };
    assert.equal(refusal(unaligned, { t: "scene.setMap", sceneId: "s1", map: { ...map, assetId: "a3" } }), HEX_ORIGIN, "a hand-made backup's reference grid");
  });

  test("so a hex scene switched back to squares can always come back", () => {
    const back = run(hexMap(), toHex("s1", "squares")).state;
    assert.equal(run(back, toHex("s1", "hexColumns")).state.scenes.s1!.gridShape, "hexColumns");
  });
});

describe("the room's New scenes (D-261025-10)", () => {
  test("a patch stores a hex shape and squares clears it, leaving the other settings as they were", () => {
    const set = run(room(), { t: "room.update", settings: { newScenes: "hexColumns" } });
    assert.equal(set.state.meta.settings.newScenes, "hexColumns");
    assert.ok(set.global, "a settings change reprojects, as every one does");
    const cleared = run(set.state, { t: "room.update", settings: { newScenes: "squares" } }).state.meta.settings;
    assert.ok(!("newScenes" in cleared));
    assert.deepEqual(cleared, room().meta.settings);
  });

  test("a settings patch without it keeps it", () => {
    const set = run(room(), { t: "room.update", settings: { newScenes: "hexRows" } }).state;
    assert.equal(run(set, { t: "room.update", settings: { diagonal: "fiveTen" } }).state.meta.settings.newScenes, "hexRows");
  });
});

describe("the shape switch (HX-D14)", () => {
  test("an empty scene switches, to either hex shape and back, and squares stores no shape", () => {
    const rows = run(room(), toHex()).state;
    assert.equal(rows.scenes.s1!.gridShape, "hexRows");
    const columns = run(rows, toHex("s1", "hexColumns")).state;
    assert.equal(columns.scenes.s1!.gridShape, "hexColumns");
    const back = run(columns, toHex("s1", "squares")).state;
    assert.ok(!("gridShape" in back.scenes.s1!));
    assert.equal(run(room(), toHex("s1", "squares")).state.scenes.s1!.gridShape, undefined);
  });

  test("switching with difficult ground and two traps is refused, naming them in the scene's cell word", () => {
    let state = run(room(), { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true }).state;
    state = run(state, { t: "trap.create", trap: trapInput("t1") }).state;
    state = run(state, { t: "trap.create", trap: trapInput("t2") }).state;
    assert.equal(refusal(state, toHex()), "This scene has difficult ground and 2 traps on its squares, which can't stand on hexes. Remove them to change the grid.");
    assert.ok(run(state, toHex("s2")).state.scenes.s2!.gridShape, "the other scene is free to switch");
  });

  test("switching with painted ground, walls on the grid lines, heights or stairs is refused", () => {
    for (const op of [
      { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] },
      { t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: { kind: "wall" } }] },
      { t: "build.height", sceneId: "s1", cells: ["1,1"], height: 10 },
      { t: "build.stairs", sceneId: "s1", cells: ["1,1"], up: "n" },
    ] as Op[]) {
      assert.match(refusal(run(room(), op).state, toHex()), /^This scene has (painted ground|walls and doors|heights|stairs) on its squares/, op.t);
    }
  });

  test("in H2, free walls go along onto hexes", () => {
    const walled = run(room(), { t: "build.walls", sceneId: "s1", put: [wall] }).state;
    const switched = run(walled, toHex()).state;
    assert.equal(switched.scenes.s1!.gridShape, "hexRows");
    assert.equal(switched.buildChunks[chunkKey("s1", 0, 0)]?.walls?.length, 1);
  });

  test("from H2 an attach link moves onto hexes with its tokens, and a squeezed token keeps a scene off them", () => {
    const ridden = room({ tokens: { horse: token("horse", { size: "large", x: 4, y: 4 }), bree: token("bree", { x: 4, y: 4, attached: { to: "horse", kind: "ride" } }) } });
    assert.equal(run(ridden, toHex()).state.tokens.bree?.attached?.to, "horse");
    const squeezed = room({ tokens: { ogre: token("ogre", { size: "large", squeeze: true }) } });
    assert.match(refusal(squeezed, toHex()), /a squeezing creature/);
  });

  test("a fog draft of rects and strokes goes along, and the switch's undo is accepted", () => {
    let state = run(room(), {
      t: "fog.draft",
      sceneId: "s1",
      add: [
        { id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 4, h: 4 } },
        { id: "f2", mode: "hide", shape: { kind: "stroke", points: [0, 0, 6, 6], width: 1 } },
      ],
    }).state;
    const switched = run(state, toHex());
    state = switched.state;
    assert.equal(state.scenes.s1!.gridShape, "hexRows");
    assert.equal(run(state, undo(switched.inverse)).state.scenes.s1!.gridShape, undefined);
  });

  test("a draft holding Reveal room's cells keeps the scene on squares", () => {
    const state = run(room(), { t: "fog.draft", sceneId: "s1", add: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1", "2,1"] } }] }).state;
    assert.match(refusal(state, toHex()), /Builder room in its fog draft/);
  });

  test("a stationary emanation goes through a switch, rows to columns, as it was: it holds a size, never cell keys", () => {
    const area = template("a1", { shape: "emanation", size: 10, origin: { x: 5, y: 5, z: 0 }, footprint: { w: 2, h: 2, elevation: 0, height: 10, size: "large" } });
    const rows = room({ scenes: { ...room().scenes, s1: { ...room().scenes.s1!, gridShape: "hexRows" } }, templates: { a1: area } });
    const columns = run(rows, toHex("s1", "hexColumns")).state;
    assert.deepEqual(columns.templates.a1, area);
  });
});

describe("atomic grid restoration (H3-USEDEFAULT-RACE)", () => {
  const map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 10, y: 10 } };
  const restore = { t: "scene.setGrid", sceneId: "s1", cellPx: 47, originPx: { x: 0, y: 0 }, gridShape: "squares", bounds: { w: 29, h: 21 } } as const;
  const before = () => room({ scenes: { s1: { ...room().scenes.s1!, gridShape: "hexRows", map } } });

  test("shape, calibration and bounds restore in one scene write and one inverse, with phases too", () => {
    for (const phased of [false, true]) {
      let state = before();
      if (phased) {
        state = run(state, { t: "scene.update", sceneId: "s1", patch: { phases: [
          { id: "day", name: "Day", assetId: "a1", widthPx: 700, heightPx: 700 },
          { id: "night", name: "Night", assetId: "a2", widthPx: 1400, heightPx: 1400 },
        ] } }).state;
        state = run(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "night" }).state;
      }
      const result = step(state, restore);
      assert.ok(result.ok);
      const scene = result.state.scenes.s1!;
      assert.equal(scene.gridShape, undefined);
      assert.deepEqual(scene.bounds, restore.bounds);
      assert.equal(scene.map!.cellPx, restore.cellPx);
      assert.deepEqual(scene.map!.originPx, restore.originPx);
      assert.ok(result.global, "the shape switch reprojects the scene");
      assert.deepEqual(result.touched, ["scene:s1"]);
      assert.equal(result.inverse?.length, 1, "all values belong to one undo step");
      if (phased) {
        assert.equal(scene.phaseGrid!.cellPx, restore.cellPx / 2, "calibration is converted from the active phase into reference pixels");
        const day = run(result.state, { t: "scene.setPhase", sceneId: "s1", phaseId: "day" }).state.scenes.s1!;
        assert.equal(day.map!.cellPx, restore.cellPx / 2);
      }
      const restored = run(result.state, undo(result.inverse!)).state.scenes.s1!;
      const { rev: _old, ...old } = state.scenes.s1!;
      const { rev: _restored, ...actual } = restored;
      assert.deepEqual(actual, old, "one undo restores all three values and the phase reference");
    }
  });

  test("switch refusal and invalid hex calibration leave every restoration field untouched", () => {
    const state = run(before(), { t: "build.height", sceneId: "s1", cells: ["1,1"], height: 10 }).state;
    const saved = structuredClone(state);
    assert.match(refusal(state, restore), /heights on its hexes/);
    assert.deepEqual(state, saved);
    const empty = before();
    assert.equal(refusal(empty, { ...restore, gridShape: "hexColumns", originPx: { x: -1, y: 0 } }), HEX_ORIGIN);
    assert.deepEqual(empty, before());
    const imported = room({ scenes: { s1: { ...room().scenes.s1!, map, gridFromFile: true } } });
    assert.equal(refusal(imported, { ...restore, gridShape: "hexRows" }), OWN_SQUARE_GRID);
    const phased = run(empty, { t: "scene.update", sceneId: "s1", patch: { phases: [
      { id: "day", name: "Day", assetId: "a1", widthPx: 700, heightPx: 700 },
      { id: "night", name: "Night", assetId: "a2", widthPx: 1400, heightPx: 1400 },
    ] } }).state;
    const oldPhase = structuredClone(phased);
    assert.match(refusal(phased, { ...restore, cellPx: 10_000 }), /would not fit every phase/);
    assert.deepEqual(phased, oldPhase, "a phase's calibration refusal cannot leave the shape or bounds restored");
  });

  test("restoration supports either hex orientation and same-shape edits with cell data", () => {
    for (const shape of ["hexRows", "hexColumns"] as const) {
      const squares = room({ scenes: { s1: { ...room().scenes.s1!, map } } });
      const result = run(squares, { ...restore, gridShape: shape }).state;
      assert.equal(result.scenes.s1!.gridShape, shape);
      const held = run(result, { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true }).state;
      const calibrated = run(held, { ...restore, gridShape: shape, cellPx: 60 }).state.scenes.s1!;
      assert.equal(calibrated.map!.cellPx, 60);
      assert.equal(calibrated.gridShape, shape);
    }
  });

  test("existing setGrid payloads preserve shape and bounds at old op versions, including phases", () => {
    for (const phased of [false, true]) {
      let state = run(before(), { t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true }).state;
      if (phased) state = run(state, { t: "scene.update", sceneId: "s1", patch: { phases: [{ id: "day", name: "Day", assetId: "a1", widthPx: 700, heightPx: 700 }] } }).state;
      const op = opSchema.parse({ t: "scene.setGrid", sceneId: "s1", cellPx: 47, originPx: { x: 0, y: 0 } });
      for (const opVersion of [1, 24, 28, 29, 30, 31, 32, 33, 34, undefined]) {
        const result = applyOp(state, op, A, { ...env(200), opVersion });
        assert.ok(result.ok, String(opVersion));
        const scene = result.state.scenes.s1!;
        assert.equal(scene.gridShape, state.scenes.s1!.gridShape);
        assert.deepEqual(scene.bounds, state.scenes.s1!.bounds);
        assert.equal(scene.map!.cellPx, 47);
        assert.deepEqual(scene.map!.originPx, { x: 0, y: 0 });
        assert.equal(result.global, false);
      }
    }
  });
});
