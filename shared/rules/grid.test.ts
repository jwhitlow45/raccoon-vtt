import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, FogDraft, RoomState } from "../model.ts";
import { inBounds, parseCell } from "../reducer/map.ts";
import { int, rng, room, scene, token, trap } from "../testutil.ts";
import {
  OWN_SQUARE_GRID,
  SQUARES,
  cameWithGrid,
  cellWord,
  gridOfShape,
  heldList,
  inScene,
  restoreRefusal,
  restoredHolds,
  sceneGrid,
  sceneHolds,
  shapeOfGrid,
  switchHolds,
  switchRefusal,
  type Grid,
} from "./grid.ts";

const ROWS: Grid = { shape: "hex", orient: "rows" };
const COLUMNS: Grid = { shape: "hex", orient: "columns" };

function chunk(overrides: Partial<BuildChunk> = {}): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, ...overrides };
}

const ROUGH = "d".padEnd(256, ".");
const WALL = { id: "w00000000001", a: [1, 1] as [number, number], b: [3, 1] as [number, number], f: { kind: "wall" as const } };

describe("a scene's grid", () => {
  test("absent reads as squares, and each shape round trips through its grid", () => {
    assert.deepEqual(sceneGrid(scene("s1")), SQUARES);
    assert.deepEqual(sceneGrid(scene("s1", { gridShape: "hexRows" })), ROWS);
    assert.deepEqual(sceneGrid(scene("s1", { gridShape: "hexColumns" })), COLUMNS);
    for (const shape of [undefined, "hexRows", "hexColumns"] as const) assert.equal(shapeOfGrid(gridOfShape(shape)), shape);
  });

  test("names its cell", () => {
    assert.equal(cellWord(SQUARES), "square");
    assert.equal(cellWord(SQUARES, true), "squares");
    assert.equal(cellWord(ROWS), "hex");
    assert.equal(cellWord(COLUMNS, true), "hexes");
  });

  test("on squares a key is in the scene exactly as the builder's bound check has it", () => {
    const r = rng(31);
    const s = scene("s1", { bounds: { w: 12, h: 7 } });
    for (let i = 0; i < 2000; i++) {
      const key = `${int(r, -3, 15)},${int(r, -3, 10)}`;
      assert.equal(inScene(SQUARES, s.bounds, key), inBounds(s, parseCell(key)), key);
    }
  });

  test("on hexes a key is in the scene when its hex lies wholly inside", () => {
    const bounds = { w: 30, h: 20 };
    assert.ok(inScene(ROWS, bounds, "29,0"));
    assert.ok(!inScene(ROWS, bounds, "29,1"), "odd rows hold one fewer");
    assert.ok(inScene(ROWS, bounds, "0,21"));
    assert.ok(!inScene(ROWS, bounds, "0,22"));
    assert.ok(!inScene(ROWS, bounds, "-1,0"));
    assert.ok(inScene(COLUMNS, bounds, "33,0"), "a 30 wide scene holds 34 hex columns");
    assert.ok(!inScene(COLUMNS, bounds, "34,0"));
    assert.ok(!inScene(COLUMNS, bounds, "1,19"), "odd columns hold one fewer");
    assert.ok(!inScene(ROWS, bounds, "a,b"));
    // One hex, one key: the protocol's cell key lets these through, and they would name hexes that have a key already.
    assert.ok(inScene(ROWS, bounds, "0,1") && inScene(ROWS, bounds, "1,1"));
    for (const other of ["-0,1", "01,1", "0,01", "+1,1", " 1,1"]) assert.ok(!inScene(ROWS, bounds, other), other);
  });

  test("came with its grid: the import's mark, or a first grid line before the image", () => {
    const map = { assetId: "a1", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };
    assert.equal(cameWithGrid(scene("s1")), false);
    assert.equal(cameWithGrid(scene("s1", { gridFromFile: true })), true);
    assert.equal(cameWithGrid(scene("s1", { map })), false);
    assert.equal(cameWithGrid(scene("s1", { map: { ...map, originPx: { x: -25, y: 0 } } })), true);
    assert.equal(cameWithGrid(scene("s1", { map: { ...map, originPx: { x: 10, y: -1 } } })), true);
  });
});

