import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkedFill, type FillResource, type PcFill } from "../rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, syncPatch, syncResult, type SyncCharacter } from "../rules/pcSync.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { actor } from "../testutil.ts";
import type { PcStats } from "../model.ts";
import { readDdbCharacter } from "./read.ts";
import { resourceNameKey, resourceNameOf } from "./resources.ts";

/**
 * The class resources a D&D Beyond character's limited uses read as
 * (docs/design-v1-ddb-resources.md 1 to 3), over hand-built JSON in the
 * shape of public sample characters: an invented character and only the
 * paths the reader reads, so no D&D Beyond text is in the repository. One
 * fixture per row of 1.1's table and per path through 1.2.
 */

type J = Record<string, unknown>;

const CLASS_FEATURE = 12168134;
const SPECIES_TRAIT = 1960452172;
const FEAT = 1088085227;
/** An option of a class feature, such as a maneuver, and of a species trait, such as a 2014 Breath Weapon's color. */
const CLASS_OPTION = 258900837;
const SPECIES_OPTION = 306912077;

/**
 * A limited use as D&D Beyond sends it on an action, in the shape of the
 * public samples checked during the build: every key they carry, a cost of
 * 1 to 1 as every action's has, pools included.
 */
const lu = (over: J = {}): J => ({
  name: null,
  statModifierUsesId: null,
  resetType: 2,
  numberUsed: 0,
  minNumberConsumed: 1,
  maxNumberConsumed: 1,
  maxUses: 1,
  operator: 1,
  useProficiencyBonus: false,
  proficiencyBonusOperator: 1,
  resetDice: null,
  ...over,
});

let nextId = 5000;
/** An action of a class feature, a species trait or a feat, with a limited use or none. */
const act = (name: string, limitedUse: J | null, over: J = {}): J => ({ name, limitedUse, componentTypeId: CLASS_FEATURE, componentId: nextId++, dice: null, ...over });
const feature = (id: number, name: string, requiredLevel: number): J => ({ definition: { id, name, requiredLevel } });
const cls = (name: string, level: number, features: J[] = []): J => ({ level, definition: { name, spellCastingAbilityId: null }, subclassDefinition: null, classFeatures: features });
const stats = (values: number[]) => values.map((value, i) => ({ id: i + 1, name: null, value }));
const nulls = () => stats([0, 0, 0, 0, 0, 0]).map((s) => ({ ...s, value: null }));

/** Bree Holloway, an invented character: the classes and actions each test gives, Str 10, Dex 14, Con 12, Int 10, Wis 16, Cha 8. */
function bree(actions: { class?: J[]; race?: J[]; feat?: J[] }, classes: J[] = [cls("Druid", 6)], over: J = {}): J {
  return {
    id: 87654321,
    name: "Bree Holloway",
    stats: stats([10, 14, 12, 10, 16, 8]),
    bonusStats: nulls(),
    overrideStats: nulls(),
    baseHitPoints: 40,
    bonusHitPoints: null,
    overrideHitPoints: null,
    race: { weightSpeeds: { normal: { walk: 30 } } },
    classes,
    modifiers: { race: [], class: [], background: [], feat: [], item: [], condition: [] },
    inventory: [],
    classSpells: [],
    spells: { race: [], class: [], item: [], feat: [] },
    actions: { race: actions.race ?? [], class: actions.class ?? [], feat: actions.feat ?? [] },
    ...over,
  };
}

function read(json: J): PcFill {
  const fill = readDdbCharacter(json);
  assert.ok(fill, "reads as a character");
  assert.ok(checkedFill(fill), "passes the fill schema");
  return fill;
}

/** One action alone, of a feature the classes do not list, so nothing resolves and no preset matches. */
function one(limitedUse: J, name = "Grit Points", classes?: J[], over: J = {}): { resource: FillResource | undefined; fill: PcFill } {
  const fill = read(bree({ class: [act(name, limitedUse, over)] }, classes));
  return { resource: fill.resources?.[0], fill };
}

const UNREAD = /could not be read/;

