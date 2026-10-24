import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "../model.ts";
import { checkedFill, type PcFill } from "../rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, syncPatch, syncResult, type SyncCharacter } from "../rules/pcSync.ts";
import { actor } from "../testutil.ts";
import { readDdbCharacter } from "./read.ts";

/**
 * The D&D Beyond reader over hand-made JSON in the shape of a character's
 * (docs/design-v1-pc-stats.md 6.3 and Appendix B): an invented character
 * and only the fields the reader reads, so no D&D Beyond text is in the
 * repository. One fixture part per row of Appendix B.
 */

type J = Record<string, unknown>;

const mod = (type: string, subType: string, value: number | null, extra: J = {}): J => ({ type, subType, fixedValue: value, value, statId: null, componentId: 0, requiresAttunement: false, ...extra });
const stats = (values: number[]) => values.map((value, i) => ({ id: i + 1, name: null, value }));
const nulls = () => stats([0, 0, 0, 0, 0, 0]).map((s) => ({ ...s, value: null }));
const feature = (name: string, requiredLevel: number): J => ({ definition: { name, requiredLevel } });

/** Wren Ashdown, an invented rogue 7 and fighter 3 (Champion). */
function wren(over: J = {}): J {
  return {
    id: 12345678,
    name: "Wren Ashdown",
    stats: stats([12, 16, 14, 10, 13, 8]),
    bonusStats: nulls(),
    overrideStats: nulls(),
    baseHitPoints: 60,
    bonusHitPoints: null,
    overrideHitPoints: null,
    race: { weightSpeeds: { normal: { walk: 30, fly: 0, burrow: 0, swim: 10, climb: 0 } } },
    classes: [
      { level: 7, definition: { name: "Rogue", spellCastingAbilityId: null }, subclassDefinition: null, classFeatures: [feature("Sneak Attack", 1), feature("Evasion", 7), feature("Reliable Talent", 11)] },
      { level: 3, definition: { name: "Fighter", spellCastingAbilityId: null }, subclassDefinition: { spellCastingAbilityId: null }, classFeatures: [feature("Improved Critical", 3), feature("Superior Critical", 15)] },
    ],
    modifiers: {
      race: [mod("bonus", "dexterity-score", 2), mod("set-base", "darkvision", 60), mod("resistance", "poison", null)],
      class: [
        mod("proficiency", "dexterity-saving-throws", null),
        mod("proficiency", "intelligence-saving-throws", null),
        mod("proficiency", "stealth", null),
        mod("expertise", "stealth", null),
        mod("proficiency", "perception", null),
        mod("bonus", "saving-throws", null, { statId: 6, fixedValue: null, value: null }),
      ],
      background: [mod("proficiency", "sleight-of-hand", null)],
      feat: [mod("proficiency", "initiative", null), mod("bonus", "passive-perception", 5)],
      item: [
        mod("bonus", "saving-throws", 1, { componentId: 900, requiresAttunement: true }),
        mod("bonus", "armor-class", 1, { componentId: 901 }),
        mod("bonus", "spell-attacks", 2, { componentId: 902 }),
      ],
      condition: [],
    },
    inventory: [
      { equipped: true, isAttuned: true, definition: { id: 900, name: "Cloak of Protection", filterType: "Wondrous item" } },
      { equipped: true, isAttuned: false, definition: { id: 901, name: "Studded Leather Armor", filterType: "Armor", armorClass: 12, armorTypeId: 1 } },
      { equipped: false, isAttuned: false, definition: { id: 902, name: "Wand", filterType: "Wand" } },
      { equipped: true, definition: { id: 903, name: "Rapier", filterType: "Weapon", damage: { diceString: "1d8" }, damageType: "Piercing", attackType: 1, properties: [{ name: "Finesse" }], grantedModifiers: [] } },
      { equipped: true, definition: { id: 904, name: "Longsword", filterType: "Weapon", damage: { diceString: "1d8" }, damageType: "Slashing", attackType: 1, properties: [{ name: "Versatile", notes: "1d10" }], grantedModifiers: [{ type: "bonus", subType: "magic", fixedValue: 1, value: 1 }] } },
      { equipped: true, definition: { id: 905, name: "Shortbow", filterType: "Weapon", damage: { diceString: "1d6" }, damageType: "Piercing", attackType: 2, properties: [{ name: "Ammunition" }] } },
      { equipped: false, definition: { id: 906, name: "Dagger", filterType: "Weapon", damage: { diceString: "1d4" }, damageType: "Piercing", attackType: 1, properties: [{ name: "Finesse" }] } },
    ],
    classSpells: [],
    spells: { race: [], class: [], item: [], feat: [] },
    actions: { race: [], class: [{ name: "Cunning Action", dice: null }], feat: [] },
    ...over,
  };
}

/** Ione Marrow, an invented wizard 5 whose casting ability is given on the subclass alone, for the spell paths. */
function ione(spells: J[], over: J = {}): J {
  return {
    ...wren(),
    name: "Ione Marrow",
    stats: stats([8, 14, 14, 18, 12, 10]),
    classes: [{ level: 5, definition: { name: "Wizard", spellCastingAbilityId: null }, subclassDefinition: { spellCastingAbilityId: 4 }, classFeatures: [] }],
    modifiers: { race: [], class: [], background: [], feat: [], item: [], condition: [] },
    inventory: [],
    classSpells: [{ spells }],
    ...over,
  };
}

