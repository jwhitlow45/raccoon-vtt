import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent, diceLineText, diceText, rollToastText, type LogNames } from "./logText.ts";
import type { DiceRoll, LogEvent } from "./model.ts";
import { member, room, token, character } from "./testutil.ts";

/** Dice wording (docs/design-v1-dice.md 5.5). */
const names: LogNames = room({
  members: { bree: { ...member("bree"), name: "Bree" }, mara: { ...member("mara", "dm"), name: "Mara" } },
  tokens: { thorn: token("thorn", { kind: "pc", name: "Thorn" }), g1: token("g1", { number: 1 }) },
  characters: { owl: character("owl", { name: "Owl" }) },
});

type DiceEvent = Extract<LogEvent, { type: "dice" }>;

function line(rolls: DiceRoll[], extra: Partial<DiceEvent> = {}): DiceEvent {
  return { type: "dice", by: "bree", to: "all", rolls, ...extra };
}

const LONGSWORD: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 13, label: "Longsword" };

describe("dice wording (docs/design-v1-dice.md 5.5)", () => {
  test("a roll's dice: its formula as asked, every face, a dropped one said, and the total", () => {
    assert.equal(diceText({ formula: "2d6+3", faces: [4, 6], total: 13 }), "2d6+3 (4, 6) = 13");
    assert.equal(diceText({ formula: "2d20kh1+5", faces: [14, 7], total: 19, mode: "adv" }), "1d20+5 with advantage (14, 7 dropped) = 19");
    assert.equal(diceText({ formula: "2d20kl1+5", faces: [14, 7], total: 12, mode: "dis" }), "1d20+5 with disadvantage (14 dropped, 7) = 12");
    assert.equal(diceText({ formula: "4d6kh3", faces: [3, 5, 1, 5], total: 13 }), "4d6kh3 (3, 5, 1 dropped, 5) = 13");
    assert.equal(diceText({ formula: "2d1000", faces: [1000, 999], total: 1999 }), "2d1000 (1,000, 999) = 1,999");
    assert.equal(diceText({ formula: "2d6 words", faces: [1, 2], total: 3 }), "2d6 words = 3", "a formula a later grammar refuses reads as its text and total");
  });

  test("a line names the roller, the label, the creature, and a DC's or an AC's verdict", () => {
    assert.equal(diceLineText(line([LONGSWORD]), names), "Bree rolled Longsword: 2d6+3 (4, 6) = 13.");
    assert.equal(diceLineText(line([{ formula: "2d6+3", faces: [4, 6], total: 13 }]), names), "Bree rolled 2d6+3 (4, 6) = 13.");
    assert.equal(diceLineText(line([{ formula: "1d20+5", faces: [12], total: 17, label: "Stealth", tokenId: "thorn" }]), names), "Bree rolled for Thorn, Stealth: 1d20+5 (12) = 17.");
    assert.equal(diceLineText(line([{ formula: "1d20", faces: [12], total: 12, characterId: "owl" }]), names), "Bree rolled for Owl: 1d20 (12) = 12.");
    assert.equal(diceLineText(line([{ formula: "1d20+5", faces: [8], total: 13 }], { dc: 15 }), names), "Bree rolled 1d20+5 (8) = 13 against DC 15: fail.");
    assert.equal(diceLineText(line([{ formula: "1d20+5", faces: [10], total: 15 }], { dc: 15 }), names), "Bree rolled 1d20+5 (10) = 15 against DC 15: pass.");
    assert.equal(diceLineText(line([{ formula: "1d20+4", faces: [13], total: 17 }], { ac: 15 }), names), "Bree rolled 1d20+4 (13) = 17 against AC 15: hit.");
    assert.equal(diceLineText(line([{ formula: "1d20+4", faces: [19], total: 23, critOn: 19 }], { ac: 25 }), names), "Bree rolled 1d20+4 (19) = 23 against AC 25: critical hit.");
    assert.equal(diceLineText(line([{ formula: "1d20+20", faces: [1], total: 21 }], { ac: 15 }), names), "Bree rolled 1d20+20 (1) = 21 against AC 15: miss.");
  });

  test("several rolls are one line each under the roller, a secret line read in full says so, and the bare line says only that", () => {
    const goblin: DiceRoll = { formula: "1d20+2", faces: [9], total: 11, label: "Dexterity save", tokenId: "g1" };
    assert.equal(
      diceLineText(line([goblin, { ...goblin, faces: [15], total: 17 }], { by: "mara", to: "dm", dc: 15 }), names),
      ["Mara rolled 2 times (secret):", "for Goblin 1, Dexterity save: 1d20+2 (9) = 11 against DC 15: fail.", "for Goblin 1, Dexterity save: 1d20+2 (15) = 17 against DC 15: pass."].join("\n"),
    );
    assert.equal(diceLineText(line([LONGSWORD], { to: "dm" }), names), "Bree rolled Longsword: 2d6+3 (4, 6) = 13 (secret).");
    assert.equal(diceLineText(line([], { by: "mara", to: "dm" }), names), "Mara rolled in secret.");
    assert.equal(describeEvent(line([], { by: "mara", to: "dm" }), names), "Mara rolled in secret.");
    assert.equal(diceLineText(line([LONGSWORD], { by: "gone" }), names), "Someone rolled Longsword: 2d6+3 (4, 6) = 13.");
  });

  test("a hidden creature's name reads as the viewer's view names it", () => {
    const view: LogNames = { ...names, tokens: {} };
    assert.equal(diceLineText(line([{ formula: "1d20", faces: [3], total: 3, tokenId: "thorn" }]), view), "Bree rolled for a creature: 1d20 (3) = 3.");
  });

  test("others' rolls of one batch are one toast", () => {
    assert.equal(rollToastText([line([{ formula: "1d20+5", faces: [14], total: 19, label: "Stealth" }])], names), "Bree rolled 19 for Stealth.");
    assert.equal(rollToastText([line([{ formula: "1d20+5", faces: [14], total: 19, tokenId: "thorn", label: "Stealth" }])], names), "Bree rolled 19 for Thorn, Stealth.");
    assert.equal(rollToastText([line([{ formula: "2d6", faces: [1, 1], total: 2 }])], names), "Bree rolled 2.");
    const save: DiceRoll = { formula: "1d20+2", faces: [9], total: 11, label: "Dexterity save" };
    assert.equal(rollToastText([line(Array.from({ length: 4 }, () => save), { by: "mara" }), line([save, save], { by: "mara" })], names), "Mara rolled 6 Dexterity saves.");
    assert.equal(rollToastText([line([LONGSWORD, LONGSWORD, LONGSWORD])], names), "Bree rolled Longsword 3 times.");
    assert.equal(rollToastText([line([LONGSWORD, save])], names), "Bree rolled 2 times.");
  });
});