describe("the fields relied on (1.1)", () => {
  test("a limited use null or absent is no resource, silently, and the read stays whole", () => {
    const fill = read(bree({ class: [act("Flurry of Blows", null), { name: "Cunning Action", dice: null }] }));
    assert.deepEqual(fill.resources, []);
    assert.equal(fill.read?.resource, true);
    assert.ok(!fill.warnings.some((w) => UNREAD.test(w)));
  });

  test("a limited use that is not an object could not be read", () => {
    const fill = read(bree({ class: [act("Odd", 3 as unknown as J)] }));
    assert.deepEqual(fill.resources, []);
    assert.equal(fill.read?.resource, false);
    assert.ok(fill.warnings.includes("1 limited use in D&D Beyond could not be read, so it was left out."));
  });

  test("a name that does not read is left out and counted", () => {
    for (const name of [null, 7, "   ", "\u0007"]) {
      const fill = read(bree({ class: [act(name as string, lu())] }));
      assert.deepEqual(fill.resources, [], String(name));
      assert.equal(fill.read?.resource, false);
    }
    const two = read(bree({ class: [act("", lu()), act(" ", lu())] }));
    assert.ok(two.warnings.includes("2 limited uses in D&D Beyond could not be read, so they were left out."));
  });

  test("the name is cleaned and cut on a whole character at 40", () => {
    assert.equal(resourceNameOf("  Second\n  Wind "), "Second Wind");
    const long = `${"a".repeat(38)}😀bcd`;
    const cut = resourceNameOf(long)!;
    assert.ok(cut.length <= 40);
    assert.equal(cut, `${"a".repeat(38)}…`, "the emoji would split, so the cut ends before it");
    const { resource } = one(lu(), long);
    assert.equal(resource?.name, cut);
  });

  test("the base count, the rest and the spent count", () => {
    const { resource, fill } = one(lu({ maxUses: 4, resetType: 1, numberUsed: 1 }));
    assert.deepEqual(resource, { name: "Grit Points", max: 4, reset: "short", used: 1 });
    assert.equal(fill.read?.resource, true);
  });

  test("an ability adds its modifier, Strength to Charisma by 1 to 6", () => {
    for (const [id, mod] of [[1, 0], [2, 2], [3, 1], [4, 0], [5, 3]] as const) {
      assert.equal(one(lu({ maxUses: 2, statModifierUsesId: id })).resource?.max, Math.max(1, 2 + mod), `ability ${id}`);
    }
    assert.equal(one(lu({ maxUses: 0, statModifierUsesId: 6 })).resource?.max, 1, "Charisma 8 is -1, and the floor is 1");
  });

  test("an ability id of 0, null or absent is none, and another number could not be read", () => {
    assert.equal(one(lu({ maxUses: 2, statModifierUsesId: 0 })).resource?.max, 2);
    const { statModifierUsesId: _gone, ...absent } = lu({ maxUses: 2 });
    assert.equal(one(absent).resource?.max, 2);
    for (const bad of [7, -1, "5", 2.5]) {
      const { fill } = one(lu({ maxUses: 2, statModifierUsesId: bad }));
      assert.deepEqual(fill.resources, [], String(bad));
      assert.equal(fill.read?.resource, false);
    }
  });

  test("the proficiency bonus counts only when the flag is true, and older bodies leave it out", () => {
    assert.equal(one(lu({ maxUses: 0, useProficiencyBonus: true })).resource?.max, 3, "Druid 6: +3");
    assert.equal(one(lu({ maxUses: 2, useProficiencyBonus: "true" })).resource?.max, 2);
    const { useProficiencyBonus: _u, proficiencyBonusOperator: _p, ...older } = lu({ maxUses: 2 });
    assert.equal(one(older).resource?.max, 2);
  });

  test("an operator absent or null is 1, and another number could not be read", () => {
    const { operator: _o, ...absent } = lu({ maxUses: 1, statModifierUsesId: 5 });
    assert.equal(one(absent).resource?.max, 4);
    assert.equal(one(lu({ maxUses: 1, statModifierUsesId: 5, operator: null })).resource?.max, 4);
    for (const bad of [{ operator: 3, statModifierUsesId: 5 }, { proficiencyBonusOperator: 0, useProficiencyBonus: true }, { operator: "1", statModifierUsesId: 5 }]) {
      const { fill } = one(lu({ maxUses: 1, ...bad }));
      assert.deepEqual(fill.resources, [], JSON.stringify(bad));
      assert.equal(fill.read?.resource, false);
    }
    assert.equal(one(lu({ maxUses: 2, operator: 9 })).resource?.max, 2, "an operator beside no ability is never read");
  });

  test("each rest (1.3): 1 Short, 2 Long, 3 dawn as Long with its line", () => {
    assert.equal(one(lu({ resetType: 1 })).resource?.reset, "short");
    assert.equal(one(lu({ resetType: 2 })).resource?.reset, "long");
    const dawn = one(lu({ resetType: 3 }), "Fey Step");
    assert.equal(dawn.resource?.reset, "long");
    assert.ok(dawn.fill.warnings.includes("Fey Step comes back at dawn in D&D Beyond. Here a Long Rest brings it back."));
    assert.equal(dawn.fill.read?.resource, true);
  });

  test("resetType 4 is left out with its line and the read stays whole (OP-1, ASTRA-3)", () => {
    const fill = read(bree({ feat: [act("Cold Caster", lu({ resetType: 4 }), { componentTypeId: FEAT }), act("Action Hero", lu({ resetType: 4 }), { componentTypeId: FEAT })] }));
    assert.deepEqual(fill.resources, []);
    assert.equal(fill.read?.resource, true);
    assert.ok(fill.warnings.includes("Cold Caster and Action Hero come back another way in D&D Beyond, so they were left out. Add one as your own if it counts."));
  });

  test("resetType absent, null, a string or 7 could not be read, and the read is not whole (OP-1, ASTRA-3)", () => {
    const { resetType: _r, ...absent } = lu();
    for (const limitedUse of [absent, lu({ resetType: null }), lu({ resetType: "2" }), lu({ resetType: 7 })]) {
      const { fill } = one(limitedUse);
      assert.deepEqual(fill.resources, [], JSON.stringify(limitedUse.resetType));
      assert.equal(fill.read?.resource, false);
      assert.ok(fill.warnings.some((w) => UNREAD.test(w)));
    }
  });

  test("the spent count: absent or not a whole number is unknown, past the count is cut", () => {
    for (const bad of [undefined, null, -1, 1.5, "1"]) assert.equal(one(lu({ maxUses: 3, numberUsed: bad })).resource?.used, undefined, String(bad));
    assert.equal(one(lu({ maxUses: 3, numberUsed: 5 })).resource?.used, 3);
  });

  test("the cost per use (OP-8, ASTRA-7, D-261024-34): a range is a pool, a fixed cost above 1 a pool with its line, a cost of 1 a count", () => {
    const fixed = one(lu({ maxUses: 8, minNumberConsumed: null, maxNumberConsumed: 2 }));
    assert.equal(fixed.resource?.pool, true);
    assert.equal(fixed.resource?.max, 8);
    assert.ok(fixed.fill.warnings.includes("Grit Points costs 2 a use on D&D Beyond: spend 2 each time."));
    const range = one(lu({ maxUses: 25, minNumberConsumed: 1, maxNumberConsumed: 25 }), "Healing Light");
    assert.equal(range.resource?.pool, true);
    assert.ok(!range.fill.warnings.some((w) => /costs/.test(w)));
    assert.equal(one(lu({ maxUses: 3, minNumberConsumed: 1, maxNumberConsumed: 1 })).resource?.pool, undefined);
    assert.equal(one(lu({ maxUses: 3, minNumberConsumed: "1", maxNumberConsumed: "4" })).resource?.pool, undefined, "not numbers: not a pool");
  });

  test("a class feature's source resolves by its id to its class and level", () => {
    const fill = read(bree({ class: [act("Wild Shape", lu({ maxUses: 3, resetType: 2 }), { componentId: 71 })] }, [cls("Druid", 6, [feature(71, "Wild Shape", 2)])]));
    assert.equal(fill.resources?.[0]?.classId, "druid");
    assert.equal(fill.resources?.[0]?.preset, "druid-wild-shape");
  });
});

