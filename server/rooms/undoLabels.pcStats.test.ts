import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CharacterPatch, DdbSyncPatch } from "#shared/protocol.ts";
import { AT, character, room } from "#shared/testutil.ts";
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

/** A re-sync and its Undo read in the dialog's words on the DM's stack (docs/design-v1-resync.md 4). */
describe("re-sync undo labels", () => {
  const s = room({ characters: { bree: character("bree", { name: "Bree" }) } });
  const record: DdbSyncPatch = { from: "123456789", base: { level: 6 }, rolls: {} };
  const label = (patch: CharacterPatch, characterId = "bree") => describeOp({ t: "character.update", characterId, patch }, s);

  test("a sync, and an editor Save that carries a record, are the re-sync, before the block's words", () => {
    assert.equal(label({ stats: { saves: ["wis"] }, level: 6, actor: { ac: 16 }, ddbSync: record }), "re-syncing Bree from D&D Beyond");
    assert.equal(label({ stats: { saves: ["wis"], rolls: [] }, ddbSync: { ...record, gone: ["w:0123456789ab"] } }), "re-syncing Bree from D&D Beyond");
    assert.equal(label({ ddbSync: record }, "gone"), "re-syncing a character from D&D Beyond");
  });

  test("the dialog's Undo, with the record before and its at, or with none, is undoing the re-sync, a removed block included", () => {
    assert.equal(label({ stats: { saves: ["dex"] }, level: 5, ddbSync: { ...record, at: AT } }), "undoing Bree's re-sync");
    assert.equal(label({ stats: { saves: ["dex"] }, level: 5, ddbSync: null }), "undoing Bree's re-sync");
    assert.equal(label({ stats: null, ddbSync: null }), "undoing Bree's re-sync");
    assert.equal(label({ stats: null }), "removing Bree's stat block", "a patch without a record keeps the block's words");
  });
});
