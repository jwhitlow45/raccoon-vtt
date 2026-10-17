import { blockRollNumbers, type NamedRoll } from "#shared/dice/bonus.ts";
import { blockDefenses } from "#shared/dice/defenses.ts";
import { parseFormula, formatFormula } from "#shared/dice/formula.ts";
import { blockActions, blockEntries, hasTrait } from "#shared/dice/named.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type PcDice, type PcRoll, type PcStats, type StatBlock } from "#shared/model.ts";
import { MAX_PC_DICE_PARTS } from "#shared/protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "#shared/rules/damage.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { pcProficiency } from "#shared/rules/pcStats.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { fitLine } from "#shared/srd/monsters.ts";
import { abilityMod, monsterView, speedsOf } from "#shared/statBlock.ts";

/**
 * A stat block read into a player character's (docs/design-v1-pc-stats.md
 * 6.2): the pasted text goes through the monster editor's reader, then
 * each printed number reads as the derivation it matches, else as typed,
 * by one rule. Of the derivations a number could have, the nearest is
 * taken, a tie to the lower, and the rest is kept as the adjustment. So a
 * printed "+5" save at proficiency +3 on a +2 modifier is a proficient
 * save, and a "+6" one is proficient with +1 more, as a Cloak of
 * Protection gives.
 */

const ADJUST = 20;

/** Of `options`, lowest first, the index nearest `value`, a tie going to the lower. */
function nearest(value: number, options: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < options.length; i++) if (Math.abs(options[i]! - value) < Math.abs(options[best]! - value)) best = i;
  return best;
}

/** A difference kept as an adjustment, within its bounds, saying so when it is not. */
function adjustment(value: number, what: string, warnings: string[]): number {
  if (Math.abs(value) <= ADJUST) return value;
  warnings.push(`${what} differs from what the rules give by more than ${ADJUST}, so it reads ${value < 0 ? "−" : "+"}${ADJUST} off instead. Check it.`);
  return value < 0 ? -ADJUST : ADJUST;
}

function setIf<T extends Record<string, number>>(map: T, key: keyof T & string, value: number): void {
  if (value !== 0) (map as Record<string, number>)[key] = value;
}

/** The ability whose modifier and proficiency make `bonus`, Dex first for a ranged attack, else Str with the difference left over. */
function attackAbility(bonus: number, mods: Record<AbilityKey, number>, pb: number, ranged: boolean): { ability: AbilityKey; rest: number } {
  const order: AbilityKey[] = ranged ? ["dex", "str", "con", "int", "wis", "cha"] : ["str", "dex", "con", "int", "wis", "cha"];
  const found = order.find((a) => mods[a] + pb === bonus);
  return found ? { ability: found, rest: 0 } : { ability: "str", rest: bonus - (mods.str + pb) };
}