const damage = (subType: string, diceString: string, higher: J[] = [], usePrimaryStat = false): J => ({ type: "damage", subType, die: { diceString }, usePrimaryStat, atHigherLevels: { higherLevelDefinitions: higher } });
const spell = (name: string, level: number, definition: J, entry: J = {}): J => ({ prepared: true, definition: { name, level, modifiers: [], ...definition }, ...entry });

let n = 0;
const ids = () => `id${++n}`;

describe("readDdbCharacter: the character", () => {
  const fill = readDdbCharacter({ success: true, data: wren() }, ids)!;

  test("name, level as the classes' sum, and the envelope or the bare data alike", () => {
    assert.equal(fill.source, "ddb");
    assert.equal(fill.name, "Wren Ashdown");
    assert.equal(fill.level, 10);
    assert.deepEqual(readDdbCharacter(wren(), ids)?.stats.abilities, fill.stats.abilities);
  });

  test("scores: base, bonuses, a set that raises one, and an override over all", () => {
    assert.deepEqual(fill.stats.abilities, { str: 12, dex: 18, con: 14, int: 10, wis: 13, cha: 8 });
    const set = readDdbCharacter(wren({ modifiers: { race: [mod("set", "strength-score", 19), mod("set", "dexterity-score", 9)] }, overrideStats: [{ id: 6, value: 20 }] }), ids)!;
    assert.equal(set.stats.abilities?.str, 19, "a belt sets Strength 19");
    assert.equal(set.stats.abilities?.dex, 16, "a set below the score changes nothing");
    assert.equal(set.stats.abilities?.cha, 20);
  });

  test("proficiencies, expertise, Jack of All Trades and Alert", () => {
    assert.deepEqual(fill.stats.saves, ["dex", "int"]);
    assert.deepEqual(fill.stats.skills, { stealth: "expert", perception: "prof", "sleight-of-hand": "prof" });
    assert.equal(fill.stats.alert, true);
    assert.equal(fill.stats.jack, false);
    assert.equal(readDdbCharacter(wren({ modifiers: { class: [mod("half-proficiency", "ability-checks", null)] } }), ids)!.stats.jack, true);
  });

  test("adjustments: every save from Charisma's modifier (min 1) and an attuned item, Passive Perception, spell attacks only from an equipped item", () => {
    assert.deepEqual(fill.stats.adjust, { allSaves: 1 + 1, passive: 5 });
  });

  test("an item's modifiers count only while it is equipped, and attuned where it needs it", () => {
    const unattuned = wren();
    (unattuned.inventory as J[])[0] = { equipped: true, isAttuned: false, definition: { id: 900, name: "Cloak of Protection" } };
    assert.equal(readDdbCharacter(unattuned, ids)!.stats.adjust?.allSaves, 1);
  });

  test("defenses, features by the class's level, and the critical range", () => {
    assert.deepEqual(fill.stats.defenses, { poison: "resistant" });
    assert.equal(fill.stats.evasion, true, "Evasion at rogue 7");
    assert.equal(fill.stats.critOn, 19, "Improved Critical at fighter 3, Superior Critical not yet");
    const low = wren({ classes: [{ level: 6, definition: { name: "Rogue" }, classFeatures: [feature("Evasion", 7), feature("Sneak Attack", 1)] }] });
    assert.equal(readDdbCharacter(low, ids)!.stats.evasion, false);
  });

  test("AC from the armor worn and its bonus, HP, speeds and darkvision, and the sheet link", () => {
    assert.equal(fill.actor.ac, 12 + 4 + 1);
    // The review's AC line says to check it, so it is not a warning as well (docs/design-v1-resync.md 2.5).
    assert.ok(!fill.warnings.some((w) => /worked out from the armor/.test(w)));
    assert.equal(fill.actor.hpMax, 60 + 2 * 10);
    assert.equal(readDdbCharacter(wren({ overrideHitPoints: 99 }), ids)!.actor.hpMax, 99);
    assert.deepEqual(fill.actor.speeds, { walk: 30, swim: 10 });
    assert.equal(fill.actor.senses, "Darkvision 60 ft.");
    // Darkvision is the one sense it reads, so a character without it leaves the senses the card has, such as a typed Blindsight (LP7-PC-9).
    const human = wren({ modifiers: { race: [mod("bonus", "dexterity-score", 2)] } });
    assert.equal(readDdbCharacter(human, ids)!.actor.senses, undefined);
    assert.equal(fill.actor.sheetUrl, "https://www.dndbeyond.com/characters/12345678");
    const heavy = wren({ inventory: [{ equipped: true, definition: { id: 1, armorClass: 18, armorTypeId: 3 } }, { equipped: true, definition: { id: 2, armorClass: 2, armorTypeId: 4 } }], modifiers: {} });
    assert.equal(readDdbCharacter(heavy, ids)!.actor.ac, 20);
    const medium = wren({ inventory: [{ equipped: true, definition: { id: 1, armorClass: 14, armorTypeId: 2 } }], modifiers: {} });
    assert.equal(readDdbCharacter(medium, ids)!.actor.ac, 14 + 2, "Dex +3 counts at most +2 in medium armor");
  });

  test("weapons: Finesse takes the better of Str and Dex, a ranged one Dex, Versatile a second roll, magic its bonus, and Sneak Attack a rider on Finesse and ranged", () => {
    const rolls = fill.stats.rolls;
    const rapier = rolls.find((r) => r.name === "Rapier")!;
    assert.equal(rapier.ability, "dex");
    assert.deepEqual(rapier.dice, [
      { formula: "1d8", mod: true, type: "piercing" },
      { formula: "4d6", type: "piercing", optional: true, name: "Sneak Attack" },
    ]);
    assert.equal(rapier.ddb, true);
    const sword = rolls.find((r) => r.name === "Longsword")!;
    assert.equal(sword.ability, "str");
    assert.deepEqual(sword.attack, { prof: true, bonus: 1 });
    assert.deepEqual(sword.dice, [{ formula: "1d8+1", mod: true, type: "slashing" }], "no rider on a plain melee weapon");
    assert.deepEqual(rolls.find((r) => r.name === "Longsword (two hands)")?.dice, [{ formula: "1d10+1", mod: true, type: "slashing" }]);
    const bow = rolls.find((r) => r.name === "Shortbow")!;
    assert.equal(bow.ability, "dex");
    assert.equal(bow.dice[1]?.name, "Sneak Attack");
    assert.equal(rolls.some((r) => r.name === "Dagger"), false, "a weapon not equipped");
    assert.equal(rolls.some((r) => r.name === "Cunning Action"), false, "an action with nothing to roll");
  });

  test("what it reads passes the block's own bounds", () => {
    assert.ok(checkedFill(fill));
  });

  test("every kind of roll is read whole, and no source is missing", () => {
    assert.deepEqual(fill.read, { weapon: true, spell: true, other: true, resource: true });
    assert.ok(!fill.warnings.some((w) => /did not send|No class was read/.test(w)));
  });
});

