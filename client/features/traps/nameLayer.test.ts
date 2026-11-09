import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * A found trap's name draws on the overlay layer, above the fog and the dark
 * (LP33-B polish note). The e2e step tr-5 reads the real stage.
 */

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the trap names stand in an overlay entry the isometric view leaves to the traps layer, and the board layer's mark draws no name in Top-down", () => {
  const layers = read("layers.ts");
  assert.match(layers, /\{ id: "trapNames", layer: "overlay", order: \d+, iso: "off", Component: TrapNameLayer \}/);
  assert.match(layers, /\{ id: "traps", layer: "board", order: 35, iso: \["ground", "upright"\], Component: TrapLayer \}/);
  const source = read("traps/TrapLayer.tsx");
  assert.match(source, /const nameHere = name !== null && iso !== null && /, "only an isometric tree's mark draws a name");
  assert.match(source, /<MarkPill \{\.\.\.name\} scale=\{props\.scale\} color=\{lookOf\(trap as SeenTrap, dm\)\.color\} \/>/, "TrapNameLayer draws the pill");
});
