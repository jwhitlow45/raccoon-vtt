import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { footprintSubcells, setFootprintMemoOffForTests, withFootprintMemo, type PlacedToken } from "./footprint.ts";
import { gridOfShape } from "./grid.ts";
import type { HexGrid } from "./hex.ts";

const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;

/** Probes that differ from `base` in one field each, every one a different footprint. */
function variants(base: PlacedToken): { field: string; probe: PlacedToken }[] {
  return [
    { field: "x", probe: { ...base, x: base.x + 3 } },
    { field: "y", probe: { ...base, y: base.y + 3 } },
    { field: "size", probe: { ...base, size: "gargantuan" } },
    { field: "w", probe: { ...base, w: 4 } },
    { field: "h", probe: { ...base, h: 4 } },
    { field: "squeeze", probe: { ...base, squeeze: true } },
  ];
}

describe("footprintSubcells inside withFootprintMemo", () => {
  test("every size, squeezed or not, on both orientations, answers as it does outside the memo", () => {
    const probes: PlacedToken[] = [];
    for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const) {
      for (const squeeze of [undefined, true]) {
        for (const [x, y] of [[0, 0], [3.5, 2], [7.25, 5.75], [12, 9.5]] as const) probes.push({ size, x, y, ...(size === "custom" ? { w: 2.5, h: 1 } : {}), ...(squeeze ? { squeeze } : {}) });
      }
    }
    for (const g of [ROWS, COLUMNS]) {
      const plain = probes.map((p) => footprintSubcells(g, p));
      const kept = withFootprintMemo(() => probes.map((p) => [footprintSubcells(g, p), footprintSubcells(g, p)] as const));
      kept.forEach(([first, again], i) => {
        assert.deepEqual(first, plain[i]);
        assert.equal(again, first, "a second ask is the kept answer");
      });
    }
  });

  test("one object written in place, or asked on the other orientation, is answered afresh in the same memo", () => {
    const base: PlacedToken = { size: "custom", x: 4, y: 4, w: 2, h: 2 };
    for (const { field, probe } of variants(base)) {
      withFootprintMemo(() => {
        const token: PlacedToken = { ...base };
        assert.deepEqual(footprintSubcells(ROWS, token), footprintSubcells(ROWS, { ...base }));
        Object.assign(token, probe);
        assert.notDeepEqual(footprintSubcells(ROWS, { ...probe }), footprintSubcells(ROWS, { ...base }), `${field} changes the footprint`);
        assert.deepEqual(footprintSubcells(ROWS, token), footprintSubcells(ROWS, { ...probe }), `${field} written in place`);
      });
    }
    withFootprintMemo(() => {
      const token: PlacedToken = { ...base };
      footprintSubcells(ROWS, token);
      assert.notDeepEqual(footprintSubcells(COLUMNS, { ...base }), footprintSubcells(ROWS, { ...base }));
      assert.deepEqual(footprintSubcells(COLUMNS, token), footprintSubcells(COLUMNS, { ...base }));
    });
  });

  test("nothing is kept once the outermost call returns, and a nested call shares the outer memo", () => {
    const token: PlacedToken = { size: "large", x: 6, y: 6 };
    const outer = withFootprintMemo(() => {
      const first = footprintSubcells(ROWS, token);
      assert.equal(withFootprintMemo(() => footprintSubcells(ROWS, token)), first);
      return first;
    });
    assert.notEqual(footprintSubcells(ROWS, token), outer);
    assert.notEqual(
      withFootprintMemo(() => footprintSubcells(ROWS, token)),
      outer,
      "a new call starts a new memo",
    );
  });

  test("turned off for a test, the call keeps nothing", (t) => {
    const token: PlacedToken = { size: "huge", x: 8, y: 8 };
    setFootprintMemoOffForTests(true);
    t.after(() => setFootprintMemoOffForTests(false));
    withFootprintMemo(() => assert.notEqual(footprintSubcells(ROWS, token), footprintSubcells(ROWS, token)));
  });

  test("a throw inside the call still ends its memo", () => {
    const token: PlacedToken = { size: "medium", x: 2, y: 2 };
    let kept: readonly (readonly [number, number])[] | undefined;
    assert.throws(() =>
      withFootprintMemo(() => {
        kept = footprintSubcells(ROWS, token);
        throw new Error("boom");
      }),
    );
    assert.notEqual(footprintSubcells(ROWS, token), kept);
  });
});