describe("shapes the public samples hold", () => {
  test("a 2014 Monk 8's Ki Points, 4 spent, whose feature is named Ki: the Focus Points preset, a pool of 8", () => {
    const ki = act("Ki Points", lu({ maxUses: 8, numberUsed: 4, resetType: 1, useProficiencyBonus: false, proficiencyBonusOperator: 1 }), { componentId: 228 });
    const fill = read(bree({ class: [ki] }, [cls("Monk", 8, [feature(228, "Ki", 2)])]));
    assert.deepEqual(fill.resources, [{ name: "Focus Points", max: 8, reset: "short", pool: true, preset: "monk-focus-points", level: 8, classId: "monk", used: 4 }]);
  });

  test("an older body with no proficiency keys: a Fighter 3's Action Surge", () => {
    const { useProficiencyBonus: _u, proficiencyBonusOperator: _p, resetDice: _d, ...older } = lu({ maxUses: 1, resetType: 1 });
    const fill = read(bree({ class: [act("Action Surge", older, { componentId: 193 })] }, [cls("Fighter", 3, [feature(193, "Action Surge", 2)])]));
    assert.deepEqual(fill.resources, [{ name: "Action Surge", max: 1, reset: "short", preset: "fighter-action-surge", level: 3, classId: "fighter", used: 0 }]);
  });

  test("a class feature's option and a species trait's option stand alone, unresolved", () => {
    const fill = read(
      bree({ class: [act("Maneuvers: Parry", lu({ maxUses: 1, resetType: 1 }), { componentTypeId: CLASS_OPTION, componentId: 193 })], race: [act("Breath Weapon (Green)", lu({ maxUses: 1, resetType: 1 }), { componentTypeId: SPECIES_OPTION })] }, [
        cls("Fighter", 3, [feature(193, "Action Surge", 2)]),
      ]),
    );
    assert.deepEqual(
      fill.resources?.map((r) => [r.name, r.preset, r.classId]),
      [
        ["Maneuvers: Parry", undefined, undefined],
        ["Breath Weapon (Green)", undefined, undefined],
      ],
      "an option's id is never a class feature's, even when the numbers meet",
    );
  });

  test("a 2024 feature on several actions, one per way to use it: one resource, named as the first, its class resolved", () => {
    const invoke = act("Bladesong (Invoke)", lu({ maxUses: 1, statModifierUsesId: 4, operator: 2, resetType: 2, numberUsed: 1 }), { componentId: 12370310 });
    const end = act("Bladesong (End)", null, { componentId: 12370310 });
    const fill = read(bree({ class: [invoke, end] }, [cls("Wizard", 5, [feature(12370310, "Bladesong", 3)])], { stats: stats([10, 14, 12, 16, 10, 8]) }));
    assert.deepEqual(fill.resources, [{ name: "Bladesong (Invoke)", max: 3, reset: "long", classId: "wizard", used: 1 }]);
  });
});

