import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FORMULA_ERRORS } from "#shared/dice/formula.ts";
import { BLOCK_SAVES_TOO_FAST, LIMITS } from "#shared/limits.ts";
import type { PcRoll, PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS, pcDerived } from "#shared/rules/pcStats.ts";
import { draftDirty, draftProblems, editedRoll, lateSaveText, newRoll, openDraft, saveOutcome, savePatch, statsPatch, tidyPart, withAllBonus, withTotal, type PcDraft } from "./draft.ts";
import { rollReading, rollTitle } from "./reading.ts";

/** The stat block editor's draft (docs/design-v1-pc-stats.md 7.2). */

function stats(overrides: Partial<PcStats> = {}): PcStats {
  return { ...structuredClone(EMPTY_PC_STATS as PcStats), ...overrides };
}

const DEX16 = stats({ abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 14, cha: 10 }, saves: ["dex"], skills: { perception: "prof" } });

function roll(overrides: Partial<PcRoll> = {}): PcRoll {
  return { id: "r", name: "Longsword", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "slashing", mod: true }], ...overrides };
}

describe("totals", () => {
  test("a typed total keeps its difference from the rules as the adjustment, which a level change keeps", () => {
    const typed = withTotal(DEX16, 5, { kind: "save", ability: "dex" }, 8);
    assert.deepEqual(typed.adjust, { saves: { dex: 2 } });
    assert.equal(pcDerived(typed, 5).saves.dex.total, 8);
    assert.equal(pcDerived(typed, 9).saves.dex.total, 9, "a level-up moves the total and keeps the +2");
    const passive = withTotal(DEX16, 5, { kind: "passive" }, 10);
    assert.equal(passive.adjust.passive, -5);
    assert.equal(withTotal(DEX16, 5, { kind: "skill", skill: "stealth" }, 5).adjust.skills?.stealth, 2);
    assert.equal(withTotal(DEX16, 5, { kind: "init" }, 3).adjust.init, undefined, "the total the rules give stores no adjustment");
  });

  test("clearing a field sets its adjustment to 0, which is left out", () => {
    const typed = withTotal(withTotal(DEX16, 5, { kind: "save", ability: "dex" }, 8), 5, { kind: "save", ability: "con" }, 1);
    const cleared = withTotal(typed, 5, { kind: "save", ability: "dex" }, null);
    assert.deepEqual(cleared.adjust, { saves: { con: 1 } });
    assert.deepEqual(withTotal(cleared, 5, { kind: "save", ability: "con" }, null).adjust, {}, "an empty map goes too");
  });

  test("a total past the adjustments' bounds is held at the nearest the bounds allow", () => {
    const high = withTotal(DEX16, 5, { kind: "save", ability: "dex" }, 60);
    assert.equal(high.adjust.saves?.dex, 20);
    assert.equal(pcDerived(high, 5).saves.dex.total, 6 + 20);
    assert.equal(withTotal(DEX16, 5, { kind: "init" }, -40).adjust.init, -20);
  });

  test("spell numbers need a spellcasting ability, and All saves and All checks are bonuses of their own", () => {
    assert.equal(withTotal(DEX16, 5, { kind: "spellDc" }, 15), DEX16, "no spellcasting ability, no field");
    const caster = { ...DEX16, spellAbility: "wis" as const };
    assert.equal(withTotal(caster, 5, { kind: "spellDc" }, 15).adjust.spellDc, 15 - (8 + 2 + 3));
    assert.equal(withTotal(caster, 5, { kind: "spellAttack" }, 4).adjust.spellAttack, -1);
    assert.equal(withAllBonus(DEX16, "allSaves", 1).adjust.allSaves, 1);
    assert.deepEqual(withAllBonus(withAllBonus(DEX16, "allChecks", 2), "allChecks", null).adjust, {});
    assert.equal(withAllBonus(DEX16, "allSaves", 30).adjust.allSaves, 20);
  });
});

