import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, room } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

/** A DM's stat block edits go on the DM's stack in the block's words (docs/design-v1-pc-stats.md 3.5). */
describe("stat block undo labels", () => {
  test("changing and removing a character's stat block, and the character's other edits as before", () => {
    const s = room({ characters: { bree: character("bree", { name: "Bree" }) } });
    assert.equal(describeOp({ t: "character.update", characterId: "bree", patch: { stats: { saves: ["dex"] }, level: 5 } }, s), "changing Bree's stat block");
    assert.equal(describeOp({ t: "character.update", characterId: "bree", patch: { stats: null } }, s), "removing Bree's stat block");
    assert.equal(describeOp({ t: "character.update", characterId: "bree", patch: { level: 5 } }, s), "changing the character Bree");
    assert.equal(describeOp({ t: "character.update", characterId: "gone", patch: { stats: {} } }, s), "changing a character's stat block");
  });
});