describe("the maximum (1.2)", () => {
  const count = (limitedUse: J) => one(limitedUse).resource?.max;

  test("an ability by each operator", () => {
    assert.equal(count(lu({ maxUses: 2, statModifierUsesId: 5, operator: 1 })), 5, "2 + Wis 3");
    assert.equal(count(lu({ maxUses: 2, statModifierUsesId: 5, operator: 2 })), 6, "2 × Wis 3");
  });

  test("the bonus by each operator", () => {
    assert.equal(count(lu({ maxUses: 1, useProficiencyBonus: true, proficiencyBonusOperator: 1 })), 4, "1 + 3");
    assert.equal(count(lu({ maxUses: 2, useProficiencyBonus: true, proficiencyBonusOperator: 2 })), 6, "2 × 3");
  });

  test("both together, in all four pairs of operators", () => {
    const both = (opA: number, opP: number) => count(lu({ maxUses: 2, statModifierUsesId: 5, operator: opA, useProficiencyBonus: true, proficiencyBonusOperator: opP }));
    assert.equal(both(1, 1), 2 + 3 + 3);
    assert.equal(both(1, 2), (3 + 2) * 3);
    assert.equal(both(2, 1), 6 + 3);
    assert.equal(both(2, 2), (6 + 0) * 3);
  });

  test("the floor of 1 (choice 1), and under 1 from a multiply is no resource, silently", () => {
    assert.equal(count(lu({ maxUses: 0, statModifierUsesId: 6, operator: 1 })), 1);
    assert.equal(count(lu({ maxUses: 2, statModifierUsesId: 6, operator: 2 })), 2, "a multiply's floor is the base: 2 × -1 reads 2");
    const { fill } = one(lu({ maxUses: 0, statModifierUsesId: 5, operator: 2 }));
    assert.deepEqual(fill.resources, [], "0 × Wis 3 is under 1");
    assert.equal(fill.read?.resource, true);
    assert.ok(!fill.warnings.some((w) => UNREAD.test(w)));
  });

  test("-1 reads as 0 (choice 2): the bonus alone, or the ability alone", () => {
    assert.equal(count(lu({ maxUses: -1, useProficiencyBonus: true })), 3);
    assert.equal(count(lu({ maxUses: -1, statModifierUsesId: 5 })), 3);
  });

  test("an absent operator is 1 (choice 3), and the bonus counts without the ability key (choice 4)", () => {
    const { statModifierUsesId: _s, proficiencyBonusOperator: _p, ...older } = lu({ maxUses: 1, useProficiencyBonus: true });
    assert.equal(count(older), 4);
  });

  test("a base of 0 or -1 with nothing beside it is no resource, silently (choice 5), and null could not be read", () => {
    for (const base of [0, -1]) {
      const { fill } = one(lu({ maxUses: base }));
      assert.deepEqual(fill.resources, []);
      assert.equal(fill.read?.resource, true, String(base));
    }
    const nul = one(lu({ maxUses: null }));
    assert.deepEqual(nul.fill.resources, []);
    assert.equal(nul.fill.read?.resource, false);
  });

  test("maxUses absent, a string or past -1 could not be read; null beside an ability or the bonus is 0 (OP-2, ASTRA-2)", () => {
    const { maxUses: _m, ...absent } = lu();
    for (const limitedUse of [absent, lu({ maxUses: "3" }), lu({ maxUses: -2 }), lu({ maxUses: 2.5 })]) {
      const { fill } = one(limitedUse);
      assert.deepEqual(fill.resources, [], JSON.stringify(limitedUse.maxUses));
      assert.equal(fill.read?.resource, false);
    }
    assert.equal(count(lu({ maxUses: null, statModifierUsesId: 5 })), 3);
    assert.equal(count(lu({ maxUses: null, useProficiencyBonus: true })), 3);
  });

  test("over 99 for a count, or 200 for a pool, is left out and the read is not whole", () => {
    for (const limitedUse of [lu({ maxUses: 100 }), lu({ maxUses: 201, minNumberConsumed: 1, maxNumberConsumed: 10 })]) {
      const { fill } = one(limitedUse);
      assert.deepEqual(fill.resources, []);
      assert.equal(fill.read?.resource, false);
      assert.ok(fill.warnings.some((w) => UNREAD.test(w)));
    }
    assert.equal(one(lu({ maxUses: 200, minNumberConsumed: 1, maxNumberConsumed: 10 })).resource?.max, 200);
  });

  test("an ability without the scores, or the bonus without the classes, is left out with its line, and the read is not whole", () => {
    const noScores = read(bree({ class: [act("Bardic Inspiration", lu({ maxUses: 0, statModifierUsesId: 6 }))] }, [cls("Bard", 3)], { bonusStats: undefined }));
    assert.deepEqual(noScores.resources, []);
    assert.equal(noScores.read?.resource, false);
    assert.ok(noScores.warnings.includes("Bardic Inspiration's count comes from an ability score, which was not read, so it stays as it is."));
    const noClasses = read(bree({ race: [act("Breath Weapon", lu({ maxUses: 0, useProficiencyBonus: true }), { componentTypeId: SPECIES_TRAIT })] }, []));
    assert.deepEqual(noClasses.resources, []);
    assert.equal(noClasses.read?.resource, false);
    assert.ok(noClasses.warnings.includes("Breath Weapon's count comes from the proficiency bonus, which needs the classes, so it stays as it is."));
  });

  test("a Breath Weapon by proficiency at level 5: 3 uses, back on a Long Rest, no preset", () => {
    const fill = read(bree({ race: [act("Breath Weapon", lu({ maxUses: 0, useProficiencyBonus: true, resetType: 2 }), { componentTypeId: SPECIES_TRAIT })] }, [cls("Fighter", 5)]));
    assert.deepEqual(fill.resources, [{ name: "Breath Weapon", max: 3, reset: "long", used: 0 }]);
  });
});

