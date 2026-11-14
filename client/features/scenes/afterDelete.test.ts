import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scene } from "#shared/testutil.ts";
import { deleteBlocked, LAST_SCENE, leavesPlayers, sceneAfterDelete } from "./afterDelete.ts";

/*
 * Deleting the players' scene sent them to the first scene in the list,
 * which can be one the DM is preparing in private, with nothing to warn of
 * it (LP9-PLAY-2). The delete then waited until the players were moved. It
 * now asks once and leaves them with no map until the DM moves them
 * (docs/design/design-v1-player-limits.md 5.1).
 */

const crypt = scene("crypt", { order: 0 });
const road = scene("road", { order: 1 });

describe("deleting a scene", () => {
  test("any scene but the last one can go, the players' one included", () => {
    assert.equal(deleteBlocked([crypt, road], "crypt"), null);
    assert.equal(deleteBlocked([crypt, road], "road"), null);
  });

  test("deleting the players' scene, or a scene with a floor they start on, leaves them with no map", () => {
    const floors = ["tower", "tower-upper"];
    assert.equal(leavesPlayers("road", "road"), true);
    assert.equal(leavesPlayers("road", "crypt"), false);
    assert.equal(leavesPlayers("road", null), false);
    assert.equal(leavesPlayers("road", "tower-upper", ["road", ...floors]), true);
    assert.equal(leavesPlayers("road", "crypt", ["road", ...floors]), false);
  });

  test("the last scene never can, whoever is on it", () => {
    assert.equal(deleteBlocked([road], "road"), LAST_SCENE);
  });

  test("the DM's view still lands on the first of the rest", () => {
    assert.equal(sceneAfterDelete([crypt, road], "crypt")?.id, "road");
    assert.equal(sceneAfterDelete([crypt], "crypt"), undefined);
  });
});
