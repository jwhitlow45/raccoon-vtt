import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER } from "#shared/floorLinksTestutil.ts";
import type { RoomState, TerrainId } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { openTower, pc, withAll } from "#shared/openingsTestutil.ts";
import { FULL_TILE_BITS } from "#shared/testutil.ts";
import { playerView } from "./playerView.ts";

/*
 * The player view export of a floor nobody looks at
 * (docs/design/design-v1-floors.md phase 4, 9.3, D-261119-087): its room
 * drops the creatures of every floor of the exported floor's scene, so a
 * party on the next floor lends no live sight through an opening into a
 * file labeled for players (O15).
 */

/**
 * Ground floor dark under a bright Upper floor, Thorn upstairs looking down
 * the hole, and a cell under the hole painted `terrain` or not since the
 * party explored it and remembered it bare: only live sight shows the
 * paint.
 */
function room(terrain: TerrainId | null, over: (s: RoomState) => RoomState = (s) => s): RoomState {
  const s = withAll(openTower({ ground: "dark", upper: "bright" }), [pc("thorn", "p1", UPPER, 3, 3)]);
  const cells: Record<string, TerrainId> = terrain ? { "6,6": terrain } : {};
  const explored = { [tileKey(GROUND, 0, 0)]: { sceneId: GROUND, tx: 0, ty: 0, rev: 1, bits: FULL_TILE_BITS } };
  const memory = { [`${GROUND}:0,0`]: { sceneId: GROUND, cx: 0, cy: 0, rev: 1, cells: { "6,6": null } } };
  // Paint makes no automatic walls here, so the paint alone tells the two rooms apart.
  const scenes = { ...s.scenes, [GROUND]: { ...s.scenes[GROUND]!, autoWalls: "off" as const } };
  return over({ ...s, scenes, exploredTiles: explored, memory, buildChunks: { ...s.buildChunks, [`${GROUND}:0,0`]: { sceneId: GROUND, cx: 0, cy: 0, rev: 1, cells, edges: {} } } });
}

const blackout = (s: RoomState): RoomState => ({ ...s, meta: { ...s.meta, view: { ...s.meta.view, blackout: true } } });
const elsewhere = (s: RoomState): RoomState => ({ ...s, meta: { ...s.meta, playerSceneId: "s2" } });

describe("the player view of a floor next to the party (O15)", () => {
  test("players looking see the cell under the hole live through the opening", () => {
    assert.notDeepEqual(playerView(room("stone"), GROUND), playerView(room(null), GROUND));
  });

  test("behind a blackout, and after the party leaves the scene, the cell under the hole is not live", () => {
    for (const [name, over] of [
      ["a blackout", blackout],
      ["the party on another scene", elsewhere],
    ] as const) {
      assert.deepEqual(playerView(room("stone", over), GROUND), playerView(room(null, over), GROUND), name);
      assert.deepEqual(playerView(room("stone", over), GROUND), playerView(room("grass", over), GROUND), name);
    }
  });
});
