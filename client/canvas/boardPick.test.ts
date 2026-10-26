import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { reveal, rng, room, scene } from "#shared/testutil.ts";
import { screenToView, viewToScreen, type Camera } from "../lib/camera.ts";
import { isometric, K, TOP_DOWN, toView, toWorld, type Turn } from "../lib/view.ts";
import { boardPickFor, drawnAt, DrawnHeightsMemo, flatPick, pressAt, pressGap, screenAt, type BoardPick } from "./boardPick.ts";

/** One chunk of scene s1 with these cells raised or lowered, in feet. */
function chunkWith(heights: Record<string, number>): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[y * CHUNK_CELLS + x] = v;
  }
  return { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
}

function heightsRoom(heights: Record<string, number>): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 }, fogEnabled: true });
  state.buildChunks["s1:0,0"] = chunkWith(heights);
  return state;
}

/** The pick the board makes for a viewer, as Stage.tsx makes it. */
function pickFor(state: RoomState, role: "dm" | "player", camera: Camera, turn: Turn = 0, memo = new DrawnHeightsMemo()): BoardPick {
  return boardPickFor({ room: state, scene: state.scenes.s1!, role, fog: true, view: isometric(turn), camera, lowPower: false }, memo);
}

const CAM: Camera = { x: 400, y: 120, scale: 40 };

describe("the board's pick (docs/design-v1-isometric-view.md 6.1)", () => {
  test("Top-down: a press means the point under it, and a gap is the world distance times the scale, as before", () => {
    const cam: Camera = { x: 13, y: -7, scale: 37 };
    const pick = flatPick(cam, { w: 20, h: 20 });
    const random = rng(4);
    for (let i = 0; i < 200; i++) {
      const p = { x: random() * 800, y: random() * 600 };
      const world = toWorld(TOP_DOWN, screenToView(cam, p));
      assert.deepEqual(pressAt(pick, p), world);
      const q = { x: random() * 20, y: random() * 20 };
      assert.equal(pressGap(pick, { world, screen: p })(q), Math.hypot(q.x - world.x, q.y - world.y) * cam.scale);
    }
  });

  test("Isometric: a press on a 10 ft platform's top means that cell, and its gap to a point there is measured where it draws", () => {
    const state = heightsRoom({ "6,6": 10 });
    const pick = pickFor(state, "dm", CAM);
    const top = screenAt(pick, { x: 6.5, y: 6.5 }, 2);
    const world = pressAt(pick, top);
    assert.equal(Math.floor(world.x), 6);
    assert.equal(Math.floor(world.y), 6);
    assert.equal(drawnAt(pick, world), 2);
    // A handle on the top, 10 px to the right of the press on screen.
    const handle = toWorld(pick.view, screenToView(CAM, { x: top.x + 10, y: top.y }), 2);
    assert.ok(Math.abs(pressGap(pick, { world, screen: top })(handle) - 10) < 1e-6);
    // Read at 0 instead, the same handle would stand K·2 view units lower.
    assert.ok(Math.abs(pressGap(pick, { world, screen: top })(handle, 0) - Math.hypot(10, 2 * K * CAM.scale)) < 1e-6);
  });

  test("a cell off the scene and every cell in Top-down draw at 0", () => {
    const state = heightsRoom({ "0,0": 20 });
    const pick = pickFor(state, "dm", CAM);
    assert.equal(drawnAt(pick, { x: 0.5, y: 0.5 }), 4);
    assert.equal(drawnAt(pick, { x: -0.5, y: 0.5 }), 0);
    assert.equal(drawnAt({ ...pick, view: TOP_DOWN }, { x: 0.5, y: 0.5 }), 0);
  });

  test("security: two scenes that differ only in heights under a player's fog give that player the same picks at every turn", () => {
    const random = rng(11);
    for (let round = 0; round < 20; round++) {
      const shown: Record<string, number> = {};
      const hiddenA: Record<string, number> = {};
      const hiddenB: Record<string, number> = {};
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const key = `${x},${y}`;
          if (x < 8) shown[key] = Math.round(random() * 6) * 5;
          else {
            hiddenA[key] = Math.round(random() * 8) * 5;
            hiddenB[key] = Math.round(random() * 8) * 5 - 10;
          }
        }
      }
      const a = heightsRoom({ ...shown, ...hiddenA });
      const b = heightsRoom({ ...shown, ...hiddenB });
      // The left half is revealed, the right half fogged.
      for (const state of [a, b]) reveal(state, "s1", { x: 0, y: 0, w: 8, h: 16 });
      const turn = (round % 4) as Turn;
      const pa = pickFor(a, "player", CAM, turn);
      const pb = pickFor(b, "player", CAM, turn);
      for (let i = 0; i < 100; i++) {
        const press = viewToScreen(CAM, toView(isometric(turn), { x: random() * 18 - 1, y: random() * 18 - 1 }, random() * 8));
        assert.deepEqual(pressAt(pa, press), pressAt(pb, press), `round ${round}, press ${i}`);
      }
      // The DM sees the hidden heights, so the same presses there differ somewhere.
      const da = pickFor(a, "dm", CAM, turn);
      const db = pickFor(b, "dm", CAM, turn);
      let differs = false;
      for (let x = 8.5; x < 16 && !differs; x++) differs = drawnAt(da, { x, y: 4.5 }) !== drawnAt(db, { x, y: 4.5 });
      assert.ok(differs, "the hidden halves differ for the DM");
    }
  });

  test("the drawn heights are made again only when the build, the fog or the threshold changes", () => {
    const state = heightsRoom({ "3,3": 10 });
    const memo = new DrawnHeightsMemo();
    const input = { chunks: state.buildChunks, sceneId: "s1", bounds: { w: 16, h: 16 }, fog: null, feetPerCell: 5, scale: 40, lowPower: false };
    const first = memo.get(input);
    assert.equal(memo.get({ ...input, scale: 41 }), first, "a zoom that keeps heights standing reads the same heights");
    assert.notEqual(memo.get({ ...input, scale: 11 }).heights, first.heights, "below the threshold they lie flat");
    assert.equal(memo.get({ ...input, scale: 11 }).heights.high, 0);
    assert.notEqual(memo.get({ ...input, chunks: { ...state.buildChunks } }).heights, first.heights);
  });
});
