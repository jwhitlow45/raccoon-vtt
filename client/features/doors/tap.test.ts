import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState } from "#shared/model.ts";
import { isometric, K, type Turn } from "../../lib/view.ts";
import { boardPickFor, DrawnHeightsMemo, screenAt, type BoardPick } from "../../canvas/boardPick.ts";
import { WALL_RISE } from "../../canvas/relief/pieces.ts";
import { CLOSED, line, OPEN, raised, world } from "../movement/testing.ts";
import { DOOR_SLOP_PX, isoDoorUnder, sweepGap } from "./tap.ts";

const CAM = { x: 500, y: 100, scale: 40 };

function pickOf(state: RoomState, turn: Turn, scale = CAM.scale): BoardPick {
  return boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: { ...CAM, scale }, lowPower: false }, new DrawnHeightsMemo());
}

/** A wall along x = 6 with a door at (6, 5), on ground raised 10 ft east of it. */
function hall(door: EdgeFeature = CLOSED) {
  return world({ edges: { ...line("w", 6, 0, 12), "6,5,w": door }, heights: raised(6, 0, 12, 12, 10) });
}

describe("a door tapped in Isometric (docs/design-v1-isometric-view.md 6.2)", () => {
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

  test("an open door lies flat: only its line on the ground reaches it", () => {
    const state = hall(OPEN);
    const pick = pickOf(state, 0, 80);
    const onLine = screenAt(pick, { x: 6, y: 5.5 }, 2);
    const up = screenAt(pick, { x: 6, y: 5.5 }, 2 + WALL_RISE);
    const under = (screen: { x: number; y: number }) => isoDoorUnder({ chunks: state.buildChunks, sceneId: "s1", fog: null, pick, world: { x: 6, y: 5.5 }, screen })?.ref ?? null;
    assert.deepEqual(under(onLine), { edge: "6,5,w" });
    assert.ok(K * WALL_RISE * pick.camera.scale > DOOR_SLOP_PX, "the piece is taller than the slop at this zoom");
    assert.equal(under(up), null);
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
