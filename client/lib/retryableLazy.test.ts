import assert from "node:assert/strict";
import { test } from "node:test";
import { roleMayLoad } from "./retryableLazy.ts";

test("a DM-only part never loads for a player, and a part with no role in its props loads for everyone", () => {
  // The map's layers carry the viewer's role (features/layers.ts LayerProps), so a player's height marks and explored outline are never mounted.
  assert.equal(roleMayLoad(["dm"], "player"), false);
  assert.equal(roleMayLoad(["dm"], "dm"), true);
  assert.equal(roleMayLoad(["dm", "player"], "player"), true);
  assert.equal(roleMayLoad(["dm"], undefined), true);
  assert.equal(roleMayLoad(["player"], "dm"), false);
});
