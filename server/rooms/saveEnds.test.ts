import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Effect, LogEvent, RoomState } from "#shared/model.ts";
import { AT, actor, effect, room, token } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";
import { describeOp } from "./undoLabels.ts";

/** A save that ends an effect in a room's export and its undo words (docs/design-v1-roll-options.md 6.1). */
function withSave(): RoomState {
  const fx: Effect = effect("fx", { key: "frightened", save: { ability: "wis", dc: 15, spell: true }, due: { id: "3:0", state: "pending" } });
  const line: LogEvent = { type: "saveEnds", tokenId: "gob", effectId: "fx", key: "frightened", ability: "wis", dc: 15 };
  return { ...room({ tokens: { gob: token("gob", { name: "Goblin 2", actor: { inline: actor({ effects: [fx] }) } }) } }), log: [{ id: "3:0", at: AT, kind: "event", data: line }] };
}

describe("save ends in a room's export", () => {
  test("the import schema takes an effect's save and occurrence and the turn end's line, with the DC in doc 1's bounds", () => {
    const parsed = parseRoomState(JSON.parse(JSON.stringify(withSave())));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const far = withSave();
    ((far.tokens.gob!.actor as { inline: { effects: Effect[] } }).inline.effects[0]!.save as { dc: number }).dc = 51;
    assert.equal(parseRoomState(JSON.parse(JSON.stringify(far))).ok, false);
  });

  test("remap keeps the save, moves the line to the new token, and drops the occurrence, whose line and request stay behind", () => {
    const out = remapState(withSave(), { assets: new Map() });
    const gob = Object.values(out.tokens)[0]!;
    const fx = (gob.actor as { inline: { effects: Effect[] } }).inline.effects[0]!;
    assert.deepEqual([fx.save, fx.due], [{ ability: "wis", dc: 15, spell: true }, undefined]);
    const data = out.log[0]?.data as Extract<LogEvent, { type: "saveEnds" }>;
    assert.equal(data.tokenId, gob.id);
    assert.notEqual(data.tokenId, "gob");
  });

  test("the DM's settle has undo words", () => {
    const state = withSave();
    assert.equal(describeOp({ t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due: "3:0", state: "resolved" }, state), "accepting a failed save for Goblin 2");
    assert.equal(describeOp({ t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due: "3:0", state: "dismissed" }, state), "dismissing a save for Goblin 2");
  });
});
