import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { canApply, type PermissionDeps } from "./permissions.ts";
import type { CompanionBlockInput, Op } from "./protocol.ts";
import { DM, P1, P2, character, companionBlock, imageRef, room } from "./testutil.ts";

/**
 * The permissions of companion stat blocks
 * (docs/design-v1-companion-stat-blocks.md 4.1): a character's players and
 * the DM keep its blocks, with no room setting, and a player never learns
 * that a block outside their view exists.
 */

/** Only the images named "mine" are the player's to use. The DM may use every image of the room. */
const deps: PermissionDeps = { canUseAsset: (memberId, assetId) => memberId === "dm1" || assetId.startsWith("mine") };

/** Bree, played by p1 and p2 together, Cy by p2 alone, and one block each. */
function setup(): RoomState {
  return room({
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }),
      cy: character("cy", { name: "Cy", ownerIds: ["p2"] }),
    },
    companionBlocks: { moth: companionBlock("moth", "bree"), wolf: companionBlock("wolf", "cy", { name: "Wolf" }) },
  });
}

function input(id: string, characterId: string, overrides: Partial<CompanionBlockInput> = {}): CompanionBlockInput {
  const { rev: _rev, ...block } = companionBlock(id, characterId);
  return { ...block, ...overrides };
}

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const create = (block: CompanionBlockInput): Op => ({ t: "companionBlock.create", block });

describe("a character's companion stat blocks", () => {
  test("its players create, edit and delete them with no room setting, a co-owner too", () => {
    const state = setup();
    assert.equal(state.meta.settings.playersCreateCharacters, false);
    for (const who of [P1, P2]) {
      assert.equal(decide(create(input("new", "bree")), who, state), "ok");
      assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { ac: 13 } }, who, state), "ok");
      assert.equal(decide({ t: "companionBlock.delete", blockId: "moth" }, who, state), "ok");
    }
  });

  test("another's character answers that it is not theirs on create, and its blocks are not there", () => {
    assert.equal(decide(create(input("new", "cy"))), "forbidden: that is not yours");
    assert.equal(decide({ t: "companionBlock.update", blockId: "wolf", patch: { ac: 13 } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.delete", blockId: "wolf" }), "gone: that is not here");
  });

  test("a block or a character that is not there answers alike, and a new id in use never says so", () => {
    assert.equal(decide(create(input("new", "nobody"))), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "missing", patch: { ac: 13 } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.delete", blockId: "missing" }), "gone: that is not here");
    // Cy's wolf is out of p1's view: its id answers as the id of nothing.
    assert.equal(decide(create(input("wolf", "bree"))), "gone: that is not here");
  });

  test("a picture must be one the player may use, on create and on edit", () => {
    assert.equal(decide(create(input("new", "bree", { defaultImage: imageRef("mine-moth") }))), "ok");
    assert.equal(decide(create(input("new", "bree", { defaultImage: imageRef("theirs") }))), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { defaultImage: imageRef("theirs") } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { defaultImage: null } }), "ok");
    // A shipped icon names no asset.
    assert.equal(decide(create(input("new", "bree", { defaultImage: { icon: "lorc/wolf-head", color: "#336699" } }))), "ok");
  });

  test("the DM may do all of it, on any character, with an image of the room", () => {
    const state = setup();
    for (const op of [
      create(input("new", "cy", { defaultImage: imageRef("theirs") })),
      { t: "companionBlock.update", blockId: "wolf", patch: { name: "Dire Wolf" } } as Op,
      { t: "companionBlock.delete", blockId: "moth" } as Op,
    ]) {
      assert.equal(decide(op, DM, state), "ok", op.t);
    }
    const noRoom: PermissionDeps = { canUseAsset: () => false };
    const d = canApply(create(input("new", "cy", { defaultImage: imageRef("elsewhere") })), DM, state, noRoom);
    assert.deepEqual(d, { ok: false, code: "gone", message: "that is not here" });
  });
});
