import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { int, pick, rng } from "../testutil.ts";
import { distanceFt, pathDistanceFt, pointCellBox, pointDistanceFt, rulerDistanceFt, stepsBetween, tokenCellBox } from "./distance.ts";
import { occupiedHexes, placedOnHex, tokenRefHex, type FootprintToken, type SizeCategory } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { hexAt, hexDistance, hexKey, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";

/**
 * Distance on hexes (docs/design-v1-hex-grids.md 4.3): the fewest hex steps
 * between any hex of one creature and any hex of the other, and with height
 * the room's rule between those steps and the vertical ones.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS: readonly [string, HexGrid][] = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
];
const SIZES: readonly SizeCategory[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const five = { feetPerCell: 5, diagonal: "five" } as const;
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" } as const;
const euclid = { feetPerCell: 5, diagonal: "euclid" } as const;

function on(g: HexGrid, size: SizeCategory, ref: Hex, elevation = 0): FootprintToken {
  return { size, elevation, ...placedOnHex(g, { size, x: 0, y: 0 }, ref) };
}

/** Steps from any hex of `from` to the nearest hex of `to`, by walking neighbors. */
function bfsSteps(g: HexGrid, from: readonly Hex[], to: readonly Hex[]): number {
  const goal = new Set(to.map(hexKey));
  const seen = new Set(from.map(hexKey));
  let frontier = [...from];
  for (let d = 0; d < 400; d++) {
    if (frontier.some((h) => goal.has(hexKey(h)))) return d;
    const next: Hex[] = [];
    for (const h of frontier) {
      for (const n of hexNeighbors(g, h)) {
        if (seen.has(hexKey(n))) continue;
        seen.add(hexKey(n));
        next.push(n);
      }
    }
    frontier = next;
  }
  throw new Error("no path");
}

for (const [name, g] of GRIDS) {
  describe(`${name}: distance between creatures`, () => {
    test("equals a breadth-first walk between their hexes, on random boards, and is symmetric", () => {
      const r = rng(51);
      for (let i = 0; i < 1500; i++) {
        const a = on(g, pick(r, SIZES), { col: int(r, 0, 40), row: int(r, 0, 40) });
        const b = on(g, pick(r, SIZES), { col: int(r, 0, 40), row: int(r, 0, 40) });
        const steps = bfsSteps(g, occupiedHexes(g, a), occupiedHexes(g, b));
        assert.equal(distanceFt(g, a, b, five), steps * 5);
        assert.equal(distanceFt(g, b, a, five), steps * 5, "symmetric");
        assert.deepEqual(stepsBetween(tokenCellBox(g, a, 5), tokenCellBox(g, b, 5)), { dx: steps, dy: 0, dz: 0 });
        // Every hex is one step under every rule: a hex has no diagonal.
        assert.equal(distanceFt(g, a, b, fiveTen), steps * 5);
        assert.equal(distanceFt(g, a, b, euclid), steps * 5);
      }
    });

    test("a Gargantuan next to a Medium is 5 ft apart when a hex of each touches, whichever of its hexes it touches", () => {
      const garg = on(g, "gargantuan", { col: 10, row: 10 });
      const its = occupiedHexes(g, garg);
      const inside = new Set(its.map(hexKey));
      let touching = 0;
      for (const h of its) {
        for (const n of hexNeighbors(g, h)) {
          if (inside.has(hexKey(n))) continue;
          const medium = on(g, "medium", n);
          assert.equal(distanceFt(g, garg, medium, five), 5, `beside ${hexKey(h)}`);
          // Section 10's mutant: counting between the two reference hexes alone puts most of these further away.
          if (hexDistance(g, tokenRefHex(g, garg), n) > 1) touching++;
        }
      }
      assert.ok(touching > 0, "some touch a hex other than the reference");
      assert.equal(distanceFt(g, garg, on(g, "medium", its[5]!), five), 0, "a shared hex is 0 ft");
    });

    test("height counts by the room's rule, and a flier's vertical steps carry across legs under 5-10-5", () => {
      const ground = on(g, "medium", { col: 4, row: 4 });
      const up = on(g, "medium", { col: 6, row: 4 }, 15);
      // Two hexes across and three cells up.
      assert.equal(distanceFt(g, ground, up, five), 15);
      assert.equal(distanceFt(g, ground, up, fiveTen), 20);
      assert.equal(distanceFt(g, ground, up, euclid), Math.round(Math.hypot(2, 3) * 5));
      // Rising 10 ft a leg over one hex a leg, for two legs: the second leg's diagonal is the path's second.
      const stops = [on(g, "medium", { col: 1, row: 1 }, 0), on(g, "medium", { col: 2, row: 1 }, 10), on(g, "medium", { col: 3, row: 1 }, 20)].map((t) => tokenCellBox(g, t, 5));
      assert.deepEqual(pathDistanceFt(stops, fiveTen), { totalFt: 25, legsFt: [10, 15] });
    });

    test("a ruler point stands in the hex that holds it", () => {
      const r = rng(52);
      for (let i = 0; i < 500; i++) {
        const p = { x: r() * 60, y: r() * 60 };
        const q = { x: r() * 60, y: r() * 60 };
        const steps = hexDistance(g, hexAt(g, p), hexAt(g, q));
        assert.equal(pointDistanceFt(g, p, q, five), steps * 5);
        assert.deepEqual(pointCellBox(g, p, 5).hexes?.at, [hexAt(g, p)]);
        assert.deepEqual(rulerDistanceFt(g, [p, q, p], five).legsFt, [steps * 5, steps * 5]);
      }
    });
  });
}

describe("squares keep their boxes", () => {
  test("a square box holds no hexes, so its steps are per axis as before", () => {
    const box = tokenCellBox(SQUARES, { size: "large", x: 2, y: 2, elevation: 0 }, 5);
    assert.ok(!("hexes" in box));
    assert.ok(!("hexes" in pointCellBox(SQUARES, { x: 1, y: 1 }, 5)));
    assert.deepEqual(stepsBetween(box, pointCellBox(SQUARES, { x: 6.5, y: 7.5 }, 5)), { dx: 3, dy: 4, dz: 0 });
  });
});