/** Whether a named roll's entry is a ranged attack, "Ranged Attack Roll" or 2014's "Ranged Weapon Attack", which reads Dexterity first. */
function rangedOf(entries: ReturnType<typeof blockEntries>, named: NamedRoll): boolean {
  const entry = entries.find((e) => e.section === named.section && named.name.startsWith(e.name.replace(/\s*\(.*$/, "")));
  return entry !== undefined && /^\W*ranged\b/i.test(entry.text);
}

/** A damage part's formula without a trailing constant equal to the modifier, which becomes "Add the modifier". */
function withoutMod(formula: string, mod: number): { formula: string; mod: boolean } {
  if (mod === 0) return { formula, mod: false };
  const parsed = parseFormula(formula);
  if (!parsed.ok) return { formula, mod: false };
  const last = parsed.formula[parsed.formula.length - 1];
  if (!last || last.kind !== "number" || last.sign * last.value !== mod || parsed.formula.length < 2) return { formula, mod: false };
  return { formula: formatFormula(parsed.formula.slice(0, -1)), mod: true };
}

/** One of the block's named rolls as a roll of the character's (6.2), or null when it has nothing to roll. */
function rollOf(named: NamedRoll, id: string, ctx: { mods: Record<AbilityKey, number>; pb: number; ranged: boolean; warnings: string[] }): PcRoll | null {
  const { mods, pb, warnings } = ctx;
  const name = fitLine(named.name, 60);
  const roll: PcRoll = { id, name, kind: named.attack !== undefined ? "weapon" : "other", dice: [] };
  let mod = 0;
  if (named.attack !== undefined) {
    const { ability, rest } = attackAbility(named.attack, mods, pb, ctx.ranged);
    roll.ability = ability;
    roll.attack = { prof: true, bonus: adjustment(rest, `${name}'s attack`, warnings) };
    mod = mods[ability];
  }
  if (named.save) {
    // The block's text says whether a pass halves, so its none is read, not unknown.
    const save: NonNullable<PcRoll["save"]> = { ability: named.save.ability, onPass: named.save.onPass };
    const dc = named.save.dc;
    const derives = (a: AbilityKey) => 8 + mods[a] + pb === dc;
    // The attack's ability gives the DC where it matches. A roll with no attack takes the ability that matches, else the DC stays as printed.
    const byAttack = roll.ability !== undefined && roll.ability !== "spell" && derives(roll.ability);
    const byAbility = roll.ability === undefined ? ABILITY_KEYS.find(derives) : undefined;
    if (byAbility) {
      roll.ability = byAbility;
      mod = mods[byAbility];
    } else if (!byAttack) save.dc = dc;
    roll.save = save;
  }
  const parts: PcDice[] = [];
  for (const part of named.damage) {
    const type = part.type && (DAMAGE_TYPES as readonly string[]).includes(part.type) ? (part.type as DamageType) : undefined;
    if (part.optional) {
      // A rider is damage of a type. One without a type has nothing to say what it deals.
      if (type) parts.push({ formula: part.formula, type, optional: true, ...(part.name ? { name: fitLine(part.name, 30) } : {}) });
      else warnings.push(`${name}: ${part.formula} that applies only sometimes names no damage type, so it was left out.`);
      continue;
    }
    // The modifier comes off the first part that ends with it, as a weapon's "1d8 + 3" does.
    const taken = parts.some((p) => p.mod) ? { formula: part.formula, mod: false } : withoutMod(part.formula, mod);
    parts.push({ formula: taken.formula, ...(taken.mod ? { mod: true as const } : {}), ...(type ? { type } : {}) });
  }
  if (named.heal) parts.push({ formula: named.heal.formula, type: "healing" });
  if (named.dice) parts.push({ formula: named.dice });
  if (parts.length > MAX_PC_DICE_PARTS) warnings.push(`${name} has more dice than a roll holds, so its last ${parts.length - MAX_PC_DICE_PARTS} were left out.`);
  roll.dice = parts.slice(0, MAX_PC_DICE_PARTS);
  if (!roll.attack && !roll.save && roll.dice.length === 0) return null;
  return roll;
}

/**
 * A block, as the stat block reader gives it, read into a character's
 * fill at a level (6.2). Recharge, uses and conditions stay in the pasted
 * text. A defense with words after it, such as "from nonmagical attacks",
 * is one the block cannot hold, so it is named in a warning.
 */
export function statsFromBlock(block: StatBlock, level: number | undefined, newId: () => string): PcFill {
  const warnings: string[] = [];
  const pb = pcProficiency(level);
  const view = monsterView(block);
  const abilities = {} as PcStats["abilities"];
  const mods = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) {
    const score = block.abilities[a].score;
    abilities[a] = Math.min(30, Math.max(1, score));
    if (abilities[a] !== score) warnings.push(`A score of ${score} is past what a character holds, so it reads ${abilities[a]}.`);
    mods[a] = abilityMod(abilities[a]);
  }
  const saves: PcStats["saves"] = [];
  const adjust: PcStats["adjust"] = {};
  const saveAdjust: Partial<Record<AbilityKey, number>> = {};
  for (const a of ABILITY_KEYS) {
    const options = [mods[a], mods[a] + pb];
    const at = nearest(block.abilities[a].save, options);
    if (at === 1) saves.push(a);
    setIf(saveAdjust, a, adjustment(block.abilities[a].save - options[at]!, `The ${ABILITY_NAMES[a]} save`, warnings));
  }
  if (Object.keys(saveAdjust).length > 0) adjust.saves = saveAdjust;

  const numbers = blockRollNumbers(block);
  const skills: PcStats["skills"] = {};
  const skillAdjust: Partial<Record<(typeof SKILL_KEYS)[number], number>> = {};
  for (const s of SKILL_KEYS) {
    const printed = numbers.skills[s];
    if (printed === undefined) continue;
    const m = mods[SKILLS[s].ability];
    const options = [m, m + pb, m + 2 * pb];
    const at = nearest(printed, options);
    if (at === 1) skills[s] = "prof";
    else if (at === 2) skills[s] = "expert";
    setIf(skillAdjust, s, adjustment(printed - options[at]!, SKILLS[s].name, warnings));
  }
  if (Object.keys(skillAdjust).length > 0) adjust.skills = skillAdjust;
  const perceptionLevel = skills.perception === "expert" ? 2 : skills.perception === "prof" ? 1 : 0;
  const perception = mods.wis + perceptionLevel * pb + (skillAdjust.perception ?? 0);
  const init = adjustment(block.initiative - mods.dex, "Initiative", warnings);
  if (init !== 0) adjust.init = init;
  const passive = adjustment(block.passivePerception - (10 + perception), "Passive Perception", warnings);
  if (passive !== 0) adjust.passive = passive;

  const out: PcFill = { source: "paste", stats: { abilities, saves, skills, adjust, rolls: [] }, actor: {}, warnings };
  if (numbers.spellDc !== undefined || numbers.spellAttack !== undefined) {
    // Casters' abilities first, so a tie names the one a stat block means.
    const order: AbilityKey[] = ["int", "wis", "cha", "str", "dex", "con"];
    const options = order.map((a) => (numbers.spellDc !== undefined ? 8 + mods[a] + pb : mods[a] + pb));
    const target = numbers.spellDc ?? numbers.spellAttack!;
    let best = 0;
    options.forEach((v, i) => {
      if (Math.abs(v - target) < Math.abs(options[best]! - target)) best = i;
    });
    const caster = order[best]!;
    out.stats.spellAbility = caster;
    if (numbers.spellDc !== undefined) {
      const dc = adjustment(numbers.spellDc - (8 + mods[caster] + pb), "The spell save DC", warnings);
      if (dc !== 0) adjust.spellDc = dc;
    }
    if (numbers.spellAttack !== undefined) {
      const attack = adjustment(numbers.spellAttack - (mods[caster] + pb), "The spell attack", warnings);
      if (attack !== 0) adjust.spellAttack = attack;
    }
  }

  const defenses: PcStats["defenses"] = {};
  const KIND = { resist: "resistant", immune: "immune", vulnerable: "vulnerable" } as const;
  let anyDefense = false;
  for (const d of blockDefenses(view)) {
    anyDefense = true;
    if (d.qualifier === undefined && (DAMAGE_TYPES as readonly string[]).includes(d.of)) defenses[d.of as DamageType] = KIND[d.kind];
    else if (d.qualifier !== undefined) warnings.push(`${d.kind === "resist" ? "Resistance" : d.kind === "immune" ? "Immunity" : "Vulnerability"} to ${d.of} ${d.qualifier} was left out: the stat block holds only plain ones.`);
  }
  if (anyDefense) out.stats.defenses = defenses;
  if (hasTrait(view, "Evasion")) out.stats.evasion = true;

  const entries = blockEntries(view);
  for (const named of blockActions(view)) {
    const roll = rollOf(named, newId(), { mods, pb, ranged: rangedOf(entries, named), warnings });
    if (roll) out.stats.rolls.push(roll);
  }

  if (block.name.trim()) out.name = fitLine(block.name.trim(), 80);
  out.actor.ac = block.ac;
  if (block.hp.average >= 1) out.actor.hpMax = block.hp.average;
  if (block.speed.trim()) out.actor.speeds = speedsOf(block.speed);
  out.actor.senses = fitLine(block.senses.trim(), 80);
  return out;
}