describe("readDdbCharacter: spells", () => {
  test("the casting ability from the class, else its subclass, and the spells usable, once each", () => {
    const fill = readDdbCharacter(
      ione([
        spell("Fire Bolt", 0, { requiresAttackRoll: true, scaleType: "characterlevel", modifiers: [damage("fire", "1d10", [{ level: 5, dice: { diceString: "2d10" } }, { level: 11, dice: { diceString: "3d10" } }, { level: 17, dice: { diceString: "4d10" } }])] }, { prepared: false }),
        spell("Fireball", 3, { requiresSavingThrow: true, saveDcAbilityId: 2, scaleType: "spellscale", modifiers: [damage("fire", "8d6", [{ level: 1, dice: { diceString: "1d6" } }])] }),
        spell("Fireball", 3, { requiresSavingThrow: true, saveDcAbilityId: 2 }),
        spell("Sleep", 1, { modifiers: [] }),
        spell("Magic Missile", 1, { modifiers: [damage("force", "1d4 + 1")] }, { prepared: false, alwaysPrepared: false, countsAsKnownSpell: false }),
        spell("Cure Wounds", 1, { scaleType: "spellscale", modifiers: [{ type: "bonus", subType: "hit-points", die: { diceString: "2d8" }, usePrimaryStat: true, atHigherLevels: { higherLevelDefinitions: [{ level: 1, dice: { diceString: "2d8" } }] } }] }),
        spell("Prism Orb", 1, { requiresAttackRoll: true, modifiers: ["acid", "cold", "fire"].map((t) => damage(t, "3d8")) }),
        spell("Ember Burst", 2, { requiresSavingThrow: true, saveDcAbilityId: 2, modifiers: [damage("fire", "3d6")] }),
        spell("Odd Cantrip", 0, { requiresAttackRoll: true, scaleType: "characterlevel", modifiers: [damage("cold", "1d6", [{ level: 5, dice: { diceString: "1d8" } }, { level: 11, dice: { diceString: "1d10" } }])] }),
      ]),
      ids,
    )!;
    assert.equal(fill.stats.spellAbility, "int");
    const by = (name: string) => fill.stats.rolls.find((r) => r.name === name);
    assert.deepEqual(by("Fire Bolt"), { id: by("Fire Bolt")!.id, name: "Fire Bolt", kind: "spell", ability: "spell", level: 0, dice: [{ formula: "1d10", grows: true, type: "fire" }], ddb: true, attack: { prof: true, bonus: 0 } });
    assert.deepEqual(by("Fireball")?.save, { ability: "dex" });
    assert.deepEqual(by("Fireball")?.dice, [{ formula: "8d6", upcast: "1d6", type: "fire" }]);
    assert.equal(fill.stats.rolls.filter((r) => r.name === "Fireball").length, 1);
    assert.equal(by("Sleep"), undefined, "nothing to roll");
    assert.equal(by("Magic Missile"), undefined, "neither prepared nor known");
    assert.deepEqual(by("Cure Wounds")?.dice, [{ formula: "2d8", mod: true, upcast: "2d8", type: "healing" }]);
    assert.deepEqual(by("Prism Orb")?.dice, [{ formula: "3d8", type: "acid" }]);
    assert.deepEqual(by("Odd Cantrip")?.dice, [{ formula: "1d8", type: "cold" }], "scaling off the tier rule is read at level 5");
    assert.ok(fill.warnings.some((w) => /Odd Cantrip's dice were read at level 5/.test(w)));
    assert.ok(fill.warnings.some((w) => /Prism Orb deals one of several damage types\. Acid was read/.test(w)));
    // Fireball's half comes from the SRD's rule when it is rolled, so only the spell the SRD does not hold is named.
    assert.ok(fill.warnings.some((w) => /halves the damage is not known for Ember Burst\. A cantrip's pass takes none and another spell's half until you set On a pass\./.test(w)));
    assert.ok(!fill.warnings.some((w) => /halves the damage.*Fireball/.test(w)));
    assert.deepEqual(by("Ember Burst")?.save, { ability: "dex" });
    assert.ok(checkedFill(fill));
  });

  test("eight unhalved spells with long names: the line names fewer and stays within 400 characters, so the fill still passes", () => {
    const long = Array.from({ length: 9 }, (_, i) => spell(`${"An invented spell of a very long name".padEnd(57, "x")} ${i}`, 1, { requiresSavingThrow: true, saveDcAbilityId: 2, modifiers: [damage("fire", "2d6")] }));
    const fill = readDdbCharacter(ione(long), ids)!;
    const line = fill.warnings.find((w) => /halves the damage/.test(w));
    assert.ok(line && line.length <= 400 && / and others\./.test(line));
    assert.ok(checkedFill(fill));
  });

  test("granted spells, actions with dice or a save, and 40 rolls at most", () => {
    const many = Array.from({ length: 50 }, (_, i) => spell(`Bolt ${i}`, 1, { requiresAttackRoll: true }));
    const fill = readDdbCharacter(
      ione(many, {
        spells: { race: [], class: [], item: [{ prepared: false, definition: { name: "Wand Bolt", level: 2, requiresAttackRoll: true, modifiers: [] } }], feat: [] },
        actions: { race: [{ name: "Breath Weapon", dice: { diceString: "2d6" }, saveStatId: 2, abilityModifierStatId: 3 }], class: [{ name: "Second Wind", dice: { diceString: "1d10" } }], feat: [] },
      }),
      ids,
    )!;
    assert.equal(fill.stats.rolls.length, 40);
    assert.ok(fill.warnings.includes("D&D Beyond has 13 more rolls for Ione Marrow than the 40 that are read, so those were not read. Rolls here that they would change stay as they are."));
    assert.deepEqual(fill.read, { weapon: true, spell: false, other: false, resource: true }, "the cut took spells and both actions");
    const all = readDdbCharacter(ione([], { actions: { race: [{ name: "Breath Weapon", dice: { diceString: "2d6" }, saveStatId: 2, abilityModifierStatId: 3 }], class: [{ name: "Second Wind", dice: { diceString: "1d10" } }] } }), ids)!;
    assert.deepEqual(all.stats.rolls.find((r) => r.name === "Breath Weapon"), { id: all.stats.rolls[0]!.id, name: "Breath Weapon", kind: "other", dice: [{ formula: "2d6" }], ddb: true, ability: "con", save: { ability: "dex" } });
    assert.deepEqual(all.stats.rolls.find((r) => r.name === "Second Wind")?.dice, [{ formula: "1d10" }]);
  });
});

describe("readDdbCharacter: what does not read", () => {
  test("not a character, never a throw", () => {
    for (const bad of [null, 5, "x", [], {}, { success: false }, { data: { stats: [] } }, { data: { stats: stats([10, 10, 10]) } }]) {
      assert.equal(readDdbCharacter(bad, ids), null, JSON.stringify(bad));
    }
  });

  test("missing and mistyped fields are skipped, a name loses its control and direction characters, and the level stops at 20", () => {
    const odd = wren({
      name: "Wren‮\u0007 Ashdown",
      classes: [{ level: 15, definition: { name: "Rogue" } }, { level: 9, definition: { name: 5 } }, "x", null],
      baseHitPoints: "lots",
      race: { weightSpeeds: "fast" },
      modifiers: { race: [null, 5, { type: "bonus" }, mod("bonus", "dexterity-score", Number.NaN)], class: "nope" },
      inventory: [{ equipped: true, definition: { name: "Bad Sword", filterType: "Weapon", damage: { diceString: "1d8; drop" } } }],
    });
    const fill = readDdbCharacter(odd, ids)!;
    assert.equal(fill.name, "Wren Ashdown");
    assert.equal(fill.level, 20);
    assert.ok(fill.warnings.some((w) => /add up to 24, past 20/.test(w)));
    assert.equal(fill.actor.hpMax, undefined);
    assert.equal(fill.actor.speeds, undefined);
    // A modifier list that is not a list leaves every modifier unread (DDBBUILD-ASTRA-06). Bad entries in a list are skipped.
    assert.equal(fill.stats.abilities, undefined);
    assert.ok(fill.warnings.some((w) => w.startsWith("Part of the character's bonuses and proficiencies")));
    assert.equal(fill.stats.rolls.length, 0);
    assert.ok(checkedFill(fill));
    const entries = readDdbCharacter(wren({ modifiers: { ...(wren().modifiers as J), race: [null, 5, { type: "bonus" }, mod("bonus", "dexterity-score", Number.NaN)] } }), ids)!;
    assert.equal(entries.stats.abilities?.dex, 16);
  });

  test("a spell or equipment list cut at its bound or not a list leaves its rolls read not whole, with its line (DDBBUILD-ASTRA-01)", () => {
    const SPELLS_CUT = "Some of D&D Beyond's spells were not read, since a list of them was too long or did not read. Spells here that they would change stay as they are.";
    const gearLine = (w: string) => w.startsWith("Part of the equipment in D&D Beyond could not be read");
    const bolt = spell("Fire Bolt", 0, { requiresAttackRoll: true, modifiers: [damage("fire", "1d10")] });
    const sleeps = (count: number) => Array.from({ length: count }, (_, i) => spell(`Sleep ${i}`, 1, { modifiers: [] }));
    const spellCuts = [
      ione([...sleeps(400), bolt]),
      ione([bolt], { classSpells: [{ spells: [bolt] }, { spells: {} }] }),
      ione([bolt], { classSpells: Array.from({ length: 21 }, () => ({ spells: [] })) }),
      ione([bolt], { spells: { race: "bolt", class: [], item: [], feat: [] } }),
      ione(sleeps(200), { spells: { race: sleeps(201), class: [], item: [], feat: [] } }),
    ];
    for (const [i, json] of spellCuts.entries()) {
      const fill = readDdbCharacter(json, ids)!;
      assert.equal(fill.read?.spell, false, `spell cut ${i}`);
      assert.ok(fill.warnings.includes(SPELLS_CUT), `spell cut ${i}`);
      assert.ok(checkedFill(fill));
    }
    for (const json of [ione([bolt]), ione([bolt], { classSpells: [{ spells: [bolt] }, { spells: null }, {}] }), ione([bolt], { spells: { race: null, class: [] } })]) {
      const fill = readDdbCharacter(json, ids)!;
      assert.equal(fill.read?.spell, true);
      assert.ok(!fill.warnings.includes(SPELLS_CUT));
    }
    const knives = (count: number) => Array.from({ length: count }, (_, i) => ({ equipped: false, definition: { id: 1000 + i, name: `Knife ${i}`, filterType: "Weapon" } }));
    const rapier = { equipped: true, definition: { id: 903, name: "Rapier", filterType: "Weapon", damage: { diceString: "1d8" }, damageType: "Piercing", attackType: 1, properties: [{ name: "Finesse" }] } };
    const gearCut = readDdbCharacter(wren({ inventory: [...knives(400), rapier] }), ids)!;
    assert.equal(gearCut.read?.weapon, false);
    assert.ok(gearCut.warnings.some(gearLine));
    const gearWhole = readDdbCharacter(wren({ inventory: [...knives(399), rapier] }), ids)!;
    assert.equal(gearWhole.read?.weapon, true, "400 is read whole");
    assert.ok(!gearWhole.warnings.some(gearLine));
  });

  test("a list past its bound is read only to it", () => {
    const flood = wren({ inventory: Array.from({ length: 100_000 }, (_, i) => ({ equipped: true, definition: { id: i, name: `Knife ${i}`, filterType: "Weapon", damage: { diceString: "1d4" }, damageType: "Piercing", attackType: 1, properties: [] } })) });
    const started = Date.now();
    const fill = readDdbCharacter(flood, ids)!;
    // Equipment past its bound is not read at all, so no weapon comes from it (DDBBUILD-ASTRA-06).
    assert.equal(fill.stats.rolls.length, 0);
    assert.equal(fill.read?.weapon, false);
    assert.ok(Date.now() - started < 2000);
  });
});

describe("readDdbCharacter: a source D&D Beyond did not send (docs/design-v1-resync.md 2.5)", () => {
  const WARN = {
    classes: "D&D Beyond did not send the character's classes, so the level, spellcasting, class features, max HP, weapons and spells were not read. They stay as they are.",
    modifiers: "D&D Beyond did not send the character's bonuses and proficiencies, so the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are.",
    equipment: "D&D Beyond did not send the equipment, so AC and weapons were not read. They stay as they are.",
    equipmentWithItems: "D&D Beyond did not send the equipment, so its magic items' bonuses could not be counted, and the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are.",
    scores: "D&D Beyond did not send the bonuses and overrides to the ability scores, so the scores, bonuses, AC, max HP and weapons were not read. They stay as they are.",
    spellLists: "D&D Beyond did not send the character's spell lists, so spells were not read. They stay as they are.",
    actions: "D&D Beyond did not send the character's actions, so other rolls and class resources were not read. They stay as they are.",
  };
  /** What the modifiers' needs hold up: every part that reads a modifier or a score. */
  const MODIFIER_PARTS = ["abilities", "saves", "skills", "adjust", "defenses", "jack", "alert", "actor.ac", "actor.hpMax", "actor.senses"];
  const wrenMods = wren().modifiers as J;
  const cloak = mod("bonus", "saving-throws", 1, { componentId: 900, requiresAttunement: true });

  const without = (body: J, ...keys: string[]): J => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));
  /** Wren with a roll of each kind, so a test sees which kinds a body leaves out. */
  const rich = (over: J = {}): J =>
    wren({
      classSpells: [{ spells: [spell("Fire Bolt", 0, { requiresAttackRoll: true, modifiers: [damage("fire", "1d10")] })] }],
      actions: { race: [], class: [{ name: "Cunning Action", dice: null }, { name: "Second Wind", dice: { diceString: "1d10" } }], feat: [] },
      ...over,
    });
  const WEAPONS = ["Rapier", "Longsword", "Longsword (two hands)", "Shortbow"];

  /** Every part a fill read, by name. */
  function partsOf(fill: PcFill): string[] {
    const stats = Object.keys(fill.stats).filter((k) => k !== "rolls");
    const actor = Object.keys(fill.actor).map((k) => `actor.${k}`);
    return [...stats, ...actor, ...(["level", "name"] as const).filter((k) => fill[k] !== undefined)].sort();
  }
  function partOf(fill: PcFill, part: string): unknown {
    if (part.startsWith("actor.")) return (fill.actor as J)[part.slice("actor.".length)];
    if (part === "level" || part === "name") return fill[part];
    return (fill.stats as J)[part];
  }

  /**
   * Reads the whole body and the partial one. The partial read leaves out
   * exactly `leftOut`, reads every other part as the whole read does, never
   * as empty, and gives `warning` as its one missing source.
   */
  function leavesOut(whole: J, partial: J, leftOut: readonly string[], warning: string): PcFill {
    const full = readDdbCharacter(whole, ids)!;
    const fill = readDdbCharacter(partial, ids)!;
    const missing = (f: PcFill) => f.warnings.filter((w) => w.startsWith("D&D Beyond did not send "));
    assert.deepEqual(missing(full), []);
    for (const part of leftOut) assert.ok(partsOf(full).includes(part), `the whole read has ${part}`);
    assert.deepEqual(partsOf(fill), partsOf(full).filter((p) => !leftOut.includes(p)));
    for (const part of partsOf(fill)) assert.deepEqual(partOf(fill, part), partOf(full, part), part);
    assert.deepEqual(missing(fill), [warning]);
    assert.ok(checkedFill(fill));
    return fill;
  }
  const names = (fill: PcFill) => fill.stats.rolls.map((r) => r.name);

  test("no classes: no level, spellcasting, class features, max HP, weapons or spells", () => {
    const leftOut = ["level", "spellAbility", "evasion", "critOn", "actor.hpMax"];
    for (const partial of [without(rich(), "classes"), rich({ classes: { level: 7 } }), rich({ classes: [{ level: "7", definition: { name: "Rogue" } }, { level: 3, definition: "Fighter" }, null] })]) {
      const fill = leavesOut(rich(), partial, leftOut, WARN.classes);
      assert.deepEqual(names(fill), ["Second Wind"]);
      assert.deepEqual(fill.read, { weapon: false, spell: false, other: true, resource: true });
      assert.ok(!fill.warnings.some((w) => /No class was read/.test(w)), "the level is left out, never read as 1");
    }
    // An override is the whole maximum, so it reads without the classes.
    const override = leavesOut(rich({ overrideHitPoints: 99 }), without(rich({ overrideHitPoints: 99 }), "classes"), ["level", "spellAbility", "evasion", "critOn"], WARN.classes);
    assert.equal(override.actor.hpMax, 99);
  });

  test("no modifiers, so a finesse Rapier, which takes the higher score, is left out with the scores", () => {
    for (const partial of [without(rich(), "modifiers"), rich({ modifiers: [] }), rich({ modifiers: "none" })]) {
      const fill = leavesOut(rich(), partial, MODIFIER_PARTS, WARN.modifiers);
      assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"]);
      assert.deepEqual(fill.read, { weapon: false, spell: true, other: true, resource: true });
    }
  });

  test("no inventory and no item's modifiers: only AC and the weapons are left out", () => {
    const body = rich({ modifiers: { ...wrenMods, item: [] } });
    for (const partial of [without(body, "inventory"), { ...body, inventory: { 0: "Rapier" } }]) {
      const fill = leavesOut(body, partial, ["actor.ac"], WARN.equipment);
      assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"]);
      assert.deepEqual(fill.read, { weapon: false, spell: true, other: true, resource: true });
    }
  });

  test("no inventory beside a Cloak of Protection's modifier: nothing the modifiers give is read", () => {
    const body = rich({ modifiers: { ...wrenMods, item: [cloak] } });
    const fill = leavesOut(body, without(body, "inventory"), MODIFIER_PARTS, WARN.equipmentWithItems);
    assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"]);
    assert.deepEqual(fill.read, { weapon: false, spell: true, other: true, resource: true });
  });

  test("no inventory beside an item's 120 ft Darkvision: the senses are not read as the race's 60 ft", () => {
    const goggles = { equipped: true, definition: { id: 907, name: "Goggles of Night", filterType: "Wondrous item" } };
    const body = rich({ modifiers: { ...wrenMods, item: [mod("set-base", "darkvision", 120, { componentId: 907 })] }, inventory: [...(wren().inventory as J[]), goggles] });
    assert.equal(readDdbCharacter(body, ids)!.actor.senses, "Darkvision 120 ft.");
    const fill = leavesOut(body, without(body, "inventory"), MODIFIER_PARTS, WARN.equipmentWithItems);
    assert.equal(fill.actor.senses, undefined);
  });

  test("no bonuses or overrides to the scores, beside an Aura of Protection's bonus of Charisma's modifier to saves", () => {
    const aura = rich({ modifiers: { ...wrenMods, class: [mod("bonus", "saving-throws", null, { statId: 6, fixedValue: null, value: null })], item: [] } });
    assert.deepEqual(readDdbCharacter(aura, ids)!.stats.adjust, { allSaves: 1, passive: 5 });
    for (const partial of [without(aura, "bonusStats"), without(aura, "overrideStats"), without(aura, "bonusStats", "overrideStats"), { ...aura, overrideStats: {} }]) {
      const fill = leavesOut(aura, partial, ["abilities", "adjust", "actor.ac", "actor.hpMax"], WARN.scores);
      assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"]);
      assert.deepEqual(fill.read, { weapon: false, spell: true, other: true, resource: true });
    }
  });

  test("no spell lists: the spells alone are left out, and the casting ability is still read", () => {
    const body = ione([spell("Fire Bolt", 0, { requiresAttackRoll: true, modifiers: [damage("fire", "1d10")] })]);
    assert.deepEqual(names(readDdbCharacter(body, ids)!), ["Fire Bolt"]);
    for (const partial of [without(body, "classSpells"), { ...body, classSpells: { spells: [] } }, { ...body, spells: null }, without(body, "spells")]) {
      const fill = leavesOut(body, partial, [], WARN.spellLists);
      assert.deepEqual(names(fill), []);
      assert.equal(fill.stats.spellAbility, "int");
      assert.deepEqual(fill.read, { weapon: true, spell: false, other: true, resource: true });
    }
  });

  test("no actions: the other rolls alone are left out", () => {
    for (const partial of [without(rich(), "actions"), rich({ actions: [] })]) {
      const fill = leavesOut(rich(), partial, [], WARN.actions);
      assert.deepEqual(names(fill), [...WEAPONS, "Fire Bolt"]);
      assert.deepEqual(fill.read, { weapon: true, spell: true, other: false, resource: false });
    }
  });

  test("41 rolls: the kind the cut reached is marked, and the others are whole", () => {
    const bolts = (count: number) => Array.from({ length: count }, (_, i) => spell(`Bolt ${i}`, 1, { requiresAttackRoll: true }));
    const spellCut = readDdbCharacter(wren({ classSpells: [{ spells: bolts(37) }] }), ids)!;
    assert.equal(spellCut.stats.rolls.length, 40);
    assert.equal(spellCut.stats.rolls.at(-1)?.name, "Bolt 35");
    assert.deepEqual(spellCut.read, { weapon: true, spell: false, other: true, resource: true });
    assert.ok(spellCut.warnings.includes("D&D Beyond has 1 more roll for Wren Ashdown than the 40 that are read, so it was not read. Rolls here that it would change stay as they are."));
    const otherCut = readDdbCharacter(rich({ classSpells: [{ spells: bolts(36) }] }), ids)!;
    assert.deepEqual(names(otherCut).slice(0, 4), WEAPONS);
    assert.equal(otherCut.stats.rolls.some((r) => r.name === "Second Wind"), false);
    assert.deepEqual(otherCut.read, { weapon: true, spell: true, other: false, resource: true });
    // A character with no name read is named in the words all the same.
    assert.ok(readDdbCharacter(without(rich({ classSpells: [{ spells: bolts(36) }] }), "name"), ids)!.warnings.some((w) => w.startsWith("D&D Beyond has 1 more roll for the character than the 40")));
    assert.ok(!spellCut.warnings.some((w) => /left out\. At most/.test(w)));
  });

  describe("a source cut at its bound or not a list is not read (DDBBUILD-ASTRA-06)", () => {
    const CUT = {
      classes: "Part of the character's classes in D&D Beyond could not be read, so the level, spellcasting, class features, max HP, weapons and spells were not read. They stay as they are.",
      modifiers: "Part of the character's bonuses and proficiencies in D&D Beyond could not be read, so the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are.",
      equipment: "Part of the equipment in D&D Beyond could not be read, so AC and weapons were not read. They stay as they are.",
      equipmentWithItems: "Part of the equipment in D&D Beyond could not be read, so its magic items' bonuses could not be counted, and the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are.",
      scores: "Part of the ability scores and their bonuses and overrides in D&D Beyond could not be read, so the scores, bonuses, AC, max HP and weapons were not read. They stay as they are.",
    };
    /** As leavesOut, with the source's line among those for sources not read. */
    function cutLeavesOut(whole: J, partial: J, leftOut: readonly string[], warning: string): PcFill {
      const full = readDdbCharacter(whole, ids)!;
      const fill = readDdbCharacter(partial, ids)!;
      const unread = (f: PcFill) => f.warnings.filter((w) => w.startsWith("D&D Beyond did not send ") || w.startsWith("Part of "));
      assert.deepEqual(unread(full), []);
      for (const part of leftOut) assert.ok(partsOf(full).includes(part), `the whole read has ${part}`);
      assert.deepEqual(partsOf(fill), partsOf(full).filter((p) => !leftOut.includes(p)));
      for (const part of partsOf(fill)) assert.deepEqual(partOf(fill, part), partOf(full, part), part);
      assert.deepEqual(unread(fill), [warning]);
      assert.ok(checkedFill(fill));
      return fill;
    }
    const filler = (count: number) => Array.from({ length: count }, () => mod("bonus", "nothing-read", 1));
    const knives = (count: number) => Array.from({ length: count }, (_, i) => ({ equipped: false, definition: { id: 2000 + i, name: `Knife ${i}`, filterType: "Weapon" } }));
    const features = (count: number) => Array.from({ length: count }, (_, i) => feature(`Feature ${i}`, 1));
    const wrenClasses = wren().classes as J[];

    test("classes past 20, or a class's features past 300 or not a list: nothing the classes give is read", () => {
      const leftOut = ["level", "spellAbility", "evasion", "critOn", "actor.hpMax"];
      const extra = Array.from({ length: 19 }, () => ({ level: 0, definition: { name: "Commoner", spellCastingAbilityId: null }, subclassDefinition: null, classFeatures: [] }));
      const cuts = [rich({ classes: [...wrenClasses, ...extra] }), rich({ classes: [{ ...wrenClasses[0]!, classFeatures: [...(wrenClasses[0]!.classFeatures as J[]), ...features(298)] }, wrenClasses[1]] }), rich({ classes: [{ ...wrenClasses[0]!, classFeatures: { 0: "Evasion" } }, wrenClasses[1]] })];
      for (const partial of cuts) {
        const fill = cutLeavesOut(rich(), partial, leftOut, CUT.classes);
        assert.deepEqual(names(fill), ["Second Wind"]);
        assert.deepEqual(fill.read, { weapon: false, spell: false, other: true, resource: false });
      }
      const at = readDdbCharacter(rich({ classes: [...wrenClasses, ...extra.slice(1)] }), ids)!;
      assert.ok(!at.warnings.includes(CUT.classes), "20 classes are read whole");
      assert.equal(readDdbCharacter(rich({ classes: [{ ...wrenClasses[0]!, classFeatures: [...(wrenClasses[0]!.classFeatures as J[]), ...features(297)] }, wrenClasses[1]] }), ids)!.level, 10, "300 features are read whole");
    });

    test("a modifier list past 600 or not a list, or more than 10 lists: nothing the modifiers give is read. A null list is empty", () => {
      const cuts = [rich({ modifiers: { ...wrenMods, class: [...filler(600), ...(wrenMods.class as J[])] } }), rich({ modifiers: { ...wrenMods, race: "dex" } }), rich({ modifiers: { ...wrenMods, a: [], b: [], c: [], d: [], e: [] } })];
      for (const partial of cuts) {
        const fill = cutLeavesOut(rich(), partial, MODIFIER_PARTS, CUT.modifiers);
        assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"]);
        assert.deepEqual(fill.read, { weapon: false, spell: true, other: true, resource: true });
      }
      const whole = readDdbCharacter(rich({ modifiers: { ...wrenMods, condition: null, a: [], b: [], c: [], d: [] } }), ids)!;
      assert.deepEqual(whole.stats.saves, ["dex", "int"], "10 lists, one null, are read whole");
      assert.ok(!whole.warnings.some((w) => w.startsWith("Part of ")));
    });

    test("equipment past 400: AC and the weapons are not read, and the modifiers too when an item's modifier names an item past it", () => {
      const own = wren().inventory as J[];
      // An item modifier naming no item is never counted, so it never makes the modifiers unread.
      const loose = { ...wrenMods, item: [...(wrenMods.item as J[]), mod("bonus", "saving-throws", 1, { componentId: null })] };
      const near = cutLeavesOut(rich({ modifiers: loose }), rich({ modifiers: loose, inventory: [...own, ...knives(400)] }), ["actor.ac"], CUT.equipment);
      assert.deepEqual(names(near), ["Fire Bolt", "Second Wind"]);
      assert.deepEqual(near.read, { weapon: false, spell: true, other: true, resource: true });
      const far = cutLeavesOut(rich(), rich({ inventory: [...knives(400), ...own] }), MODIFIER_PARTS, CUT.equipmentWithItems);
      assert.deepEqual(names(far), ["Fire Bolt", "Second Wind"]);
      assert.ok(!readDdbCharacter(rich({ inventory: [...own, ...knives(393)] }), ids)!.warnings.some((w) => w.startsWith("Part of ")), "400 items are read whole");
    });

    test("the scores, their bonuses or their overrides past 12: the scores are not read", () => {
      const aura = rich({ modifiers: { ...wrenMods, class: [mod("bonus", "saving-throws", null, { statId: 6, fixedValue: null, value: null })], item: [] } });
      const more = (list: unknown) => [...(list as J[]), ...stats([1, 1, 1, 1, 1, 1]), { id: 6, name: null, value: 5 }];
      const twelve = { ...aura, bonusStats: [...(aura.bonusStats as J[]), ...nulls()] };
      assert.ok(!readDdbCharacter(twelve, ids)!.warnings.some((w) => w.startsWith("Part of ")), "12 are read whole");
      for (const key of ["stats", "bonusStats", "overrideStats"]) {
        const partial = { ...aura, [key]: more(aura[key]) };
        const fill = cutLeavesOut(aura, partial, ["abilities", "adjust", "actor.ac", "actor.hpMax"], CUT.scores);
        assert.deepEqual(names(fill), ["Fire Bolt", "Second Wind"], key);
      }
    });

    test("reader to merge: a cut modifier list or an equipped item past 400 leaves the saves, defenses and scores as synced", () => {
      const sync = (c: SyncCharacter, json: J): SyncCharacter => {
        const p = planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill: readDdbCharacter(json, ids)! });
        const sent = syncPatch(c, syncResult(p, defaultTicks(p)));
        return sent ? afterSync(c, sent.patch, "2026-10-24T10:00:00.000Z") : c;
      };
      const bare: SyncCharacter = { name: "Wren Ashdown", level: 10, stats: undefined, actor: actor({ sheetUrl: "https://www.dndbeyond.com/characters/12345678" }) };
      const synced = sync(bare, rich());
      assert.deepEqual(synced.stats!.saves, ["dex", "int"]);
      assert.deepEqual(synced.stats!.defenses, { poison: "resistant" });
      for (const json of [rich({ modifiers: { ...wrenMods, class: [...filler(600), ...(wrenMods.class as J[])], race: [...filler(600), ...(wrenMods.race as J[])] } }), rich({ inventory: [...knives(400), ...(wren().inventory as J[])] })]) {
        const after = sync(synced, json);
        assert.deepEqual(after.stats!.saves, synced.stats!.saves);
        assert.deepEqual(after.stats!.defenses, synced.stats!.defenses);
        assert.deepEqual(after.stats!.abilities, synced.stats!.abilities);
        assert.deepEqual(after.stats!.adjust, synced.stats!.adjust);
      }
    });
  });
});