describe("one feature, one resource (2.1)", () => {
  test("an action whose feature is above its class's level is dropped, silently", () => {
    const fill = read(bree({ class: [act("Divine Intervention", lu({ resetType: 2 }), { componentId: 81 })] }, [cls("Cleric", 6, [feature(81, "Divine Intervention", 10)])]));
    assert.deepEqual(fill.resources, []);
    assert.equal(fill.read?.resource, true);
  });

  test("two actions of one feature are one, named as the feature, with the higher spent count", () => {
    const actions = [act("Inspire", lu({ maxUses: 3, numberUsed: 2 }), { componentId: 90 }), act("Bardic Inspiration", lu({ maxUses: 3, numberUsed: 1 }), { componentId: 90 })];
    const fill = read(bree({ class: actions }, [cls("Bard", 4, [feature(90, "Bardic Inspiration", 1)])]));
    assert.equal(fill.resources?.length, 1);
    assert.equal(fill.resources?.[0]?.name, "Bardic Inspiration");
    assert.equal(fill.resources?.[0]?.used, 2);
  });

  test("Bardic Inspiration from features at Bard 1 and Bard 5, at Bard 5: one, the level 5 feature's, back on a Short or Long Rest", () => {
    const actions = [act("Bardic Inspiration", lu({ maxUses: 0, statModifierUsesId: 6, resetType: 2 }), { componentId: 91 }), act("Bardic Inspiration", lu({ maxUses: 0, statModifierUsesId: 6, resetType: 1, numberUsed: 1 }), { componentId: 92 })];
    const fill = read(bree({ class: actions }, [cls("Bard", 5, [feature(91, "Bardic Inspiration", 1), feature(92, "Font of Inspiration", 5)])]));
    assert.equal(fill.resources?.length, 1);
    assert.deepEqual(fill.resources?.[0], { name: "Bardic Inspiration", max: 1, reset: "short", preset: "bard-bardic-inspiration", level: 5, classId: "bard", used: 1 });
  });

  test("one name in two classes: two resources, each its class's preset (Cleric 6/Paladin 3)", () => {
    const actions = [act("Channel Divinity", lu({ maxUses: 3, resetType: 1 }), { componentId: 101 }), act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 102 })];
    const fill = read(bree({ class: actions }, [cls("Paladin", 3, [feature(102, "Channel Divinity", 3)]), cls("Cleric", 6, [feature(101, "Channel Divinity", 2)])]));
    assert.deepEqual(
      fill.resources?.map((r) => [r.preset, r.classId, r.max, r.reset]),
      [
        ["cleric-channel-divinity", "cleric", 3, "shortOne"],
        ["paladin-channel-divinity", "paladin", 2, "shortOne"],
      ],
      "class features sort by class in CLASS_IDS order",
    );
  });

  test("Cleric 2/Paladin 3, both Channel Divinity actions unresolved: the Cleric's and the Paladin's by the fallback (OP-22)", () => {
    const actions = [act("Channel Divinity", lu({ maxUses: 2, resetType: 1, numberUsed: 1 }), { componentId: 201 }), act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 202 })];
    const fill = read(bree({ class: actions }, [cls("Paladin", 3), cls("Cleric", 2)]));
    assert.deepEqual(
      fill.resources?.map((r) => [r.preset, r.classId, r.used]),
      [
        ["cleric-channel-divinity", "cleric", 1],
        ["paladin-channel-divinity", "paladin", 0],
      ],
    );
  });

  test("an unresolved Channel Divinity beside a resolved Cleric one is the Paladin's", () => {
    const actions = [act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 211 }), act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 212 })];
    const fill = read(bree({ class: actions }, [cls("Cleric", 2, [feature(211, "Channel Divinity", 2)]), cls("Paladin", 3)]));
    assert.deepEqual(
      fill.resources?.map((r) => r.preset),
      ["cleric-channel-divinity", "paladin-channel-divinity"],
    );
  });

  test("a third unresolved Channel Divinity, past the classes that hold it, meets the first class's by rule 3 and goes (OP-25)", () => {
    const cd = (id: number, used: number) => act("Channel Divinity", lu({ maxUses: 2, resetType: 1, numberUsed: used }), { componentId: id });
    const fill = read(bree({ class: [cd(221, 1), cd(222, 0), cd(223, 2)] }, [cls("Cleric", 2), cls("Paladin", 3)]));
    assert.deepEqual(
      fill.resources?.map((r) => [r.preset, r.used]),
      [
        ["cleric-channel-divinity", 1],
        ["paladin-channel-divinity", 0],
      ],
      "no class-unknown third comes in, and the Cleric's keeps its own spent count",
    );
    assert.equal(fill.read?.resource, true);
  });

  test("two unresolved actions of one name that only one class holds are one", () => {
    const actions = [act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 231 }), act("Channel Divinity", lu({ maxUses: 2, resetType: 1 }), { componentId: 232 })];
    const fill = read(bree({ class: actions }, [cls("Cleric", 2)]));
    assert.equal(fill.resources?.length, 1);
  });

  test("one name in one class: the feature with the highest required level stays", () => {
    const actions = [act("Wild Shape", lu({ maxUses: 2, resetType: 1 }), { componentId: 301 }), act("Wild Shape", lu({ maxUses: 3, resetType: 1 }), { componentId: 302 })];
    const fill = read(bree({ class: actions }, [cls("Druid", 6, [feature(301, "Wild Shape", 2), feature(302, "Wild Resurgence", 5)])]));
    assert.equal(fill.resources?.length, 1);
    assert.equal(fill.resources?.[0]?.max, 3);
  });

  test("order: class features by class, unresolved ones after them, then species traits, then feats", () => {
    const fill = read(
      bree(
        {
          class: [act("Mystery", lu()), act("Second Wind", lu({ maxUses: 2, resetType: 1 }), { componentId: 401 }), act("Wild Shape", lu({ maxUses: 2, resetType: 1 }), { componentId: 402 })],
          race: [act("Relentless Endurance", lu(), { componentTypeId: SPECIES_TRAIT })],
          feat: [act("Luck Points", lu({ maxUses: 3 }), { componentTypeId: FEAT })],
        },
        [cls("Fighter", 1, [feature(401, "Second Wind", 1)]), cls("Druid", 2, [feature(402, "Wild Shape", 2)])],
      ),
    );
    assert.deepEqual(
      fill.resources?.map((r) => r.name),
      ["Wild Shape", "Second Wind", "Mystery", "Relentless Endurance", "Luck Points"],
    );
  });

  test("14 limited uses: 12 read, the cut's line, and the read not whole", () => {
    const actions = Array.from({ length: 14 }, (_, i) => act(`Use ${i + 1}`, lu()));
    const fill = read(bree({ class: actions }));
    assert.equal(fill.resources?.length, 12);
    assert.equal(fill.resources?.[11]?.name, "Use 12");
    assert.equal(fill.read?.resource, false);
    assert.ok(fill.warnings.includes("D&D Beyond has 14 class resources for Bree Holloway, more than the 12 a character holds, so 2 were not read. Class resources here that they would change stay as they are."));
  });
});

