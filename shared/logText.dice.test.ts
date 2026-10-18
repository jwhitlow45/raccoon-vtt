import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { critSumText, describeEvent, diceLineText, diceText, keptFrom, rollToastText, type LogNames } from "./logText.ts";
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
    assert.equal(diceText({ formula: "2d20kh1+5", faces: [14, 7], total: 19, mode: "adv" }), "1d20+5 with Advantage (14, 7 dropped) = 19");
    assert.equal(diceText({ formula: "2d20kl1+5", faces: [14, 7], total: 12, mode: "dis" }), "1d20+5 with Disadvantage (14 dropped, 7) = 12");
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
    assert.equal(diceLineText(line([{ formula: "1d20+4", faces: [19], total: 23, critOn: 19 }], { ac: 25 }), names), "Bree rolled 1d20+4 (19) = 23 against AC 25: Critical Hit.");
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

  test("a critical hit by each rule says how it was reached, the maxed part labeled and a doubling as × 2 (the critical hit rules addendum)", () => {
    const hit = (formula: string, faces: number[], total: number, crit: DiceRoll["crit"]): DiceRoll => ({ formula, faces, total, crit, label: "Scimitar critical damage, slashing" });
    assert.equal(diceText(hit("4d6+3", [1, 2, 5, 6], 17, "rollTwice")), "4d6+3 (1, 2, 5, 6) = 17");
    assert.equal(diceText(hit("2d6+3", [4, 6], 25, "maxPlusRoll")), "12 max + 2d6+3 (4, 6) = 25");
    assert.equal(diceText(hit("2d6+3", [4, 6], 23, "doubleDice")), "2d6 × 2 + 3 (4, 6) = 23");
    assert.equal(diceText(hit("2d6+3", [4, 6], 26, "doubleTotal")), "(2d6+3) × 2 (4, 6) = 26");
    // A rider merged into the weapon's formula: several dice terms take parentheses where the rule doubles them.
    assert.equal(diceText(hit("1d8+4+3d6", [5, 2, 3, 6], 46, "maxPlusRoll")), "26 max + 1d8+4+3d6 (5, 2, 3, 6) = 46");
    assert.equal(diceText(hit("1d8+4+3d6", [5, 2, 3, 6], 36, "doubleDice")), "(1d8+3d6) × 2 + 4 (5, 2, 3, 6) = 36");
    assert.equal(diceText(hit("2d6", [4, 6], 20, "doubleDice")), "2d6 × 2 (4, 6) = 20");
    assert.equal(diceText(hit("2d6-1", [4, 6], 19, "doubleDice")), "2d6 × 2 - 1 (4, 6) = 19");
    assert.equal(diceText(hit("1d6", [4], 8, "doubleTotal")), "1d6 × 2 (4) = 8");
    assert.equal(diceText(hit("4d6kh3", [3, 5, 1, 5], 31, "maxPlusRoll")), "18 max + 4d6kh3 (3, 5, 1 dropped, 5) = 31");
    assert.equal(critSumText(hit("2d6+3", [4, 6], 25, "maxPlusRoll")), "12 max + 13");
    assert.equal(critSumText(hit("2d6+3", [4, 6], 23, "doubleDice")), "10 × 2 + 3");
    assert.equal(critSumText(hit("2d6+3", [4, 6], 26, "doubleTotal")), "13 × 2");
    assert.equal(critSumText(hit("1d4-1", [1], 4, "maxPlusRoll")), "4 max + 0", "a sum of 0 still shows, so the arithmetic reads");
    assert.equal(critSumText(hit("4d6+3", [1, 2, 5, 6], 17, "rollTwice")), null, "the dice are the whole of it");
    assert.equal(critSumText(LONGSWORD), null);
    assert.equal(diceLineText(line([hit("2d6+3", [4, 6], 25, "maxPlusRoll")]), names), "Bree rolled Scimitar critical damage, slashing: 12 max + 2d6+3 (4, 6) = 25.");
    assert.equal(rollToastText([line([hit("2d6+3", [4, 6], 25, "maxPlusRoll")])], names), "Bree rolled 25 (12 max + 13) for Scimitar critical damage, slashing.");
    const fire: DiceRoll = { formula: "1d6", faces: [2], total: 8, crit: "maxPlusRoll", label: "Flame Tongue critical damage, fire" };
    const slashing: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll", label: "Flame Tongue critical damage, slashing" };
    assert.equal(rollToastText([line([slashing, fire])], names), "Bree rolled 33 (12 max + 13, 6 max + 2) for Flame Tongue critical damage.");
    assert.equal(diceLineText(line([], { to: "dm" }), names), "Bree rolled in secret.", "a secret crit shows no sum to another player");
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
    const slashing = { formula: "2d6+3", faces: [4, 3], total: 10, label: "Flame Tongue damage, slashing" };
    const fire = { formula: "2d6", faces: [1, 3], total: 4, label: "Flame Tongue damage, fire" };
    assert.equal(rollToastText([line([slashing, fire])], names), "Bree rolled 14 for Flame Tongue damage.", "one damage tap of two types is one roll");
    assert.equal(rollToastText([line([{ ...slashing, tokenId: "thorn" }, { ...fire, tokenId: "thorn" }])], names), "Bree rolled 14 for Thorn, Flame Tongue damage.");
    assert.equal(rollToastText([line([slashing, { ...fire, label: "Rend damage, fire" }])], names), "Bree rolled 2 times.", "two heads are two damages");
    assert.equal(rollToastText([line([slashing, slashing])], names), "Bree rolled Flame Tongue damage, slashing 2 times.", "a type twice is the same roll again");
    assert.equal(rollToastText([line([slashing, { ...fire, tokenId: "thorn" }])], names), "Bree rolled 2 times.", "two creatures are not one damage");
    assert.equal(rollToastText([line([{ ...slashing, label: "Flame Tongue damage, sharp" }, fire])], names), "Bree rolled 2 times.", "a word that is no damage type");
    // Labels sent since the SRD's capitals say "Slashing", and the lowercase in older rooms still reads.
    const capital = (roll: DiceRoll): DiceRoll => ({ ...roll, label: roll.label!.replace(/, (\w)/, (_, c: string) => `, ${c.toUpperCase()}`) });
    assert.equal(rollToastText([line([capital(slashing), capital(fire)])], names), "Bree rolled 14 for Flame Tongue damage.");
    assert.equal(rollToastText([line([slashing, capital(fire)])], names), "Bree rolled 14 for Flame Tongue damage.", "an old label beside a new one");
    assert.equal(rollToastText([line([slashing, capital(slashing)])], names), "Bree rolled 2 times.", "a type twice in either case is no one damage");
    // The server's death save keeps the label its replayed ops have always written, and reads as its button does.
    const death: DiceRoll = { formula: "1d20", faces: [12], total: 12, label: "Death save" };
    assert.equal(rollToastText([line([death])], names), "Bree rolled 12 for Death Save.");
    assert.equal(rollToastText([line([death, death])], names), "Bree rolled 2 Death Saves.");
    assert.equal(diceLineText(line([death]), names), "Bree rolled Death Save: 1d20 (12) = 12.");
  });
});

