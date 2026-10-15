import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { P1, reveal, room, scene } from "#shared/testutil.ts";
import { groundSource, seenGround } from "./ground.ts";

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
