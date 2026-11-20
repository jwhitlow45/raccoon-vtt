import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { draftRect } from "./linkTap.ts";

/*
 * An opening's draft in Between floors (docs/design/design-v1-floors.md
 * phase 4, 3): a drag draws up to 8 by 8 for an opening, where stairs and
 * ladders keep to 4 by 4.
 */

const BOUNDS = { w: 20, h: 20 };

describe("an opening's draft", () => {
  test("a long drag holds an opening to its own side, longer than stairs'", () => {
    assert.equal(LIMITS.openingSide > LIMITS.floorLinkSide, true);
    assert.deepEqual(draftRect(SQUARES, { x: 3.5, y: 3.5 }, { x: 15.5, y: 14.5 }, BOUNDS, "opening"), { x: 3, y: 3, w: LIMITS.openingSide, h: LIMITS.openingSide });
    assert.deepEqual(draftRect(SQUARES, { x: 3.5, y: 3.5 }, { x: 15.5, y: 14.5 }, BOUNDS, "stairs"), { x: 3, y: 3, w: LIMITS.floorLinkSide, h: LIMITS.floorLinkSide });
    assert.deepEqual(draftRect(SQUARES, { x: 3.5, y: 3.5 }, { x: 15.5, y: 14.5 }, BOUNDS, "ladder"), { x: 3, y: 3, w: LIMITS.floorLinkSide, h: LIMITS.floorLinkSide });
  });

  test("dragged back past its start, it keeps the square the drag began on", () => {
    assert.deepEqual(draftRect(SQUARES, { x: 15.5, y: 12.5 }, { x: 1.5, y: 1.5 }, BOUNDS, "opening"), { x: 8, y: 5, w: LIMITS.openingSide, h: LIMITS.openingSide });
  });

  test("an 8 by 8 drag stays whole for an opening, and stairs by default", () => {
    assert.deepEqual(draftRect(SQUARES, { x: 2.5, y: 2.5 }, { x: 9.5, y: 9.5 }, BOUNDS, "opening"), { x: 2, y: 2, w: 8, h: 8 });
    assert.deepEqual(draftRect(SQUARES, { x: 2.5, y: 2.5 }, { x: 9.5, y: 9.5 }, BOUNDS), { x: 2, y: 2, w: 4, h: 4 });
  });
});
