import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { token } from "#shared/testutil.ts";
import { flatPressTokens, keepRingPairs } from "./renderCache.ts";

const flat = () => 0;

describe("the isometric board's render caches (FU39-B)", () => {
  test("a fresh layout of equal flat press geometry keeps each token's render prop", () => {
    const a = token("a", { x: 2.5, y: 3, size: "large" });
    const b = token("b", { x: 6, y: 3 });
    const first = flatPressTokens(new Map(), [a, b], 0, flat, flat);
    const next = flatPressTokens(first, [{ ...b }, { ...a }], 0, flat, flat);
    assert.equal(next.get("a"), first.get("a"), "a pan or reordered layout does not redraw a's press area");
    assert.equal(next.get("b"), first.get("b"), "each id keeps its own geometry");
    assert.ok(first.get("a")!.press.length > 1, "the fixture covers split press cells");
  });

  test("a changed flat token replaces its press geometry while other tokens keep theirs", () => {
    const a = token("a", { x: 2.5, y: 3, size: "large" });
    const b = token("b", { x: 6, y: 3 });
    const first = flatPressTokens(new Map(), [a, b], 0, flat, flat);
    for (const change of [{ ...a, x: 2.25 }, { ...a, y: 3.5 }, { ...a, size: "medium" as const }]) {
      const next = flatPressTokens(first, [change, b], 0, flat, flat);
      assert.notEqual(next.get("a"), first.get("a"));
      assert.notDeepEqual(next.get("a")!.press, first.get("a")!.press);
      assert.equal(next.get("b"), first.get("b"));
    }
    const turned = flatPressTokens(first, [a, b], 1, flat, flat);
    assert.notEqual(turned.get("a"), first.get("a"));
    assert.equal(turned.get("a")!.turn, 1);
    const raised = flatPressTokens(first, [a, b], 0, () => 2, () => 2);
    assert.equal(raised.get("a")!.ground, 2);
    assert.equal(raised.get("a")!.press[0]!.z, 2);
  });

  test("a changed drawn cell updates the press area even when the footprint's highest ground stays put", () => {
    const a = token("a", { x: 2, y: 3, size: "large" });
    const first = flatPressTokens(new Map(), [a], 0, () => 2, () => 2);
    const next = flatPressTokens(first, [a], 0, () => 2, (x) => x < 3 ? 1 : 2);
    assert.notEqual(next.get("a"), first.get("a"));
    assert.equal(next.get("a")!.ground, 2);
    assert.deepEqual(next.get("a")!.press.map((p) => p.z), [1, 2, 1, 2]);
  });

  test("tokens that stand up or leave the scene leave the flat cache", () => {
    const a = token("a");
    const b = token("b");
    const first = flatPressTokens(new Map(), [a, b], 0, flat, flat);
    const next = flatPressTokens(first, [b], 0, flat, flat);
    assert.deepEqual([...next.keys()], ["b"]);
    assert.equal(next.get("b"), first.get("b"));
    assert.equal(flatPressTokens(next, [], 0, flat, flat).size, 0);
  });

  test("equal ring membership preserves the areas context input across fresh layouts", () => {
    const first = new Set(["sphere|a", "cube|b"]);
    assert.equal(keepRingPairs(first, new Set(["cube|b", "sphere|a"])), first, "set order has no drawing meaning");
    const empty = new Set<string>();
    assert.equal(keepRingPairs(empty, new Set()), empty, "layouts without rings also stay stable");
  });

  test("standing, flattened and recaught areas replace the ring membership even at the same count", () => {
    const first = new Set(["sphere|a", "cube|b"]);
    for (const next of [new Set(["sphere|a"]), new Set(["sphere|a", "cube|b", "cone|a"]), new Set(["sphere|b", "cube|b"]), new Set<string>()]) {
      assert.equal(keepRingPairs(first, next), next);
      assert.deepEqual([...first], ["sphere|a", "cube|b"], "published membership is never mutated");
    }
  });
});
