import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONDITION_KEYS } from "../model.ts";
import { CONDITIONS, EXHAUSTION_MAX_LEVEL, exhaustionEffects } from "./conditions.ts";

describe("conditions", () => {
  test("all 15 conditions have a name, a summary and the SRD text", () => {
    assert.equal(CONDITION_KEYS.length, 15);
    assert.deepEqual(Object.keys(CONDITIONS).sort(), [...CONDITION_KEYS].sort());
    for (const key of CONDITION_KEYS) {
      const c = CONDITIONS[key];
      assert.equal(c.key, key);
      assert.equal(c.name.toLowerCase(), key);
      assert.ok(c.summary.length > 10 && c.summary.length <= 200, `${key} summary length`);
      assert.match(c.rules.text, new RegExp(`^While you have the ${c.name} condition, you experience the following effects?\\.`));
      assert.equal(c.rules.source, "Rules Glossary, condition");
    }
  });

  test("summaries follow the house style", () => {
    for (const c of Object.values(CONDITIONS)) {
      assert.doesNotMatch(c.summary, /[;\u2014]/, `${c.key} summary`);
    }
  });

  test("rules text matches SRD 5.2.1", () => {
    assert.match(CONDITIONS.blinded.rules.text, /\*\*Can’t See\.\*\* You can’t see and automatically fail any ability check that requires sight\./);
    assert.match(CONDITIONS.prone.rules.text, /half your Speed \(round down\) to right yourself/);
    assert.match(CONDITIONS.incapacitated.rules.text, /\*\*Surprised\.\*\* If you’re Incapacitated when you roll Initiative, you have Disadvantage on the roll\./);
    assert.match(CONDITIONS.grappled.rules.text, /\*\*Attacks Affected\.\*\* You have Disadvantage on attack rolls against any target other than the grappler\./);
    assert.match(CONDITIONS.exhaustion.rules.text, /the roll is reduced by 2 times your Exhaustion level/);
    assert.match(CONDITIONS.exhaustion.rules.text, /reduced by a number of feet equal to 5 times your Exhaustion level/);
    assert.match(CONDITIONS.exhaustion.rules.text, /You die if your Exhaustion level is 6\./);
  });
});

describe("exhaustionEffects", () => {
  test("each level is -2 to D20 Tests and -5 feet of Speed", () => {
    assert.deepEqual(exhaustionEffects(0), { level: 0, d20Modifier: 0, speedModifier: 0, dead: false });
    assert.deepEqual(exhaustionEffects(1), { level: 1, d20Modifier: -2, speedModifier: -5, dead: false });
    assert.deepEqual(exhaustionEffects(3), { level: 3, d20Modifier: -6, speedModifier: -15, dead: false });
    assert.deepEqual(exhaustionEffects(5), { level: 5, d20Modifier: -10, speedModifier: -25, dead: false });
  });

  test("level 6 is death", () => {
    assert.equal(EXHAUSTION_MAX_LEVEL, 6);
    assert.deepEqual(exhaustionEffects(6), { level: 6, d20Modifier: -12, speedModifier: -30, dead: true });
  });

  test("out-of-range levels are clamped", () => {
    assert.deepEqual(exhaustionEffects(9), exhaustionEffects(6));
    assert.deepEqual(exhaustionEffects(-2), exhaustionEffects(0));
    assert.deepEqual(exhaustionEffects(Number.NaN), exhaustionEffects(0));
    assert.deepEqual(exhaustionEffects(2.7), exhaustionEffects(2));
  });
});