describe("a rolled answer's line (5.5)", () => {
  type RollLine = Extract<LogEvent, { type: "roll" }>;
  const owl = (extra: Partial<RollLine>): RollLine => ({
    type: "roll",
    test: { kind: "save", choices: [{ ability: "dex" }] },
    characterId: "owl",
    total: 12,
    dc: 13,
    dcShown: true,
    resultShown: true,
    result: "fail",
    dice: { formula: "1d20+3", faces: [9], total: 12 },
    tag: "t1",
    ...extra,
  });

  test("the dice follow the total, a typed bonus and a failing condition say so", () => {
    assert.equal(describeEvent(owl({}), names), "Owl rolled 12 (1d20+3: 9) on a Dexterity saving throw against DC 13: fail.");
    assert.equal(describeEvent(owl({ typedBonus: true }), names), "Owl rolled 12 (1d20+3, your bonus: 9) on a Dexterity saving throw against DC 13: fail.", "the player who typed it");
    assert.equal(describeEvent(owl({ typedBonus: true }), names, true), "Owl rolled 12 (1d20+3, their bonus: 9) on a Dexterity saving throw against DC 13: fail.", "the DM (LP7-DICE-11)");
    assert.equal(describeEvent(owl({ total: 21, dice: { formula: "1d20+3", faces: [18], total: 21, fails: "stunned" } }), names), "Owl rolled 21 (1d20+3: 18) on a Dexterity saving throw against DC 13: fails (Stunned).");
    assert.equal(describeEvent(owl({ total: 20, result: "pass", dice: { formula: "2d20kh1+3", faces: [17, 4], total: 20, mode: "adv" } }), names), "Owl rolled 20 (1d20+3 with Advantage: 17, 4 dropped) on a Dexterity saving throw against DC 13: pass.");
    assert.equal(describeEvent(owl({ total: 12, dice: undefined, tag: undefined }), names), "Owl rolled 12 on a Dexterity saving throw against DC 13: fail.", "a typed total reads as before");
  });

  test("an allowed change names its reason", () => {
    const change = (reason: "heroic-inspiration" | "halfling-luck" | "lucky" | "bardic-inspiration", die?: 8) => ({ id: "a", on: "t0", reason, ...(die ? { die } : {}) });
    assert.equal(
      describeEvent(owl({ total: 17, result: "pass", dice: { formula: "1d20+3+1d4", faces: [11, 3], total: 17 }, changed: change("heroic-inspiration") }), names),
      "Owl rerolled 17 (Heroic Inspiration, 1d20+3+1d4: 11, 3) on a Dexterity saving throw against DC 13: pass.",
    );
    assert.equal(describeEvent(owl({ total: 19, result: "pass", dice: { formula: "2d20kh1+3", faces: [9, 16], total: 19, mode: "adv" }, changed: change("lucky") }), names), "Owl used Lucky: 19 (1d20+3 with Advantage: 9 dropped, 16) on a Dexterity saving throw against DC 13: pass.");
    assert.equal(describeEvent(owl({ total: 15, result: "pass", dice: { formula: "1d20+3+1d8", faces: [9, 3], total: 15 }, changed: change("bardic-inspiration", 8) }), names), "Owl added Bardic Inspiration's 1d8: 3, now 15 on a Dexterity saving throw against DC 13: pass.");
  });
});

