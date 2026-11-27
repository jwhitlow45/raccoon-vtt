import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClassLevel } from "../model.ts";
import { classesFit, diceOf, dieOf, hasSlots, isNormalSpent, levelOf, normalSpent, slotsOf, spentWithin } from "./spellSlots.ts";

/**
 * The tables as SRD 5.2.1 prints them (each class's Features table, the
 * Multiclass Spellcaster table, Pact Magic), typed again here by slot level
 * so a row typed wrong in spellSlots.ts fails. The one-third rows are the
 * 2024 Player's Handbook's, not SRD 5.2.1.
 */
const FULL: Record<number, number[]> = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2],
  11: [4, 3, 3, 3, 2, 1], 12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1], 15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1],
  17: [4, 3, 3, 3, 2, 1, 1, 1, 1], 18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};
const HALF: Record<number, number[]> = {
  1: [2], 2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3], 9: [4, 3, 2], 10: [4, 3, 2],
  11: [4, 3, 3], 12: [4, 3, 3], 13: [4, 3, 3, 1], 14: [4, 3, 3, 1], 15: [4, 3, 3, 2], 16: [4, 3, 3, 2], 17: [4, 3, 3, 3, 1], 18: [4, 3, 3, 3, 1], 19: [4, 3, 3, 3, 2], 20: [4, 3, 3, 3, 2],
};
const THIRD: Record<number, number[]> = {
  1: [], 2: [], 3: [2], 4: [3], 5: [3], 6: [3], 7: [4, 2], 8: [4, 2], 9: [4, 2], 10: [4, 3],
  11: [4, 3], 12: [4, 3], 13: [4, 3, 2], 14: [4, 3, 2], 15: [4, 3, 2], 16: [4, 3, 3], 17: [4, 3, 3], 18: [4, 3, 3], 19: [4, 3, 3, 1], 20: [4, 3, 3, 1],
};
const PACT: Record<number, [number, number]> = {
  1: [1, 1], 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [2, 3], 6: [2, 3], 7: [2, 4], 8: [2, 4], 9: [2, 5], 10: [2, 5],
  11: [3, 5], 12: [3, 5], 13: [3, 5], 14: [3, 5], 15: [3, 5], 16: [3, 5], 17: [4, 5], 18: [4, 5], 19: [4, 5], 20: [4, 5],
};
const nine = (counts: number[]) => [...counts, ...Array<number>(9 - counts.length).fill(0)];
const levels = Array.from({ length: 20 }, (_, i) => i + 1);

describe("spell slots by class (SRD 5.2.1)", () => {
  for (const id of ["bard", "cleric", "druid", "sorcerer", "wizard"] as const) {
    test(`${id} reads the full caster table at every level`, () => {
      for (const level of levels) assert.deepEqual(slotsOf([{ id, level }]), { slots: nine(FULL[level]!), pact: null }, `${id} ${level}`);
    });
  }
  for (const id of ["paladin", "ranger"] as const) {
    test(`${id} has Spellcasting from level 1 by its own table`, () => {
      for (const level of levels) assert.deepEqual(slotsOf([{ id, level }]).slots, nine(HALF[level]!), `${id} ${level}`);
    });
  }
  for (const id of ["fighter", "rogue"] as const) {
    test(`${id} whose subclass casts reads the one-third table from level 3, and none untick or below`, () => {
      for (const level of levels) {
        assert.deepEqual(slotsOf([{ id, level, third: true }]).slots, nine(THIRD[level]!), `${id} ${level}`);
        assert.deepEqual(slotsOf([{ id, level }]).slots, nine([]), `${id} ${level} unticked`);
      }
    });
  }
  test("a warlock has Pact Magic and no spell slots at every level", () => {
    for (const level of levels) assert.deepEqual(slotsOf([{ id: "warlock", level }]), { slots: nine([]), pact: { slots: PACT[level]![0], level: PACT[level]![1] } }, `warlock ${level}`);
  });
  test("barbarian, monk and an Other class cast nothing", () => {
    for (const level of levels) {
      for (const entry of [{ id: "barbarian", level }, { id: "monk", level }, { id: "other", level, die: 8 }] as ClassLevel[]) assert.equal(hasSlots([entry]), false);
    }
  });
});

