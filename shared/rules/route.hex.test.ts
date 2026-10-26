import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { int, pick, rng } from "../testutil.ts";
import { placedOnHex, tokenRefHex, type PlacedToken, type SizeCategory } from "./footprint.ts";
import { hexDistance, hexKey, hexLine, sameHex, type Hex, type HexGrid } from "./hex.ts";
import { ownWalk } from "./movement.ts";
import { hexPieceSpot, plainLegCost, routeWalk, straightCost, straightFeet, type SizedSpot } from "./route.ts";

/**
 * Straight legs and walk spots on hexes (docs/design-v1-hex-grids.md 4.2
 * and 4.4): a leg's feet are the hex steps between its ends' reference
 * hexes, and its spots stand on the hex line between them.
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
const NO_BUILD = { buildChunks: {} };

function spotOn(g: HexGrid, token: PlacedToken, ref: Hex, elevation = 0): SizedSpot {
  return { ...placedOnHex(g, token, ref), elevation };
}

function walker(size: SizeCategory, at: { x: number; y: number }, elevation = 0) {
  return ownWalk({ id: "t", sceneId: "s1", size, x: at.x, y: at.y, elevation, attached: undefined });
}

for (const [name, g] of GRIDS) {
  describe(`${name}: a straight leg`, () => {
    test("takes the hex steps between its ends' reference hexes, for every size", () => {
      const r = rng(61);
      for (let i = 0; i < 1000; i++) {
        const size = pick(r, SIZES);
        const t: PlacedToken = { size, x: 0, y: 0 };
        const a: Hex = { col: int(r, 0, 60), row: int(r, 0, 60) };
        const b: Hex = { col: int(r, 0, 60), row: int(r, 0, 60) };
        const steps = hexDistance(g, a, b);
        assert.equal(straightFeet(g, t, spotOn(g, t, a), spotOn(g, t, b), five), steps * 5, `${size} ${hexKey(a)} to ${hexKey(b)}`);
        assert.deepEqual(straightCost(g, t, spotOn(g, t, a), spotOn(g, t, b), fiveTen, { h: 0, v: 0 }), { moved: steps * 5, cost: steps * 5, diag: [0, 0] });
      }
    });

    test("a Large creature moved one hex has moved 5 ft, and a leg across a resize counts each end at its own size", () => {
      const large: PlacedToken = { size: "large", x: 0, y: 0 };
      assert.equal(straightFeet(g, large, spotOn(g, large, { col: 4, row: 4 }), spotOn(g, large, { col: 5, row: 4 }), five), 5);
      // A Medium on hex 4,4 stopped there; it then grew Large keeping 4,4 as its top hex, and moved two hexes.
      const from: SizedSpot = { ...spotOn(g, { size: "medium", x: 0, y: 0 }, { col: 4, row: 4 }), footprint: { w: 1, h: 1 } };
      assert.equal(straightFeet(g, large, from, spotOn(g, large, { col: 6, row: 4 }), five), 10);
    });

    test("height counts by the room's rule, the vertical counter carrying across legs under 5-10-5", () => {
      const t: PlacedToken = { size: "medium", x: 0, y: 0 };
      const counter = { h: 0, v: 0 };
      assert.equal(straightFeet(g, t, spotOn(g, t, { col: 1, row: 1 }, 0), spotOn(g, t, { col: 2, row: 1 }, 10), fiveTen, counter), 10);
      assert.equal(straightFeet(g, t, spotOn(g, t, { col: 2, row: 1 }, 10), spotOn(g, t, { col: 3, row: 1 }, 20), fiveTen, counter), 15);
      assert.deepEqual(counter, { h: 0, v: 2 });
      const before = { ...t, ...spotOn(g, t, { col: 1, row: 1 }) };
      assert.deepEqual(plainLegCost(g, before, { ...t, ...spotOn(g, t, { col: 4, row: 1 }) }, five, { h: 0, v: 0 }), { moved: 15, cost: 15, diag: [0, 0] });
    });
  });

  describe(`${name}: a walk's spots`, () => {
    test("stand on the hex line, one a hex, each at the walker's size, the last where the leg ends", () => {
      const r = rng(62);
      for (let i = 0; i < 600; i++) {
        const size = pick(r, SIZES);
        const a: Hex = { col: int(r, 0, 40), row: int(r, 0, 40) };
        const b: Hex = { col: int(r, 0, 40), row: int(r, 0, 40) };
        const start = walker(size, placedOnHex(g, { size, x: 0, y: 0 }, a), 10);
        // The leg may end off its anchor, as a drop can: its last spot is where it ends.
        const end = { ...start, x: placedOnHex(g, start, b).x + 0.1, y: placedOnHex(g, start, b).y, elevation: 30 };
        const spots = routeWalk(g, [start, end], NO_BUILD);
        const line = hexLine(g, a, tokenRefHex(g, end));
        const n = Math.max(1, line.length - 1);
        assert.equal(spots.length, n + 1);
        assert.deepEqual(spots[0], { x: start.x, y: start.y, elevation: 10, progress: [0, 0, n] });
        for (let k = 1; k <= n; k++) {
          const s = spots[k]!;
          assert.deepEqual(s.progress, [0, k, n]);
          assert.ok(sameHex(tokenRefHex(g, { size, x: s.x, y: s.y }), line[Math.min(k, line.length - 1)]!), `spot ${k} on the line's hex`);
          // A walker off the ground rises evenly between the leg's ends.
          assert.equal(s.elevation, k === n ? 30 : 10 + (20 * k) / n);
        }
        assert.deepEqual([spots[n]!.x, spots[n]!.y], [end.x, end.y]);
      }
    });

    test("the area sweep's spot at a fraction stands on the line's hex at that fraction of its steps", () => {
      const t: PlacedToken = { size: "medium", x: 0, y: 0 };
      const a = placedOnHex(g, t, { col: 2, row: 2 });
      const b = placedOnHex(g, t, { col: 10, row: 2 });
      const line = hexLine(g, { col: 2, row: 2 }, { col: 10, row: 2 });
      for (let k = 0; k <= 16; k++) {
        const p = hexPieceSpot(g, t, a, b, k / 16);
        assert.ok(sameHex(tokenRefHex(g, { ...t, ...p }), line[Math.round((k / 16) * 8)]!));
      }
    });
  });
}

describe("the line's nudge decides a walk along the side between two hexes (section 10's mutant)", () => {
  test("a Medium walking two rows straight down on hex rows passes the row between on the hex the nudge picks", () => {
    // From 4,2 to 4,4 the straight line runs down the side between hexes 3,3 and 4,3 of the odd row between.
    const start = walker("medium", placedOnHex(ROWS, { size: "medium", x: 0, y: 0 }, { col: 4, row: 2 }));
    const end = { ...start, ...placedOnHex(ROWS, start, { col: 4, row: 4 }) };
    const spots = routeWalk(ROWS, [start, end], NO_BUILD);
    assert.deepEqual(
      spots.map((s) => hexKey(tokenRefHex(ROWS, { size: "medium", x: s.x, y: s.y }))),
      ["4,2", "4,3", "4,4"],
    );
    const mirrored = routeWalk(COLUMNS, [{ ...start, ...placedOnHex(COLUMNS, start, { col: 2, row: 4 }) }, { ...start, ...placedOnHex(COLUMNS, start, { col: 4, row: 4 }) }], NO_BUILD);
    assert.deepEqual(
      mirrored.map((s) => hexKey(tokenRefHex(COLUMNS, { size: "medium", x: s.x, y: s.y }))),
      ["2,4", "3,4", "4,4"],
    );
  });
});
