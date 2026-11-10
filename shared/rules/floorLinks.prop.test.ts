import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "../propertyTestutil.ts";
import { scene } from "../testutil.ts";
import { endRegion } from "./floorLinks.ts";
import { isHex, sceneGrid, type Grid } from "./grid.ts";
import { cornerAt, hexCorners } from "./hex.ts";
import { LATTICE } from "./segments.ts";

/**
 * Property test of the stairs check's wall filter (floorLinks.ts
 * wallInside, FL2-OPUS-3): it skips the exact test for a wall whose two
 * ends lie past one side of the squares' box, which is right only while no
 * such wall crosses the squares. So for any squares and any segment, on
 * squares and on both hex grids, a segment the box drops is one the exact
 * test refuses too.
 */

const GRIDS: readonly Grid[] = [sceneGrid(scene("sq")), sceneGrid(scene("hr", { gridShape: "hexRows" })), sceneGrid(scene("hc", { gridShape: "hexColumns" }))];

const rects = fc.record({ x: fc.integer({ min: 0, max: 12 }), y: fc.integer({ min: 0, max: 12 }), w: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 1, max: 4 }) });
const lattice = fc.integer({ min: -4 * LATTICE, max: 20 * LATTICE }).map((v) => v / LATTICE);
const whole = fc.integer({ min: -2, max: 18 });

/** A point of the walls' lattice, a whole one, or a corner of a cell near the squares, where walls on a grid run. */
function points(g: Grid): fc.Arbitrary<{ x: number; y: number }> {
  const free = fc.oneof(fc.record({ x: lattice, y: lattice }), fc.record({ x: whole, y: whole }));
  if (!isHex(g)) return free;
  const corner = fc.record({ col: whole, row: whole, k: fc.integer({ min: 0, max: 5 }) }).map(({ col, row, k }) => cornerAt(g, hexCorners(g, { col, row })[k]!));
  return fc.oneof(free, corner);
}

function dropped(box: { x0: number; y0: number; x1: number; y1: number }, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return (a.x < box.x0 && b.x < box.x0) || (a.x > box.x1 && b.x > box.x1) || (a.y < box.y0 && b.y < box.y0) || (a.y > box.y1 && b.y > box.y1);
}

describe("the stairs check's wall filter (property)", () => {
  for (const [i, g] of GRIDS.entries()) {
    const name = ["squares", "hex rows", "hex columns"][i]!;
    test(`${name}: a wall whose ends lie past one side of the squares' box never crosses them, and some walls inside it do`, () => {
      let crossed = 0;
      let skipped = 0;
      holds(
        fc.property(rects, points(g), points(g), (rect, a, b) => {
          const { box, crosses } = endRegion(g, rect);
          const hit = crosses(a.x, a.y, b.x, b.y);
          assert.equal(hit, crosses(b.x, b.y, a.x, a.y), "either end first");
          if (dropped(box, a, b)) {
            skipped++;
            assert.equal(hit, false, `a wall from ${a.x}, ${a.y} to ${b.x}, ${b.y} outside the box crosses the squares`);
          }
          if (hit) crossed++;
        }),
        2_000,
      );
      assert.ok(crossed > 0 && skipped > 0, `the cases cross (${crossed}) and miss (${skipped})`);
    });
  }
});