describe("what keeps a scene from a shape (HX-D14)", () => {
  test("any cell data blocks a switch, named in order", () => {
    const state = room({
      buildChunks: { "s1:0,0": chunk({ cells: { "1,1": "stone" }, edges: { "1,1,n": { kind: "none" } }, heights: "A".repeat(683) + "=", up: ".".repeat(256), rough: ROUGH }) },
      traps: { t1: trap("t1"), t2: trap("t2") },
      fogDrafts: { s1: { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } }] } },
      tokens: { a: token("a", { size: "large", squeeze: true }) },
    });
    const held = switchHolds(state, state.scenes.s1!, ROWS);
    assert.equal(heldList(held), "painted ground, walls and doors, heights, stairs, difficult ground, 2 traps, Reveal room in its fog draft and a squeezing creature");
    assert.equal(switchHolds(state, state.scenes.s1!, SQUARES).length, 0, "the shape it has already");
    assert.equal(switchHolds(state, state.scenes.s2!, ROWS).length, 0, "another scene's data");
  });

  test("in H2, free walls go along onto hexes and back: they are in world units", () => {
    const state = room({ buildChunks: { "s1:0,0": chunk({ walls: [WALL] }) } });
    assert.equal(switchHolds(state, state.scenes.s1!, ROWS).length, 0);
    assert.equal(switchHolds(state, state.scenes.s1!, COLUMNS).length, 0);
    const hex = { ...state, scenes: { ...state.scenes, s1: scene("s1", { gridShape: "hexRows" }) } } as RoomState;
    assert.equal(switchHolds(hex, hex.scenes.s1!, SQUARES).length, 0);
    assert.equal(switchHolds(hex, hex.scenes.s1!, COLUMNS).length, 0, "rows to columns too");
  });

  test("from H2, attach links move to any shape, as their tokens do", () => {
    const state = room({ tokens: { horse: token("horse", { size: "large" }), bree: token("bree", { attached: { to: "horse", kind: "ride" } }) } });
    assert.equal(switchHolds(state, state.scenes.s1!, ROWS).length, 0, "onto hexes");
    const hex = { ...state, scenes: { ...state.scenes, s1: scene("s1", { gridShape: "hexRows" }) } } as RoomState;
    assert.equal(switchHolds(hex, hex.scenes.s1!, SQUARES).length, 0, "back onto squares");
    assert.equal(switchHolds(hex, hex.scenes.s1!, COLUMNS).length, 0, "rows to columns");
  });

  test("a fog draft of world shapes moves to any shape", () => {
    const draft: FogDraft = { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 3, h: 3 } }, { id: "f2", mode: "hide", shape: { kind: "stroke", points: [0, 0, 4, 4], width: 1 } }] };
    const state = room({ fogDrafts: { s1: draft } });
    assert.equal(switchHolds(state, state.scenes.s1!, ROWS).length, 0);
  });

  test("the switch's words name the data in the scene's own cell word", () => {
    const state = room({ buildChunks: { "s1:0,0": chunk({ rough: ROUGH }) }, traps: { t1: trap("t1"), t2: trap("t2") } });
    assert.equal(
      switchRefusal(state, state.scenes.s1!, ROWS),
      "This scene has difficult ground and 2 traps on its squares, which can't stand on hexes. Remove them to change the grid.",
    );
    const onRows = room({ scenes: { s1: scene("s1", { gridShape: "hexRows" }) }, buildChunks: { "s1:0,0": chunk({ rough: ROUGH, grid: "hexRows" }) } });
    assert.equal(switchRefusal(onRows, onRows.scenes.s1!, COLUMNS), "This scene has difficult ground on its hex rows, which can't stand on hex columns. Remove them to change the grid.");
    assert.equal(switchRefusal(onRows, onRows.scenes.s1!, SQUARES), "This scene has difficult ground on its hexes, which can't stand on squares. Remove them to change the grid.");
    assert.equal(switchRefusal(room(), room().scenes.s1!, ROWS), null);
  });

  test("a scene that came with its square grid never leaves squares", () => {
    const state = room({ scenes: { s1: scene("s1", { gridFromFile: true }) } });
    assert.equal(switchRefusal(state, state.scenes.s1!, ROWS), OWN_SQUARE_GRID);
    assert.equal(switchRefusal(state, state.scenes.s1!, SQUARES), null);
  });
});

