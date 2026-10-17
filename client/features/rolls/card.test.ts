import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult, RollTarget } from "#shared/model.ts";
import { reminderPreset } from "#shared/rules/rollReminders.ts";
import { bestChoice, cardRoll, dmRoll, choiceLabel, CLEAR_TOTAL, NO_INPUTS, parseBonus, rolledDice, rolledNews, rolledText, TYPE_BONUS, verdictText } from "./card.ts";

const DEX = { kind: "save", ability: "dex" } as const;
const restrained = [{ key: "restrained" as const }];

describe("the card's Roll (docs/design-v1-roll-request.md 5.2, 5.3)", () => {
  test("with a known bonus it reads Roll +3, and with none it waits for a typed one", () => {
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll +3");
    assert.equal(cardRoll({ bonus: -1, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll -1");
    assert.equal(cardRoll({ bonus: 0, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll +0");
    const none = cardRoll({ bonus: null, preset: null, inputs: NO_INPUTS, text: "" });
    assert.equal(none.label, "Roll d20");
    assert.equal(none.blocked, TYPE_BONUS);
    assert.deepEqual(none.fields, { ok: false, error: TYPE_BONUS });
    const typed = cardRoll({ bonus: null, preset: null, inputs: { ...NO_INPUTS, bonus: "5" }, text: "" });
    assert.equal(typed.label, "Roll d20+5");
    assert.deepEqual(typed.fields, { ok: true, value: { bonus: 5 } }, "the typed bonus goes as `bonus`");
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, bonus: "5" }, text: "" }).fields, { ok: true, value: {} }, "a known bonus never sends one");
    assert.equal(cardRoll({ bonus: null, preset: null, inputs: { ...NO_INPUTS, bonus: "31" }, text: "" }).fields.ok, false);
    assert.deepEqual([parseBonus(""), parseBonus("+5"), parseBonus("−2"), parseBonus("-20"), parseBonus("x")], [null, { ok: true, bonus: 5 }, { ok: true, bonus: -2 }, { ok: true, bonus: -20 }, { ok: false, error: "A bonus is a whole number from -20 to 30." }]);
  });

  test("a total in the field holds Roll back", () => {
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "9" }).blocked, CLEAR_TOTAL);
  });

  test("the reading names each source and extra, and nothing at all draws none", () => {
    const blessed = reminderPreset([...restrained, { key: "blessed" }], DEX);
    const roll = cardRoll({ bonus: 3, preset: blessed, inputs: NO_INPUTS, text: "" });
    assert.equal(roll.reading, "Rolls 1d20+3 with disadvantage (Restrained), +1d4 (Blessed).");
    assert.deepEqual(roll.fields, { ok: true, value: { mode: "dis", extra: "+1d4" } });
    // Restrained and the player's Adv: any advantage with any disadvantage is a normal roll.
    const adv = cardRoll({ bonus: 3, preset: reminderPreset(restrained, DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" });
    assert.equal(adv.reading, "Rolls 1d20+3: Advantage and Restrained cancel.");
    assert.deepEqual(adv.fields, { ok: true, value: { cancelled: true } });
    // Hasted (advantage on Dex saves) and Restrained, the player presses Adv too: still normal.
    const hasted = cardRoll({ bonus: 3, preset: reminderPreset([...restrained, { key: "hasted" }], DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" });
    assert.deepEqual(hasted.fields, { ok: true, value: { cancelled: true } });
    // Blessed and Exhaustion 2, the player types +1d6: "+1d4-4+1d6", each named.
    const tired = cardRoll({ bonus: 3, preset: reminderPreset([{ key: "blessed" }, { key: "exhaustion", level: 2 }], DEX), inputs: { ...NO_INPUTS, extra: "1d6" }, text: "" });
    assert.equal(tired.reading, "Rolls 1d20+3, -4 (Exhaustion), +1d4 (Blessed), +1d6.");
    assert.deepEqual(tired.fields, { ok: true, value: { extra: "-4+1d4+1d6" } });
    assert.equal(cardRoll({ bonus: 3, preset: reminderPreset([], DEX), inputs: NO_INPUTS, text: "" }).reading, null);
    assert.equal(cardRoll({ bonus: 3, preset: reminderPreset([], DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" }).reading, "Rolls 1d20+3 with advantage.");
    assert.equal(tired.extraRoom, 40 - "-4+1d4".length, "the whole extra keeps within 40 characters");
  });

  test("Stunned on a Dex save says it fails whatever the roll", () => {
    const stunned = cardRoll({ bonus: 3, preset: reminderPreset([{ key: "stunned" }], DEX), inputs: NO_INPUTS, text: "" });
    assert.equal(stunned.reading, "Stunned: this save fails whatever the roll.");
  });

  test("the card checks what the server would refuse first, in its words", () => {
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, extra: "+1d" }, text: "" }).fields.ok, false);
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, extra: "+10d20" }, text: "" }).fields, { ok: false, error: "That roll could total outside -50 to 100. Type the total instead." });
  });

  test("two choices start at the higher bonus and name it", () => {
    assert.equal(bestChoice([1, 3]), 1);
    assert.equal(bestChoice([3, 3]), 0, "the first on a tie");
    assert.equal(bestChoice([null, 3]), 0, "the first with one unknown");
    assert.equal(choiceLabel("Dexterity", 3), "Dexterity +3");
    assert.equal(choiceLabel("Strength", null), "Strength");
  });
});

describe("a rolled result's words (5.4)", () => {
  const dis: DiceResult = { formula: "2d20kl1+3+1d4", faces: [14, 6, 3], total: 12, mode: "dis" };
  test("the dice with the dropped one, the verdict, a natural, and the news", () => {
    const target: RollTarget = { characterId: "thorn", total: 12, result: "fail", dice: dis, tag: "t1" };
    assert.deepEqual(rolledDice(dis), { formula: "1d20+3+1d4 with disadvantage", faces: [{ face: 14, dropped: true }, { face: 6, dropped: false }, { face: 3, dropped: false }] });
    assert.equal(rolledText(target), "Rolled 12 (1d20+3+1d4 with disadvantage: 14 dropped, 6, 3). Fail.");
    assert.equal(rolledNews("Thorn", target), "Thorn rolled 12. Fail.");
    const twenty: RollTarget = { characterId: "thorn", total: 25, result: "pass", dice: { formula: "1d20+5", faces: [20], total: 25 }, tag: "t2" };
    assert.equal(rolledText(twenty), "Rolled 25 (1d20+5: 20). Natural 20. Pass.");
    assert.equal(verdictText({ result: "fail", dice: { ...dis, fails: "stunned" } }), "Fail (Stunned)");
    assert.equal(verdictText({ dice: dis }), null, "pass or fail hidden");
  });
});

describe("the DM's Roll for a waiting creature (6)", () => {
  test("worded as doc 3's buttons, with the fields its unanswered roll sends", () => {
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset([], DEX) }), { label: "Roll +5", fields: {} });
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset(restrained, DEX), ability: "Dex" }), { label: "Roll Dex +5, Disadvantage (Restrained)", fields: { mode: "dis" } });
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset([{ key: "stunned" }], DEX) }).label, "Roll +5: fails (Stunned)");
    const mr = reminderPreset([], { ...DEX, spell: true }, { magicResistance: true });
    assert.deepEqual(dmRoll({ bonus: 2, preset: mr }), { label: "Roll +2, Advantage (Magic Resistance)", fields: { mode: "adv" } });
    assert.deepEqual(dmRoll({ bonus: 2, preset: reminderPreset([{ key: "blessed" }], DEX) }), { label: "Roll +2, +1d4 (Blessed)", fields: { extra: "+1d4" } });
  });
});
