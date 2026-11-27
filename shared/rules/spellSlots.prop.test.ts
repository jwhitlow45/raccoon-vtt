import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { CLASS_IDS } from "./classResources.ts";
import type { ClassLevel, HitDieSize } from "../model.ts";
import { holds } from "../propertyTestutil.ts";
import { DIE_KEYS, diceOf, isNormalSpent, levelOf, slotsOf, spentWithin } from "./spellSlots.ts";

/** Classes within the caps: distinct SRD classes and Other rows, levels adding up to at most 20. */
const classesArb: fc.Arbitrary<ClassLevel[]> = fc
  .tuple(
    fc.subarray([...CLASS_IDS], { maxLength: 4 }),
    fc.array(fc.constantFrom<HitDieSize>(6, 8, 10, 12), { maxLength: 2 }),
    fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 6, maxLength: 6 }),
    fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  )
  .map(([ids, others, lv, ticks]) => {
    const out: ClassLevel[] = ids.map((id, i) => (ticks[i] && (id === "fighter" || id === "rogue") ? { id, level: lv[i]!, third: true as const } : { id, level: lv[i]! }));
    others.forEach((die, i) => out.push({ id: "other", level: lv[4 + i]!, die }));
    let sum = levelOf(out);
    while (sum > 20) {
      const big = out.reduce((a, b) => (b.level > a.level ? b : a));
      big.level -= 1;
      sum -= 1;
    }
    return out;
  });

const spentArb = fc.record(
  {
    slots: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 9, maxLength: 9 }),
    pact: fc.integer({ min: 0, max: 6 }),
    dice: fc.record({ d12: fc.integer({ min: 0, max: 22 }), d10: fc.integer({ min: 0, max: 22 }), d8: fc.integer({ min: 0, max: 22 }), d6: fc.integer({ min: 0, max: 22 }) }, { requiredKeys: [] }),
  },
  { requiredKeys: [] },
);

describe("spell slot and Hit Point Dice properties", () => {
  test("raising any class's level never lowers a count", () => {
    holds(
      fc.property(classesArb, fc.nat(11), (classes, pick) => {
        if (classes.length === 0 || levelOf(classes) >= 20) return;
        const i = pick % classes.length;
        const raised = classes.map((c, j) => (j === i ? { ...c, level: c.level + 1 } : c));
        const before = slotsOf(classes);
        const after = slotsOf(raised);
        // One class becoming a caster can move a lone half or third caster onto the multiclass table, which only ever adds.
        before.slots.forEach((count, level) => assert.ok(after.slots[level]! >= count, `slot level ${level + 1}`));
        assert.ok((after.pact?.slots ?? 0) >= (before.pact?.slots ?? 0) && (after.pact?.level ?? 0) >= (before.pact?.level ?? 0));
        for (const key of DIE_KEYS) assert.ok((diceOf(raised)[key] ?? 0) >= (diceOf(classes)[key] ?? 0));
      }),
      300,
    );
  });
  test("any split of full caster levels gives the same slots", () => {
    holds(
      fc.property(fc.integer({ min: 2, max: 20 }), fc.subarray(["bard", "cleric", "druid", "sorcerer", "wizard"] as const, { minLength: 2 }), fc.nat(), (total, ids, seed) => {
        const split = ids.map(() => 1);
        let left = total - split.length;
        if (left < 0) return;
        for (let i = 0; left > 0; i = (i + seed + 1) % split.length, left--) split[i]! += 1;
        assert.deepEqual(slotsOf(ids.map((id, i) => ({ id, level: split[i]! }))).slots, slotsOf([{ id: "wizard", level: total }]).slots);
      }),
      300,
    );
  });
  test("dice always add up to the class levels", () => {
    holds(fc.property(classesArb, (classes) => assert.equal(Object.values(diceOf(classes)).reduce((a, b) => a + b, 0), levelOf(classes))), 300);
  });
  test("spentWithin is idempotent, normal and within the counts", () => {
    holds(
      fc.property(classesArb, spentArb, (classes, spent) => {
        const once = spentWithin(spent, classes);
        assert.deepEqual(spentWithin(once, classes), once);
        assert.ok(isNormalSpent(once, classes));
        const { slots, pact } = slotsOf(classes);
        once?.slots?.forEach((count, i) => assert.ok(count <= slots[i]!));
        assert.ok((once?.pact ?? 0) <= (pact?.slots ?? 0));
        const dice = diceOf(classes);
        for (const key of DIE_KEYS) assert.ok((once?.dice?.[key] ?? 0) <= (dice[key] ?? 0));
      }),
      300,
    );
  });
});