describe("what a restored value brings (HX-D14's two checks)", () => {
  const squares = scene("s1");
  const rows = scene("s1", { gridShape: "hexRows" });
  const columns = scene("s1", { gridShape: "hexColumns" });

  test("the stamp check: grid-keyed content stands only on the shape it was stamped with", () => {
    const state = room();
    assert.deepEqual(restoredHolds(state, "chunk", chunk({ rough: ROUGH }), rows), { held: [{ what: "rough", count: 1 }], from: "squares" });
    assert.equal(restoredHolds(state, "chunk", chunk({ rough: ROUGH }), squares), null);
    assert.equal(restoredHolds(state, "chunk", chunk({ rough: ROUGH, grid: "hexRows" }), rows), null, "a matching stamp passes this check, and difficult ground meets H2's");
    assert.deepEqual(restoredHolds(state, "chunk", chunk({ heights: "A".repeat(683) + "=", grid: "hexRows" }), rows)?.from, "hexRows", "and heights meet the phase's");
    assert.deepEqual(restoredHolds(state, "chunk", chunk({ rough: ROUGH, grid: "hexRows" }), columns), { held: [{ what: "rough", count: 1 }], from: "hexRows" });
    assert.deepEqual(restoredHolds(state, "chunk", chunk({ cells: { "0,0": "stone" }, grid: "hexColumns" }), squares)?.from, "hexColumns");
    const cells: FogDraft = { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } }] };
    assert.ok(restoredHolds(state, "fogDraft", cells, rows));
    assert.equal(restoredHolds(state, "fogDraft", cells, squares), null);
    assert.ok(restoredHolds(state, "trap", trap("t1"), rows));
    assert.ok(restoredHolds(state, "trap", trap("t1", { grid: "hexRows" }), squares));
  });

  test("a value with no grid keys is never compared: a draft of rects and strokes, or a chunk emptied", () => {
    const state = room();
    const draft: FogDraft = { sceneId: "s1", rev: 1, ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } }] };
    for (const s of [rows, columns, squares]) {
      assert.equal(restoredHolds(state, "fogDraft", draft, s), null);
      assert.equal(restoredHolds(state, "chunk", chunk(), s), null);
    }
  });

  test("the phase check: in H2 a hex scene takes free walls and squeezed tokens", () => {
    for (const s of [rows, columns, squares]) assert.equal(restoredHolds(room(), "chunk", chunk({ walls: [WALL] }), s), null);
    assert.equal(restoredHolds(room(), "token", token("g", { size: "large", squeeze: true }), columns), null);
    assert.equal(restoredHolds(room(), "token", token("g", { size: "large", squeeze: true }), rows), null);
  });

  test("the phase check: from H2 a hex scene takes attach links and traps of its shape, but no pit", () => {
    const state = room({ tokens: { horse: token("horse", { size: "large" }), bree: token("bree", { attached: { to: "horse", kind: "ride" } }) } });
    assert.equal(restoredHolds(state, "trap", trap("t1", { grid: "hexRows" }), rows), null, "a trap of the scene's shape");
    const pit = trap("t1", { grid: "hexRows" });
    pit.rig = { ...pit.rig!, pit: { floor: -10 } };
    assert.deepEqual(restoredHolds(state, "trap", pit, rows), { held: [{ what: "trap", count: 1 }], from: "hexRows" }, "a pit");
    assert.ok(restoredHolds(state, "trap", trap("t1", { grid: "hexRows" }), columns), "a trap of hex rows on hex columns, by its stamp");
    assert.equal(restoredHolds(state, "token", state.tokens.bree!, rows), null, "a rider");
    assert.equal(restoredHolds(state, "token", state.tokens.horse!, rows), null, "what something rides");
    assert.equal(restoredHolds(state, "token", state.tokens.bree!, columns), null, "on hex columns");
    assert.equal(restoredHolds(state, "token", token("g"), rows), null);
    assert.equal(restoredHolds(state, "token", state.tokens.bree!, squares), null);
  });

  test("the phase check: in H2 a hex scene takes no grid-keyed content but difficult ground, whatever its stamp (D-261026-8)", () => {
    const state = room();
    const kinds: [Partial<BuildChunk>, string][] = [
      [{ cells: { "1,1": "stone" } }, "ground"],
      [{ edges: { "1,1,n": { kind: "wall" } } }, "walls"],
      [{ edges: { "1,1,n": { kind: "none" } } }, "walls"],
      [{ heights: "A".repeat(683) + "=" }, "heights"],
      [{ up: ".".repeat(256) }, "stairs"],
    ];
    for (const [s, shape] of [
      [rows, "hexRows"],
      [columns, "hexColumns"],
    ] as const) {
      for (const [content, what] of kinds) {
        assert.deepEqual(restoredHolds(state, "chunk", chunk({ ...content, grid: shape }), s), { held: [{ what, count: 1 }], from: shape }, `${what} on ${shape}`);
      }
      assert.equal(restoredHolds(state, "chunk", chunk({ rough: ROUGH, walls: [WALL], grid: shape }), s), null, `difficult ground and free walls on ${shape}`);
      const cells: FogDraft = { sceneId: "s1", rev: 1, grid: shape, ops: [{ id: "f1", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } }] };
      assert.deepEqual(restoredHolds(state, "fogDraft", cells, s), { held: [{ what: "roomFog", count: 1 }], from: shape });
    }
    const both = chunk({ cells: { "1,1": "stone" }, rough: ROUGH, walls: [WALL], grid: "hexRows" });
    assert.equal(heldList(restoredHolds(state, "chunk", both, rows)!.held), "painted ground", "only what the phase leaves out");
  });

  test("the restore's words", () => {
    const found = restoredHolds(room(), "chunk", chunk({ rough: ROUGH }), rows)!;
    assert.equal(restoreRefusal("undo", found, rows), "Can't undo that: difficult ground on squares can't stand on this scene's hexes.");
    const turned = restoredHolds(room(), "chunk", chunk({ rough: ROUGH, grid: "hexRows" }), columns)!;
    assert.equal(restoreRefusal("redo", turned, columns), "Can't redo that: difficult ground on hex rows can't stand on this scene's hex columns.");
    const own = restoredHolds(room(), "chunk", chunk({ up: ".".repeat(256), grid: "hexRows" }), rows)!;
    assert.equal(restoreRefusal("undo", own, rows), "Can't undo that: stairs can't stand on this scene's hexes.");
  });

  test("a whole scene: nothing on a square room, and the first thing out of place on a hex one", () => {
    const state = room({ buildChunks: { "s1:0,0": chunk({ rough: ROUGH, walls: [WALL] }) }, traps: { t1: trap("t1") } });
    assert.equal(sceneHolds(state, state.scenes.s1!), null);
    assert.equal(sceneHolds(state, rows)?.held[0]?.what, "rough");
    assert.equal(sceneHolds(room(), rows), null);
  });
});
