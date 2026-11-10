import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, putOp, run, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { serializedBytes } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM } from "#shared/testutil.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { checkWholeScenes, growthBound, projectedSceneBytes, SizeGuard } from "./sizeGuard.ts";

/**
 * Stairs and ladders in the size guard (docs/design/design-v1-floors.md
 * phase 2, 2, lane FL2-C): a scene's measure counts both ends of every
 * pair, which a DM's projection of any of its floors holds, and the bound
 * of an op that places a pair holds the measure's growth.
 */

/** Ends enough on the tower to weigh: stairs from Ground floor and a ladder from Upper floor, under long ids. */
function stairs(): RoomState {
  const long = (c: string) => c.repeat(60);
  let s = withStairs(tower(), { id: long("a"), pairId: long("b") });
  s = run(s, putOp({ id: long("c"), pairId: long("d"), sceneId: UPPER, to: ATTIC, kind: "ladder", rect: { x: 8, y: 8, w: 1, h: 1 } }));
  return s;
}

describe("the size guard on stairs and ladders", () => {
  test("every floor's measure counts both ends of each pair, and holds the DM's projection from any floor", () => {
    const state = stairs();
    // The same room without its stairs, the reducer's bookkeeping since kept.
    const { floorLinks: _links, ...bare } = state;
    const ends = Object.values(state.floorLinks!);
    assert.equal(ends.length, 4);
    const grew = projectedSceneBytes(state, GROUND) - projectedSceneBytes(bare, GROUND);
    const everyEnd = ends.reduce((sum, end) => sum + serializedBytes(end), 0);
    assert.ok(grew >= everyEnd, `the measure grew by ${grew}, at least the ${everyEnd} bytes of all four ends`);
    const dmGrew = serializedBytes(projectState(state, DM, { sceneId: GROUND })) - serializedBytes(projectState(bare, DM, { sceneId: GROUND }));
    assert.ok(grew >= dmGrew, `the measure grew by ${grew}, at least the DM's projection's ${dmGrew}, its field and braces included`);
    for (const sceneId of [GROUND, UPPER, ATTIC]) {
      assert.equal(projectedSceneBytes(state, sceneId), projectedSceneBytes(state, GROUND), `${sceneId} measures as its scene`);
      const projected = serializedBytes(projectState(state, DM, { sceneId }));
      assert.ok(projected <= projectedSceneBytes(state, sceneId), `the DM's projection from ${sceneId}, ${projected}, within the measure`);
    }
    // Another scene's measure carries none of them.
    assert.equal(projectedSceneBytes(state, "s2"), projectedSceneBytes(bare, "s2"));
  });

  test("an import counts the ends too: a tower that fits without them and not with them is refused", () => {
    const state = stairs();
    // The import's check leaves out what players' copies may add, as a player's measure does.
    const limit = projectedSceneBytes(state, GROUND, MEMORY_CAP, "player") - 1;
    assert.equal(checkWholeScenes(tower(), limit).ok, true);
    assert.equal(checkWholeScenes(state, limit).ok, false);
  });

  test("placing a pair is bounded by both its ends, so the guard's quick answer never passes what the measure refuses", () => {
    const before = tower();
    const after = stairs();
    const touched = Object.keys(after.floorLinks!).map((id) => `floorLink:${id}`);
    const bound = growthBound(before, after, touched);
    const grew = projectedSceneBytes(after, GROUND) - projectedSceneBytes(before, GROUND);
    assert.ok(bound >= grew, `the bound ${bound} holds the measure's growth ${grew}`);
    const guard = new SizeGuard({ stateLimit: 8 * 1024 * 1024, sceneLimit: projectedSceneBytes(after, GROUND) - 1 });
    assert.equal(guard.check(before, [GROUND], 0, before).ok, true);
    assert.equal(guard.check(after, [GROUND, UPPER, ATTIC], bound, before).ok, false);
  });
});
