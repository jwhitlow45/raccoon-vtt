import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { before, describe, test } from "node:test";
import { SIZE_CELLS } from "../model.ts";
import { loadedMonsters, loadMonsters, monsterActor, type SrdMonster } from "./monsters.ts";

/**
 * monsters.json ships to the DM's browser when the monster browser opens, so
 * it has a budget well under the 2 MB the design allows. It was about 540 KB
 * when written.
 */
const SIZE_BUDGET_BYTES = 1_000_000;

const XP_BY_CR: Record<string, number> = {
  "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900,
  "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000, "16": 15000,
  "17": 18000, "18": 20000, "19": 22000, "20": 25000, "21": 33000, "22": 41000, "23": 50000, "24": 62000,
  "25": 75000, "26": 90000, "27": 105000, "28": 120000, "29": 135000, "30": 155000,
};

let monsters: readonly SrdMonster[] = [];
const byName = (name: string): SrdMonster => {
  const m = monsters.find((x) => x.name === name);
  assert.ok(m, `no monster named ${name}`);
  return m;
};

before(async () => {
  monsters = await loadMonsters();
});

describe("monsters.json", () => {
  test("has every SRD 5.2.1 stat block", () => {
    assert.equal(monsters.length, 330);
  });

  test("once loaded, the same blocks are there at once for a view that shows them again", () => {
    assert.equal(loadedMonsters(), monsters);
  });

  test("stays within its size budget", () => {
    const bytes = statSync(new URL("./monsters.json", import.meta.url)).size;
    assert.ok(bytes < SIZE_BUDGET_BYTES, `monsters.json is ${bytes} bytes`);
  });

  test("srdIds are unique slugs", () => {
    const ids = monsters.map((m) => m.srdId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test("every monster has the required fields in sane ranges", () => {
    for (const m of monsters) {
      const at = m.name;
      assert.ok(m.name.length > 0 && m.name.length <= 80, at);
      assert.ok(m.size in SIZE_CELLS, `${at} size ${m.size}`);
      assert.ok(m.type.length > 0, `${at} type`);
      assert.ok(m.alignment.length > 0, `${at} alignment`);
      assert.ok(Number.isInteger(m.ac) && m.ac >= 5 && m.ac <= 30, `${at} ac ${m.ac}`);
      assert.ok(Number.isInteger(m.hp.average) && m.hp.average >= 1 && m.hp.average <= 1000, `${at} hp ${m.hp.average}`);
      const dice = m.hp.formula.match(/^(\d+)d(\d+)(?: ([+-]) (\d+))?$/);
      assert.ok(dice, `${at} hp formula ${m.hp.formula}`);
      const [, n, d, sign, k] = dice;
      const average = Math.floor((Number(n) * (Number(d) + 1)) / 2) + (sign === "-" ? -1 : 1) * Number(k ?? 0);
      assert.equal(m.hp.average, average, `${at} hp average of ${m.hp.formula}`);
      for (const kind of ["walk", "fly", "swim", "climb", "burrow"] as const) {
        const ft = m.speeds[kind];
        if (ft === undefined) continue;
        assert.ok(Number.isInteger(ft) && ft >= 0 && ft <= 200 && ft % 5 === 0, `${at} ${kind} ${ft}`);
      }
      if (m.speeds.hover) assert.ok((m.speeds.fly ?? 0) > 0, `${at} hovers without a fly speed`);
      assert.ok(m.initiative.bonus >= -5 && m.initiative.bonus <= 20, `${at} initiative ${m.initiative.bonus}`);
      assert.equal(m.initiative.score, 10 + m.initiative.bonus, `${at} initiative score`);
      assert.ok(m.passivePerception >= 1 && m.passivePerception <= 40, `${at} passive Perception`);
      assert.doesNotMatch(m.senses, /Passive Perception/, `${at} senses`);
      if (m.cr === "0") assert.ok(m.xp === 0 || m.xp === 10, `${at} xp`);
      else assert.equal(m.xp, XP_BY_CR[m.cr], `${at} xp for CR ${m.cr}`);
      if (m.xpInLair !== undefined) assert.ok(m.xpInLair > m.xp, `${at} lair xp`);
      for (const uses of [m.legendaryActions, m.legendaryResistance]) {
        if (!uses) continue;
        // The Tarrasque has the most: 6 Legendary Resistances.
        assert.ok(uses.uses >= 1 && uses.uses <= 6, `${at} legendary uses`);
        if (uses.usesInLair !== undefined) assert.ok(uses.usesInLair > uses.uses, `${at} legendary uses in lair`);
      }
      assert.ok(m.statBlock.startsWith(`## ${m.name}\n\n*`), `${at} stat block heading`);
      assert.match(m.statBlock, /\n\n\*\*CR\*\* /, `${at} stat block CR`);
      assert.match(m.statBlock, /\| Cha \| \d+ \| [+−]\d+ \| [+−]\d+ \|/, `${at} ability table`);
    }
  });

  test("Goblin Warrior", () => {
    const m = byName("Goblin Warrior");
    assert.equal(m.srdId, "goblin-warrior");
    assert.equal(m.size, "small");
    assert.equal(m.type, "Fey (Goblinoid)");
    assert.equal(m.alignment, "Chaotic Neutral");
    assert.equal(m.ac, 15);
    assert.deepEqual(m.hp, { average: 10, formula: "3d6" });
    assert.deepEqual(m.speeds, { walk: 30 });
    assert.deepEqual(m.initiative, { bonus: 2, score: 12 });
    assert.equal(m.passivePerception, 9);
    assert.equal(m.senses, "Darkvision 60 ft.");
    assert.equal(m.languages, "Common, Goblin");
    assert.equal(m.cr, "1/4");
    assert.equal(m.xp, 50);
    assert.equal(m.legendaryActions, undefined);
    assert.match(m.statBlock, /\*\*Nimble Escape\.\*\* The goblin takes the Disengage or Hide action\./);
  });

  test("Adult Red Dragon", () => {
    const m = byName("Adult Red Dragon");
    assert.equal(m.size, "huge");
    assert.equal(m.type, "Dragon (Chromatic)");
    assert.equal(m.ac, 19);
    assert.deepEqual(m.hp, { average: 256, formula: "19d12 + 133" });
    assert.deepEqual(m.speeds, { walk: 40, climb: 40, fly: 80 });
    assert.deepEqual(m.initiative, { bonus: 12, score: 22 });
    assert.equal(m.passivePerception, 23);
    assert.equal(m.senses, "Blindsight 60 ft., Darkvision 120 ft.");
    assert.equal(m.cr, "17");
    assert.equal(m.xp, 18000);
    assert.equal(m.xpInLair, 20000);
    assert.deepEqual(m.legendaryActions, { uses: 3, usesInLair: 4 });
    assert.deepEqual(m.legendaryResistance, { uses: 3, usesInLair: 4 });
    assert.match(m.statBlock, /\*\*Fire Breath \(Recharge 5–6\)\.\*\* Dexterity Saving Throw: DC 21, each creature in a 60-foot Cone\./);
    assert.match(m.statBlock, /\n- \*\*1\/Day:\*\* Fireball\n/);
  });

  test("other spot checks", () => {
    assert.deepEqual(byName("Aboleth").speeds, { walk: 10, swim: 40 });
    assert.deepEqual(byName("Air Elemental").speeds, { walk: 10, fly: 90, hover: true });
    assert.deepEqual(byName("Lich").legendaryResistance, { uses: 4, usesInLair: 5 });
    assert.equal(byName("Tarrasque").size, "gargantuan");
    assert.equal(byName("Tarrasque").cr, "30");
    assert.deepEqual(byName("Tarrasque").legendaryResistance, { uses: 6 });
    assert.deepEqual(byName("Pit Fiend").legendaryResistance, { uses: 4 });
    assert.equal(byName("Pit Fiend").legendaryActions, undefined);
    assert.equal(byName("Bat").cr, "0");
    assert.equal(byName("Bat").size, "tiny");
    assert.equal(byName("Will-o’-Wisp").srdId, "will-o-wisp");
    // "Medium or Small" blocks take the first size.
    assert.equal(byName("Werebear").size, "medium");
    // Speeds of other forms stay in the stat block only.
    assert.deepEqual(byName("Werebear").speeds, { walk: 30 });
  });

  test("the SRD errors fixed by the importer stay fixed", () => {
    assert.equal(byName("Archmage").xp, 8400);
    assert.deepEqual(byName("Gray Ooze").initiative, { bonus: -2, score: 8 });
    assert.deepEqual(byName("Invisible Stalker").initiative, { bonus: 7, score: 17 });
    assert.match(byName("Young White Dragon").statBlock, /\| Int \| 6 \| −2 \| −2 \|/);
  });
});

describe("monsterActor", () => {
  test("fills a token's actor from the stat block", () => {
    const actor = monsterActor(byName("Goblin Warrior"));
    assert.deepEqual(actor, {
      hp: { cur: 10, max: 10, temp: 0 },
      life: "alive",
      ac: 15,
      speeds: { walk: 30 },
      initBonus: 2,
      initScore: 12,
      passivePerception: 9,
      senses: "Darkvision 60 ft.",
      creatureType: "Fey (Goblinoid)",
      cr: "1/4",
      xp: 50,
      srdId: "goblin-warrior",
      effects: [],
      deathSaves: { ok: 0, fail: 0 },
      notes: "",
      dmNotes: "",
    });
  });

  test("takes the DM's HP and the lair values", () => {
    const dragon = byName("Adult Red Dragon");
    const outside = monsterActor(dragon);
    assert.deepEqual(outside.legendary, { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 });
    assert.equal(outside.xp, 18000);
    const lair = monsterActor(dragon, { inLair: true, hp: 300 });
    assert.deepEqual(lair.hp, { cur: 300, max: 300, temp: 0 });
    assert.deepEqual(lair.legendary, { actionsMax: 4, actionsUsed: 0, resistMax: 4, resistUsed: 0 });
    assert.equal(lair.xp, 20000);
  });

  test("copies speeds, so editing a token never edits the shared data", () => {
    const m = byName("Aboleth");
    const actor = monsterActor(m);
    actor.speeds.walk = 99;
    assert.equal(m.speeds.walk, 10);
  });
});
