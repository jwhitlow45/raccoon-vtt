import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { snapPosition } from "../../lib/scene.ts";
import { dragSpots, parseSpotsKey, spotsKey, withSpots } from "./liveTokens.ts";

const tok = (x: number, y: number, size: "medium" | "large" | "tiny" = "medium") => ({ x, y, size });
const squares = () => SQUARES;

describe("tokens where they are being dragged", () => {
  const tokens = { a: tok(2, 2), big: tok(10, 10, "large"), mouse: tok(5, 5, "tiny") };

  test("a drag counts at the cell it would drop on, and only once it leaves its own", () => {
    assert.equal(dragSpots(tokens, [{ tokenId: "a", x: 2.3, y: 1.8 }], squares).size, 0);
    assert.deepEqual([...dragSpots(tokens, [{ tokenId: "a", x: 3.6, y: 2.2 }], squares)], [["a", { x: 4, y: 2 }]]);
    // A tiny token snaps to half cells.
    assert.deepEqual(dragSpots(tokens, [{ tokenId: "mouse", x: 6.3, y: 5.1 }], squares).get("mouse"), { x: 6.5, y: 5 });
    // A token the view does not hold is skipped.
    assert.equal(dragSpots(tokens, [{ tokenId: "ghost", x: 1, y: 1 }], squares).size, 0);
  });

  test("the key changes only when a spot does, and reads back", () => {
    const one = spotsKey(dragSpots(tokens, [{ tokenId: "a", x: 3.6, y: 2.2 }], squares));
    const same = spotsKey(dragSpots(tokens, [{ tokenId: "a", x: 4.4, y: 1.7 }], squares));
    assert.equal(one, same);
    const both = dragSpots(tokens, [
      { tokenId: "big", x: 12.2, y: 9.9 },
      { tokenId: "a", x: 3.6, y: 2.2 },
    ], squares);
    assert.equal(spotsKey(both), "a:4,2;big:12,10");
    assert.deepEqual(parseSpotsKey(spotsKey(both)), both);
    assert.equal(parseSpotsKey("").size, 0);
  });

  test("tokens move to their spots, and nothing moving keeps the same map", () => {
    assert.equal(withSpots(tokens, new Map()), tokens);
    assert.equal(withSpots(tokens, new Map([["a", { x: 2, y: 2 }]])), tokens);
    const moved = withSpots(tokens, new Map([["a", { x: 7, y: 3 }]]));
    assert.deepEqual(moved.a, { x: 7, y: 3, size: "medium" });
    assert.equal(moved.big, tokens.big);
    assert.deepEqual(tokens.a, { x: 2, y: 2, size: "medium" });
  });
});

describe("a lone drag's planned landing (SNAPBUILD-ASTRA-04)", () => {
  const tokens = { ogre: tok(10, 6, "large"), squeezed: { ...tok(4, 4, "large"), squeeze: true as const } };

  test("a landing that names its squeeze is kept as it is, half a cell off the grid, and never snapped again", () => {
    assert.deepEqual(dragSpots(tokens, [{ tokenId: "ogre", x: 10.5, y: 3.5, squeeze: true }], squares).get("ogre"), { x: 10.5, y: 3.5, squeeze: true });
    assert.deepEqual(dragSpots(tokens, [{ tokenId: "ogre", x: 10.5, y: 3.5 }], squares).get("ogre"), { x: 11, y: 4 }, "a spot that names none is the cell under it");
  });

  test("a squeezed token whose landing leaves the squeeze on its own spot moves, and one that keeps it does not", () => {
    assert.deepEqual(dragSpots(tokens, [{ tokenId: "squeezed", x: 4, y: 4, squeeze: false }], squares).get("squeezed"), { x: 4, y: 4, squeeze: false });
    assert.equal(dragSpots(tokens, [{ tokenId: "squeezed", x: 4, y: 4, squeeze: true }], squares).size, 0);
  });

  test("the key carries the squeeze both ways, and the tokens take it", () => {
    const spots = new Map([
      ["ogre", { x: 10.5, y: 3.5, squeeze: true }],
      ["squeezed", { x: 6, y: 4, squeeze: false }],
      ["a", { x: 4, y: 2 }],
    ]);
    assert.deepEqual(parseSpotsKey(spotsKey(spots)), spots);
    const moved = withSpots(tokens, spots);
    assert.deepEqual(moved.ogre, { x: 10.5, y: 3.5, size: "large", squeeze: true });
    assert.deepEqual(moved.squeezed, { x: 6, y: 4, size: "large" }, "out of its squeeze");
    assert.equal(withSpots(tokens, new Map([["squeezed", { x: 4, y: 4, squeeze: true }]])), tokens, "where it stands, squeezed as it is");
  });
});

describe("tokens where they are being dragged on a hex scene (docs/design/design-v1-hex-grids.md HX-D11)", () => {
  test("a drag counts at the hex anchor its scene's drop would snap it to", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g = { shape: "hex", orient } as const;
      const tokens = { a: tok(2, 2) };
      const at = dragSpots(tokens, [{ tokenId: "a", x: 6.3, y: 4.2 }], () => g).get("a");
      assert.deepEqual(at, snapPosition(g, 6.3, 4.2, { w: 1, h: 1 }), orient);
      assert.notDeepEqual(at, dragSpots(tokens, [{ tokenId: "a", x: 6.3, y: 4.2 }], squares).get("a"), "not the square under it");
    }
  });
});
