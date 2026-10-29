import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp } from "#shared/reducer.ts";
import { actor, customMonster, DM, env, room, token } from "#shared/testutil.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { parseRoomState } from "./stateSchema.ts";

test("FL3-OPUS-1: states after typed hits round trip through room import validation", () => {
  let state = room({ monsters: { frost: customMonster("frost", { immunities: "Fire" }) }, tokens: { target: token("target", { actor: { inline: actor({ monsterId: "frost", hp: { cur: 100, max: 100, temp: 0 } }) } }) } });
  assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok, "the initial fixture imports");
  let seq = 1;
  for (const parts of [[{ amount: 5 }], [{ amount: 10, type: "fire" }, { amount: 5 }], [{ amount: 10, type: "fire" }], [{ amount: 4, type: "cold" }]]) {
    const op = clientOpSchema.parse({ t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: parts.reduce((sum, part) => sum + part.amount, 0), parts } });
    const result = applyOp(state, op, DM, env(seq++));
    assert.ok(result.ok);
    const imported = parseRoomState(JSON.parse(JSON.stringify(result.state)));
    assert.ok(imported.ok, imported.ok ? "" : imported.message);
    assert.deepEqual(imported.state.tokens, result.state.tokens);
    state = result.state;
  }
});