describe("multiclass spell slots", () => {
  test("paladin 1 alone has its own 2 level 1 slots, and with fighter 1 still one caster class", () => {
    assert.deepEqual(slotsOf([{ id: "paladin", level: 1 }]).slots, nine([2]));
    assert.deepEqual(slotsOf([{ id: "paladin", level: 1 }, { id: "fighter", level: 1 }]).slots, nine([2]));
  });
  test("paladin 3 and wizard 1 read caster level 3, half rounded up", () => {
    assert.deepEqual(slotsOf([{ id: "paladin", level: 3 }, { id: "wizard", level: 1 }]).slots, nine([4, 2]));
  });
  test("ranger 5 and druid 5 read caster level 8", () => {
    assert.deepEqual(slotsOf([{ id: "ranger", level: 5 }, { id: "druid", level: 5 }]).slots, nine(FULL[8]!));
  });
  test("a third caster alone at 2, 3 and 4, and with a wizard a third rounded down", () => {
    assert.deepEqual(slotsOf([{ id: "fighter", level: 2, third: true }]).slots, nine([]));
    assert.deepEqual(slotsOf([{ id: "fighter", level: 3, third: true }]).slots, nine([2]));
    assert.deepEqual(slotsOf([{ id: "fighter", level: 4, third: true }]).slots, nine([3]));
    assert.deepEqual(slotsOf([{ id: "fighter", level: 4, third: true }, { id: "wizard", level: 1 }]).slots, nine(FULL[2]!));
    assert.deepEqual(slotsOf([{ id: "rogue", level: 5, third: true }, { id: "wizard", level: 1 }]).slots, nine(FULL[2]!));
    // Below 3 the tick gives no Spellcasting, so the wizard is the one caster class on its own table.
    assert.deepEqual(slotsOf([{ id: "fighter", level: 2, third: true }, { id: "wizard", level: 3 }]).slots, nine(FULL[3]!));
  });
  test("a ticked fighter 2 with a ticked rogue 5 is one caster class, the rogue's own one-third table", () => {
    assert.deepEqual(slotsOf([{ id: "fighter", level: 2, third: true }, { id: "rogue", level: 5, third: true }]).slots, nine(THIRD[5]!));
  });
  test("a ticked fighter 2 with paladin 3 is one caster class, the paladin's own table", () => {
    assert.deepEqual(slotsOf([{ id: "fighter", level: 2, third: true }, { id: "paladin", level: 3 }]).slots, nine(HALF[3]!));
  });
  test("warlock 5 and sorcerer 3 keep Pact Magic apart", () => {
    assert.deepEqual(slotsOf([{ id: "warlock", level: 5 }, { id: "sorcerer", level: 3 }]), { slots: nine([4, 2]), pact: { slots: 2, level: 3 } });
  });
  test("an Other class counts toward no slots", () => {
    assert.deepEqual(slotsOf([{ id: "other", level: 3, die: 8 }, { id: "wizard", level: 2 }]).slots, nine(FULL[2]!));
  });
  test("paladin 1 and ranger 1 read caster level 2, each class rounded on its own", () => {
    assert.deepEqual(slotsOf([{ id: "paladin", level: 1 }, { id: "ranger", level: 1 }]).slots, nine(FULL[2]!));
  });
});

describe("Hit Point Dice", () => {
  test("each class's die", () => {
    const expected = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8, sorcerer: 6, wizard: 6 } as const;
    for (const [id, die] of Object.entries(expected)) assert.equal(dieOf({ id, level: 1 } as ClassLevel), die, id);
    assert.equal(dieOf({ id: "other", level: 2, die: 12 }), 12);
  });
  test("paladin 5 and fighter 5 pool 10 d10, and with cleric 5 keep 5 d8 apart", () => {
    assert.deepEqual(diceOf([{ id: "paladin", level: 5 }, { id: "fighter", level: 5 }]), { d10: 10 });
    assert.deepEqual(diceOf([{ id: "paladin", level: 5 }, { id: "cleric", level: 5 }]), { d10: 5, d8: 5 });
  });
  test("an Other class adds its die, and the level is the sum", () => {
    const classes: ClassLevel[] = [{ id: "other", level: 3, die: 8 }, { id: "wizard", level: 2 }];
    assert.deepEqual(diceOf(classes), { d8: 3, d6: 2 });
    assert.equal(levelOf(classes), 5);
    assert.deepEqual(Object.keys(diceOf([{ id: "wizard", level: 1 }, { id: "barbarian", level: 1 }, { id: "fighter", level: 1 }, { id: "bard", level: 1 }])), ["d12", "d10", "d8", "d6"]);
  });
});

describe("spent counts", () => {
  const wizard5: ClassLevel[] = [{ id: "wizard", level: 5 }];
  test("normal form: nine slot counts while one is above 0, zeros dropped, empty is absent", () => {
    assert.equal(normalSpent({ slots: [0, 0, 0, 0, 0, 0, 0, 0, 0], pact: 0, dice: { d6: 0 } }), undefined);
    assert.deepEqual(normalSpent({ slots: [0, 1], dice: { d6: 2, d12: 0 } }), { slots: [0, 1, 0, 0, 0, 0, 0, 0, 0], dice: { d6: 2 } });
  });
  test("a classes change clamps spent to the new counts", () => {
    const spent = { slots: [4, 3, 2, 0, 0, 0, 0, 0, 0], dice: { d6: 5 } };
    assert.deepEqual(spentWithin(spent, [{ id: "wizard", level: 4 }]), { slots: [4, 3, 0, 0, 0, 0, 0, 0, 0], dice: { d6: 4 } });
    assert.equal(spentWithin(spent, []), undefined);
    assert.equal(spentWithin({ pact: 2 }, wizard5), undefined);
  });
  test("an import's spent must be normal and within the counts, keys in any order", () => {
    assert.equal(isNormalSpent({ slots: [1, 0, 0, 0, 0, 0, 0, 0, 0] }, wizard5), true);
    assert.equal(isNormalSpent({ dice: { d6: 1 }, slots: [1, 0, 0, 0, 0, 0, 0, 0, 0] }, wizard5), true);
    assert.equal(isNormalSpent({ slots: [5, 0, 0, 0, 0, 0, 0, 0, 0] }, wizard5), false);
    assert.equal(isNormalSpent({ slots: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, wizard5), false);
    assert.equal(isNormalSpent({ pact: 0 }, wizard5), false);
    assert.equal(isNormalSpent(undefined, wizard5), true);
  });
  test("the caps: 12 entries, each SRD class once, levels 1 to 20 adding up to 20, third only on a fighter or rogue", () => {
    assert.equal(classesFit([{ id: "wizard", level: 10 }, { id: "cleric", level: 10 }]), true);
    assert.equal(classesFit([{ id: "wizard", level: 10 }, { id: "cleric", level: 11 }]), false);
    assert.equal(classesFit([{ id: "wizard", level: 1 }, { id: "wizard", level: 1 }]), false);
    assert.equal(classesFit([{ id: "other", level: 1, die: 6 }, { id: "other", level: 1, die: 8 }]), true);
    assert.equal(classesFit([{ id: "wizard", level: 3, third: true }]), false);
    assert.equal(classesFit([{ id: "wizard", level: 0 }]), false);
  });
});
