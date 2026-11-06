import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState } from "#shared/model.ts";
import { isometric, K, type Turn } from "../../lib/view.ts";
import { boardPickFor, boardPickSlot, DrawnHeightsMemo, pressAt, screenAt, type BoardPick } from "../../canvas/boardPick.ts";
import { LEAF_RISE, WALL_RISE } from "../../canvas/relief/pieces.ts";
import { CLOSED, line, OPEN, raised, world } from "../movement/testing.ts";
import { RoomScope } from "../../state/scope.ts";
import { reveal } from "#shared/testutil.ts";
import { segmentDistance } from "./doors.ts";
import { doorPillSlot } from "./store.ts";
import { DOOR_SLOP_PX, doorPieceStands, isoDoorUnder, standingLeaf, sweepGap, tapDoor } from "./tap.ts";

const CAM = { x: 500, y: 100, scale: 40 };

function pickOf(state: RoomState, turn: Turn, scale = CAM.scale): BoardPick {
  return boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: { ...CAM, scale }, lowPower: false }, new DrawnHeightsMemo());
}

/** A wall along x = 6 with a door at (6, 5), on ground raised 10 ft east of it. */
function hall(door: EdgeFeature = CLOSED) {
  return world({ edges: { ...line("w", 6, 0, 12), "6,5,w": door }, heights: raised(6, 0, 12, 12, 10) });
}

