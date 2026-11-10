import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * A found trap's name draws on the overlay layer, above the fog and the dark
 * (LP33-B polish note). The e2e step tr-5 reads the real stage.
 */

const { LAYERS, isoPlacesOf } = await import("../layers.ts");
const { nameStands } = await import("./TrapLayer.tsx");

test("the trap names stand in an overlay entry the isometric view leaves to the traps layer, and the board layer's mark draws no name in Top-down", () => {
  const names = LAYERS.find((l) => l.id === "trapNames");
  const traps = LAYERS.find((l) => l.id === "traps");
  assert.ok(names && traps, "both entries are registered");
  assert.equal(names.layer, "overlay");
  assert.deepEqual([...isoPlacesOf(names)], ["off"], "the isometric view leaves the names to the traps layer");
  assert.equal(traps.layer, "board");
  assert.equal(traps.order, 35);
  assert.deepEqual([...isoPlacesOf(traps)], ["ground", "upright"]);
  assert.ok(names.order > traps.order, "the names draw above the marks");
  const name = { x: 1, y: 1, text: "Pit", anchor: { x: 1, y: 1 } } as never;
  assert.equal(nameStands(name, null, 40), false, "Top-down: the mark draws no name");
});
