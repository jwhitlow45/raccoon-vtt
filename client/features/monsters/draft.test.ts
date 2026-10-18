import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { monsterInputSchema } from "#shared/protocol.ts";
import { emptyStatBlock, statBlockOf } from "#shared/statBlock.ts";
import { BLOCK_SAVES_TOO_FAST, BLOCKS_ROOM_TOO_FULL, LIMITS } from "#shared/limits.ts";
import { blockOf, companionBlock, customMonster, imageRef } from "#shared/testutil.ts";
import { blockSaveOutcome, issueText, lateBlockSaveText, monsterPatch, tidy, viewOf, withCr, withImage, withScore } from "./draft.ts";

describe("the editor's draft", () => {
  test("tidy trims, drops blank lines and empty entries, and keeps an ASCII minus in the hit dice", () => {
    const block = {
      ...emptyStatBlock(),
      name: "  Bog Hag ",
      hp: { average: 1, formula: " 1d4 − 1 " },
      skills: " Stealth +4 ",
      traits: [
        { name: " Swamp Stride. ", text: "  It moves freely.  \n\n  Even in mud. " },
        { name: "", text: " \n " },
      ],
    };
    const out = tidy(block);
    assert.equal(out.name, "Bog Hag");
    assert.equal(out.hp.formula, "1d4 - 1");
    assert.equal(out.skills, "Stealth +4");
    assert.deepEqual(out.traits, [{ name: "Swamp Stride", text: "It moves freely.\nEven in mud." }]);
  });

  test("an edit sends only the lines it changed, and null for an optional line it cleared", () => {
    const before = customMonster("m1", { sizeAlt: "medium", xpInLair: 700 });
    assert.deepEqual(monsterPatch(before, statBlockOf(before)), {});
    const after = { ...statBlockOf(before), ac: 16, actions: [] };
    delete after.sizeAlt;
    delete after.xpInLair;
    assert.deepEqual(monsterPatch(before, after), { ac: 16, actions: [], sizeAlt: null, xpInLair: null });
    const plain = customMonster("m2");
    assert.deepEqual(monsterPatch(plain, { ...statBlockOf(plain), sizeAlt: "small", xpInLair: 900 }), { sizeAlt: "small", xpInLair: 900 });
  });

  test("the image is saved with the block: set, changed, or cleared with null, and a paste keeps it", () => {
    const plain = customMonster("m1");
    const set = withImage(statBlockOf(plain), imageRef("pic"));
    assert.deepEqual(monsterPatch(plain, set), { defaultImage: imageRef("pic") });
    assert.equal(tidy(set).defaultImage, set.defaultImage);
    assert.ok(monsterInputSchema.safeParse({ id: "m1", ...tidy(set) }).success);

    const pictured = customMonster("m2", { defaultImage: imageRef("pic") });
    assert.deepEqual(monsterPatch(pictured, statBlockOf(pictured)), {});
    assert.deepEqual(monsterPatch(pictured, withImage(statBlockOf(pictured), imageRef("pic", 2))), { defaultImage: imageRef("pic", 2) });
    const removed = withImage(statBlockOf(pictured), null);
    assert.equal("defaultImage" in removed, false);
    assert.deepEqual(monsterPatch(pictured, removed), { defaultImage: null });
    // A pasted block has no image, and the editor puts the chosen one back on it.
    const pasted = withImage(emptyStatBlock(), statBlockOf(pictured).defaultImage ?? null);
    assert.deepEqual(pasted.defaultImage, imageRef("pic"));
  });

  test("a save that was the plain modifier follows the score, a proficient one stays", () => {
    const block = blockOf(customMonster("m1"));
    // Str 15 saves at +2, its modifier. Wis 12 saves at +3, a proficient save.
    const stronger = withScore(block, "str", 20);
    assert.deepEqual(stronger.abilities.str, { score: 20, save: 5 });
    const wiser = withScore(block, "wis", 18);
    assert.deepEqual(wiser.abilities.wis, { score: 18, save: 3 });
  });

  test("XP follows the challenge rating unless the DM typed another number", () => {
    const block = blockOf(customMonster("m1"));
    assert.equal(withCr(block, "5").xp, 1800);
    assert.equal(withCr({ ...block, xp: 123 }, "5").xp, 123);
  });

  test("refusals read as plain sentences that name the field", () => {
    const block = blockOf(customMonster("m1"));
    const check = (patch: object) => {
      const parsed = monsterInputSchema.safeParse({ id: "m1", ...block, ...patch });
      assert.ok(!parsed.success);
      return issueText(parsed.error.issues);
    };
    assert.deepEqual(check({ name: "" }), ["Name is needed."]);
    assert.deepEqual(check({ skills: "x".repeat(501) }), ["Skills is too long (at most 500 characters)."]);
    assert.deepEqual(check({ ac: 120 }), ["AC is too high (at most 100)."]);
    assert.deepEqual(check({ abilities: { ...block.abilities, dex: { score: -1, save: 0 } } }), ["Ability scores, DEX, score is too low (at least 0)."]);
    assert.deepEqual(check({ actions: [{ name: "Bite", text: "ok" }, { name: "Two\nlines", text: "" }] }), ["Actions, entry 2, name has a line break or a hidden character it cannot hold."]);
    assert.deepEqual(check({ cr: "1/3" }), ["CR is not a challenge rating."]);
    const huge = check({ traits: Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, text: "x".repeat(3_000) })) });
    assert.deepEqual(huge, ["This stat block is too long. A monster is at most 16 KiB."]);
  });

  test("a room monster's SRD-shaped view is worked out once per version", () => {
    const m = customMonster("m1");
    assert.equal(viewOf(m), viewOf(m));
    assert.notEqual(viewOf({ ...m }), viewOf(m));
    assert.equal(viewOf(m).name, "Cave Lurker");
    assert.equal(viewOf(m).srdId, undefined);
  });
});

