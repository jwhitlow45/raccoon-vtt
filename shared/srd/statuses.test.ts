import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STATUS_KEYS, type StatusKey } from "../model.ts";
import { STATUSES } from "./statuses.ts";

/** The statuses whose rules the SRD defines, and where. */
const SRD_DEFINED: Record<Exclude<StatusKey, "marked">, string> = {
  concentrating: "Concentration",
  hidden: "Hide",
  flying: "Flying",
  dodging: "Dodge",
  raging: "Rage",
  blessed: "Bless",
  baned: "Bane",
  hasted: "Haste",
  "hunters-mark": "Hunter’s Mark",
  hexed: "Hex",
  "heroic-inspiration": "Heroic Inspiration",
  surprised: "Surprise",
  readied: "Ready",
};

describe("statuses", () => {
  test("every status key has a label, a summary and a color", () => {
    assert.deepEqual(Object.keys(STATUSES).sort(), [...STATUS_KEYS].sort());
    for (const key of STATUS_KEYS) {
      const s = STATUSES[key];
      assert.equal(s.key, key);
      assert.ok(s.label.length > 0 && s.label.length <= 24, `${key} label`);
      assert.ok(s.summary.length > 10 && s.summary.length <= 200, `${key} summary length`);
      assert.doesNotMatch(s.summary, /[;\u2014]/, `${key} summary`);
      assert.match(s.color, /^#[0-9a-f]{6}$/, `${key} color`);
    }
  });

  test("colors are distinct", () => {
    const colors = STATUS_KEYS.map((k) => STATUSES[k].color);
    assert.equal(new Set(colors).size, colors.length);
  });

  test("statuses the SRD defines carry its rules text, and Marked does not", () => {
    for (const [key, title] of Object.entries(SRD_DEFINED)) {
      const rules = STATUSES[key as StatusKey].rules;
      assert.ok(rules, `${key} has rules`);
      assert.equal(rules.title, title);
      assert.ok(rules.text.length > 50, `${key} rules text`);
    }
    assert.equal(STATUSES.marked.rules, undefined);
  });

  test("rules text matches SRD 5.2.1", () => {
    const text = (k: StatusKey) => STATUSES[k].rules?.text ?? "";
    assert.match(text("hidden"), /you must succeed on a DC 15 Dexterity \(Stealth\) check/);
    assert.match(text("hidden"), /you have the Invisible condition while hidden/);
    assert.match(text("dodging"), /any attack roll made against you has Disadvantage if you can see the attacker, and you make Dexterity saving throws with Advantage/);
    assert.match(text("raging"), /\*\*Damage Resistance\.\*\* You have Resistance to Bludgeoning, Piercing, and Slashing damage\./);
    assert.match(text("raging"), /You can maintain a Rage for up to 10 minutes\./);
    assert.match(text("blessed"), /the target adds 1d4 to the attack roll or save/);
    assert.match(text("baned"), /the target must subtract 1d4 from the attack roll or save/);
    assert.match(text("hasted"), /it gains a \+2 bonus to Armor Class/);
    assert.match(text("hunters-mark"), /you deal an extra 1d6 Force damage to the target/);
    assert.match(text("hexed"), /you deal an extra 1d6 Necrotic damage to the target/);
    assert.match(text("heroic-inspiration"), /reroll any die immediately after rolling it/);
    assert.match(text("surprised"), /Disadvantage on its Initiative roll/);
    assert.match(text("concentrating"), /up to a maximum DC of 30/);
    assert.match(text("flying"), /You can stay aloft in those circumstances if you can hover\./);
    assert.match(text("readied"), /lets you act by taking a Reaction before the start of your next turn/);
    assert.match(text("readied"), /you can either take your Reaction right after the trigger finishes or ignore the trigger/);
  });

  test("the Barbarian Features table is cut out of Rage", () => {
    assert.doesNotMatch(STATUSES.raging.rules?.text ?? "", /Primal Champion|Proficiency Bonus/);
  });

  test("spells show their header", () => {
    assert.match(STATUSES.blessed.rules?.text ?? "", /^\*Level 1 Enchantment \(Cleric, Paladin\)\*\n\n\*\*Casting Time:\*\* Action/);
    assert.match(STATUSES.hexed.rules?.text ?? "", /\*\*Duration:\*\* Concentration, up to 1 hour/);
  });
});
