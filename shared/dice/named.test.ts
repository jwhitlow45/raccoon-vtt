import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { StatBlockEntry } from "../model.ts";
import { loadMonsters, type SrdMonster } from "../srd/monsters.ts";
import { emptyStatBlock, monsterView } from "../statBlock.ts";
import type { NamedRoll } from "./bonus.ts";
import { formatFormula, parseFormula } from "./formula.ts";
import { blockActions, blockEntries, hasTrait, multiattackNote, type BlockEntry } from "./named.ts";

/**
 * The stat block reader (docs/design-v1-roll-options.md 3.1) over every
 * SRD 5.2.1 block, each rule checked against the block's own words with
 * patterns of the test's own, and over hand-written 2014 text as room
 * monsters and pasted blocks keep it.
 */

let monsters: readonly SrdMonster[] = [];
before(async () => {
  monsters = await loadMonsters();
});

const byName = (name: string): SrdMonster => {
  const m = monsters.find((x) => x.name === name);
  assert.ok(m, `no monster named ${name}`);
  return m;
};

/** The roll an entry gives under its printed name, recharge and uses aside. */
function rollOf(m: SrdMonster, entry: BlockEntry, suffix = ""): NamedRoll | undefined {
  const name = entry.name.replace(/\s*\((?:Recharge [^)]*|\d+\/Day[^)]*)\)/gi, "").trim() + suffix;
  return blockActions(m).find((r) => r.section === entry.section && r.name === name);
}

function named(m: SrdMonster, name: string): NamedRoll {
  const roll = blockActions(m).find((r) => r.name === name);
  assert.ok(roll, `${m.name} has no roll named ${name}: ${blockActions(m).map((r) => r.name).join(", ")}`);
  return roll;
}

function every(fn: (m: SrdMonster, entry: BlockEntry) => void): void {
  for (const m of monsters) for (const entry of blockEntries(m)) fn(m, entry);
}

/** A sentence-start clause of an entry's text: "Failure: ..." up to the next label. */
function clauseText(text: string, label: string): string | null {
  const m = new RegExp(`(?:^|[.!?] )${label}: (.*?)(?=[.!?] [A-Z][A-Za-z0-9 ]{1,40}: |$)`).exec(text);
  return m ? m[1]! : null;
}

