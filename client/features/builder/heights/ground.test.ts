import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { P1, reveal, room, scene } from "#shared/testutil.ts";
import { NO_INSETS } from "../../../lib/camera.ts";
import { cellReadout, groundSource, pillOutline, readoutOf, readoutPlace, seenGround } from "./ground.ts";

/** One chunk of scene s1 with these cells raised or lowered, in feet. */
function chunkWith(heights: Record<string, number>): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[y * CHUNK_CELLS + x] = v;
  }
  return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
}

/** A 10 by 8 scene with fog on: a platform 10 ft up at (2, 2), a pit 10 ft down at (5, 5). */
function fogged(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 10, h: 8 }, fogEnabled: true });
  state.buildChunks["s1:0,0"] = chunkWith({ "2,2": 10, "5,5": -10, "9,7": 5 });
  return state;
}

describe("the ground a viewer may read", () => {
  test("the DM reads all of it, fog or not", () => {
    const state = fogged();
    const dm = groundSource(state, state.scenes.s1!, "dm");
    assert.equal(seenGround(dm, { x: 2, y: 2 }), 10);
    assert.equal(seenGround(dm, { x: 5, y: 5 }), -10);
    assert.equal(seenGround(dm, { x: 0, y: 0 }), 0);
  });

  test("a player reads nothing a fully fogged cell holds, and all of a cell with any part revealed", () => {
    const state = fogged();
    const player = () => groundSource(state, state.scenes.s1!, "player");
    assert.equal(seenGround(player(), { x: 2, y: 2 }), null, "fully fogged");
    assert.equal(seenGround(player(), { x: 0, y: 0 }), null, "ground at 0 under the fog says nothing either");
    // A quarter of the cell's width revealed is enough, as a door counts it.
    reveal(state, "s1", { x: 2.75, y: 2, w: 0.25, h: 1 });
    assert.equal(seenGround(player(), { x: 2, y: 2 }), 10);
    assert.equal(seenGround(player(), { x: 5, y: 5 }), null);
  });

  test("ground the party explored counts as seen, as the merged fog shows it", () => {
    const state = fogged();
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark" } };
    const changes = rasterizeFogOps({}, "s1", { w: 10, h: 8 }, [{ id: "e", mode: "reveal", shape: { kind: "rect", x: 5, y: 5, w: 1, h: 1 } }]);
    for (const [key, tile] of Object.entries(changes)) if (tile) state.exploredTiles[key] = tile;
    const mine = projectState(state, P1, { sceneId: "s1" });
    const src = groundSource(mine as unknown as RoomState, state.scenes.s1!, "player");
    assert.equal(seenGround(src, { x: 5, y: 5 }), -10);
    assert.equal(seenGround(src, { x: 2, y: 2 }), null);
  });

  test("with fog off a player reads all of it", () => {
    const state = fogged();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: false };
    const src = groundSource(state, state.scenes.s1!, "player");
    assert.equal(seenGround(src, { x: 2, y: 2 }), 10);
    assert.equal(seenGround(src, { x: 5, y: 5 }), -10);
  });

  test("outside the scene there is no ground, even where a shrunk scene left a height", () => {
    const state = fogged();
    state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 9, h: 7 } };
    const dm = groundSource(state, state.scenes.s1!, "dm");
    assert.equal(seenGround(dm, { x: 9, y: 7 }), null);
    assert.equal(seenGround(dm, { x: -1, y: 0 }), null);
    assert.equal(seenGround(dm, { x: 0, y: 7 }), null);
  });
});

