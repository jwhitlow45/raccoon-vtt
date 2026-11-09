import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { ATTIC, GROUND, UPPER, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { chosenTarget, draftRect, endAt, judgeDraft, linkTargets, paneEnd } from "./linkTap.ts";

/*
 * Between floors' rules (docs/design/design-v1-floors.md phase 2, 7): the
 * floors the To choice offers, the squares a drag draws held to 4 by 4, the end
 * a tap lands on, and the draft's first refusal.
 */

const BOUNDS = { w: 20, h: 20 };

describe("the floors To offers", () => {
  test("the floors next to the one shown, the floor above first", () => {
    const state = tower();
    assert.deepEqual(linkTargets(state, UPPER), [
      { id: ATTIC, dir: "up", name: "Attic" },
      { id: GROUND, dir: "down", name: "Ground floor" },
    ]);
    assert.deepEqual(linkTargets(state, GROUND), [{ id: UPPER, dir: "up", name: "Upper floor" }]);
    assert.deepEqual(linkTargets(state, ATTIC), [{ id: UPPER, dir: "down", name: "Upper floor" }]);
  });

  test("none on a scene of one floor, and none before the scene is known", () => {
    assert.deepEqual(linkTargets(tower(), "s2"), []);
    assert.deepEqual(linkTargets(tower(), null), []);
    assert.deepEqual(linkTargets(null, GROUND), []);
  });

  test("a pick that is still next to the floor shown stays, and one left over from another floor gives way to the floor above", () => {
    const targets = linkTargets(tower(), UPPER);
    assert.equal(chosenTarget(targets, GROUND)?.id, GROUND);
    assert.equal(chosenTarget(targets, null)?.id, ATTIC);
    assert.equal(chosenTarget(linkTargets(tower(), GROUND), ATTIC)?.id, UPPER);
    assert.equal(chosenTarget([], null), null);
  });
});

describe("the squares a drag draws", () => {
  test("a drag over more than 4 squares a side keeps to 4 from where it began, either way", () => {
    assert.deepEqual(draftRect(SQUARES, { x: 3.5, y: 3.5 }, { x: 12.5, y: 5.5 }, BOUNDS), { x: 3, y: 3, w: LIMITS.floorLinkSide, h: 3 });
    assert.deepEqual(draftRect(SQUARES, { x: 12.5, y: 10.5 }, { x: 3.5, y: 2.5 }, BOUNDS), { x: 9, y: 7, w: 4, h: 4 });
  });

  test("a tap, or a drag inside one square, draws that square", () => {
    assert.deepEqual(draftRect(SQUARES, { x: 6.2, y: 7.8 }, { x: 6.2, y: 7.8 }, BOUNDS), { x: 6, y: 7, w: 1, h: 1 });
  });

  test("a drag keeps to the scene", () => {
    assert.deepEqual(draftRect(SQUARES, { x: 18.5, y: 18.5 }, { x: 30, y: 30 }, BOUNDS), { x: 18, y: 18, w: 2, h: 2 });
  });
});

describe("the squares a drag draws on a hex scene", () => {
  const ROWS: HexGrid = { shape: "hex", orient: "rows" };
  const at = (col: number, row: number) => hexCenter(ROWS, { col, row });

  test("a drag over more than 4 hexes a side keeps to 4 from the hex it began on", () => {
    const rect = draftRect(ROWS, at(2, 2), at(9, 8), BOUNDS);
    assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [2, 2, 4, 4]);
  });

  test("a tap draws the hex under it, and finds the end there", () => {
    assert.deepEqual(draftRect(ROWS, at(3, 4), at(3, 4), BOUNDS), { x: 3, y: 4, w: 1, h: 1 });
    const state = withStairs(tower(), { rect: { x: 3, y: 4, w: 2, h: 1 } });
    assert.equal(endAt(state, GROUND, ROWS, BOUNDS, at(4, 4))?.id, "l1");
    assert.equal(endAt(state, GROUND, ROWS, BOUNDS, at(5, 4)), null);
  });
});

describe("the end under a tap", () => {
  test("the end whose squares hold the tap, on its own floor only", () => {
    const state = withStairs();
    assert.equal(endAt(state, GROUND, SQUARES, BOUNDS, { x: 4.5, y: 3.5 })?.id, "l1");
    assert.equal(endAt(state, GROUND, SQUARES, BOUNDS, { x: 5.5, y: 3.5 }), null);
    assert.equal(endAt(state, UPPER, SQUARES, BOUNDS, { x: 3.5, y: 3.5 })?.id, "l2");
    assert.equal(paneEnd(state, "l2")?.sceneId, UPPER);
    assert.equal(paneEnd(state, "gone"), null);
    assert.equal(paneEnd(state, null), null);
  });
});

describe("the draft's reason", () => {
  test("clear squares pass", () => {
    assert.equal(judgeDraft(tower(), GROUND, UPPER, { x: 6, y: 6, w: 2, h: 2 }, "stairs").problem, null);
  });

  test("squares over another end, and past the floor's edge, read 7.3's words", () => {
    const state = withStairs();
    assert.equal(judgeDraft(state, GROUND, UPPER, { x: 4, y: 3, w: 2, h: 1 }, "stairs").problem, LINK_WORDS.overEnd("stairs", "Upper floor"));
    assert.equal(judgeDraft(state, GROUND, UPPER, { x: 19, y: 3, w: 2, h: 1 }, "ladder").problem, LINK_WORDS.pastEdge("Ground floor"));
  });

  test("a floor two levels away is refused", () => {
    assert.equal(judgeDraft(tower(), GROUND, ATTIC, { x: 6, y: 6, w: 1, h: 1 }, "stairs").problem, LINK_WORDS.notNext);
  });
});