describe("named rolls from every SRD block", () => {
  test("every Attack Roll is an attack with its printed bonus, minus included", () => {
    let n = 0;
    every((m, entry) => {
      const printed = /(?:Melee|Ranged|Melee or Ranged) Attack Roll: ([+−])(\d+)/.exec(entry.text);
      if (!printed) return;
      n++;
      const roll = rollOf(m, entry);
      assert.equal(roll?.attack, (printed[1] === "+" ? 1 : -1) * Number(printed[2]), `${m.name}: ${entry.name}`);
    });
    assert.equal(n, 423);
  });

  test("every save is a save of its ability and DC, and after an attack it is the hit's own roll", () => {
    const ABILITY: Record<string, string> = { Strength: "str", Dexterity: "dex", Constitution: "con", Intelligence: "int", Wisdom: "wis", Charisma: "cha" };
    let n = 0;
    every((m, entry) => {
      const printed = /(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw: DC (\d+)/.exec(entry.text);
      if (!printed) return;
      n++;
      const roll = rollOf(m, entry, /Attack Roll:/.test(entry.text) ? ", on a hit" : "");
      assert.equal(roll?.save?.ability, ABILITY[printed[1]!], `${m.name}: ${entry.name}`);
      assert.equal(roll?.save?.dc, Number(printed[2]), `${m.name}: ${entry.name}`);
    });
    assert.equal(n, 199);
  });

  test('every Success clause that begins "Half damage" is half on a pass, "Half damage only." among them, and every other save none', () => {
    let half = 0;
    let only = 0;
    every((m, entry) => {
      const roll = blockActions(m).find((r) => r.save && rollOf(m, entry, r.name.endsWith(", on a hit") ? ", on a hit" : "") === r);
      if (!roll?.save) return;
      const success = clauseText(entry.text, "Success");
      const halved = success !== null && success.startsWith("Half damage");
      if (halved) half++;
      if (success?.startsWith("Half damage only.")) only++;
      assert.equal(roll.save.onPass, halved ? "half" : "none", `${m.name}: ${entry.name}`);
    });
    assert.equal(half, 80);
    assert.ok(only >= 2, "the silver dragons' Cold Gale and others read Half damage only.");
    assert.equal(named(byName("Adult Silver Dragon"), "Cold Gale").save?.onPass, "half");
    assert.equal(named(byName("Gelatinous Cube"), "Engulf").save?.onPass, "half", '"Half damage, and the target moves..."');
  });

  test("every (Recharge n–6) and (Recharge 6) recharges on n, 4–6 included, even an action with nothing else to roll", () => {
    const counts: Record<number, number> = {};
    every((m, entry) => {
      const printed = /\(Recharge (\d)(?:–6)?\)/.exec(entry.name);
      if (!printed) return;
      const n = Number(printed[1]);
      counts[n] = (counts[n] ?? 0) + 1;
      assert.equal(rollOf(m, entry)?.recharge, n, `${m.name}: ${entry.name}`);
    });
    assert.deepEqual(counts, { 4: 5, 5: 67, 6: 14 });
    assert.equal(named(byName("Basilisk"), "Petrifying Gaze").recharge, 4);
    assert.deepEqual(named(byName("Blink Dog"), "Teleport"), { key: "bonusActions:teleport", name: "Teleport", section: "bonusActions", damage: [], recharge: 4 });
  });

  test("every formula is canonical and parses, and every SRD part names its damage type", () => {
    for (const m of monsters) {
      for (const roll of blockActions(m)) {
        for (const f of [...roll.damage.map((d) => d.formula), ...(roll.heal ? [roll.heal.formula] : [])]) {
          const parsed = parseFormula(f);
          assert.ok(parsed.ok, `${m.name}: ${roll.name}: ${f}`);
          assert.equal(formatFormula(parsed.formula), f);
        }
        for (const part of roll.damage) assert.ok(part.type, `${m.name}: ${roll.name}`);
      }
    }
    // The SRD prints Jackal's bite with an en dash for its minus.
    assert.deepEqual(named(byName("Jackal"), "Bite").damage, [{ formula: "1d4-1", type: "piercing" }]);
  });

  test("keys are unique in each block", () => {
    for (const m of monsters) {
      const keys = blockActions(m).map((r) => r.key);
      assert.equal(new Set(keys).size, keys.length, m.name);
    }
  });

  test("damage keeps each typed part", () => {
    assert.deepEqual(named(byName("Balor"), "Death Throes").damage, [
      { formula: "9d6", type: "fire" },
      { formula: "9d6", type: "force" },
    ]);
    assert.equal(named(byName("Balor"), "Death Throes").section, "traits");
    assert.deepEqual(named(byName("Adult Bronze Dragon"), "Rend").damage, [
      { formula: "2d8+7", type: "slashing" },
      { formula: "1d10", type: "lightning" },
    ]);
    assert.deepEqual(named(byName("Remorhaz"), "Swallow, later turns").damage, [
      { formula: "3d6", type: "acid" },
      { formula: "3d6", type: "fire" },
    ]);
  });

  test("a part on if is optional and named by its clause, and a part after or, which replaces the one before it, is left out", () => {
    assert.deepEqual(named(byName("Goblin Warrior"), "Scimitar").damage, [
      { formula: "1d6+2", type: "slashing" },
      { formula: "1d4", type: "slashing", optional: true, name: "if the attack roll had Advantage" },
    ]);
    assert.deepEqual(named(byName("Swarm of Rats"), "Bites").damage, [{ formula: "2d4", type: "piercing" }]);
    assert.deepEqual(named(byName("Chimera"), "Bite").damage.length, 1);
  });

  test("damage taken on later turns is its own roll with no save, and the first damage stays immediate", () => {
    const cube = byName("Gelatinous Cube");
    assert.deepEqual(named(cube, "Engulf").damage, [{ formula: "3d6", type: "acid" }]);
    assert.deepEqual(named(cube, "Engulf, later turns"), { key: "actions:engulf:later", name: "Engulf, later turns", section: "actions", damage: [{ formula: "3d6", type: "acid" }] });
    const stalker = byName("Invisible Stalker");
    assert.deepEqual(named(stalker, "Vortex").damage, [{ formula: "1d8+3", type: "thunder" }]);
    assert.deepEqual(named(stalker, "Vortex, later turns").damage, [{ formula: "2d6", type: "thunder" }]);
    // Every timed damage of the SRD, and nothing else, is split off.
    const later = monsters.flatMap((m) => blockActions(m).filter((r) => r.key.endsWith(":later")).map((r) => `${m.name}: ${r.name}`));
    assert.deepEqual(later.sort(), [
      "Animated Rug of Smothering: Smother, later turns",
      "Behir: Swallow, later turns",
      "Gelatinous Cube: Engulf, later turns",
      "Invisible Stalker: Vortex, later turns",
      "Kraken: Swallow, later turns",
      "Pit Fiend: Bite, later turns",
      "Purple Worm: Swallow, later turns",
      "Remorhaz: Swallow, later turns",
      "Shambling Mound: Engulf, later turns",
      "Stirge: Proboscis, later turns",
      "Tarrasque: Swallow, later turns",
      "Vrock: Spores, later turns",
      "Water Elemental: Whelm, later turns",
    ]);
  });

  test('the 43 Hit or Failure clauses whose first sentence also holds "until" or "for 1 minute" keep their first damage immediate, with lasts naming whose turn', () => {
    let n = 0;
    every((m, entry) => {
      for (const label of ["Hit", "Failure"]) {
        const text = clauseText(entry.text, label);
        const first = text?.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? "";
        const damage = /\((\d+d\d+(?: [+−] \d+)?)\) ([A-Z][a-z]+) damage/.exec(first);
        if (!damage || !/\buntil\b|for 1 minute/.test(first)) continue;
        n++;
        const roll = rollOf(m, entry, label === "Failure" && /Attack Roll:/.test(entry.text) ? ", on a hit" : "");
        const formula = damage[1]!.replace(/ /g, "").replace("−", "-");
        assert.ok(roll?.damage.some((d) => d.formula === formula && d.type === damage[2]!.toLowerCase()), `${m.name}: ${entry.name} keeps ${formula}`);
        const until = /until the (start|end) of (its|the [^.,]+?’s) next turn/.exec(first);
        if (until) {
          const of = until[2] === "its" || until[2] === "the target’s" ? "target" : "self";
          assert.deepEqual(roll?.lasts, { at: until[1], of }, `${m.name}: ${entry.name}`);
        }
      }
    });
    assert.equal(n, 43);
    assert.deepEqual(named(byName("Adult Bronze Dragon"), "Thunderclap"), {
      key: "legendaryActions:thunderclap",
      name: "Thunderclap",
      section: "legendaryActions",
      save: { ability: "con", dc: 17, onPass: "none" },
      damage: [{ formula: "3d6", type: "thunder" }],
      conditions: ["deafened"],
      lasts: { at: "end", of: "target" },
    });
    assert.deepEqual(named(byName("Adult Gold Dragon"), "Banish").lasts, { at: "start", of: "self" });
    assert.deepEqual(named(byName("Adult White Dragon"), "Freezing Burst").lasts, { at: "end", of: "target" }, '"the target’s next turn"');
    assert.deepEqual(named(byName("Mummy Lord"), "Dreadful Glare").lasts, { at: "end", of: "self" });
  });

  test("conditions come from the Failure clause, or First Failure where there is one, and save ends from its words", () => {
    assert.deepEqual(named(byName("Basilisk"), "Petrifying Gaze").conditions, ["restrained"], "Second Failure stays text");
    assert.equal(named(byName("Basilisk"), "Petrifying Gaze").saveEnds, undefined, "repeats at the end of its next turn, not each turn");
    assert.deepEqual(named(byName("Rakshasa"), "Baleful Command").conditions, ["frightened", "incapacitated"]);
    const spores = named(byName("Vrock"), "Spores");
    assert.deepEqual([spores.conditions, spores.saveEnds, spores.recharge], [["poisoned"], true, 6]);
    assert.deepEqual(named(byName("Gelatinous Cube"), "Engulf").conditions, ["restrained"]);
  });

  test("a save after a hit is the hit's own roll, so the hit's damage never joins it", () => {
    const ghoul = byName("Ghoul");
    assert.deepEqual(named(ghoul, "Claw").damage, [{ formula: "1d4+2", type: "slashing" }]);
    assert.deepEqual(named(ghoul, "Claw, on a hit"), {
      key: "actions:claw:hit",
      name: "Claw, on a hit",
      section: "actions",
      save: { ability: "con", dc: 10, onPass: "none" },
      damage: [],
      conditions: ["paralyzed"],
      lasts: { at: "end", of: "target" },
    });
    const bite = named(byName("Pit Fiend"), "Bite, on a hit");
    assert.deepEqual([bite.conditions, bite.saveEnds], [["poisoned"], true]);
  });

  test("healing, uses, the to-hit words and what gives no roll", () => {
    assert.deepEqual(named(byName("Will-o’-Wisp"), "Consume Life").heal, { formula: "3d6" });
    assert.deepEqual(named(byName("Aboleth"), "Psychic Drain"), { key: "legendaryActions:psychic-drain", name: "Psychic Drain", section: "legendaryActions", damage: [], heal: { formula: "1d10" } });
    assert.equal(named(byName("Vrock"), "Stunning Screech").uses, "1/Day");
    assert.equal(named(byName("Ancient Gold Dragon"), "Rend").attack, 17, '"+17 to hit"');
    const bronze = byName("Adult Bronze Dragon");
    assert.ok(!blockActions(bronze).some((r) => /^(Multiattack|Spellcasting|Amphibious|Legendary Resistance)/.test(r.name)));
    assert.match(multiattackNote(bronze) ?? "", /^The dragon makes three Rend attacks\./);
    assert.equal(named(bronze, "Lightning Breath").recharge, 5);
  });

  test("Magic Resistance and Evasion are traits by name", () => {
    const resistant = monsters.filter((m) => /^\*\*Magic Resistance\b/m.test(m.statBlock));
    assert.equal(monsters.filter((m) => hasTrait(m, "Magic Resistance")).length, resistant.length);
    assert.ok(resistant.length >= 30);
    assert.deepEqual(
      monsters.filter((m) => hasTrait(m, "Evasion")).map((m) => m.name),
      ["Assassin"],
    );
  });
});

/** A room monster with these entries, seen through its Markdown as every reader sees one. */
function roomMonster(actions: StatBlockEntry[], extra: Partial<ReturnType<typeof emptyStatBlock>> = {}) {
  return monsterView({ ...emptyStatBlock(), name: "Cinder Drake", actions, ...extra });
}

describe("2014 wording, as room monsters and pasted text keep it", () => {
  test("weapon and spell attacks, their mixes and a minus", () => {
    const view = roomMonster([
      { name: "Claw", text: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage." },
      { name: "Spark", text: "Ranged Spell Attack: +5 to hit, range 120 ft., one creature. Hit: 10 (3d6) fire damage." },
      { name: "Spear", text: "Melee or Ranged Weapon Attack: +4 to hit, reach 5 ft. or range 20/60 ft., one target. Hit: 5 (1d6 + 2) piercing damage, or 6 (1d8 + 2) piercing damage if used with two hands to make a melee attack." },
      { name: "Flail", text: "Melee Weapon Attack: −1 to hit, reach 5 ft., one target. Hit: 2 (1d4) bludgeoning damage." },
    ]);
    const rolls = blockActions(view);
    assert.deepEqual(
      rolls.map((r) => [r.name, r.attack, r.damage]),
      [
        ["Claw", 4, [{ formula: "1d6+2", type: "slashing" }]],
        ["Spark", 5, [{ formula: "3d6", type: "fire" }]],
        ["Spear", 4, [{ formula: "1d6+2", type: "piercing" }]],
        ["Flail", -1, [{ formula: "1d4", type: "bludgeoning" }]],
      ],
    );
  });

  test('"DC 13 Dexterity saving throw" with "half as much damage on a successful one", and its recharge', () => {
    const [breath] = blockActions(
      roomMonster([
        {
          name: "Fire Breath (Recharge 5–6)",
          text: "The drake exhales fire in a 15-foot cone. Each creature in that area must make a DC 13 Dexterity saving throw, taking 22 (5d8) fire damage on a failed save, or half as much damage on a successful one.",
        },
      ]),
    );
    assert.deepEqual(breath, {
      key: "actions:fire-breath",
      name: "Fire Breath",
      section: "actions",
      save: { ability: "dex", dc: 13, onPass: "half" },
      damage: [{ formula: "5d8", type: "fire" }],
      recharge: 5,
    });
  });

  test("a save a hit goes on with is the hit's own roll, with its own damage", () => {
    const rolls = blockActions(
      roomMonster([
        {
          name: "Bite",
          text: "Melee Weapon Attack: +5 to hit, reach 5 ft., one creature. Hit: 7 (1d8 + 3) piercing damage, and the target must make a DC 11 Constitution saving throw, taking 9 (2d8) poison damage on a failed save, or half as much damage on a successful one.",
        },
      ]),
    );
    assert.deepEqual(rolls, [
      { key: "actions:bite", name: "Bite", section: "actions", attack: 5, damage: [{ formula: "1d8+3", type: "piercing" }] },
      { key: "actions:bite:hit", name: "Bite, on a hit", section: "actions", save: { ability: "con", dc: 11, onPass: "half" }, damage: [{ formula: "2d8", type: "poison" }] },
    ]);
  });

  test("2014 conditions, their end, save ends and later damage", () => {
    const rolls = blockActions(
      roomMonster([
        { name: "Glare", text: "One creature the drake can see within 30 feet must succeed on a DC 14 Wisdom saving throw or be frightened for 1 minute. The creature can repeat the saving throw at the end of each of its turns, ending the effect on itself on a success." },
        { name: "Stomp", text: "Each creature within 10 feet of the drake must succeed on a DC 12 Strength saving throw or be stunned until the end of the drake's next turn." },
        {
          name: "Tail",
          text: "Melee Weapon Attack: +6 to hit, reach 10 ft., one target. Hit: 6 (1d8 + 2) bludgeoning damage, and the target is grappled (escape DC 13). Until this grapple ends, the target is restrained, and at the start of each of the drake's turns, the target takes 7 (2d6) acid damage.",
        },
      ]),
    );
    assert.deepEqual(rolls, [
      { key: "actions:glare", name: "Glare", section: "actions", save: { ability: "wis", dc: 14, onPass: "none" }, damage: [], conditions: ["frightened"], saveEnds: true },
      { key: "actions:stomp", name: "Stomp", section: "actions", save: { ability: "str", dc: 12, onPass: "none" }, damage: [], conditions: ["stunned"], lasts: { at: "end", of: "self" } },
      { key: "actions:tail", name: "Tail", section: "actions", attack: 6, damage: [{ formula: "1d8+2", type: "bludgeoning" }], conditions: ["grappled", "restrained"] },
      { key: "actions:tail:later", name: "Tail, later turns", section: "actions", damage: [{ formula: "2d6", type: "acid" }] },
    ]);
  });

  test("Hit or Miss reads as a hit, and a 2024 room monster reads as an SRD block does", () => {
    const [slash] = blockActions(roomMonster([{ name: "Searing Slash", text: "Melee Attack Roll: +3, reach 5 ft. Hit: 4 (1d4 + 2) Slashing damage. Hit or Miss: 3 (1d6) Fire damage." }]));
    assert.deepEqual(slash?.damage, [
      { formula: "1d4+2", type: "slashing" },
      { formula: "1d6", type: "fire" },
    ]);
  });

  test("a paragraph with nothing to roll gives none, and a formula parseFormula refuses is left out", () => {
    const rolls = blockActions(
      roomMonster(
        [
          { name: "Multiattack", text: "The drake makes two Claw attacks." },
          { name: "Hide", text: "The drake takes the Hide action." },
          { name: "Huge Bite", text: "Melee Attack Roll: +4, reach 5 ft. Hit: 9 (1d1001 + 2) Piercing damage." },
        ],
        { traits: [{ name: "Keen Smell", text: "The drake has Advantage on Wisdom (Perception) checks that rely on smell." }] },
      ),
    );
    assert.deepEqual(rolls, [{ key: "actions:huge-bite", name: "Huge Bite", section: "actions", attack: 4, damage: [] }]);
  });

  test("the reader is cached per view object", () => {
    const view = roomMonster([{ name: "Claw", text: "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage." }]);
    assert.equal(blockActions(view), blockActions(view));
  });
});