describe("what the readout says", () => {
  test("every row of the table: the pill, the words spoken, and the outline", () => {
    assert.deepEqual(readoutOf(10, undefined), { pill: "↑10 ft", spoken: "Ground 10 ft up.", edge: "raised" });
    assert.deepEqual(readoutOf(-10, undefined), { pill: "↓10 ft", spoken: "Ground 10 ft down.", edge: "lowered" });
    assert.deepEqual(readoutOf(0, "e"), { pill: "Stairs", spoken: "Stairs, up to the east.", edge: "raised" });
    assert.deepEqual(readoutOf(5, null), { pill: "Stairs · ↑5 ft", spoken: "Stairs, 5 ft up.", edge: "raised" });
    assert.deepEqual(readoutOf(5, "e"), { pill: "Stairs · ↑5 ft", spoken: "Stairs, 5 ft up, up to the east.", edge: "raised" });
    assert.equal(readoutOf(0, undefined), null, "ground at 0 says nothing");
    assert.equal(readoutOf(100, undefined)?.pill, "↑100 ft");
  });

  test("a stair in a pit takes the light outline, since it is the way up", () => {
    assert.deepEqual(readoutOf(-10, "n"), { pill: "Stairs · ↓10 ft", spoken: "Stairs, 10 ft down, up to the north.", edge: "raised" });
    assert.equal(readoutOf(0, null)?.spoken, "Stairs.");
  });

  test("a cell reads its stair as movement does, and says nothing outside the scene or under the fog", () => {
    const state = fogged();
    const walls = { stairAt: (x: number, y: number) => (x === 4 && y === 2 ? ("e" as const) : undefined) };
    const dm = groundSource(state, state.scenes.s1!, "dm");
    assert.equal(cellReadout(dm, walls, { x: 4, y: 2 })?.spoken, "Stairs, up to the east.");
    assert.equal(cellReadout(dm, walls, { x: 2, y: 2 })?.spoken, "Ground 10 ft up.");
    assert.equal(cellReadout(dm, walls, { x: 3, y: 3 }), null);
    assert.equal(cellReadout(dm, walls, { x: 12, y: 2 }), null);
    const player = groundSource(state, state.scenes.s1!, "player");
    assert.equal(cellReadout(player, walls, { x: 4, y: 2 }), null, "a stair under the fog is not named");
    assert.equal(cellReadout(player, walls, { x: 2, y: 2 }), null);
  });
});

describe("where the readout's pill sits", () => {
  /** A phone held upright: the top bar over the map, and the toolbar and its options under it. */
  const phone = { width: 390, height: 760 };
  const bars = { top: 56, right: 0, bottom: 140, left: 0 };
  const pill = { width: 48, height: 22 };

  test("over the cell with its pointer down to the center", () => {
    const at = readoutPlace({ anchor: { x: 200, y: 400 }, viewport: phone, insets: bars, ...pill })!;
    assert.deepEqual(at, { left: 176, top: 400 - 2 - 28, pointer: { side: "down", x: 24 } });
  });

  test("a cell just under the top bar flips the pill below it, pointing up", () => {
    const at = readoutPlace({ anchor: { x: 200, y: 70 }, viewport: phone, insets: bars, ...pill })!;
    assert.equal(at.top, 72);
    assert.deepEqual(at.pointer, { side: "up", x: 24 });
  });

  test("a cell at a phone's left or right edge slides the pill, its pointer still on the cell", () => {
    const left = readoutPlace({ anchor: { x: 20, y: 400 }, viewport: phone, insets: bars, ...pill })!;
    assert.equal(left.left, 8);
    assert.deepEqual(left.pointer, { side: "down", x: 12 });
    const right = readoutPlace({ anchor: { x: 370, y: 400 }, viewport: phone, insets: bars, ...pill })!;
    assert.equal(right.left, 390 - 8 - 48);
    assert.deepEqual(right.pointer, { side: "down", x: 370 - 334 });
  });

  test("a corner cell beside a bar shows a clamped pill with no pointer", () => {
    const at = readoutPlace({ anchor: { x: 6, y: 615 }, viewport: phone, insets: bars, ...pill })!;
    assert.equal(at.left, 8);
    assert.equal(at.pointer, null, "the center is past the pill's rounded corner");
  });

  test("a cell panned under a dock or a bar hides the pill", () => {
    assert.equal(readoutPlace({ anchor: { x: 200, y: 700 }, viewport: phone, insets: bars, ...pill }), null);
    assert.equal(readoutPlace({ anchor: { x: 200, y: 30 }, viewport: phone, insets: bars, ...pill }), null);
    assert.equal(readoutPlace({ anchor: { x: -4, y: 400 }, viewport: phone, insets: NO_INSETS, ...pill }), null);
  });

  test("the outline merges the pointer into the edge it points from", () => {
    assert.equal(pillOutline(48, 22, null), "M 6 0 H 42 A 6 6 0 0 1 48 6 V 16 A 6 6 0 0 1 42 22 H 6 A 6 6 0 0 1 0 16 V 6 A 6 6 0 0 1 6 0 Z");
    assert.match(pillOutline(48, 22, { side: "down", x: 24 }), /H 29 L 24 28 L 19 22 H 6/);
    assert.match(pillOutline(48, 22, { side: "up", x: 24 }), /^M 6 6 H 19 L 24 0 L 29 6 H 42/);
  });
});
