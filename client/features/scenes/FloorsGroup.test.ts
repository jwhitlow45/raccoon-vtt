import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shallow } from "zustand/shallow";
import { drawing } from "#shared/testutil.ts";
import { tower, TOWER, UPPER } from "../floors/testing.ts";
import { playersAt } from "./floorWords.ts";

/*
 * The Floors group's rows read only what their marks read (floorWords.ts
 * playersAt), so the group, which stays mounted while folded, draws no row
 * again for an op on anything else.
 */

const { floorRowParts } = await import("./FloorsGroup.tsx");

describe("the Floors group's rows", () => {
  test("an op on what no mark reads leaves the rows' parts as they were, and a creature taken to another floor changes them", () => {
    const before = tower();
    const drawn = { ...before, drawings: { d1: drawing("d1", { sceneId: TOWER }) } };
    assert.ok(shallow(floorRowParts(before), floorRowParts(drawn)));
    const moved = { ...before, tokens: { ...before.tokens, thorn: { ...before.tokens.thorn!, sceneId: UPPER } } };
    assert.ok(!shallow(floorRowParts(before), floorRowParts(moved)));
  });

  test("each floor's mark reads the same from the parts as from the whole view", () => {
    const state = { ...tower(), openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } };
    const parts = floorRowParts(state)!;
    for (const id of Object.keys(state.scenes)) assert.equal(playersAt(parts, { id }), playersAt(state, { id }), id);
    assert.equal(floorRowParts(null), null);
  });
});
