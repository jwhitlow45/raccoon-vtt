import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor } from "#shared/testutil.ts";
import { END_SHAPE, shapeNote, shapePatch } from "./shape.ts";

/** Take a shape and the section's words (docs/design-v1-pc-stats.md 7.3). The numbers a shape rolls with are doc 1's creatureNumbers (shared/rules/pcStats.shape.test.ts). */
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
});
