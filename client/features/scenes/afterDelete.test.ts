import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";
import { scene } from "#shared/testutil.ts";
import { deleteBlocked, LAST_SCENE, sceneAfterDelete } from "./afterDelete.ts";

/*
 * Deleting the players' scene sent them to the first scene in the list,
 * which can be one the DM is preparing in private, with nothing to warn of
 * it (LP9-PLAY-2). Both delete controls now wait until the players are
 * moved, and say why.
 */

const crypt = scene("crypt", { order: 0 });
const road = scene("road", { order: 1 });

describe("deleting a scene", () => {
  test("any scene but the players' one and the last one can go", () => {
    assert.equal(deleteBlocked([crypt, road], "crypt", "road"), null);
    assert.equal(deleteBlocked([crypt, road], "road", "crypt"), null);
    assert.equal(deleteBlocked([crypt, road], "road", null), null);
  });

  test("the players' scene waits until they are moved, with the server's words", () => {
    assert.equal(deleteBlocked([crypt, road], "road", "road"), MOVE_PLAYERS_FIRST);
    assert.equal(MOVE_PLAYERS_FIRST, "Move the players to another scene first.");
  });

  test("the last scene never can, whoever is on it", () => {
    assert.equal(deleteBlocked([road], "road", "road"), LAST_SCENE);
    assert.equal(deleteBlocked([road], "road", null), LAST_SCENE);
  });

  test("the DM's view still lands on the first of the rest", () => {
    assert.equal(sceneAfterDelete([crypt, road], "crypt")?.id, "road");
    assert.equal(sceneAfterDelete([crypt], "crypt"), undefined);
  });
});
