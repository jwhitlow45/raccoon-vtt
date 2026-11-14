import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { opKind } from "./farLine.ts";
import { admitLimits, checkLimits, LIMITS, type LimitSender } from "./limits.ts";
import type { RoomState } from "./model.ts";
import { seatView } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { character, companionBlock, DM, env, member, room } from "./testutil.ts";

/*
 * The companion stat block caps at admission (limits.ts admitLimits): the
 * room's totals answer the DM over the blocks of characters no player
 * owns and refuse only an op that adds to the room's blocks, so a
 * character handed from a player to the DM changes no answer of an op
 * that adds no block, and a refusal names a character as it is named now.
 */

const DM_SENDER: LimitSender = { role: "dm" };
const P1: LimitSender = { role: "player", memberId: "p1", viewOf: (state) => seatView(state, "p1") };

/** Six characters no player owns and one of P1's, each keeping `perCharacter` small blocks. */
function blocksRoom(perCharacter: number): RoomState {
  const state = room();
  state.members.p1 = member("p1");
  for (let c = 0; c < 7; c++) {
    const id = `c${c}`;
    state.characters[id] = character(id, { name: `Hero ${c}`, ownerIds: c === 6 ? ["p1"] : [] });
    for (let i = 0; i < perCharacter; i++) {
      const blockId = `b${c}-${String(i).padStart(3, "0")}`;
      state.companionBlocks[blockId] = companionBlock(blockId, id);
    }
  }
  return state;
}

/** The answer admission gives `op` from `sender` on `state`. */
function admit(state: RoomState, op: Op, sender: LimitSender): string {
  const viewer = sender.role === "dm" ? DM : { memberId: sender.memberId, role: "player" as const };
  const r = applyOp(state, op, viewer, env(9));
  assert.ok(r.ok, r.ok ? "" : r.message);
  const check = admitLimits(r.state, null, state, sender, opKind(op));
  return check.ok ? "taken" : check.message;
}

function blockCreate(id: string, characterId: string): Op {
  const { rev: _rev, ...block } = companionBlock(id, characterId);
  return { t: "companionBlock.create", block } as Op;
}

describe("the room's block caps answer the DM by what an op adds", () => {
  test("the DM handing a player's character back takes it with the room's total unchanged, and the DM's later ops are taken", () => {
    const state = blocksRoom(LIMITS.companionBlocksPerRoom / 6);
    assert.equal(Object.keys(state.companionBlocks).length, LIMITS.companionBlocksPerRoom + LIMITS.companionBlocksPerRoom / 6);
    const handBack: Op = { t: "character.update", characterId: "c6", patch: { ownerIds: [] } } as Op;
    assert.equal(admit(state, handBack, DM_SENDER), "taken", "the hand-back adds no block");
    const back = applyOp(state, handBack, DM, env(9));
    assert.ok(back.ok);
    const hp: Op = { t: "actor.hp", target: { characterId: "c0" }, change: { kind: "damage", amount: 1 } } as Op;
    assert.equal(admit(back.state, hp, DM_SENDER), "taken", "an HP change after it");
    assert.match(admit(back.state, blockCreate("b-new", "c0"), DM_SENDER), /^The room can hold at most 600 companion stat blocks/, "a block the DM adds past the room's cap");
  });

  test("a refusal for a character past its own cap names it as it is named now, after a rename, for a player and for an import", () => {
    const state = blocksRoom(1);
    for (let i = 0; i <= LIMITS.companionBlocksPerCharacter; i++) state.companionBlocks[`x${i}`] = companionBlock(`x${i}`, "c6");
    const hp: Op = { t: "actor.hp", target: { characterId: "c6" }, change: { kind: "damage", amount: 1 } } as Op;
    assert.match(admit(state, hp, P1), /^Hero 6 can keep at most/);
    const imported = checkLimits(state);
    assert.match(imported.ok ? "taken" : imported.message, /^Hero 6 can keep at most/);
    // Renamed with its blocks untouched, as no op that adds no block changes them.
    const renamed = applyOp(state, { t: "character.update", characterId: "c6", patch: { name: "Ayla" } } as Op, DM, env(9));
    assert.ok(renamed.ok);
    assert.equal(renamed.state.companionBlocks, state.companionBlocks);
    assert.match(admit(renamed.state, hp, P1), /^Ayla can keep at most/);
    const again = checkLimits(renamed.state);
    assert.match(again.ok ? "taken" : again.message, /^Ayla can keep at most/);
  });
});
