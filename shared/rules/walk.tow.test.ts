import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { apply, DM, room, scene, token } from "../testutil.ts";
import { planMove } from "./moveLeg.ts";
import { legStop, ownWalk } from "./movement.ts";
import { findRoute, type WalkRoute } from "./walk.ts";
import { groupWalkWorld } from "./walkWorld.ts";

/**
 * A chain of drags on squares (docs/design-v1-attach.md 4.2): each
 * creature follows its own holder (moveLeg.ts follow), so the way a drag
 * finds is one the server's leg test takes for every creature in the chain
 * (permissions.ts draggedWalls), however deep, flying or on the ground.
 */

/** A square scene whose moves walls and ledges stop, with heights painted through the reducer. */
function raised(heights: Record<string, number>): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 14 }, blockMovement: true }) } });
  for (const [cell, height] of Object.entries(heights)) s = apply(s, { t: "build.height", sceneId: "s1", cells: [cell], height } as Op);
  return s;
}

/**
 * A chain down column 4 from the lead at row 4, each creature at
 * `heights[i]` and dragged by the one before it, the lead sent 3 squares
 * east: what the search answers, and whether every dragged creature's walk
 * passes the server's leg test.
 */
function chain(s: RoomState, heights: readonly number[]): { found: WalkRoute | null | "none"; follows: boolean } {
  const ids = heights.map((_, i) => `c${i}`);
  const tokens = heights.map((elevation, i) => token(ids[i]!, { name: `Creature ${i}`, x: 4, y: 4 + i, elevation, ...(i > 0 ? { attached: { to: ids[i - 1]!, kind: "drag" as const } } : {}) }));
  s.tokens = { ...s.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) };
  const lead = tokens[0]!;
  const world = groupWalkWorld(s, ownWalk(lead), { role: "dm" });
  assert.equal(world.input.towed?.length, heights.length - 1);
  const to = { x: 7, y: 4 };
  const found = findRoute(world.input, to);
  if (found === "none") return { found, follows: true };
  const op: Op = { t: "token.move", tokenId: lead.id, x: to.x, y: to.y, ...(found ? { route: found.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim] as [number, number, number, 0 | 1]) } : {}) };
  const moved = planMove(op, s, DM, {}).filter((mv) => mv.carriedBy !== undefined);
  assert.equal(moved.length, heights.length - 1);
  const follows = moved.every((mv) => mv.route.every((p, i) => i === 0 || legStop(s, mv.trace[i - 1]!, p) === null));
  return { found, follows };
}

describe("a chain of drags on squares", () => {
  test("two deep: a flier drags a creature on the ground, which drags one at 5 ft, and that one follows its own holder down to the ground", () => {
    const { found, follows } = chain(raised({ "6,6": 2 }), [5, 0, 5]);
    assert.notEqual(found, null, "the last creature walks on the ground behind its holder, so a 2 ft square in its row is a ledge to it");
    assert.equal(follows, true);
  });

  test("three deep: a flier and a flier drag a creature on a causeway, which drags one at 10 ft that walks on its own ground", () => {
    const causeway: Record<string, number> = {};
    for (let x = 2; x <= 9; x++) causeway[`${x},6`] = 5;
    const { found, follows } = chain(raised({ ...causeway, "6,7": 2 }), [10, 10, 5, 10]);
    assert.notEqual(found, null);
    assert.equal(follows, true);
  });

  test("fliers all down the chain pass over a low square together, straight", () => {
    const { found, follows } = chain(raised({ "6,6": 2 }), [10, 10, 10]);
    assert.ok(found !== null && found !== "none");
    assert.equal(found.pieces.length, 1, "one straight piece, at the drag's extra foot");
    assert.equal(follows, true);
  });
});
