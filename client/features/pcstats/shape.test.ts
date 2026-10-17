import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, character, customMonster, blockOf } from "#shared/testutil.ts";
import { END_SHAPE, shapedRollNumbers, shapeNote, shapePatch } from "./shape.ts";

/** Take a shape and the section's words (docs/design-v1-pc-stats.md 7.3). */

const BREE: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 10 }, saves: ["wis"] };
const BEAR = blockOf(
  customMonster("bear", {
    name: "Brown Bear",
    abilities: { str: { score: 17, save: 3 }, dex: { score: 12, save: 1 }, con: { score: 15, save: 2 }, int: { score: 2, save: -4 }, wis: { score: 13, save: 1 }, cha: { score: 7, save: -2 } },
    skills: "Perception +3",
  }),
);

describe("shapes", () => {
  test("one patch takes Wild Shape or another shape, and one ends either", () => {
    assert.deepEqual(shapePatch("brown-bear", "wild"), { srdId: "brown-bear", wildShape: true });
    assert.deepEqual(shapePatch("brown-bear", "other"), { srdId: "brown-bear" });
    assert.deepEqual(END_SHAPE, { srdId: null });
  });

  test("the section says what the shape does", () => {
    assert.equal(shapeNote({ actor: actor({ srdId: "brown-bear", wildShape: true }) }, "Brown Bear"), "In Wild Shape as Brown Bear. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.");
    assert.equal(shapeNote({ actor: actor({ srdId: "brown-bear" }) }, "Brown Bear"), "In the shape of Brown Bear. Rolls use all of its numbers.");
    assert.equal(shapeNote({ actor: actor() }, "Brown Bear"), null);
  });

  test("the numbers rolled with: mixed in Wild Shape with a block, the creature's own otherwise", () => {
    const wild = character("bree", { level: 5, stats: BREE, actor: actor({ srdId: "brown-bear", wildShape: true }) });
    assert.equal(shapedRollNumbers(wild, BEAR).abilities.wis.save, 6);
    assert.equal(shapedRollNumbers(wild, BEAR).abilities.str.save, 3);
    assert.equal(shapedRollNumbers({ ...wild, stats: undefined }, BEAR).abilities.wis.save, 1);
    assert.equal(shapedRollNumbers({ ...wild, actor: actor({ srdId: "brown-bear" }) }, BEAR).abilities.wis.save, 1);
  });
});