describe("a preset match (3.4)", () => {
  test("by name and class: a Barbarian 5's Rage that says Long Rest takes the preset's rest", () => {
    const fill = read(bree({ class: [act("Rage", lu({ maxUses: 3, resetType: 2 }), { componentId: 501 })] }, [cls("Barbarian", 5, [feature(501, "Rage", 1)])]));
    assert.deepEqual(fill.resources?.[0], { name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, classId: "barbarian", used: 0 });
  });

  test("by each of D&D Beyond's names, 2024 and 2014", () => {
    const cases: [string, string, string, number][] = [
      ["Focus Points", "Monk", "monk-focus-points", 5],
      ["Ki Points", "Monk", "monk-focus-points", 5],
      ["Lay On Hands: Healing Pool", "Paladin", "paladin-lay-on-hands", 25],
      ["Lay on Hands Pool", "Paladin", "paladin-lay-on-hands", 25],
      ["Font of Magic: Sorcery Points", "Sorcerer", "sorcerer-sorcery-points", 5],
      ["Sorcery Points", "Sorcerer", "sorcerer-sorcery-points", 5],
    ];
    for (const [name, className, preset, max] of cases) {
      const fill = read(bree({ class: [act(name, lu({ maxUses: max, resetType: 2 }), { componentId: 601 })] }, [cls(className, 5, [feature(601, name, 1)])]));
      const r = fill.resources?.[0];
      assert.equal(r?.preset, preset, name);
      assert.equal(r?.pool, true, `${name} is a pool`);
      assert.equal(r?.max, max);
    }
  });

  test("Lay On Hands: Healing Pool, 25 with 10 spent: the preset, a pool of 25, 10 spent", () => {
    const fill = read(bree({ class: [act("Lay On Hands: Healing Pool", lu({ maxUses: 25, numberUsed: 10, resetType: 2, minNumberConsumed: 1, maxNumberConsumed: 25 }), { componentId: 602 })] }, [cls("Paladin", 5, [feature(602, "Lay On Hands", 1)])]));
    assert.deepEqual(fill.resources?.[0], { name: "Lay on Hands", max: 25, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, classId: "paladin", used: 10 });
  });

  test("a count under the preset's takes the preset's with the Check it line: Lay on Hands Pool at 5 for a Paladin 5", () => {
    const fill = read(bree({ class: [act("Lay on Hands Pool", lu({ maxUses: 5, resetType: 2 }), { componentId: 603 })] }, [cls("Paladin", 5, [feature(603, "Lay on Hands", 1)])]));
    assert.equal(fill.resources?.[0]?.max, 25);
    assert.ok(fill.warnings.includes("Lay on Hands reads 5 in D&D Beyond, fewer than a Paladin 5's 25 by SRD 5.2.1, so it reads 25 here. Check it."));
  });

  test("a 2014 Druid 6's Wild Shape of 2 reads 3, one back on a Short Rest, with the Check it line (D-261024-30)", () => {
    const fill = read(bree({ class: [act("Wild Shape", lu({ maxUses: 2, resetType: 1 }), { componentId: 604 })] }, [cls("Druid", 6, [feature(604, "Wild Shape", 2)])]));
    assert.deepEqual(fill.resources?.[0], { name: "Wild Shape", max: 3, reset: "shortOne", preset: "druid-wild-shape", level: 6, classId: "druid", used: 0 });
    assert.ok(fill.warnings.includes("Wild Shape reads 2 in D&D Beyond, fewer than a Druid 6's 3 by SRD 5.2.1, so it reads 3 here. Check it."));
  });

  test("a count over the preset's stays D&D Beyond's, which counts what feats and items add", () => {
    const fill = read(bree({ class: [act("Rage", lu({ maxUses: 4, resetType: 2 }), { componentId: 605 })] }, [cls("Barbarian", 5, [feature(605, "Rage", 1)])]));
    assert.equal(fill.resources?.[0]?.max, 4);
    assert.ok(!fill.warnings.some((w) => /Check it/.test(w)));
  });

  test("curly apostrophes made straight, a subclass's preset, and a straight name taking the preset's", () => {
    assert.equal(resourceNameKey("Nature's  Veil"), resourceNameKey("Nature’s Veil"));
    const fill = read(bree({ class: [act("Dark One's Own Luck", lu({ maxUses: 0, statModifierUsesId: 6, resetType: 2 }), { componentId: 606 })] }, [cls("Warlock", 6, [feature(606, "Dark One's Own Luck", 6)])]));
    assert.equal(fill.resources?.[0]?.name, "Dark One’s Own Luck");
    assert.equal(fill.resources?.[0]?.preset, "warlock-dark-ones-own-luck");
  });

  test("a class below the preset's level, and a name in no preset, come in as named with no preset", () => {
    const low = read(bree({ class: [act("Divine Intervention", lu({ resetType: 2 }), { componentId: 607 })] }, [cls("Cleric", 9, [feature(607, "Divine Intervention", 9)])]));
    assert.equal(low.resources?.[0]?.preset, undefined);
    assert.equal(low.resources?.[0]?.classId, "cleric");
    const other = read(bree({ class: [act("Superiority Dice", lu({ maxUses: 4, resetType: 1 }), { componentId: 608 })] }, [cls("Fighter", 3, [feature(608, "Combat Superiority", 3)])]));
    assert.deepEqual(other.resources?.[0], { name: "Superiority Dice", max: 4, reset: "short", classId: "fighter", used: 0 });
  });

  test("species traits and feats match no preset", () => {
    const fill = read(bree({ race: [act("Rage", lu({ maxUses: 2 }), { componentTypeId: SPECIES_TRAIT })] }, [cls("Barbarian", 5)]));
    assert.equal(fill.resources?.[0]?.preset, undefined);
    assert.equal(fill.resources?.[0]?.classId, undefined);
  });

  test("the bound runs after the preset: Lay on Hands at Paladin 20 with no cost fields is a pool of 100 (OP-14)", () => {
    const fill = read(bree({ class: [act("Lay On Hands: Healing Pool", lu({ maxUses: 100, resetType: 2 }), { componentId: 609 })] }, [cls("Paladin", 20, [feature(609, "Lay On Hands", 1)])]));
    assert.equal(fill.resources?.[0]?.max, 100);
    assert.equal(fill.resources?.[0]?.pool, true);
    assert.equal(fill.read?.resource, true);
  });
});

