import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { dragSpots } from "../features/areas/liveTokens.ts";
import { groupSpot, groupSpotOf } from "./localDrags.ts";

const ogre = { x: 4, y: 4, size: "large" as const, w: 2, h: 2, squeeze: true as const };

describe("a group or carried token's drag spot (GROUP-DRAG-SQUEEZE)", () => {
  test("names squeeze false, since token.moveMany and a carry land it unsqueezed", () => {
    assert.deepEqual(groupSpot(SQUARES, ogre, 6.2, 4.1), { x: 6, y: 4, squeeze: false });
  });

  test("a squeezed member moved by the drag reads as unsqueezed where it lands", () => {
    const spot = groupSpot(SQUARES, ogre, 6.2, 4.1);
    const spots = dragSpots({ ogre }, [{ tokenId: "ogre", ...spot }], () => SQUARES);
    assert.deepEqual(spots.get("ogre"), { x: 6, y: 4, squeeze: false });
  });

  test("a squeezed member held on its own cell still leaves its squeeze", () => {
    const spot = groupSpot(SQUARES, ogre, 4.1, 3.9);
    assert.deepEqual(dragSpots({ ogre }, [{ tokenId: "ogre", ...spot }], () => SQUARES).get("ogre"), { x: 4, y: 4, squeeze: false });
  });
});

describe("the spot the ruler reads for a group drag (R2-OPUS-2)", () => {
  const spots = { a: { x: 1, y: 2, squeeze: false }, b: { x: 2, y: 2, squeeze: false } };

  test("is the board's spot only while the drag names a group, not for a lone drag that carries others", () => {
    assert.deepEqual(groupSpotOf({ spots, group: true }, "a"), { x: 1, y: 2, squeeze: false });
    assert.equal(groupSpotOf({ spots, group: false }, "a"), undefined);
    assert.equal(groupSpotOf({ spots: {}, group: true }, "a"), undefined);
  });
});