describe("an initiative roll kept from players, in the DM's log (B7B-P-5, docs/design-v1-combat-flow.md 11.3)", () => {
  const init = (total: number, extra: Partial<DiceRoll> = {}): DiceRoll => ({ formula: "1d20+2", faces: [total - 2], total, label: "Initiative", tokenId: "g1", initiative: true, ...extra });

  test("says hidden from players on each roll kept from them, and nothing on the others", () => {
    assert.equal(diceLineText(line([init(14, { hidden: true })], { by: "mara" }), names), "Mara rolled for Goblin 1, Initiative: 1d20+2 (12) = 14 (hidden from players).");
    assert.equal(diceLineText(line([init(14, { hidden: true })], { by: "mara", to: "dm" }), names), "Mara rolled for Goblin 1, Initiative: 1d20+2 (12) = 14 (secret, hidden from players).");
    assert.equal(
      diceLineText(line([init(14, { tokenId: "thorn" }), init(9, { hidden: true })], { by: "mara" }), names),
      ["Mara rolled 2 times:", "for Thorn, Initiative: 1d20+2 (12) = 14.", "for Goblin 1, Initiative: 1d20+2 (7) = 9 (hidden from players)."].join("\n"),
    );
    assert.equal(diceLineText(line([init(14)], { by: "mara" }), names), "Mara rolled for Goblin 1, Initiative: 1d20+2 (12) = 14.");
  });

  test("says hidden from other players on a creature lent to a player, whose own player still gets the roll (B7B-P-9)", () => {
    const lent: LogNames = room({
      members: { bree: { ...member("bree"), name: "Bree" }, mara: { ...member("mara", "dm"), name: "Mara" } },
      tokens: {
        wolf: token("wolf", { name: "Wolf", ownerIds: ["bree"] }),
        sage: token("sage", { kind: "npc", name: "Sage", actor: { ref: "sage" } }),
        kept: token("kept", { name: "Imp", ownerIds: ["mara"] }),
      },
      characters: { sage: character("sage", { name: "Sage", ownerIds: ["bree"] }) },
    });
    assert.equal(diceLineText(line([init(14, { tokenId: "wolf", hidden: true })], { by: "mara" }), lent), "Mara rolled for Wolf, Initiative: 1d20+2 (12) = 14 (hidden from other players).");
    assert.equal(diceLineText(line([init(14, { tokenId: "sage", hidden: true })], { by: "mara", to: "dm" }), lent), "Mara rolled for Sage, Initiative: 1d20+2 (12) = 14 (secret, hidden from other players).", "owned through its character");
    assert.equal(
      diceLineText(line([init(14, { tokenId: "wolf", hidden: true }), init(9, { tokenId: "kept", hidden: true })], { by: "mara" }), lent),
      ["Mara rolled 2 times:", "for Wolf, Initiative: 1d20+2 (12) = 14 (hidden from other players).", "for Imp, Initiative: 1d20+2 (7) = 9 (hidden from players)."].join("\n"),
      "a DM's own ownership is no player's",
    );
    assert.equal(keptFrom({ tokenId: "wolf" }, lent), "other players");
    assert.equal(keptFrom({ tokenId: "gone" }, lent), "players");
  });
});