describe("the read's lines", () => {
  test("the missing actions line names class resources too, and no resources are read", () => {
    const { actions: _a, ...json } = bree({});
    const fill = read(json);
    assert.equal(fill.resources, undefined);
    assert.equal(fill.read?.resource, false);
    assert.ok(fill.warnings.includes("D&D Beyond did not send the character's actions, so other rolls and class resources were not read. They stay as they are."));
  });

  test("the resource lines come before 40 spell lines, so the cut never drops them (OP-13)", () => {
    const spells = Array.from({ length: 45 }, (_, i) => ({ prepared: true, definition: { name: `Spell ${i}`, level: 0, scaleType: "characterlevel", modifiers: [{ type: "damage", subType: "fire", die: { diceString: "1d6" }, atHigherLevels: { higherLevelDefinitions: [{ level: 5, dice: { diceString: "3d6" } }] } }] } }));
    const json = bree({ class: [act("Fey Step", lu({ resetType: 3 }))] }, [cls("Wizard", 5)], { classSpells: [{ spells }] });
    const fill = read(json);
    assert.equal(fill.warnings.length, 40);
    assert.ok(fill.warnings.includes("Fey Step comes back at dawn in D&D Beyond. Here a Long Rest brings it back."));
  });

  test("a long list of names stays within a warning's 400 characters", () => {
    const actions = Array.from({ length: 10 }, (_, i) => act(`${"A long feat name number".padEnd(36, "x")} ${i}`, lu({ resetType: 4 })));
    const fill = read(bree({ class: actions }));
    const line = fill.warnings.find((w) => /another way/.test(w));
    assert.ok(line && line.length <= 400 && / and others come back/.test(line));
  });
});

