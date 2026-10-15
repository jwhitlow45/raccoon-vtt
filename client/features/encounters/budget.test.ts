import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { difficultyOf, encounterXp, partyBudgets, partyFromCharacters, partySize, xpText } from "./budget.ts";

/** Each SRD monster's XP from its own stat block, as the builder reads it. */
async function xpOf(name: string): Promise<number> {
  const m = (await loadMonsters()).find((x) => x.name === name);
  assert.ok(m, name);
  return m.xp;
}

describe("encounter budget", () => {
  test("the SRD's worked examples come out as the SRD says", async () => {
    // Example 1: four level 1 characters, Low: 200 XP, and one Bugbear Warrior spends it all.
    const four = partyBudgets([{ count: 4, level: 1 }]);
    assert.equal(four.low, 200);
    const bugbear = encounterXp([{ count: 1, xp: await xpOf("Bugbear Warrior") }]);
    assert.deepEqual(bugbear, { total: 200, unknown: 0 });
    assert.equal(difficultyOf(bugbear.total, four), "low");
    assert.equal(encounterXp([{ count: 6, xp: await xpOf("Giant Rat") }]).total, 150);

    // Example 2: five level 3 characters, Moderate: 1,125 XP.
    const five = partyBudgets([{ count: 5, level: 3 }]);
    assert.equal(five.moderate, 1_125);
    const druids = encounterXp([
      { count: 2, xp: await xpOf("Druid") },
      { count: 9, xp: await xpOf("Stirge") },
    ]);
    assert.equal(druids.total, 1_125);
    assert.equal(difficultyOf(druids.total, five), "moderate");
    const undead = encounterXp([
      { count: 1, xp: await xpOf("Wight") },
      { count: 1, xp: await xpOf("Warhorse Skeleton") },
      { count: 6, xp: await xpOf("Skeleton") },
    ]);
    assert.equal(undead.total, 1_100);

    // Example 3: six level 15 characters, High: 46,800 XP.
    const six = partyBudgets([{ count: 6, level: 15 }]);
    assert.equal(six.high, 46_800);
    const dragons = encounterXp([
      { count: 2, xp: await xpOf("Adult Red Dragon") },
      { count: 2, xp: await xpOf("Fire Giant") },
    ]);
    assert.equal(dragons.total, 46_000);
    assert.equal(difficultyOf(dragons.total, six), "high");
  });

  test("a mixed party adds each character's own budget", () => {
    assert.deepEqual(partyBudgets([{ count: 2, level: 3 }, { count: 2, level: 4 }]), { low: 800, moderate: 1_200, high: 1_800 });
    assert.equal(partySize([{ count: 2, level: 3 }, { count: 2, level: 4 }]), 4);
  });

  test("past the High budget there is no name, and no party means no budget", () => {
    const budgets = partyBudgets([{ count: 4, level: 1 }]);
    assert.equal(difficultyOf(400, budgets), "high");
    assert.equal(difficultyOf(401, budgets), "over");
    assert.equal(difficultyOf(0, budgets), "low");
    assert.equal(difficultyOf(100, partyBudgets([])), null);
  });

  test("levels outside the table add nothing rather than a guess", () => {
    assert.deepEqual(partyBudgets([{ count: 3, level: 0 }, { count: 3, level: 21 }]), { low: 0, moderate: 0, high: 0 });
  });

  test("monsters whose stat block is not at hand are counted as unknown, not as zero", () => {
    assert.deepEqual(encounterXp([{ count: 3, xp: 50 }, { count: 2, xp: null }]), { total: 150, unknown: 2 });
  });

  test("the party comes from the room's characters by level, naming those without one", () => {
    const party = partyFromCharacters([
      { name: "Vex", level: 3 },
      { name: "Thorn", level: 4 },
      { name: "Pip" },
      { name: "Bree", level: 3 },
      { name: "Ash" },
    ]);
    assert.deepEqual(party, { groups: [{ count: 2, level: 3 }, { count: 1, level: 4 }], unleveled: ["Ash", "Pip"] });
    assert.deepEqual(partyFromCharacters([]), { groups: [], unleveled: [] });
  });

  test("XP reads with a thousands comma, as the SRD prints it", () => {
    assert.equal(xpText(46_800), "46,800 XP");
    assert.equal(xpText(25), "25 XP");
  });
});
