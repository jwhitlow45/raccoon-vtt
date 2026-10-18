import assert from "node:assert/strict";
import { test } from "node:test";
import { preloadInBackground, preloadLazies, roleMayLoad, type Network } from "./retryableLazy.ts";

test("a DM-only part never loads for a player, and a part with no role in its props loads for everyone", () => {
  // The map's layers carry the viewer's role (features/layers.ts LayerProps), so a player's height marks and explored outline are never mounted.
  assert.equal(roleMayLoad(["dm"], "player"), false);
  assert.equal(roleMayLoad(["dm"], "dm"), true);
  assert.equal(roleMayLoad(["dm", "player"], "player"), true);
  assert.equal(roleMayLoad(["dm"], undefined), true);
  assert.equal(roleMayLoad(["player"], "dm"), false);
});

test("the background loads wait while the device is offline, start once it is back online, and start only once", () => {
  const loads: string[] = [];
  preloadInBackground(async () => void loads.push("both"), ["dm", "player"]);
  preloadInBackground(async () => void loads.push("dm"), ["dm"]);
  let online = false;
  const waiting: (() => void)[] = [];
  const network: Network = { online: () => online, onceOnline: (go) => void waiting.push(go) };

  preloadLazies("dm", network);
  preloadLazies("dm", network);
  assert.deepEqual(loads, [], "nothing starts offline, where it could only fail");
  assert.equal(waiting.length, 2, "each call waits for the device to be back online");

  online = true;
  for (const go of waiting.splice(0)) go();
  assert.deepEqual(loads, ["both", "dm"], "back online, each load starts once");
  preloadLazies("dm", network);
  preloadLazies("player", network);
  assert.deepEqual(loads, ["both", "dm"], "a load already started never starts again, and the DM's never starts for a player");
});
