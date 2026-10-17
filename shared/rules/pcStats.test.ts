import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, PcRoll, PcStats } from "../model.ts";
import { actor, character } from "../testutil.ts";
import {
  EMPTY_PC_STATS,
  applyPcStatsPatch,
  cantripTier,
  pcActorNumbers,
  pcDefenses,
  pcDerived,
  pcNamedRolls,
  pcProficiency,
  pcRollFits,
  pcSlots,
  sortedRolls,
  srdOnPass,
  statsDefenses,
  unknownOnPass,
  withPcActorNumbers,
  withPcActors,
} from "./pcStats.ts";

/** A block from the empty one with some parts changed. */
function stats(overrides: Partial<PcStats> = {}): PcStats {
  return { ...structuredClone(EMPTY_PC_STATS as PcStats), ...overrides };
}

function pc(level: number | undefined, block: PcStats, overrides: Partial<Character> = {}): Character {
  return character("bree", { name: "Bree", ...(level !== undefined ? { level } : {}), stats: block, ...overrides });
}

function roll(id: string, overrides: Partial<PcRoll> = {}): PcRoll {
  return { id, name: id, kind: "weapon", dice: [], ...overrides };
}

describe("the derived numbers (docs/design-v1-pc-stats.md 3.3)", () => {
  test("the proficiency bonus follows the level, and an unset level reads as 1", () => {
    const table: [number | undefined, number][] = [
      [undefined, 2],
      [1, 2],
      [4, 2],
      [5, 3],
      [8, 3],
      [9, 4],
      [12, 4],
      [13, 5],
      [16, 5],
      [17, 6],
      [20, 6],
    ];
    for (const [level, pb] of table) assert.equal(pcProficiency(level), pb, `level ${level}`);
    assert.equal(pcDerived(stats(), undefined).level, 1);
  });

  test("modifiers from scores, a 30 and a 1 included", () => {
    const d = pcDerived(stats({ abilities: { str: 30, dex: 1, con: 11, int: 9, wis: 10, cha: 15 } }), 1);
    assert.deepEqual(d.mods, { str: 10, dex: -5, con: 0, int: -1, wis: 0, cha: 2 });
  });

  test("a save adds proficiency where proficient, its own adjustment and the bonus to every save", () => {
    const d = pcDerived(stats({ abilities: { str: 16, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, saves: ["str"], adjust: { saves: { dex: 2 }, allSaves: 1 } }), 5);
    assert.equal(d.saves.str.total, 3 + 3 + 1);
    assert.equal(d.saves.dex.total, 2 + 0 + 1 + 2);
    assert.equal(d.saves.con.total, 1);
    assert.deepEqual(d.saves.dex.parts, [
      { label: "Dex", value: 2 },
      { label: "all saves", value: 1 },
      { label: "other", value: 2 },
    ]);
  });

  test("a check with no skill is the modifier and the checks bonus", () => {
    const d = pcDerived(stats({ abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, adjust: { allChecks: 1 } }), 1);
    assert.equal(d.checks.str.total, 4);
    assert.equal(d.checks.dex.total, 1);
  });

  test("a skill takes expertise, proficiency, Jack of All Trades where neither, its adjustment and the checks bonus", () => {
    const block = stats({
      abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 14, cha: 10 },
      skills: { stealth: "expert", perception: "prof" },
      jack: true,
      adjust: { skills: { perception: 1 }, allChecks: 1 },
    });
    const d = pcDerived(block, 9);
    assert.equal(d.pb, 4);
    assert.equal(d.skills.stealth.total, 3 + 8 + 1, "expertise, Jack adding nothing beside it");
    assert.equal(d.skills.stealth.level, "expert");
    assert.equal(d.skills.perception.total, 2 + 4 + 1 + 1);
    assert.equal(d.skills.athletics.total, 0 + 2 + 1, "Jack of All Trades: half the bonus rounded down");
    assert.equal(d.skills.athletics.level, "jack");
    assert.equal(pcDerived({ ...block, jack: undefined }, 9).skills.athletics.total, 1, "neither: the modifier and the checks bonus");
    assert.equal(pcDerived(block, 5).skills.athletics.total, 0 + 1 + 1, "Jack at +3 is +1");
  });

  test("initiative adds proficiency with Alert and the checks bonus, never Jack of All Trades", () => {
    const block = stats({ abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, alert: true, jack: true, adjust: { allChecks: 1, init: 1 } });
    assert.equal(pcDerived(block, 5).initiative.total, 2 + 3 + 1 + 1);
    assert.equal(pcDerived({ ...block, alert: undefined }, 5).initiative.total, 2 + 1 + 1);
  });

  test("Passive Perception is 10 and the Perception skill, then its own adjustment", () => {
    const block = stats({ abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 }, skills: { perception: "prof" }, adjust: { passive: -3 } });
    const d = pcDerived(block, 5);
    assert.equal(d.passive.base, 10 + 5);
    assert.equal(d.passive.total, 12);
    assert.deepEqual(d.passive.parts, [
      { label: "10", value: 10, fixed: true },
      { label: "Perception", value: 5 },
      { label: "other", value: -3 },
    ]);
  });

  test("the spell save DC and attack come from the spellcasting ability, and there are none without one", () => {
    const block = stats({ abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 }, spellAbility: "int", adjust: { spellDc: 1, spellAttack: -1 } });
    const d = pcDerived(block, 11);
    assert.equal(d.spell?.dc.total, 8 + 4 + 4 + 1);
    assert.equal(d.spell?.attack.total, 4 + 4 - 1);
    assert.equal(pcDerived(stats(), 11).spell, undefined);
  });

  test("Appendix C: Bree's Dex save, Stealth and initiative at levels 5 and 9, the cloak kept", () => {
    const block = stats({ abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, saves: ["dex"], skills: { stealth: "expert" }, adjust: { allSaves: 1 } });
    const at5 = pcDerived(block, 5);
    assert.equal(at5.saves.dex.total, 7);
    assert.equal(at5.skills.stealth.total, 9);
    assert.equal(at5.initiative.total, 3);
    const at9 = pcDerived(block, 9);
    assert.equal(at9.saves.dex.total, 8);
    assert.equal(at9.skills.stealth.total, 11);
    assert.equal(at9.allSaves, 1, "the cloak still +1");
  });

  test("the adjustment rule: a stored difference moves with the score and the level", () => {
    // The player typed 10 where the rule gave 13, so -3 is stored. Wisdom rises from 14 to 16: the rule gives 14, the total 11.
    const typed = stats({ abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 }, adjust: { skills: { perception: 1 }, passive: -3 } });
    assert.equal(pcDerived(typed, 1).passive.base, 13);
    assert.equal(pcDerived(typed, 1).passive.total, 10);
    const wiser = { ...typed, abilities: { ...typed.abilities, wis: 16 } };
    assert.equal(pcDerived(wiser, 1).passive.base, 14);
    assert.equal(pcDerived(wiser, 1).passive.total, 11);
    const proficient = { ...wiser, skills: { perception: "prof" as const } };
    assert.equal(pcDerived(proficient, 1).passive.total, 13, "proficiency moves it and keeps the -3");
    assert.equal(pcDerived(proficient, 5).passive.total, 14, "and so does a level-up");
  });

  test("the actor's two numbers, clamped to its bounds", () => {
    const high = stats({ abilities: { str: 10, dex: 30, con: 10, int: 10, wis: 30, cha: 10 }, alert: true, skills: { perception: "expert" }, adjust: { allChecks: 20, init: 20, passive: 20, skills: { perception: 20 } } });
    assert.deepEqual(pcActorNumbers(high, 20), { initBonus: 40, passivePerception: 60 });
    const low = stats({ abilities: { str: 10, dex: 1, con: 10, int: 10, wis: 1, cha: 10 }, adjust: { allChecks: -20, init: -20, passive: -20, skills: { perception: -20 } } });
    assert.deepEqual(pcActorNumbers(low, 1), { initBonus: -20, passivePerception: 0 });
  });

  test("withPcActorNumbers writes the actor's numbers, and returns the same character when they match or it has no block", () => {
    const bree = pc(5, stats({ abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 12, cha: 10 } }));
    const derived = withPcActorNumbers(bree);
    assert.equal(derived.actor.initBonus, 2);
    assert.equal(derived.actor.passivePerception, 11);
    assert.equal(withPcActorNumbers(derived), derived);
    const plain = character("c");
    assert.equal(withPcActorNumbers(plain), plain);
    const state = withPcActors({ characters: { bree, plain } });
    assert.equal(state.characters.bree?.actor.initBonus, 2);
    assert.equal(state.characters.plain, plain);
    const settled = { characters: { plain } };
    assert.equal(withPcActors(settled), settled);
  });

  test("a patch replaces each part it names, and null takes an optional part away", () => {
    const base = stats({ jack: true, spellAbility: "wis", saves: ["wis"] });
    const next = applyPcStatsPatch(base, { saves: ["dex", "int"], jack: null, critOn: 19 });
    assert.deepEqual(next.saves, ["dex", "int"]);
    assert.equal(next.jack, undefined);
    assert.equal("jack" in next, false);
    assert.equal(next.spellAbility, "wis", "a part left out keeps its value");
    assert.equal(next.critOn, 19);
    assert.deepEqual(base.saves, ["wis"], "the block patched is left as it was");
  });

  test("cantrip tiers", () => {
    assert.deepEqual([1, 4, 5, 10, 11, 16, 17, 20].map(cantripTier), [1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe("named rolls (docs/design-v1-pc-stats.md 3.4)", () => {
  const caster = stats({ abilities: { str: 10, dex: 18, con: 10, int: 18, wis: 16, cha: 10 }, spellAbility: "int" });

  test("Appendix C: Fire Bolt at level 11 rolls 3d10 at +8", () => {
    const bree = pc(11, { ...caster, rolls: [roll("fb", { name: "Fire Bolt", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d10", type: "fire", grows: true }] })] });
    const [fireBolt] = pcNamedRolls(bree);
    assert.deepEqual(fireBolt, { key: "fb", name: "Fire Bolt", section: "spells", level: 0, attack: 8, damage: [{ formula: "3d10", type: "fire" }] });
  });

  test("Appendix C: Fireball's DC 16, half on a pass, and 10d6 at slot 5", () => {
    const bree = pc(11, {
      ...caster,
      rolls: [roll("fireball", { name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] })],
    });
    const [fireball] = pcNamedRolls(bree);
    assert.deepEqual(fireball?.save, { ability: "dex", dc: 16, onPass: "half" });
    const slots = pcSlots(bree, "fireball");
    assert.equal(slots?.from, 3);
    assert.equal(slots?.at(5).damage[0]?.formula, "10d6");
    assert.equal(slots?.at(5).level, 3, "the spell's own level stays");
    assert.equal(slots?.at(2).damage[0]?.formula, "8d6", "a slot below its level casts it at its own");
  });

  test("Appendix C: Cure Wounds heals 2d8+3, and 6d8+3 at slot 3", () => {
    const bree = pc(5, { ...caster, spellAbility: "wis", rolls: [roll("cure", { name: "Cure Wounds", kind: "spell", ability: "spell", level: 1, dice: [{ formula: "2d8", type: "healing", mod: true, upcast: "2d8" }] })] });
    const [cure] = pcNamedRolls(bree);
    assert.deepEqual(cure?.heal, { formula: "2d8+3", upcast: "2d8" });
    assert.deepEqual(cure?.damage, []);
    assert.deepEqual(pcSlots(bree, "cure")?.at(3).heal, { formula: "6d8+3", upcast: "2d8" });
  });

  test("Appendix C: a rapier with Sneak Attack as a named rider", () => {
    const bree = pc(5, {
      ...caster,
      rolls: [
        roll("rapier", {
          name: "Rapier",
          ability: "dex",
          attack: { prof: true, bonus: 0 },
          dice: [
            { formula: "1d8", type: "piercing", mod: true },
            { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" },
          ],
        }),
      ],
    });
    const [rapier] = pcNamedRolls(bree);
    assert.equal(rapier?.attack, 7);
    assert.deepEqual(rapier?.damage, [
      { formula: "1d8+4", type: "piercing" },
      { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" },
    ]);
  });

  test("an attack counts proficiency where proficient, and a spell's always, with the spell attack's adjustment", () => {
    const block = { ...caster, adjust: { spellAttack: 1 }, rolls: [roll("club", { ability: "str", attack: { prof: false, bonus: 1 } }), roll("ray", { kind: "spell", ability: "spell", level: 1, attack: { prof: false, bonus: 0 } })] };
    const [club, ray] = pcNamedRolls(pc(5, block));
    assert.equal(club?.attack, 0 + 1);
    assert.equal(ray?.attack, 4 + 3 + 1, "a spell's attack counts proficiency whatever prof says");
  });

  test("a save's DC as typed, else 8, the modifier, proficiency and its bonus, with the spell DC's adjustment on a spell", () => {
    const block = {
      ...caster,
      adjust: { spellDc: 1 },
      rolls: [
        roll("breath", { kind: "other", ability: "con", save: { ability: "dex", bonus: 1 } }),
        roll("trip", { kind: "other", save: { ability: "str", dc: 14 } }),
        roll("hold", { kind: "spell", ability: "spell", level: 2, save: { ability: "wis" } }),
      ],
    };
    const named = pcNamedRolls(pc(5, block));
    assert.deepEqual(named.find((r) => r.key === "breath")?.save, { ability: "dex", dc: 8 + 0 + 3 + 1, onPass: "half" });
    assert.deepEqual(named.find((r) => r.key === "trip")?.save, { ability: "str", dc: 14, onPass: "half" });
    assert.deepEqual(named.find((r) => r.key === "hold")?.save, { ability: "wis", dc: 8 + 4 + 3 + 1, onPass: "half" });
  });

  test("an unset On a pass is not known: a spell takes the SRD's rule by its name, else a cantrip none and the rest half, and a typed one wins (W7B-P-2)", () => {
    const save = (onPass?: "half" | "none") => ({ ability: "dex" as const, ...(onPass ? { onPass } : {}) });
    const block = {
      ...caster,
      rolls: [
        roll("fireball", { name: "Fireball", kind: "spell", ability: "spell", level: 3, save: save() }),
        roll("cased", { name: "  fireBALL ", kind: "spell", ability: "spell", level: 3, save: save() }),
        roll("breath", { name: "Dragon's Breath", kind: "spell", ability: "spell", level: 2, save: save() }),
        roll("splash", { name: "Acid Splash", kind: "spell", ability: "spell", level: 0, save: save() }),
        roll("typed", { name: "Fireball", kind: "spell", ability: "spell", level: 3, save: save("none") }),
        roll("homebrew", { name: "Ember Burst", kind: "spell", ability: "spell", level: 2, save: save() }),
        roll("other", { name: "Acid Splash", kind: "other", save: save() }),
        roll("flame", { name: "Sacred Flame", kind: "spell", ability: "spell", level: 0, save: save() }),
        roll("halved", { name: "Ember Burst", kind: "spell", ability: "spell", level: 2, save: save("half") }),
      ],
    };
    const onPass = (key: string) => pcNamedRolls(pc(5, block)).find((r) => r.key === key)?.save?.onPass;
    assert.equal(onPass("fireball"), "half");
    assert.equal(onPass("cased"), "half", "the name matches trimmed and in any case");
    assert.equal(onPass("breath"), "half", "a straight apostrophe matches the SRD's curly one");
    assert.equal(onPass("splash"), "none");
    assert.equal(onPass("typed"), "none", "a typed none wins over the SRD's half");
    assert.equal(onPass("homebrew"), "half", "a leveled spell the SRD's table does not hold halves");
    assert.equal(onPass("flame"), "none", "a cantrip the SRD's table does not hold takes none");
    assert.equal(onPass("other"), "half", "only a spell reads the SRD's rule");
    assert.equal(onPass("halved"), "half");
    assert.equal(srdOnPass({ name: "Ember Burst", kind: "spell" }), undefined);
    assert.equal(unknownOnPass({ name: "Ember Burst", kind: "spell", level: 2 }), "half");
  });

  test("a spell's `spell` ability without a spellcasting ability adds 0", () => {
    const [ray] = pcNamedRolls(pc(5, { ...caster, spellAbility: undefined, rolls: [roll("ray", { kind: "spell", ability: "spell", level: 1, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "fire", mod: true }] })] }));
    assert.equal(ray?.attack, 3);
    assert.deepEqual(ray?.damage, [{ formula: "1d8", type: "fire" }]);
  });

  test("typed parts are damage, healing parts are heal, and untyped parts the plain roll, each joined", () => {
    const [mixed] = pcNamedRolls(
      pc(5, {
        ...caster,
        rolls: [
          roll("m", {
            kind: "other",
            dice: [
              { formula: "1d8", type: "radiant" },
              { formula: "1d4", type: "healing" },
              { formula: "1d6+2", type: "healing" },
              { formula: "1d8" },
              { formula: "1d6" },
            ],
          }),
        ],
      }),
    );
    assert.deepEqual(mixed?.damage, [{ formula: "1d8", type: "radiant" }]);
    assert.deepEqual(mixed?.heal, { formula: "1d4+1d6+2" });
    assert.equal(mixed?.dice, "1d8+1d6");
  });

  test("a formula that does not read is left out, and its roll keeps its other parts", () => {
    const [odd] = pcNamedRolls(pc(5, { ...caster, rolls: [roll("o", { attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8+", type: "fire" }, { formula: "1d4", type: "cold" }] })] }));
    assert.deepEqual(odd?.damage, [{ formula: "1d4", type: "cold" }]);
  });

  test("a weapon's critical range comes with it, and spells and other rolls crit on 20 alone", () => {
    const named = pcNamedRolls(pc(5, { ...caster, critOn: 19, rolls: [roll("axe", { attack: { prof: true, bonus: 0 } }), roll("ray", { kind: "spell", level: 1, attack: { prof: true, bonus: 0 } }), roll("kick", { kind: "other", attack: { prof: true, bonus: 0 } })] }));
    assert.equal(named.find((r) => r.key === "axe")?.critOn, 19);
    assert.equal(named.find((r) => r.key === "ray")?.critOn, undefined);
    assert.equal(named.find((r) => r.key === "kick")?.critOn, undefined);
  });

  test("weapons by name, spells by level then name, other rolls by name, each tie by id", () => {
    const rolls = [
      roll("o1", { kind: "other", name: "Second Wind" }),
      roll("s2", { kind: "spell", name: "Bless", level: 1 }),
      roll("w2", { name: "Longsword" }),
      roll("s1", { kind: "spell", name: "Aid", level: 2 }),
      roll("w1", { name: "dagger" }),
      roll("s0", { kind: "spell", name: "Zap", level: 0 }),
      roll("w0", { name: "Dagger" }),
    ];
    assert.deepEqual(
      sortedRolls(rolls).map((r) => r.id),
      ["w0", "w1", "w2", "s0", "s2", "s1", "o1"],
    );
    assert.deepEqual(
      pcNamedRolls(pc(1, { ...caster, rolls: rolls.map((r) => ({ ...r, dice: [{ formula: "1d4" }] })) })).map((r) => r.key),
      ["w0", "w1", "w2", "s0", "s2", "s1", "o1"],
    );
  });

  test("none without a block, and none while the character is in another shape", () => {
    assert.deepEqual(pcNamedRolls(character("c")), []);
    const shaped = pc(5, { ...caster, rolls: [roll("w", { attack: { prof: true, bonus: 0 } })] }, { actor: actor({ srdId: "brown-bear" }) });
    assert.deepEqual(pcNamedRolls(shaped), []);
  });

  test("pcSlots: a mixed spell scales each damage part and its healing by their own upcast and keeps the plain roll", () => {
    const bree = pc(5, {
      ...caster,
      rolls: [
        roll("mix", {
          kind: "spell",
          level: 2,
          dice: [
            { formula: "2d6", type: "fire", upcast: "1d6" },
            { formula: "1d8", type: "radiant" },
            { formula: "1d4", type: "healing", upcast: "1d4" },
            { formula: "1d6" },
          ],
        }),
      ],
    });
    const at4 = pcSlots(bree, "mix")!.at(4);
    assert.deepEqual(at4.damage, [
      { formula: "4d6", type: "fire", upcast: "1d6" },
      { formula: "1d8", type: "radiant" },
    ]);
    assert.deepEqual(at4.heal, { formula: "3d4", upcast: "1d4" });
    assert.equal(at4.dice, "1d6");
    assert.equal(at4.level, 2);
    assert.equal(pcSlots(bree, "mix")!.at(12).damage[0]?.formula, "9d6", "slot 9 at most");
  });

  test("pcSlots is null for a roll that does not scale, a cantrip, a weapon and an unknown key", () => {
    const bree = pc(5, {
      ...caster,
      rolls: [
        roll("flat", { kind: "spell", level: 1, dice: [{ formula: "1d4", type: "force" }] }),
        roll("cantrip", { kind: "spell", level: 0, dice: [{ formula: "1d10", type: "fire", upcast: "1d10" }] }),
        roll("sword", { dice: [{ formula: "1d8", type: "slashing", upcast: "1d8" }] }),
      ],
    });
    assert.equal(pcSlots(bree, "flat"), null);
    assert.equal(pcSlots(bree, "cantrip"), null);
    assert.equal(pcSlots(bree, "sword"), null);
    assert.equal(pcSlots(bree, "nope"), null);
  });

  test("named rolls are kept per character object", () => {
    const bree = pc(5, { ...caster, rolls: [roll("w", { dice: [{ formula: "1d4" }] })] });
    assert.equal(pcNamedRolls(bree), pcNamedRolls(bree));
  });
});

describe("defenses (docs/design-v1-pc-stats.md 3.6)", () => {
  test("in doc 3's Defense shape, unqualified, in the damage types' order, with Evasion beside them", () => {
    const bree = pc(5, stats({ defenses: { poison: "immune", fire: "resistant", cold: "vulnerable" }, evasion: true }));
    assert.deepEqual(pcDefenses(bree), {
      defenses: [
        { kind: "vulnerable", of: "cold", source: "Stat block" },
        { kind: "resist", of: "fire", source: "Stat block" },
        { kind: "immune", of: "poison", source: "Stat block" },
      ],
      evasion: true,
    });
  });

  test("none without a block, and none in another shape, Evasion included", () => {
    assert.deepEqual(pcDefenses(character("c")), { defenses: [], evasion: false });
    const shaped = pc(5, stats({ defenses: { fire: "resistant" }, evasion: true }), { actor: actor({ srdId: "brown-bear" }) });
    assert.deepEqual(pcDefenses(shaped), { defenses: [], evasion: false });
  });
});

describe("the largest a roll grows (docs/design-v1-pc-stats.md 7.2)", () => {
  test("a cantrip at level 20 and a spell at a 9th-level slot stay within one roll's 100 dice, the modifier included", () => {
    const block = stats({ spellAbility: "int" });
    assert.equal(pcRollFits(block, roll("c", { kind: "spell", level: 0, dice: [{ formula: "25d10", type: "fire", grows: true }] })), true, "100 dice");
    assert.equal(pcRollFits(block, roll("c", { kind: "spell", level: 0, dice: [{ formula: "26d10", type: "fire", grows: true }] })), false);
    assert.equal(pcRollFits(block, roll("f", { kind: "spell", level: 3, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] })), true);
    assert.equal(pcRollFits(block, roll("f", { kind: "spell", level: 1, dice: [{ formula: "50d6", type: "fire", upcast: "7d6" }] })), false, "50 and 56 more");
    assert.equal(pcRollFits(block, roll("p", { dice: [{ formula: "60d6", type: "fire" }, { formula: "41d6", type: "cold" }] })), false, "all parts together");
    assert.equal(pcRollFits(block, roll("x", { dice: [{ formula: "1d8+", type: "fire" }] })), false, "a formula that does not read");
  });

  test("a block's defenses whatever shape its character is in, for its own view", () => {
    assert.deepEqual(statsDefenses({ defenses: { fire: "resistant" } }), [{ kind: "resist", of: "fire", source: "Stat block" }]);
  });
});