describe("a companion block's save (docs/design-v1-companion-stat-blocks.md 6.2)", () => {
  test("an edit is diffed against the block as the editor opened it, so another's change to another line is kept", () => {
    const opened = companionBlock("b1", "bree", { name: "Moth Spirit", ac: 12 });
    // A co-owner renamed it meanwhile. This draft changed the AC alone.
    const live = { ...opened, name: "Moth Spirit, Bree's version" };
    const draft = { ...statBlockOf(customMonster("x")), ...blockOf(customMonster("b1")), ...stripped(opened), ac: 14 };
    assert.deepEqual(monsterPatch(stripped(opened), draft), { ac: 14 });
    // Diffed against the live block, the old name would go back as a change.
    assert.deepEqual(monsterPatch(stripped(live), draft), { name: "Moth Spirit", ac: 14 });
  });

  test("taken closes, and a refusal keeps the draft with the server's words, a guard's in the blocks' own", () => {
    assert.deepEqual(blockSaveOutcome("taken", undefined, "Bree"), { kind: "saved" });
    assert.deepEqual(blockSaveOutcome("refused", { message: BLOCKS_ROOM_TOO_FULL }, "Bree"), { kind: "problem", text: BLOCKS_ROOM_TOO_FULL });
    assert.deepEqual(blockSaveOutcome("refused", { message: "Bree can keep at most 100 stat blocks. Delete one first." }, "Bree"), {
      kind: "problem",
      text: "Bree can keep at most 100 stat blocks. Delete one first.",
    });
    assert.deepEqual(blockSaveOutcome("refused", { message: "that is not here" }, "Bree"), { kind: "problem", text: "That is not here." });
    assert.deepEqual(blockSaveOutcome("unknown", undefined, "Bree"), { kind: "problem", text: "The connection dropped before the server answered. Check Bree’s stat blocks before saving again." });
  });

  test("past the saves budget the draft stays and Save waits out one refill before it is offered again", () => {
    assert.deepEqual(blockSaveOutcome("refused", { message: BLOCK_SAVES_TOO_FAST }, "Bree"), { kind: "problem", text: BLOCK_SAVES_TOO_FAST, retryInMs: LIMITS.companionBlockWriteRefillMs });
  });

  test("an answer after Cancel adds the block and says nothing, and a refusal or a lost answer is a toast", () => {
    assert.equal(lateBlockSaveText("Owl", "Bree", "taken"), null);
    assert.equal(lateBlockSaveText("Owl", "Bree", "refused", { message: "Bree can keep at most 100 stat blocks. Delete one first." }), "Owl was not saved. Bree can keep at most 100 stat blocks. Delete one first.");
    assert.equal(lateBlockSaveText("Owl", "Bree", "unknown"), "The connection dropped before the server answered, so Owl may not have been saved. Check Bree’s stat blocks.");
  });
});

/** A stored block as the editor's draft holds it, without the fields the entity carries. */
function stripped(block: ReturnType<typeof companionBlock>) {
  const { id: _id, rev: _rev, characterId: _c, fromSrd: _f, ...lines } = block;
  return lines;
}