describe("the patch a Save sends", () => {
  test("only the parts that differ from the block the editor opened with, each whole, and null for an optional part taken away", () => {
    const base = { ...DEX16, jack: true as const };
    const draft = { ...base, saves: ["dex", "wis"] as PcStats["saves"], jack: undefined, alert: true as const };
    delete draft.jack;
    assert.deepEqual(statsPatch(base, draft), { saves: ["dex", "wis"], jack: null, alert: true });
    assert.deepEqual(statsPatch(base, structuredClone(base)), {});
  });

  test("a character with a block gets the changed parts and the level, and nothing when nothing changed", () => {
    const { draft: opened, had } = openDraft({ stats: DEX16, level: 5 });
    assert.equal(had, true);
    assert.equal(savePatch(opened, had, opened), null);
    assert.equal(draftDirty(opened, opened), false);
    const draft: PcDraft = { stats: { ...DEX16, skills: { stealth: "expert" } }, level: 6 };
    assert.deepEqual(savePatch(opened, had, draft), { stats: { skills: { stealth: "expert" } }, level: 6 });
    assert.deepEqual(savePatch(opened, had, { stats: opened.stats, level: undefined }), { level: null });
    assert.equal(draftDirty(opened, draft), true);
  });

  test("a character without one always gets one, the empty block when nothing was typed, which is nothing to lose on close", () => {
    const { draft: opened, had } = openDraft({});
    assert.equal(had, false);
    assert.deepEqual(opened.stats, EMPTY_PC_STATS);
    assert.deepEqual(savePatch(opened, had, opened), { stats: {} });
    assert.equal(draftDirty(opened, opened), false);
    assert.deepEqual(savePatch(opened, had, { ...opened, stats: { ...opened.stats, saves: ["str"] } }), { stats: { saves: ["str"] } });
  });
});

describe("the problems that keep Save off", () => {
  test("none for a sound block", () => {
    assert.deepEqual(draftProblems({ stats: { ...DEX16, rolls: [roll()] }, level: 5 }), []);
  });

  test("a roll with no name, a formula in the dice's own words, and a roll with nothing to roll", () => {
    const problems = draftProblems({
      stats: {
        ...DEX16,
        rolls: [
          roll({ id: "a", name: " " }),
          roll({ id: "b", name: "Club", dice: [{ formula: "2d6 fire", type: "fire" }] }),
          roll({ id: "c", name: "Shove", kind: "other", attack: undefined, dice: [] }),
          roll({ id: "d", name: "Bolt", dice: [{ formula: "", type: "fire" }] }),
          roll({ id: "e", name: "Ray", kind: "spell", level: 2, dice: [{ formula: "2d6", type: "fire", upcast: "1d1001" }] }),
        ],
      },
      level: 5,
    });
    assert.deepEqual(problems, [
      "A weapon needs a name.",
      `Club, dice: ${FORMULA_ERRORS.other}`,
      "Shove has nothing to roll. Give it an attack, a save or dice.",
      "Bolt: type the dice, as 1d8 or 2d6+1.",
      `Ray, dice at higher levels: ${FORMULA_ERRORS.sides}`,
    ]);
  });

  test("a roll whose dice at level 20 or a 9th-level slot go past one roll", () => {
    const cantrip = roll({ name: "Big Bolt", kind: "spell", level: 0, ability: "spell", dice: [{ formula: "30d10", type: "fire", grows: true }] });
    assert.deepEqual(draftProblems({ stats: { ...DEX16, rolls: [cantrip] }, level: 1 }), ["Big Bolt would roll more dice at level 20 or a 9th-level slot than one roll holds. Use fewer dice."]);
    const fireball = roll({ name: "Fireball", kind: "spell", level: 3, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] });
    assert.deepEqual(draftProblems({ stats: { ...DEX16, rolls: [fireball] }, level: 5 }), [], "14d6 at slot 9");
    const flood = roll({ name: "Flood", kind: "spell", level: 1, dice: [{ formula: "20d6", type: "cold", upcast: "11d6" }] });
    assert.equal(draftProblems({ stats: { ...DEX16, rolls: [flood] }, level: 5 }).length, 1, "108 dice at slot 9");
  });

  test("a block past 12 KiB, in its size", () => {
    const rolls = Array.from({ length: 40 }, (_, i) => roll({ id: `r${i}`, name: "x".repeat(60), dice: Array.from({ length: 4 }, () => ({ formula: "1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6", type: "fire" as const })) }));
    const problems = draftProblems({ stats: { ...DEX16, rolls }, level: 5 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, new RegExp(`of the ${LIMITS.pcStatsBytes / 1024} KiB it may hold\\. Remove a few rolls\\.$`));
  });
});

