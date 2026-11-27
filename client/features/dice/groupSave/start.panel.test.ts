import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EVERYTHING } from "../../modules/gate.ts";
import { withChoice } from "../../modules/store.ts";
import type { Source } from "./chain.ts";
import { groupSavePanel } from "./start.ts";

/*
 * Where a group save shows (docs/design/design-v1-features.md 4 and 8,
 * D-261127-305): an area's in Areas, which holds the area, except while
 * Areas hides on this device, when it shows in Dice. Every other source's
 * shows in Dice whatever is hidden.
 */

const area: Source = { kind: "area", templateId: "a1" };
const selection: Source = { kind: "selection", tokenIds: ["g1"] };
const areasHidden = withChoice(EVERYTHING, "dm", "areas", false);

describe("groupSavePanel", () => {
  test("an area's save shows in Areas, and in Dice while Areas hides", () => {
    assert.equal(groupSavePanel(area, "dm", EVERYTHING), "areas");
    assert.equal(groupSavePanel(area, "dm", areasHidden), "dice");
    assert.equal(groupSavePanel(area, "player", areasHidden), "areas", "the DM's choices are not a player's");
  });

  test("every other source's shows in Dice", () => {
    assert.equal(groupSavePanel(selection, "dm", EVERYTHING), "dice");
    assert.equal(groupSavePanel(selection, "dm", areasHidden), "dice");
  });
});
