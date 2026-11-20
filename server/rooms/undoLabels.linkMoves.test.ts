import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OPENING_RECT, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { describeOp } from "./undoLabels.ts";

/** Undo steps of moving, resizing and hiding stairs, ladders and openings name the kind and the far floor (phase 4, 8.1 and 8.2). */

describe("undo step labels of an end's squares and hiding", () => {
  test("a rect of the same size is a move, and a rect of another size a resize, by the far floor's name", () => {
    const s = withStairs();
    assert.equal(describeOp({ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 5, y: 5, w: 2, h: 1 } } }, s), "moving stairs to Upper floor");
    assert.equal(describeOp({ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 3, y: 3, w: 3, h: 2 }, pairRect: { x: 3, y: 3, w: 3, h: 2 } } }, s), "resizing stairs to Upper floor");
  });

  test("a change of height alone is a resize too", () => {
    assert.equal(describeOp({ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 3, y: 3, w: 2, h: 3 }, pairRect: { x: 3, y: 3, w: 2, h: 3 } } }, withStairs()), "resizing stairs to Upper floor");
  });

  test("an opening's own words, from either end", () => {
    const s = withOpening();
    assert.equal(describeOp({ t: "floorLink.update", linkId: "o1", patch: { rect: { ...OPENING_RECT, x: 9 } } }, s), "moving an opening to Ground floor");
    assert.equal(describeOp({ t: "floorLink.update", linkId: "o2", patch: { rect: { ...OPENING_RECT, w: 4 } } }, s), "resizing an opening to Upper floor");
  });

  test("hiding and showing name the kind", () => {
    const s = tower();
    assert.equal(describeOp({ t: "floorLink.update", linkId: "l1", patch: { hidden: true } }, withStairs(s)), "hiding the stairs");
    assert.equal(describeOp({ t: "floorLink.update", linkId: "l1", patch: { hidden: false } }, withStairs(s)), "showing the stairs");
  });
});
