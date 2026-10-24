import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, actor, env, room, token } from "../testutil.ts";

/**
 * A group save's Legendary Resistance writes its use line from op version
 * 20 (docs/design-v1-combat-controls.md 3.3 and 8), a secret save's hidden
 * from players, and an op stored before it writes none, so its later line
 * ids stay where they were.
 */

function table(): RoomState {
  return room({ tokens: { lich: token("lich", { name: "Lich", actor: { inline: actor({ hp: { cur: 300, max: 315, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } }) } });
}

const outcome = (quiet: boolean): Op => ({ t: "actor.outcome", plan: "pl1", label: "Hold Monster", ...(quiet ? { quiet: true } : {}), targets: [{ target: { tokenId: "lich" }, amount: 10, resist: true, effects: [{ id: "fx", key: "poisoned" }] }] });

describe("a group save's Legendary Resistance line", () => {
  test("goes first among the creature's lines, its counts private, and hidden after a secret save", () => {
    const r = applyOp(table(), outcome(false), DM, env(5));
    assert.ok(r.ok);
    assert.deepEqual(r.log.map((e) => e.data?.type), ["use", "hp", "effect"]);
    assert.deepEqual(r.log[0]!.data, { type: "use", what: "resist", left: 2, max: 3, tokenId: "lich", seen: true });
    const quiet = applyOp(table(), outcome(true), DM, env(5));
    assert.ok(quiet.ok);
    assert.equal(quiet.log[0]!.data?.type === "use" && quiet.log[0]!.data.hidden, true);
  });

  test("an op stored before version 20 writes none, so its damage and effect lines keep their ids", () => {
    const r = applyOp(table(), outcome(false), DM, { ...env(5), opVersion: 19 });
    assert.ok(r.ok);
    assert.deepEqual(r.log.map((e) => [e.id, e.data?.type]), [["5:0", "hp"], ["5:1", "effect"]]);
  });
});
