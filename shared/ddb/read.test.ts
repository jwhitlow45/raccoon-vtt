import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkedFill } from "../rules/pcFill.ts";
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

  test("AC from the armor worn and its bonus, always a line to check, HP, speeds and darkvision, and the sheet link", () => {
    assert.equal(fill.actor.ac, 12 + 4 + 1);
    assert.ok(fill.warnings.includes("AC 17 was worked out from the armor. Check it."));
    assert.equal(fill.actor.hpMax, 60 + 2 * 10);
    assert.equal(readDdbCharacter(wren({ overrideHitPoints: 99 }), ids)!.actor.hpMax, 99);
    assert.deepEqual(fill.actor.speeds, { walk: 30, swim: 10 });
    assert.equal(fill.actor.senses, "Darkvision 60 ft.");
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
    assert.ok(fill.warnings.some((w) => /halves the damage was not read for Fireball\./.test(w)));
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
    assert.ok(fill.warnings.some((w) => /^13 more rolls were left out\. At most 40 rolls fit\.$/.test(w)));
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
    assert.equal(fill.stats.abilities?.dex, 16);
    assert.equal(fill.stats.rolls.length, 0);
    assert.ok(checkedFill(fill));
  });

  test("a list past its bound is read only to it", () => {
    const flood = wren({ inventory: Array.from({ length: 100_000 }, (_, i) => ({ equipped: true, definition: { id: i, name: `Knife ${i}`, filterType: "Weapon", damage: { diceString: "1d4" }, damageType: "Piercing", attackType: 1, properties: [] } })) });
    const started = Date.now();
    const fill = readDdbCharacter(flood, ids)!;
    assert.equal(fill.stats.rolls.length, 40);
    assert.ok(Date.now() - started < 2000);
  });
});
