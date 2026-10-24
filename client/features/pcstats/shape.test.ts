import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor } from "#shared/testutil.ts";
import type { PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { effectiveShapeKind, END_SHAPE, shapeNote, shapePatch, shapeTempHp, wildShapeDetail } from "./shape.ts";

/** Take a shape and the section's words (docs/design-v1-pc-stats.md 7.3). The numbers a shape rolls with are doc 1's creatureNumbers (shared/rules/pcStats.shape.test.ts). */
describe("shapes", () => {
  const bear = { srdId: "brown-bear", ac: 11, speeds: { walk: 40, climb: 30 }, hp: { average: 22, formula: "3d10 + 6" } };

  test("one patch takes Wild Shape or another shape with the creature's AC and speeds, and one ends either", () => {
    const bree = { actor: actor() };
    assert.deepEqual(shapePatch(bear, "wild", bree), { srdId: "brown-bear", wildShape: true, ac: 11, speeds: { walk: 40, climb: 30 } });
    assert.deepEqual(shapePatch(bear, "other", bree), { srdId: "brown-bear", ac: 11, speeds: { walk: 40, climb: 30 } });
    assert.deepEqual(END_SHAPE, { srdId: null });
  });

  test("the 2024 temporary HP: the level for Wild Shape, the creature's HP for Polymorph, and only more than the character holds (W7B-P-9)", () => {
    assert.equal(shapeTempHp("wild", { level: 5 }, bear), 5);
    assert.equal(shapeTempHp("wild", {}, bear), 1, "an unset level reads as 1");
    assert.equal(shapeTempHp("other", { level: 5 }, bear), 22);
    const holding = (temp: number) => ({ actor: actor({ hp: { cur: 30, max: 30, temp } }) });
    assert.deepEqual(shapePatch(bear, "wild", holding(0), 5).hp, { temp: 5 });
    assert.equal(shapePatch(bear, "wild", holding(5), 5).hp, undefined, "never fewer, and the same is no gain");
    assert.equal(shapePatch(bear, "other", holding(30), 22).hp, undefined);
    assert.equal(shapePatch(bear, "wild", holding(0)).hp, undefined, "unticked");
  });

  test("the section says what the shape does", () => {
    const stats = EMPTY_PC_STATS as PcStats;
    assert.equal(shapeNote({ name: "Bree", stats, actor: actor({ srdId: "brown-bear", wildShape: true }) }, "Brown Bear", true), "In Wild Shape as Brown Bear. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.");
    assert.equal(shapeNote({ name: "Bree", stats, actor: actor({ srdId: "brown-bear" }) }, "Brown Bear", true), "In the shape of Brown Bear. Rolls use all of its numbers.");
    assert.equal(shapeNote({ name: "Bree", stats, actor: actor() }, "Brown Bear", true), null);
  });

  test("Wild Shape on a character with no stat block says it takes all of the creature's numbers, and points at adding one where the viewer may (LP7-PC-11)", () => {
    const sage = { name: "Sage", actor: actor({ srdId: "wolf", wildShape: true }) };
    assert.equal(shapeNote(sage, "Wolf", true), "In Wild Shape as Wolf. Sage has no stat block, so rolls use all of Wolf's numbers. Add a stat block to keep Sage's Intelligence, Wisdom, Charisma and proficiencies.");
    assert.equal(shapeNote(sage, "Wolf", false), "In Wild Shape as Wolf. Sage has no stat block, so rolls use all of Wolf's numbers.");
    assert.equal(wildShapeDetail(sage, "Wolf", true), "Sage has no stat block, so rolls use all of Wolf's numbers. Add a stat block to keep Sage's Intelligence, Wisdom, Charisma and proficiencies.");
    assert.equal(wildShapeDetail({ ...sage, stats: EMPTY_PC_STATS as PcStats }, "Wolf", true), "Sage keeps Intelligence, Wisdom, Charisma and proficiencies, and each save and skill takes the higher of the two.");
  });
});

describe("the kind a picked creature is taken as", () => {
  test("Polymorph chosen before another device put the character in Wild Shape is sent as Wild Shape, and stays Polymorph otherwise", () => {
    const wild = { actor: actor({ srdId: "wolf", wildShape: true }) };
    assert.equal(effectiveShapeKind(wild, "other"), "wild");
    assert.equal(effectiveShapeKind({ actor: actor({}) }, "other"), "other");
    assert.equal(effectiveShapeKind({ actor: actor({ srdId: "wolf" }) }, "other"), "other", "Polymorph's own shape is not Wild Shape");
    assert.equal(effectiveShapeKind({ actor: actor({}) }, "wild"), "wild");
  });
});
