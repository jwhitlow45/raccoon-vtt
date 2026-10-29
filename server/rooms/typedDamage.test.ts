import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp } from "#shared/reducer.ts";
import { actor, customMonster, DM, env, room, token } from "#shared/testutil.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { parseRoomState } from "./stateSchema.ts";

test("FL3-OPUS-9: room import preserves a damage death-save line's audience marker", () => {
  const before = room({ tokens: { target: token("target", { ownerIds: ["p2"], actor: { inline: actor({ life: "dying", hp: { cur: 0, max: 50, temp: 0 } }) } }) } });
  const result = applyOp(before, { t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: 1, parts: [{ amount: 1, type: "fire" }] } }, DM, env(1));
  assert.ok(result.ok);
  const lines = result.state.log.filter((line) => line.data?.type === "deathSave");
  assert.equal(lines.length, 2, "the DM line and its owner's copy");
  assert.ok(lines.every((line) => line.data?.type === "deathSave" && line.data.exact));
  const imported = parseRoomState(JSON.parse(JSON.stringify(result.state)));
  assert.ok(imported.ok, imported.ok ? "" : imported.message);
  assert.deepEqual(imported.state.log, result.state.log);
});

test("FL3-ASTRA-04: room import preserves a typed concentration check's audience marker", () => {
  const before = room({ tokens: { target: token("target", { ownerIds: ["p2"], actor: { inline: actor({ effects: [{ id: "spell", key: "concentrating" }] }) } }) } });
  const result = applyOp(before, { t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: 1, parts: [{ amount: 1, type: "fire" }] } }, DM, env(1));
  assert.ok(result.ok);
  const lines = result.state.log.filter((line) => line.data?.type === "concentration");
  assert.equal(lines.length, 2, "the DM line and its owner's copy");
  assert.ok(lines.every((line) => line.data?.type === "concentration" && line.data.exact));
  const imported = parseRoomState(JSON.parse(JSON.stringify(result.state)));
  assert.ok(imported.ok, imported.ok ? "" : imported.message);
  assert.deepEqual(imported.state.log, result.state.log);
});

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
