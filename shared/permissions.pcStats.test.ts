import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats, RoomState } from "./model.ts";
import { canApply } from "./permissions.ts";
import { onPlayerUndoStack, type Op, type PcStatsPatch } from "./protocol.ts";
import { EMPTY_PC_STATS } from "./rules/pcStats.ts";
import { DM, P1, P2, actor, character, room } from "./testutil.ts";

/**
 * Who edits a character's stat block (docs/design-v1-pc-stats.md 4.1): the
 * DM and the character's players, co-owners included, with no room
 * setting, and no one else.
 */

const BLOCK: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), saves: ["dex"] };

/** Bree, played by p1 and p2 together, and Cy by p2 alone. */
function setup(): RoomState {
  return room({
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }),
      cy: character("cy", { name: "Cy", ownerIds: ["p2"] }),
    },
  });
}

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, { canUseAsset: () => true });
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const edit = (characterId: string, stats: PcStatsPatch | null): Op => ({ t: "character.update", characterId, patch: { stats } });

describe("stat block permissions", () => {
  test("an owner and a co-owner edit and remove their character's block, the DM any character's", () => {
    assert.equal(decide(edit("bree", BLOCK)), "ok");
    assert.equal(decide(edit("bree", { saves: ["con"] }), P2), "ok");
    assert.equal(decide(edit("bree", null)), "ok");
    assert.equal(decide(edit("cy", BLOCK), DM), "ok");
  });

  test("another player gets the refusal any field of a character they do not play gets", () => {
    assert.equal(decide(edit("cy", BLOCK)), "forbidden: that is not yours");
    assert.equal(decide(edit("cy", null)), "forbidden: that is not yours");
  });

  test("a player's new character may carry a block", () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = true;
    const op: Op = { t: "character.create", character: { id: "mine", name: "Mira", size: "medium", ownerIds: ["p1"], actor: actor({ dmNotes: "" }), stats: BLOCK } };
    assert.equal(decide(op, P1, state), "ok");
  });

  test("a player's undo never restores a character: a block edit is on no player's stack, and a restore of a character is refused", () => {
    assert.equal(onPlayerUndoStack(edit("bree", BLOCK)), false);
    const restore: Op = { t: "sys.restore", entries: [{ key: "character:bree", value: character("bree", { ownerIds: ["p1"], stats: BLOCK }) }], from: "undo" };
    assert.equal(decide(restore), "forbidden: only the DM can do that");
  });

  test("a character's players take a shape on it, and never link a room monster or shape another's character", () => {
    const shape = (characterId: string, actor: object): Op => ({ t: "character.update", characterId, patch: { actor } as never });
    assert.equal(decide(shape("bree", { srdId: "brown-bear", wildShape: true })), "ok");
    assert.equal(decide(shape("bree", { srdId: null }), P2), "ok");
    assert.equal(decide(shape("bree", { monsterId: "m1" })), "forbidden: owners cannot change monsterId");
    assert.equal(decide(shape("cy", { srdId: "brown-bear" })), "forbidden: that is not yours");
    assert.equal(decide(shape("cy", { monsterId: "m1" }), DM), "ok");
  });
});
