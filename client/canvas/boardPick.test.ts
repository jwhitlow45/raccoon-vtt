import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { reveal, rng, room, scene } from "#shared/testutil.ts";
import { screenToView, viewToScreen, type Camera } from "../lib/camera.ts";
import { isometric, K, TOP_DOWN, toView, toWorld, type Turn } from "../lib/view.ts";
import { holdStill, NO_INSETS } from "../lib/camera.ts";
import { boardPickFor, drawnAt, DrawnHeightsMemo, flatPick, heldPoint, liftIn, nudgeStep, pressAt, pressGap, ringCenter, screenAt, tokenBase, type BoardPick } from "./boardPick.ts";

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

  test("a token's ring stands at its drawn base: on a seen 10 ft platform at 10 ft, and in Top-down at its corner's cell", () => {
    const state = heightsRoom({ "6,6": 10, "7,6": 10 });
    const pick = pickFor(state, "dm", CAM);
    const onTop = { size: "large" as const, x: 6, y: 5, elevation: 10 };
    assert.equal(tokenBase(pick, onTop), 2);
    assert.deepEqual(ringCenter(pick, onTop), screenAt(pick, { x: 7, y: 6 }, 2));
    const flier = { size: "medium" as const, x: 2, y: 2, elevation: 20 };
    assert.equal(tokenBase(pick, flier), 4);
    assert.equal(tokenBase({ ...pick, view: TOP_DOWN }, flier), 0);
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

describe("arrow keys move by the screen (docs/design-v1-isometric-view.md 6.5)", () => {
  test("Up is north at turn 0, west at 1, south at 2 and east at 3, and every arrow turns with it", () => {
    const compass = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as const;
    const up = [0, -1] as const;
    assert.deepEqual(nudgeStep(isometric(0), ...up), compass.north);
    assert.deepEqual(nudgeStep(isometric(1), ...up), compass.west);
    assert.deepEqual(nudgeStep(isometric(2), ...up), compass.south);
    assert.deepEqual(nudgeStep(isometric(3), ...up), compass.east);
    assert.deepEqual(nudgeStep(isometric(1), 1, 0), compass.north, "Right at turn 1 moves toward the edge facing down and to the right");
    assert.deepEqual(nudgeStep(TOP_DOWN, 0, -1), compass.north);
    assert.deepEqual(nudgeStep(TOP_DOWN, -1, 0), compass.west);
  });
});

describe("a turn or a switch keeps one point still (docs/design-v1-isometric-view.md 4.2, 6.4)", () => {
  const viewport = { width: 800, height: 600 };
  const state = heightsRoom({ "6,6": 10, "7,6": 10, "6,7": 10, "7,7": 10 });
  const pickAt = (camera: Camera, view = isometric(0) as ReturnType<typeof isometric>) => boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: true, view, camera, lowPower: false }, new DrawnHeightsMemo());

  test("Q with the selected token on screen: its ring stays where it was, raised on its platform", () => {
    const goblin = { size: "medium" as const, x: 6, y: 6, elevation: 10 };
    const cam: Camera = { x: 300, y: 200, scale: 40 };
    const was = pickAt(cam, isometric(0));
    const now = pickAt(cam, isometric(3));
    const held = heldPoint(was, now, goblin, viewport, NO_INSETS);
    const next = holdStill(cam, toView(was.view, held.at, held.before), toView(now.view, held.at, held.after));
    const before = ringCenter(was, goblin);
    const after = ringCenter({ ...now, camera: next }, goblin);
    assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, JSON.stringify([before, after]));
  });

  test("a switch to Top-down for a tool keeps the ground under the clear middle, a platform's top included", () => {
    const insets = { top: 50, right: 0, bottom: 150, left: 0 };
    const middle = { x: 400, y: 50 + (600 - 200) / 2 };
    // The platform's top under the clear middle.
    const cam0: Camera = { x: 0, y: 0, scale: 40 };
    const top = screenAt(pickAt(cam0), { x: 7, y: 7 }, 2);
    const cam: Camera = { x: middle.x - top.x, y: middle.y - top.y, scale: 40 };
    const was = pickAt(cam);
    const now = pickAt(cam, TOP_DOWN as never);
    const held = heldPoint(was, now, undefined, viewport, insets);
    assert.equal(held.before, 2, "the press met the platform's top");
    assert.equal(held.after, 0);
    const next = holdStill(cam, toView(was.view, held.at, held.before), toView(TOP_DOWN, held.at));
    const shown = viewToScreen(next, toView(TOP_DOWN, held.at));
    assert.ok(Math.abs(shown.x - middle.x) < 1e-3 && Math.abs(shown.y - middle.y) < 1e-3, JSON.stringify([shown, middle]));
    assert.ok(Math.abs(held.at.x - 7) < 1e-5 && Math.abs(held.at.y - 7) < 1e-5, JSON.stringify(held.at));
  });

  test("a selected token off the clear part of the canvas gives way to the middle", () => {
    const far = { size: "medium" as const, x: 1, y: 1, elevation: 0 };
    const cam: Camera = { x: -2000, y: -2000, scale: 40 };
    const held = heldPoint(pickAt(cam), pickAt(cam, isometric(1)), far, viewport, NO_INSETS);
    assert.notDeepEqual(held.at, { x: 1.5, y: 1.5 });
  });

  test("a fit's lift is the highest drawn ground inside its rectangle", () => {
    const heights = pickAt({ x: 0, y: 0, scale: 40 }).heights;
    assert.equal(liftIn(heights, { x: 0, y: 0, width: 16, height: 16 }), 2);
    assert.equal(liftIn(heights, { x: 0, y: 0, width: 5, height: 5 }), 0);
    assert.equal(liftIn(heights, { x: 5.5, y: 5.5, width: 1, height: 1 }), 2);
  });
});

