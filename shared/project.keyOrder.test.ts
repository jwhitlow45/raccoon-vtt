import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reordered } from "./keyOrderTestutil.ts";
import type { RoomState, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import { inSortedOrder } from "./sortedJson.ts";
import { DM, P1, P2, randomState, rng } from "./testutil.ts";

/**
 * A snapshot's collections come out in id order and a whole-build chunk
 * (projectChunkForPlayer) sorted at every depth, so a player's socket sends
 * them as they are (shared/sortedJson.ts) and copies none of them, in rooms
 * whose keys are in random orders.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

/** The collections a snapshot lists by id. */
const BY_ID = [
  "members", "scenes", "labels", "fogDrafts", "tokens", "characters", "templates", "drawings", "handouts", "monsters", "srdImages",
  "savedEncounters", "stamps", "lights", "exploredTiles", "journal", "pins", "rolls", "handoutDocs", "companionBlocks", "casts", "traps", "floorLinks",
] as const;

/** A random room whose scenes hand players the whole build: fog off and no automatic walls. */
function wholeBuild(seed: number): RoomState {
  const state = randomState(rng(seed));
  for (const id of Object.keys(state.scenes)) state.scenes[id] = { ...state.scenes[id]!, fogEnabled: false, autoWalls: "off" };
  return reordered(state, rng(seed + 500));
}

describe("a snapshot's order", () => {
  test("each collection by id, and a whole-build chunk sorted at every depth", () => {
    let chunks = 0;
    let ids = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const state = wholeBuild(seed);
      for (const viewer of [P1, P2, DISPLAY, DM]) {
        const projected = projectState(state, viewer, { sceneId: null }) as unknown as Record<string, Record<string, unknown> | undefined>;
        for (const field of BY_ID) {
          const keys = Object.keys(projected[field] ?? {});
          assert.deepEqual(keys, [...keys].sort(), `seed ${seed} ${viewer.memberId} ${field}`);
          ids += keys.length;
        }
        if (viewer.role === "dm") continue;
        for (const [key, chunk] of Object.entries(projected.buildChunks ?? {})) {
          assert.equal(inSortedOrder(chunk), chunk, `seed ${seed} ${viewer.memberId} chunk ${key}`);
          chunks++;
        }
      }
    }
    assert.ok(chunks > 100, `only ${chunks} chunks`);
    assert.ok(ids > 2_000, `only ${ids} ids`);
  });
});
