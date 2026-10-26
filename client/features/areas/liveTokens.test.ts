import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
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
