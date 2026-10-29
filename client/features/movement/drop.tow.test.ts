import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { planMove } from "#shared/rules/moveLeg.ts";
import { legStop, ownWalk } from "#shared/rules/movement.ts";
import { apply, DM, room, scene, token } from "#shared/testutil.ts";
import { walkersStop } from "./drop.ts";

/**
 * Where a drag's straight walk is cut so the creatures it drags can follow
 * (drop.ts walkersStop), down a chain of drags: each creature stands as it
 * follows its own holder (moveLeg.ts follow), so the cut is where the
 * server's leg test of some creature in the chain stops it
 * (permissions.ts draggedWalls), and there is none where it stops none.
 */

function raised(heights: Record<string, number>): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 14 }, blockMovement: true }) } });
  for (const [cell, height] of Object.entries(heights)) s = apply(s, { t: "build.height", sceneId: "s1", cells: [cell], height } as Op);
  return s;
}

/** A chain down column 4 from the lead at row 4, each creature at `heights[i]` dragged by the one before it, the lead's straight walk 3 squares east. */
function straightEast(s: RoomState, heights: readonly number[]): { cut: boolean; refused: boolean } {
  const ids = heights.map((_, i) => `c${i}`);
  const tokens: Token[] = heights.map((elevation, i) => token(ids[i]!, { name: `Creature ${i}`, x: 4, y: 4 + i, elevation, ...(i > 0 ? { attached: { to: ids[i - 1]!, kind: "drag" as const } } : {}) }));
  s.tokens = { ...s.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) };
  const lead = tokens[0]!;
  const points = [
    { x: 4, y: 4, elevation: lead.elevation },
    { x: 7, y: 4, elevation: lead.elevation },
  ];
  const cut = walkersStop(s, ownWalk(lead), points, tokens.slice(1)) !== null;
  const moved = planMove({ t: "token.move", tokenId: lead.id, x: 7, y: 4 }, s, DM, {}).filter((mv) => mv.carriedBy !== undefined);
  const refused = moved.some((mv) => mv.route.some((p, i) => i > 0 && legStop(s, mv.trace[i - 1]!, p) !== null));
  return { cut, refused };
}

describe("a drag's straight walk cut for a chain of drags on squares", () => {
  test("two deep, 5, 0 and 5 ft: the last creature walks on the ground behind its holder, so a 2 ft square in its row cuts the walk", () => {
    assert.deepEqual(straightEast(raised({ "6,6": 2 }), [5, 0, 5]), { cut: true, refused: true });
  });

  test("three deep, with a creature on a causeway dragging one at 10 ft that walks on its own ground", () => {
    const causeway: Record<string, number> = {};
    for (let x = 2; x <= 9; x++) causeway[`${x},6`] = 5;
    assert.deepEqual(straightEast(raised({ ...causeway, "6,7": 2 }), [10, 10, 5, 10]), { cut: true, refused: true });
  });

  test("fliers all down the chain pass over the low square, uncut", () => {
    assert.deepEqual(straightEast(raised({ "6,6": 2 }), [10, 10, 10]), { cut: false, refused: false });
  });
});
