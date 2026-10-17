import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { NOT_YOUR_ROLL, canApply, type PermissionDeps } from "./permissions.ts";
import type { Op, OpOf } from "./protocol.ts";
import { DM, P1, P2, character, room, scene, token } from "./testutil.ts";

/**
 * Who may roll for what (docs/design-v1-dice.md 4.3), row by row: anyone
 * for no creature, the DM for any creature that exists, a player only for
 * their own. A creature a player cannot see answers `gone`, as a missing
 * one does, so no refusal says a hidden creature exists.
 */
const deps: PermissionDeps = { canUseAsset: () => true };
const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";

function diceRoll(rolls: OpOf<"dice.roll">["rolls"]): Op {
  return { t: "dice.roll", tag: TAG, to: "all", rolls };
}

/** Thorn, p1's, on the players' scene, a goblin there, a hidden goblin, a goblin on another scene, and Bree, p1's character. */
function setup(): RoomState {
  return room({
    scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) },
    tokens: {
      thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"] }),
      g1: token("g1"),
      hidden: token("hidden", { visibility: "dm" }),
      away: token("away", { sceneId: "s2" }),
    },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
  });
}

function decide(op: Op, who = P1) {
  return canApply(op, who, setup(), deps);
}

describe("dice.roll permissions (docs/design-v1-dice.md 4.3)", () => {
  test("anyone rolls with no creature", () => {
    for (const who of [DM, P1, P2]) assert.deepEqual(decide(diceRoll([{ formula: "1d20" }]), who), { ok: true });
  });

  test("a player rolls for a creature of their own, token or character", () => {
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { tokenId: "thorn" } }])), { ok: true });
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { characterId: "bree" } }])), { ok: true });
  });

  test("a player naming a creature they see and do not own is refused, one they cannot see is gone", () => {
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { tokenId: "g1" } }])), { ok: false, code: "forbidden", message: NOT_YOUR_ROLL });
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { characterId: "bree" } }]), P2), { ok: false, code: "forbidden", message: NOT_YOUR_ROLL });
    const gone = { ok: false, code: "gone", message: "that is not here" };
    for (const id of ["hidden", "away", "missing"]) assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { tokenId: id } }])), gone, id);
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { characterId: "missing" } }])), gone);
  });

  test("one creature not theirs refuses the whole op, before anything is drawn", () => {
    const mixed = diceRoll([
      { formula: "1d20", creature: { tokenId: "thorn" } },
      { formula: "1d20", creature: { tokenId: "g1" } },
    ]);
    assert.equal(decide(mixed).ok, false);
  });

  test("the DM rolls for any creature that exists, on any scene, hidden or not", () => {
    for (const id of ["thorn", "g1", "hidden", "away"]) assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { tokenId: id } }]), DM), { ok: true }, id);
    assert.deepEqual(decide(diceRoll([{ formula: "1d20", creature: { tokenId: "missing" } }]), DM), { ok: false, code: "gone", message: "that is not here" });
  });

  test("a sys.dice is held to the rule of the op it carries", () => {
    const sys = (asked: Op) => ({ t: "sys.dice", asked, batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "1d20", faces: [3], total: 3 }] }) as Op;
    assert.equal(decide(sys(diceRoll([{ formula: "1d20", creature: { tokenId: "g1" } }]))).ok, false);
    assert.equal(decide(sys(diceRoll([{ formula: "1d20", creature: { tokenId: "thorn" } }]))).ok, true);
  });
});