describe("a door tapped in Isometric (docs/design/design-v1-isometric-view.md 6.2)", () => {
  test("a press on a closed door's standing piece reaches it at every turn, from the higher ground beside it", () => {
    const state = hall();
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = pickOf(state, turn);
      // Halfway up the piece over the door's middle, which stands on the 10 ft side.
      const mid = screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE / 2);
      const under = (screen: { x: number; y: number }, world: { x: number; y: number }) =>
        isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: null, pick, world, screen })?.ref ?? null;
      assert.deepEqual(under(mid, { x: 6.2, y: 5.5 }), { edge: "6,5,w" }, `turn ${turn}`);
      // Well above the piece's top, past the slop, nothing.
      const above = screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE + 1);
      assert.equal(under(above, { x: 6.2, y: 5.5 }), null, `turn ${turn}, above the piece`);
    }
  });

  test("near the top of a closed door's piece, taller than the slop at this zoom, the press still reaches it, and the tap shows its pill", () => {
    const state = hall();
    const pick = pickOf(state, 0, 80);
    assert.ok(K * WALL_RISE * pick.camera.scale > DOOR_SLOP_PX + 8, "the piece is taller than the slop at this zoom");
    const top = screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE * 0.9);
    // The press meets the raised ground behind the piece, further from the door than the slop in world cells.
    const world = pressAt(pick, top);
    assert.ok(segmentDistance(world, { x: 6, y: 5 }, { x: 6, y: 6 }) > DOOR_SLOP_PX / pick.camera.scale);
    const scope = new RoomScope();
    scope.get(boardPickSlot).read = () => pick;
    const ctx = { getState: () => ({ view: state }) as never, scene: state.scenes.s1!, camera: () => pick.camera, role: "dm" as const, scope };
    assert.equal(tapDoor(ctx, "select", world, null, top), true);
    assert.deepEqual(scope.get(doorPillSlot).getState().pill, { sceneId: "s1", ref: { edge: "6,5,w" } });
  });

  test("a press on a closed door's piece on the edge of a 50 ft platform reaches it at every turn, where its ray meets ground far past it", () => {
    const state = world({ edges: { ...line("w", 6, 0, 30), "6,5,w": CLOSED }, heights: raised(0, 0, 6, 30, 50) });
    let far = 0;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = pickOf(state, turn);
      const screen = screenAt(pick, { x: 6, y: 5.5 }, 10 + WALL_RISE / 2);
      const world = pressAt(pick, screen);
      far = Math.max(far, Math.hypot(world.x - 6, world.y - 5.5));
      assert.deepEqual(isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: null, pick, world, screen })?.ref, { edge: "6,5,w" }, `turn ${turn}`);
    }
    assert.ok(far > 12, `at some turn the press means ground well past the door, past any padding of its chunk (${far.toFixed(1)} cells)`);
  });

  test("for a player who sees a door only through the far side of a cell beside it, its piece lies flat: its tap is its line and its pill hangs low", () => {
    const state = hall();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    const door = { a: { x: 6, y: 5 }, b: { x: 6, y: 6 }, mid: { x: 6, y: 5.5 }, door: CLOSED as never };
    const playerPick = () => boardPickFor({ room: state, scene: state.scenes.s1!, role: "player", fog: true, view: isometric(0), camera: { ...CAM, scale: 80 }, lowPower: false }, new DrawnHeightsMemo());
    // The east half of cell 6,5 only: the door is seen, but no sub-cell beside its line is.
    reveal(state, "s1", { x: 6.5, y: 5, w: 0.5, h: 1 });
    let pick = playerPick();
    const top = screenAt(pick, door.mid, 2 + WALL_RISE * 0.9);
    const onLine = screenAt(pick, door.mid, 2);
    const under = (screen: { x: number; y: number }) => isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: state.fogTiles, pick, world: pressAt(pick, screen), screen })?.ref ?? null;
    assert.equal(doorPieceStands(pick, door), false);
    assert.equal(under(top), null, "nothing stands there to tap");
    assert.deepEqual(under(onLine), { edge: "6,5,w" });
    // The sub-cells beside the line revealed: the piece stands, and its top takes the tap.
    reveal(state, "s1", { x: 6, y: 5, w: 0.25, h: 1 });
    pick = playerPick();
    assert.equal(doorPieceStands(pick, door), true);
    assert.deepEqual(under(screenAt(pick, door.mid, 2 + WALL_RISE * 0.9)), { edge: "6,5,w" });
  });

  test("an open door's frame and its upright leaf reach it while the detail shows, a tap on the leaf opens its pill, and below the detail only its line does (docs/design/design-v1-iso-depth.md 5.5)", () => {
    const state = hall(OPEN);
    const world = { x: 6, y: 5.5 };
    const under = (pick: BoardPick, screen: { x: number; y: number }) => isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: null, pick, world, screen })?.ref ?? null;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = pickOf(state, turn, 80);
      assert.equal(pick.src?.detail, true);
      // No floor is painted either side, so the leaf swings east, from its hinge at 6, 5.15 to 6.7, 5.15, on the 10 ft side.
      const leaf = standingLeaf(pick, { a: { x: 6, y: 5 }, b: { x: 6, y: 6 }, door: OPEN })!;
      assert.deepEqual([leaf.hx, leaf.hy, leaf.nx, leaf.ny + 0], [6, 5.15, 1, 0]);
      const onLeaf = screenAt(pick, { x: 6.6, y: 5.15 }, 2 + (WALL_RISE * LEAF_RISE) / 2);
      // At turn 0 the press lies past the slop from the frame's band and its line: only the leaf reaches it. At other turns the leaf stands in front of its frame on screen.
      const a = screenAt(pick, { x: 6, y: 5 }, 2);
      const b = screenAt(pick, { x: 6, y: 6 }, 2);
      if (turn === 0) assert.ok(sweepGap(onLeaf, a, b, K * WALL_RISE * 80) > DOOR_SLOP_PX, "the press is off the frame");
      assert.deepEqual(under(pick, onLeaf), { edge: "6,5,w" }, `turn ${turn}: the leaf`);
      assert.deepEqual(under(pick, screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE * 0.9)), { edge: "6,5,w" }, `turn ${turn}: the frame's top`);
      if (turn === 0) {
        const scope = new RoomScope();
        scope.get(boardPickSlot).read = () => pick;
        const ctx = { getState: () => ({ view: state }) as never, scene: state.scenes.s1!, camera: () => pick.camera, role: "dm" as const, scope };
        assert.equal(tapDoor(ctx, "select", pressAt(pick, onLeaf), null, onLeaf), true);
        assert.deepEqual(scope.get(doorPillSlot).getState().pill, { sceneId: "s1", ref: { edge: "6,5,w" } }, "the pill opens, the door's state untouched");
      }
      // Below the detail, at 20 px a cell, the leaf lies flat and so does the frame: only the line reaches the door.
      const low = pickOf(state, turn, 20);
      assert.equal(low.src?.detail, false);
      assert.equal(standingLeaf(low, { a: { x: 6, y: 5 }, b: { x: 6, y: 6 }, door: OPEN }), null);
      assert.equal(under(low, screenAt(low, world, 2 + WALL_RISE * 0.9 + (DOOR_SLOP_PX + 4) / (K * 20))), null, `turn ${turn}: above where the frame would stand`);
      assert.deepEqual(under(low, screenAt(low, world, 2)), { edge: "6,5,w" });
    }
  });

  test("an open door's pill hangs over its frame's top at 24 px a cell and over its line at 23, as a closed door's does", () => {
    for (const door of [OPEN, CLOSED]) {
      const state = hall(door);
      const d = { a: { x: 6, y: 5 }, b: { x: 6, y: 6 }, door };
      assert.equal(doorPieceStands(pickOf(state, 0, 24), d), true);
      assert.equal(doorPieceStands(pickOf(state, 0, 23), d), door === CLOSED, door.state);
    }
  });

  test("security: for a player a leaf over fog lies flat, so a press on where it would stand finds nothing while its frame still reaches the door", () => {
    const state = hall(OPEN);
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    // Both sides of the door's line seen, the square east of it only its first quarter: the leaf runs to 6.7.
    reveal(state, "s1", { x: 5, y: 5, w: 1.25, h: 1 });
    const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "player", fog: true, view: isometric(0), camera: { ...CAM, scale: 80 }, lowPower: false }, new DrawnHeightsMemo());
    const d = { a: { x: 6, y: 5 }, b: { x: 6, y: 6 }, door: OPEN };
    assert.equal(standingLeaf(pick, d), null);
    assert.equal(doorPieceStands(pick, d), true);
    reveal(state, "s1", { x: 5, y: 5, w: 2, h: 1 });
    const seen = boardPickFor({ room: state, scene: state.scenes.s1!, role: "player", fog: true, view: isometric(0), camera: { ...CAM, scale: 80 }, lowPower: false }, new DrawnHeightsMemo());
    assert.notEqual(standingLeaf(seen, d), null, "the square seen, the leaf stands");
  });

  test("below the stand threshold a closed door lies flat too (ISO-D12)", () => {
    const state = hall();
    const pick = pickOf(state, 0, 11);
    assert.equal(pick.src?.stand, false);
    // Where a standing piece would reach at 40 px a cell, but at this zoom past the slop above the flat line.
    const up = screenAt(pick, { x: 6, y: 5.5 }, (DOOR_SLOP_PX + 4) / (K * 11));
    assert.equal(isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: null, pick, world: { x: 6, y: 5.5 }, screen: up }), null);
  });

  test("a player's tap reaches only a door they can see", () => {
    const state = hall();
    const pick = pickOf(state, 0);
    const mid = screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE / 2);
    assert.equal(isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: {}, pick, world: { x: 6.2, y: 5.5 }, screen: mid }), null);
  });

  test("a band swept up the screen: 0 inside, the distance to its edge outside", () => {
    const a = { x: 0, y: 10 };
    const b = { x: 10, y: 15 };
    assert.equal(sweepGap({ x: 5, y: 8 }, a, b, 6), 0);
    assert.equal(sweepGap({ x: 5, y: 12.5 }, a, b, 6), 0);
    assert.ok(Math.abs(sweepGap({ x: 5, y: 14.5 }, a, b, 6) - 2 / Math.hypot(1, 0.5)) < 1e-9);
    assert.equal(sweepGap({ x: -3, y: 7 }, a, b, 6), 3);
  });
});
