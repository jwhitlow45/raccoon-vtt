import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, actor, env, room, token } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Ops stored before op version 5 replay with the rules they were applied
 * under (shared/migrate.ts, step 4 to 5): healing did nothing to the dead,
 * a set of HP left a dead creature dead at the set HP, and Revive kept the
 * HP a dead creature held. Replay hands the reducer the stored version, so
 * a version 4 op makes the very state it made then, whatever the room's
 * "Healing brings back the dead" reads now, and a later stored restore's
 * guard still matches.
 */
const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

function deadGoblin(cur = 0): RoomState {
  return room({ tokens: { g1: token("g1", { actor: { inline: actor({ hp: { cur, max: 20, temp: 0 }, life: "dead" }) } }) } });
}

function applied(state: RoomState, op: Op, opVersion?: number): RoomState {
  const r = applyOp(state, op, DM, at(2, opVersion));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

const hpOf = (state: RoomState) => {
  const goblin = state.tokens.g1!.actor;
  assert.ok("inline" in goblin);
  return [goblin.inline.life, goblin.inline.hp.cur];
};

describe("version 4 ops on the dead", () => {
  const heal: Op = { t: "actor.hp", target: { tokenId: "g1" }, change: { kind: "heal", amount: 5 } };
  const set: Op = { t: "actor.hp", target: { tokenId: "g1" }, change: { kind: "set", cur: 9 } };
  const revive: Op = { t: "actor.life", target: { tokenId: "g1" }, life: "alive" };

  test("a heal replays to a dead monster, and at version 5 or live brings it back at the healed HP", () => {
    const r = applyOp(deadGoblin(), heal, DM, at(2, 4));
    assert.ok(r.ok);
    assert.deepEqual(hpOf(r.state), ["dead", 0]);
    assert.deepEqual(r.log, [], "no line, as then");
    assert.deepEqual(hpOf(applied(deadGoblin(), heal, 5)), ["alive", 5]);
    assert.deepEqual(hpOf(applied(deadGoblin(), heal)), ["alive", 5]);
  });

  test("a set replays to a dead monster holding the set HP, and at version 5 brings it back at that HP", () => {
    assert.deepEqual(hpOf(applied(deadGoblin(), set, 4)), ["dead", 9]);
    assert.deepEqual(hpOf(applied(deadGoblin(), set, 5)), ["alive", 9]);
  });

  test("a Revive of a dead creature holding 12 HP replays to 12, and at version 5 gives exactly 1", () => {
    assert.deepEqual(hpOf(applied(deadGoblin(12), revive, 4)), ["alive", 12]);
    assert.deepEqual(hpOf(applied(deadGoblin(12), revive, 5)), ["alive", 1]);
  });

  test("version 4 ops keep their rule even in a room whose setting is on in so many words", () => {
    const state = deadGoblin();
    state.meta.settings = { ...state.meta.settings, healRevives: true };
    assert.deepEqual(hpOf(applied(state, heal, 4)), ["dead", 0]);
    state.meta.settings = { ...state.meta.settings, healRevives: false };
    assert.deepEqual(hpOf(applied(state, heal, 5)), ["dead", 0], "and a version 5 op follows the setting off");
  });

  test("an undo of a version 4 set on the dead still matches its guard when replayed at version 4, and would not at 5", () => {
    const start = deadGoblin();
    const first = applyOp(start, set, DM, at(2, 4));
    assert.ok(first.ok && first.inverse);
    const undo: Op = { t: "sys.restore", entries: first.inverse, from: "undo", deps: true };
    const replayed = applyOp(first.state, undo, DM, at(3, 4));
    assert.ok(replayed.ok, "the guard matches the state the version 4 set made");
    assert.deepEqual(hpOf(replayed.state), ["dead", 0]);
    const today = applyOp(start, set, DM, at(2));
    assert.ok(today.ok);
    const mismatched = applyOp(today.state, undo, DM, at(3));
    assert.equal(mismatched.ok, false, "today's set made another state, so the stored guard would refuse");
  });
});
