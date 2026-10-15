import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RollTest } from "../model.ts";
import { RULES_TEXT } from "../srd/rules-text.ts";
import { ROLL_REMINDER_RULES, rollReminders } from "./rollReminders.ts";

const DEX_SAVE: RollTest = { kind: "save", choices: [{ ability: "dex" }] };
const STR_OR_DEX_SAVE: RollTest = { kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] };
const PERCEPTION: RollTest = { kind: "check", choices: [{ ability: "wis", skill: "perception" }] };
const ATHLETICS_OR_ACROBATICS: RollTest = { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] };

/** The SRD's apostrophes are curly, the reminders' quotes straight. */
function plain(text: string): string {
  return text.replaceAll("’", "'");
}

describe("roll reminders (docs/design-v1-dm-tools.md 3.3)", () => {
  test("every reminder rests on words its SRD 5.2.1 rule says", () => {
    for (const rule of ROLL_REMINDER_RULES) {
      const entry = rule.source === "conditions" ? RULES_TEXT.conditions[rule.key as keyof typeof RULES_TEXT.conditions] : RULES_TEXT.statuses[rule.key as keyof typeof RULES_TEXT.statuses];
      assert.ok(entry, `${rule.key} has SRD text`);
      for (const quote of rule.quotes) assert.ok(plain(entry.text).includes(quote), `${rule.key}: "${quote}"`);
    }
  });

  test("each shows only when it bears on what was asked", () => {
    const keysFor = (keys: string[], test: RollTest, choice?: number) => rollReminders(keys.map((key) => ({ key: key as never })), test, choice).map((r) => r.key);
    assert.deepEqual(keysFor(["paralyzed", "petrified", "stunned", "unconscious"], DEX_SAVE), ["paralyzed", "petrified", "stunned", "unconscious"]);
    assert.deepEqual(keysFor(["paralyzed"], PERCEPTION), []);
    assert.deepEqual(keysFor(["restrained", "dodging", "hasted"], DEX_SAVE), ["restrained", "dodging", "hasted"]);
    assert.deepEqual(keysFor(["restrained", "dodging", "hasted"], { kind: "save", choices: [{ ability: "con" }] }), []);
    assert.deepEqual(keysFor(["blinded", "deafened", "poisoned", "frightened", "hexed"], PERCEPTION), ["blinded", "deafened", "poisoned", "frightened", "hexed"]);
    assert.deepEqual(keysFor(["blinded", "deafened", "poisoned", "frightened", "hexed"], DEX_SAVE), []);
    assert.deepEqual(keysFor(["blessed", "baned"], DEX_SAVE), ["baned", "blessed"]);
    assert.deepEqual(keysFor(["blessed", "baned"], PERCEPTION), []);
    assert.deepEqual(keysFor(["raging"], ATHLETICS_OR_ACROBATICS), ["raging"]);
    assert.deepEqual(keysFor(["raging"], ATHLETICS_OR_ACROBATICS, 1), []);
    assert.deepEqual(keysFor(["raging"], STR_OR_DEX_SAVE, 0), ["raging"]);
    assert.deepEqual(keysFor(["exhaustion", "heroic-inspiration"], PERCEPTION), ["exhaustion", "heroic-inspiration"]);
  });

  test("Exhaustion reads as its number, from the effect's level", () => {
    const [reminder] = rollReminders([{ key: "exhaustion", level: 2 }], DEX_SAVE);
    assert.equal(reminder?.text, "Exhaustion 2: the roll is reduced by 4.");
    assert.equal(rollReminders([{ key: "exhaustion" }], DEX_SAVE)[0]?.text, "Exhaustion 1: the roll is reduced by 2.");
  });

  test("Dodge and Rage say what ends them, and Hex stays general since the effect stores no ability", () => {
    const text = (key: string, test: RollTest) => rollReminders([{ key: key as never }], test)[0]?.text ?? "";
    assert.match(text("dodging", DEX_SAVE), /lost if you have the Incapacitated condition or if your Speed is 0/);
    assert.match(text("raging", STR_OR_DEX_SAVE), /ended early by Heavy armor or the Incapacitated condition/);
    assert.equal(text("hexed", PERCEPTION), "Hexed: Disadvantage on ability checks made with the ability the hex chose.");
  });

  test("an effect held twice reminds once", () => {
    assert.equal(rollReminders([{ key: "poisoned" }, { key: "poisoned" }], PERCEPTION).length, 1);
  });
});
