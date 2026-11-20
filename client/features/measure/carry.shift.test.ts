import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { chunkKey } from "#shared/keys.ts";
import { CHUNK_CELLS, type FloorLink, type RoomState, type SceneId } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { P1 } from "#shared/testutil.ts";
import { WAITS } from "../floors/openings.testing.ts";
import { farShift, priorOut, stairsPlan, type Stairs } from "./carry.ts";
import { tokenStop } from "./ruler.ts";
import type { WalkInput } from "./walkRuler.ts";

/*
 * A carried ruler over stairs whose ends lie on different squares
 * (docs/design/design-v1-floors.md phase 4, 8.2, D-261119-008): the landing
 * moves by the far end's offset where the device knows it, a player's end
 * carrying it as `shift` only while the far end is projected to them, and
 * the price never changes. Stairs one square at 8, 3 on Ground floor, and
 * Thorn on them. On Upper floor the far end lies 3 squares east, at 11, 3,
 * on ground 5 ft up.
 */

const ALL: SceneId[] = [GROUND, UPPER];
const NEAR = { x: 8, y: 3, w: 1, h: 1 };

/** The tower with the stairs and Thorn on them, and Upper floor's ground at 11, 3 painted 5 ft up, the far end there or on the same squares. */
function room(farAt: { x: number; y: number } = NEAR): RoomState {
  const s = withStairs(tower(), { rect: NEAR });
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  feet[3 * CHUNK_CELLS + 11] = 5;
  const chunk = { sceneId: UPPER, cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
  const far: FloorLink = { ...s.floorLinks!.l2!, rect: { ...NEAR, ...farAt } };
  return {
    ...s,
    tokens: { ...s.tokens, thorn: { ...s.tokens.thorn!, x: 8, y: 3 } },
    floorLinks: { ...s.floorLinks!, l2: far },
    buildChunks: { ...s.buildChunks, [chunkKey(UPPER, 0, 0)]: chunk },
    openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } },
  };
}

function plan(view: RoomState, role: "dm" | "player"): Stairs | null {
  const stops = [tokenStop(SQUARES, view.tokens.thorn!)];
  const walkInput: WalkInput = { view, sceneId: GROUND, stops, viewer: { role }, everything: role === "dm" };
  return stairsPlan({ role, share: false, rulerId: "r1", walkInput, walked: null, carried: null, held: ALL, whole: view });
}

/** Ana's copy, her end of the stairs with or without the `shift` the projection sends once the far end is projected to her. */
function anaCopy(s: RoomState, shift: { dx: number; dy: number } | null): RoomState {
  const ana = projectState(s, P1, { sceneId: GROUND }) as unknown as RoomState;
  const end = ana.floorLinks!.l1!;
  return { ...ana, floorLinks: { ...ana.floorLinks!, l1: (shift ? { ...end, shift } : end) as FloorLink } };
}

describe("a carried ruler over stairs with ends on different squares (phase 4, 8.2)", () => {
  test("Ana's end without `shift` lands on the same squares, and with it 3 squares east on the ground there, at one price", () => {
    const s = room({ x: 11, y: 3 });
    const same = plan(anaCopy(s, null), "player")!;
    assert.deepEqual(same.plan.stop, { x: 8.5, y: 3.5 }, "the far end fogged: the same squares, as the server lands her at the stored end");
    assert.equal(same.offer.shift, null);
    const moved = plan(anaCopy(s, { dx: 3, dy: 0 }), "player")!;
    assert.deepEqual(moved.plan.stop, { x: 11.5, y: 3.5, z: 5 }, "revealed: the far end's middle, on its ground");
    assert.equal(moved.plan.carry.prior.ft, same.plan.carry.prior.ft, "the climb costs the same either way");
    assert.deepEqual(moved.plan.carry.landing, moved.plan.stop);
    assert.deepEqual(priorOut(moved.plan.carry.prior), priorOut(same.plan.carry.prior), "the frame's prior tells nothing of the offset");
  });

  test("the DM's copy lands by the stored pair's offset", { skip: WAITS.landingShift }, () => {
    const s = room({ x: 11, y: 3 });
    assert.deepEqual(farShift(s, s.floorLinks!.l1!), { dx: 3, dy: 0 });
    assert.deepEqual(plan(s, "dm")!.plan.stop, { x: 11.5, y: 3.5, z: 5 });
  });

  test("a pair on the same squares lands in place on the DM's copy, and an end whose pair the copy lacks too", () => {
    const s = room();
    assert.equal(farShift(s, s.floorLinks!.l1!), null);
    assert.deepEqual(plan(s, "dm")!.plan.stop, { x: 8.5, y: 3.5 });
    const { l2: _far, ...lone } = s.floorLinks!;
    assert.equal(farShift({ floorLinks: lone }, s.floorLinks!.l1!), null);
  });

  test("an opening is never offered to a ruler, even to a walker on the ground over its lower end", () => {
    const s = withOpening(tower());
    const thorn = { ...s.tokens.thorn!, x: 6, y: 6 };
    const view = { ...s, tokens: { ...s.tokens, thorn } };
    assert.equal(plan(view, "dm"), null);
    assert.equal(plan(projectState(view, P1, { sceneId: GROUND }) as unknown as RoomState, "player"), null);
  });
});
