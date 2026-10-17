import assert from "node:assert/strict";
import { test } from "node:test";
import { loadedMonsters, loadMonsters, onMonstersLoaded } from "./monsters.ts";

/*
 * The SRD blocks as an external store (client/features/monsters/srdBlocks.ts),
 * in a file of its own so the module starts with nothing loaded (GGA-05).
 */

test("a load another view finishes between this view's render and its subscription still reaches it", async () => {
  // View A rendered and subscribed, and its effect started the load.
  let heard = 0;
  let atHearing: unknown = null;
  const stopA = onMonstersLoaded(() => {
    heard++;
    atHearing = loadedMonsters();
  });
  const load = loadMonsters();
  // View B renders now, before the load is in, so its snapshot is empty.
  const renderedB = loadedMonsters();
  assert.equal(renderedB, null);
  await load;
  assert.equal(heard, 1, "A hears the load once");
  assert.notEqual(atHearing, null, "and the blocks are there when it does");
  // B's effect subscribes only now. useSyncExternalStore reads the snapshot again as it subscribes, and a new one draws B again.
  const stopB = onMonstersLoaded(() => {});
  assert.notEqual(loadedMonsters(), renderedB, "B's snapshot has changed, so B draws the blocks");
  assert.equal(loadedMonsters(), loadedMonsters(), "one array, so a snapshot read twice never loops");
  stopA();
  stopB();
  await loadMonsters();
  assert.equal(heard, 1, "a listener that stopped hears nothing more");
});
