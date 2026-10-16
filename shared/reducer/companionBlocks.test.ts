import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { CompanionBlockInput } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, apply, character, companionBlock, env, imageRef, refused, room, token } from "../testutil.ts";

/** A character the player p1 plays, with a token of its own and one kept block. */
function bree() {
  return room({
    characters: { c1: character("c1", { name: "Bree", ownerIds: ["p1"] }), c2: character("c2", { name: "Ash", ownerIds: ["p2"] }) },
    tokens: { pc: token("pc", { kind: "pc", actor: { ref: "c1" } }) },
    companionBlocks: { b1: companionBlock("b1", "c1", { name: "Moth Spirit", sizeAlt: "tiny", xpInLair: 100 }) },
  });
}

function input(id: string, characterId: string, overrides: Partial<CompanionBlockInput> = {}): CompanionBlockInput {
  const { rev: _rev, ...block } = companionBlock(id, characterId);
  return { ...block, ...overrides };
}

describe("companion stat blocks", () => {
  test("create stores the block under its character with rev 0, touching nothing else, and logs nothing", () => {
    const before = bree();
    const r = applyOp(before, { t: "companionBlock.create", block: input("b2", "c1", { fromSrd: "owl" }) }, P1, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.companionBlock("b2")]);
    assert.ok(!r.global);
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.state.companionBlocks.b2, { ...input("b2", "c1", { fromSrd: "owl" }), rev: 1 });
    assert.equal(r.state.companionBlocks.b1, before.companionBlocks.b1);
    assert.equal(r.state.tokens, before.tokens);
  });

  test("create refuses an id in use as invalid and a character that is not there as gone", () => {
    const state = bree();
    assert.equal(refused(state, { t: "companionBlock.create", block: input("b1", "c1") }).code, "invalid");
    assert.equal(refused(state, { t: "companionBlock.create", block: input("b2", "nobody") }).code, "gone");
  });

  test("update changes only the lines it names, null clears the optional ones, and its character stays", () => {
    const state = bree();
    const next = apply(state, { t: "companionBlock.update", blockId: "b1", patch: { ac: 17, speed: "5 ft., Fly 60 ft.", sizeAlt: null, defaultImage: imageRef("moth") } }, P1);
    const b = next.companionBlocks.b1!;
    assert.equal(b.ac, 17);
    assert.equal(b.speed, "5 ft., Fly 60 ft.");
    assert.equal("sizeAlt" in b, false);
    assert.equal(b.xpInLair, 100);
    assert.deepEqual(b.defaultImage, imageRef("moth"));
    assert.equal(b.characterId, "c1");
    assert.deepEqual(b.actions, state.companionBlocks.b1!.actions);
    assert.equal(b.rev, state.companionBlocks.b1!.rev + 1);
    const cleared = apply(next, { t: "companionBlock.update", blockId: "b1", patch: { xpInLair: null, defaultImage: null } }, DM, 2);
    assert.equal("xpInLair" in cleared.companionBlocks.b1!, false);
    assert.equal("defaultImage" in cleared.companionBlocks.b1!, false);
    assert.equal(refused(state, { t: "companionBlock.update", blockId: "missing", patch: { ac: 1 } }).code, "gone");
  });

  test("delete removes the block and writes nothing else", () => {
    const state = bree();
    const r = applyOp(state, { t: "companionBlock.delete", blockId: "b1" }, P1, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.touched, [keys.companionBlock("b1")]);
    assert.equal(r.state.companionBlocks.b1, undefined);
    assert.equal(r.state.tokens, state.tokens);
    assert.equal(refused(r.state, { t: "companionBlock.delete", blockId: "b1" }).code, "gone");
  });

  test("deleting a character removes its blocks in id order, after its companions, and leaves another's", () => {
    const state = bree();
    state.companionBlocks.a0 = companionBlock("a0", "c1");
    state.companionBlocks.z9 = companionBlock("z9", "c1");
    state.companionBlocks.ash = companionBlock("ash", "c2");
    state.tokens.moth = token("moth", { kind: "npc", companion: { of: "c1", turn: "shared" }, ownerIds: ["p1"] });
    const r = applyOp(state, { t: "character.delete", characterId: "c1" }, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.state.companionBlocks), ["ash"]);
    const blocks = r.touched.filter((key) => key.startsWith("companionBlock:"));
    assert.deepEqual(blocks, [keys.companionBlock("a0"), keys.companionBlock("b1"), keys.companionBlock("z9")]);
    assert.ok(r.touched.indexOf(keys.token("moth")) < r.touched.indexOf(keys.companionBlock("a0")), "after its companions");
    assert.equal(r.state.tokens.moth, undefined);
  });
});