describe("an action list cut or not a list (DDBBUILD-ASTRA-01)", () => {
  const CUT_LINE = "Some of D&D Beyond's actions were not read, since a list of them was too long or did not read. Rolls and class resources here that they would change stay as they are.";
  const steps = (count: number) => Array.from({ length: count }, (_, i) => act(`Step ${i}`, null));
  const wild = () => act("Wild Shape", lu({ maxUses: 3, resetType: 1 }));

  test("past 200 actions in a list, those past it are not read, and the read is not whole, with its line", () => {
    const fill = read(bree({ class: [...steps(200), wild()] }));
    assert.deepEqual(fill.resources, []);
    assert.equal(fill.read?.resource, false);
    assert.equal(fill.read?.other, false, "the other rolls read the same list");
    assert.ok(fill.warnings.includes(CUT_LINE));
    const at = read(bree({ class: [...steps(199), wild()] }));
    assert.equal(at.read?.resource, true, "200 is read whole");
    assert.ok(!at.warnings.includes(CUT_LINE));
  });

  test("a list that is not an array is not read and the read is not whole. Null or absent reads as empty, whole", () => {
    for (const bad of [{}, "class", 3, true]) {
      const fill = read(bree({}, undefined, { actions: { class: [wild()], race: bad, feat: [] } }));
      assert.equal(fill.read?.resource, false, JSON.stringify(bad));
      assert.equal(fill.read?.other, false);
      assert.ok(fill.warnings.includes(CUT_LINE));
    }
    for (const actions of [{ class: [wild()], race: null, feat: [] }, { class: [wild()] }]) {
      const fill = read(bree({}, undefined, { actions }));
      assert.equal(fill.read?.resource, true);
      assert.equal(fill.read?.other, true);
      assert.ok(!fill.warnings.includes(CUT_LINE));
      assert.deepEqual(fill.resources?.map((r) => r.name), ["Wild Shape"]);
    }
  });

  test("reader to merge: a linked Wild Shape past the cut, or beside a list that does not read, stays with its entry", () => {
    const sync = (c: SyncCharacter, json: J): SyncCharacter => {
      const p = planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill: read(json) });
      const sent = syncPatch(c, syncResult(p, defaultTicks(p)));
      return sent ? afterSync(c, sent.patch, "2026-10-24T10:00:00.000Z") : c;
    };
    const before: SyncCharacter = { name: "Bree Holloway", level: 6, stats: structuredClone(EMPTY_PC_STATS) as PcStats, actor: actor({ sheetUrl: "https://www.dndbeyond.com/characters/87654321" }) };
    const linked = sync(before, bree({ class: [wild()] }));
    assert.deepEqual(linked.resources?.map((r) => r.name), ["Wild Shape"]);
    for (const json of [bree({ class: [...steps(200), wild()] }), bree({}, undefined, { actions: { class: [], race: {}, feat: [] } })]) {
      const after = sync(linked, json);
      assert.deepEqual(after.resources, linked.resources);
      assert.deepEqual(after.ddbSync?.res, linked.ddbSync?.res);
    }
    assert.deepEqual(sync(linked, bree({ class: [] })).resources, undefined, "a whole read without it removes it");
  });
});