describe("rolls", () => {
  test("a new weapon, spell and roll, a new spell reading the spellcasting ability and growing as a cantrip", () => {
    assert.deepEqual(newRoll("weapon", "w"), { id: "w", name: "", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "", mod: true, type: "slashing" }] });
    assert.deepEqual(newRoll("spell", "s"), { id: "s", name: "", kind: "spell", ability: "spell", level: 0, dice: [{ formula: "", grows: true }] });
    assert.deepEqual(newRoll("other", "o"), { id: "o", name: "", kind: "other", dice: [{ formula: "" }] });
  });

  test("an imported roll edited here becomes the player's own", () => {
    const imported = roll({ ddb: true });
    assert.equal(editedRoll(imported, { ...imported, name: "Longsword +1" }).ddb, undefined);
    assert.equal(editedRoll(roll(), { ...roll(), name: "x" }).ddb, undefined);
  });

  test("only a cantrip's dice grow, so a new spell given a level or another kind drops the mark it started with (LP7-PC-1)", () => {
    const fresh: PcRoll = { ...newRoll("spell", "s"), name: "Moonbeam", dice: [{ formula: "2d10", type: "radiant", grows: true }] };
    assert.deepEqual(editedRoll(fresh, { ...fresh, level: 2 }).dice, [{ formula: "2d10", type: "radiant" }]);
    assert.deepEqual(editedRoll(fresh, { ...fresh, kind: "other" }).dice, [{ formula: "2d10", type: "radiant" }]);
    assert.deepEqual(editedRoll(fresh, { ...fresh, name: "Fire Bolt" }).dice, [{ formula: "2d10", type: "radiant", grows: true }], "a cantrip keeps it");
  });

  test("a part says one thing: upcast on damage or healing, a rider on damage, its name on a rider", () => {
    assert.deepEqual(tidyPart({ formula: "1d8", upcast: "1d8", optional: true, name: "x" }), { formula: "1d8" });
    assert.deepEqual(tidyPart({ formula: "1d8", type: "healing", upcast: "1d8", optional: true, name: "x" }), { formula: "1d8", type: "healing", upcast: "1d8" });
    assert.deepEqual(tidyPart({ formula: "3d6", type: "piercing", name: "Sneak Attack" }), { formula: "3d6", type: "piercing" });
    assert.deepEqual(tidyPart({ formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" }), { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" });
  });

  test("a roll's reading and title, as the view and the editor's rows show them", () => {
    const fighter = { ...DEX16, abilities: { ...DEX16.abilities, str: 16 } };
    assert.equal(rollReading(fighter, 5, roll()), "+6 to hit, 1d8+3 slashing");
    const caster = { ...DEX16, spellAbility: "wis" as const };
    const fireball = roll({ name: "Fireball", kind: "spell", ability: "spell", level: 3, attack: undefined, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] });
    assert.equal(rollReading(caster, 5, fireball), "DC 13 Dexterity save, 8d6 fire, +1d6 for each slot level above 3");
    assert.equal(rollTitle(fireball), "Fireball (level 3)");
    assert.equal(rollTitle({ name: "Fire Bolt", kind: "spell", level: 0 }), "Fire Bolt (cantrip)");
    assert.equal(rollTitle(roll()), "Longsword");
    const rapier = roll({ name: "Rapier", ability: "dex", dice: [{ formula: "1d8", type: "piercing", mod: true }, { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" }] });
    assert.equal(rollReading(DEX16, 5, rapier), "+6 to hit, 1d8+3 piercing, +3d6 piercing Sneak Attack");
    const cure = roll({ name: "Cure Wounds", kind: "spell", ability: "spell", level: 1, attack: undefined, dice: [{ formula: "2d8", type: "healing", mod: true, upcast: "2d8" }] });
    assert.equal(rollReading(caster, 5, cure), "2d8+2 healing, +2d8 healing for each slot level above 1");
    assert.equal(rollReading(DEX16, 5, roll({ name: "Odd", dice: [{ formula: "1d8+", type: "fire" }] })), "+3 to hit, 1d8+", "a formula that stopped reading shows as typed");
  });
});

describe("a Save's answer", () => {
  test("taken closes, the budget keeps Save off for a few seconds, and a lost answer says to check", () => {
    assert.deepEqual(saveOutcome("taken", undefined, "Bree"), { kind: "saved" });
    assert.deepEqual(saveOutcome("refused", { message: BLOCK_SAVES_TOO_FAST }, "Bree"), { kind: "problem", text: BLOCK_SAVES_TOO_FAST, retryInMs: LIMITS.companionBlockWriteRefillMs });
    assert.deepEqual(saveOutcome("refused", { message: "that is not yours" }, "Bree"), { kind: "problem", text: "That is not yours." });
    assert.deepEqual(saveOutcome("unknown", undefined, "Bree"), { kind: "problem", text: "The connection dropped before the server answered. Check Bree’s stat block before saving again." });
  });

  test("after the editor closed, a toast for anything but taken", () => {
    assert.equal(lateSaveText("Bree", "taken"), null);
    assert.equal(lateSaveText("Bree", "refused", { message: "the room is full" }), "Bree’s stat block was not saved. The room is full.");
    assert.match(lateSaveText("Bree", "unknown")!, /may not have been saved/);
  });
});
