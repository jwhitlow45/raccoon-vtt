import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { hpUndoRestore } from "#shared/reducer/hpUndo.ts";
import { actor, apply, DM, room, token } from "#shared/testutil.ts";
import { canTakeBack, fightHpLines } from "./hpLog.ts";

function hurtGoblin(): RoomState {
  let state = room();
  state.tokens.gob = token("gob", { name: "Goblin", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } });
  state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 1 } }, DM, 1);
  state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 10 }] }, DM, 2);
  state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 2 } }, DM, 3);
  return apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "heal", amount: 1 } }, DM, 4);
}

describe("the combat log of HP changes", () => {
  test("lists the fight's HP lines, newest first, and none from before it began", () => {
    const lines = fightHpLines(hurtGoblin().log);
    assert.deepEqual(lines.map((l) => [l.data.change, l.data.amount]), [["heal", 1], ["damage", 2]]);
  });

  test("offers the DM an undo only where it would apply", () => {
    let state = hurtGoblin();
    const [heal, hit] = fightHpLines(state.log);
    assert.equal(canTakeBack(state, state.log, heal!), true);
    assert.equal(canTakeBack(state, state.log, hit!), false, "the heal since changed the goblin");
    const built = hpUndoRestore(state, heal!.entry.id);
    assert.ok(built.ok);
    state = apply(state, { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: heal!.entry.id }, DM, 5);
    const [back, ...rest] = fightHpLines(state.log);
    assert.equal(back!.data.back, true);
    assert.equal(canTakeBack(state, state.log, back!), false, "a take-back is not taken back from the log");
    assert.equal(canTakeBack(state, state.log, rest[0]!), false, "the heal was already taken back");
    assert.equal(canTakeBack(state, state.log, rest[1]!), true, "now the hit can go");
    // A DM viewing another scene does not hold the token, and the server decides.
    const elsewhere = { ...state, tokens: {} };
    assert.equal(canTakeBack(elsewhere, state.log, rest[1]!), true);
  });
});
