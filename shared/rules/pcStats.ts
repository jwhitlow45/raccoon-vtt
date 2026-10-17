import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type Actor, type Character, type PcDice, type PcRoll, type PcStats, type SkillKey, type Token } from "../model.ts";
import type { ActorPatch, PcStatsPatch } from "../protocol.ts";
import type { DamagePart, NamedRoll, RollNumbers } from "../dice/bonus.ts";
import type { Defense } from "../dice/defenses.ts";
import { formatFormula, parseFormula, type DiceTerm, type Formula, type Term } from "../dice/formula.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { ABILITY_NAMES, abilityMod } from "../statBlock.ts";
import { DAMAGE_TYPES } from "./damage.ts";
import { SKILLS } from "./skills.ts";
import { AREA_SPELLS } from "../srd/area-spells.ts";

/**
 * A player character's numbers from its stat block
 * (docs/design-v1-pc-stats.md 3.3 and 3.4): one pure derivation that the
 * editor, the view, the action bar, the dice's bonus on both sides and the
 * reducer's write of initiative and Passive Perception all read, so no two
 * of them can disagree. Every number is what the rules give plus a stored
 * adjustment, so a level-up moves every number and keeps an item's bonus.
 */

/** The block a character without one is patched from: every score 10, nothing proficient, no adjustments, defenses or rolls. */
export const EMPTY_PC_STATS: Readonly<PcStats> = Object.freeze({
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  saves: [],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [],
});

/** The level a block reads: the character's, 1 while unset. */
export function pcLevel(level: number | undefined): number {
  return Math.min(20, Math.max(1, Math.floor(level ?? 1)));
}

/** The proficiency bonus by level (SRD 5.2.1): +2 at 1, +3 at 5, +4 at 9, +5 at 13, +6 at 17. */
export function pcProficiency(level: number | undefined): number {
  return 2 + Math.floor((pcLevel(level) - 1) / 4);
}

/** A cantrip's dice multiplier: 1, then 2 from level 5, 3 from 11 and 4 from 17. */
export function cantripTier(level: number | undefined): number {
  const l = pcLevel(level);
  return l >= 17 ? 4 : l >= 11 ? 3 : l >= 5 ? 2 : 1;
}

/** One part of a derived number, for the editor's hint: "Dex +2", "proficiency +3". A fixed part prints as its value alone: "8". */
export type PcPart = { label: string; value: number; fixed?: true };

/** A number as the rules give it (`base`), the stored adjustment, and the total a field shows. */
export type PcNumber = { base: number; adjust: number; total: number; parts: PcPart[] };

export type SkillLevel = "none" | "prof" | "expert" | "jack";

export type PcDerived = {
  level: number;
  pb: number;
  mods: Record<AbilityKey, number>;
  saves: Record<AbilityKey, PcNumber>;
  /** An ability check with no skill: its modifier and the checks bonus. */
  checks: Record<AbilityKey, PcNumber>;
  skills: Record<SkillKey, PcNumber & { level: SkillLevel }>;
  initiative: PcNumber;
  passive: PcNumber;
  allSaves: number;
  allChecks: number;
  /** Without a spellcasting ability there is no spell save DC or attack. */
  spell?: { ability: AbilityKey; dc: PcNumber; attack: PcNumber };
};

function number(parts: PcPart[], adjust: number): PcNumber {
  const base = parts.reduce((sum, p) => sum + p.value, 0);
  return { base, adjust, total: base + adjust, parts: adjust !== 0 ? [...parts, { label: "other", value: adjust }] : parts };
}

/** Parts that add nothing are left out of a hint, except the first, so a plain number still says where it comes from. */
function nonZero(parts: PcPart[]): PcPart[] {
  return parts.filter((p, i) => i === 0 || p.fixed || p.value !== 0);
}

const derivedCache = new WeakMap<PcStats, Map<number, PcDerived>>();

/** Every number of section 3.3, with its parts. Cached per block and level, since a block is never changed in place. */
export function pcDerived(stats: PcStats, level: number | undefined): PcDerived {
  const l = pcLevel(level);
  let byLevel = derivedCache.get(stats);
  const known = byLevel?.get(l);
  if (known) return known;
  const derived = derive(stats, l);
  if (!byLevel) {
    byLevel = new Map();
    derivedCache.set(stats, byLevel);
  }
  byLevel.set(l, derived);
  return derived;
}

/** `mods` stands in for some of the scores' modifiers: a Wild Shape's Strength, Dexterity and Constitution (section 3.6). */
function derive(stats: PcStats, level: number, mods_?: Partial<Record<AbilityKey, number>>): PcDerived {
  const pb = pcProficiency(level);
  const adjust = stats.adjust;
  const allSaves = adjust.allSaves ?? 0;
  const allChecks = adjust.allChecks ?? 0;
  const mods = {} as Record<AbilityKey, number>;
  const saves = {} as PcDerived["saves"];
  const checks = {} as PcDerived["checks"];
  for (const a of ABILITY_KEYS) {
    const mod = mods_?.[a] ?? abilityMod(stats.abilities[a]);
    mods[a] = mod;
    const proficient = stats.saves.includes(a);
    saves[a] = number(
      nonZero([
        { label: ABILITY_NAMES[a], value: mod },
        { label: "proficiency", value: proficient ? pb : 0 },
        { label: "all saves", value: allSaves },
      ]),
      adjust.saves?.[a] ?? 0,
    );
    checks[a] = number(nonZero([{ label: ABILITY_NAMES[a], value: mod }, { label: "all checks", value: allChecks }]), 0);
  }
  const skills = {} as PcDerived["skills"];
  for (const s of SKILL_KEYS) {
    const usual = SKILLS[s].ability;
    const marked = stats.skills[s];
    const skillLevel: SkillLevel = marked ?? (stats.jack ? "jack" : "none");
    const value = skillLevel === "expert" ? 2 * pb : skillLevel === "prof" ? pb : skillLevel === "jack" ? Math.floor(pb / 2) : 0;
    const label = skillLevel === "expert" ? "expertise" : skillLevel === "jack" ? "Jack of All Trades" : "proficiency";
    skills[s] = {
      ...number(
        nonZero([
          { label: ABILITY_NAMES[usual], value: mods[usual] },
          { label, value },
          { label: "all checks", value: allChecks },
        ]),
        adjust.skills?.[s] ?? 0,
      ),
      level: skillLevel,
    };
  }
  // Initiative is a Dexterity check, so the checks bonus counts. Jack of All Trades needs a skill, so it does not.
  const initiative = number(
    nonZero([
      { label: ABILITY_NAMES.dex, value: mods.dex },
      { label: "Alert", value: stats.alert ? pb : 0 },
      { label: "all checks", value: allChecks },
    ]),
    adjust.init ?? 0,
  );
  const passive = number(
    [
      { label: "10", value: 10, fixed: true },
      { label: "Perception", value: skills.perception.total },
    ],
    adjust.passive ?? 0,
  );
  const out: PcDerived = { level, pb, mods, saves, checks, skills, initiative, passive, allSaves, allChecks };
  const caster = stats.spellAbility;
  if (caster !== undefined) {
    const mod = mods[caster];
    out.spell = {
      ability: caster,
      dc: number(
        [
          { label: "8", value: 8, fixed: true },
          { label: ABILITY_NAMES[caster], value: mod },
          { label: "proficiency", value: pb },
        ],
        adjust.spellDc ?? 0,
      ),
      attack: number(
        [
          { label: ABILITY_NAMES[caster], value: mod },
          { label: "proficiency", value: pb },
        ],
        adjust.spellAttack ?? 0,
      ),
    };
  }
  return out;
}

/** The actor's bounds for the two numbers the block writes (shared/protocol.ts actorSchema). */
const INIT_MIN = -20;
const INIT_MAX = 40;
const PASSIVE_MIN = 0;
const PASSIVE_MAX = 60;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** The initiative bonus and Passive Perception a block gives its actor, clamped to the actor's bounds. */
export function pcActorNumbers(stats: PcStats, level: number | undefined): { initBonus: number; passivePerception: number } {
  const d = pcDerived(stats, level);
  return { initBonus: clamp(d.initiative.total, INIT_MIN, INIT_MAX), passivePerception: clamp(d.passive.total, PASSIVE_MIN, PASSIVE_MAX) };
}

/**
 * The character with its actor's initiative and Passive Perception from its
 * block (section 3.5), or the same object when they already match or it has
 * none, so a write that changes nothing writes nothing new.
 */
export function withPcActorNumbers(character: Character): Character {
  if (!character.stats) return character;
  const numbers = pcActorNumbers(character.stats, character.level);
  if (character.actor.initBonus === numbers.initBonus && character.actor.passivePerception === numbers.passivePerception) return character;
  return { ...character, actor: { ...character.actor, ...numbers } };
}

/** A room's characters with their actors' numbers from their blocks, for a hand-made or older file brought in by an import. */
export function withPcActors<S extends { characters: Record<string, Character> }>(state: S): S {
  let characters: Record<string, Character> | null = null;
  for (const [id, character] of Object.entries(state.characters)) {
    const derived = withPcActorNumbers(character);
    if (derived === character) continue;
    characters ??= { ...state.characters };
    characters[id] = derived;
  }
  return characters ? { ...state, characters } : state;
}

/** Each part a patch names replaces that part whole, and null takes an optional one away. */
export function applyPcStatsPatch(base: PcStats, patch: PcStatsPatch): PcStats {
  const next: PcStats = { ...base };
  if (patch.abilities !== undefined) next.abilities = patch.abilities;
  if (patch.saves !== undefined) next.saves = patch.saves;
  if (patch.skills !== undefined) next.skills = patch.skills;
  if (patch.adjust !== undefined) next.adjust = patch.adjust;
  if (patch.defenses !== undefined) next.defenses = patch.defenses;
  if (patch.rolls !== undefined) next.rolls = patch.rolls;
  setOrDelete(next, "jack", patch.jack);
  setOrDelete(next, "alert", patch.alert);
  setOrDelete(next, "spellAbility", patch.spellAbility);
  setOrDelete(next, "critOn", patch.critOn);
  setOrDelete(next, "evasion", patch.evasion);
  return next;
}

function setOrDelete<T extends object, K extends keyof T>(target: T, field: K, value: T[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete target[field];
  else target[field] = value;
}

/** A block's serialized size against LIMITS.pcStatsBytes. */
export function pcStatsFits(stats: PcStats): boolean {
  return serializedBytes(stats) <= LIMITS.pcStatsBytes;
}

/** The refusal of a block that would end past its size (section 3.5). */
export function pcStatsTooBig(name: string): string {
  return `${name}'s stat block can be at most ${LIMITS.pcStatsBytes / 1024} KiB. Remove a few rolls.`;
}

/** The refusal of a typed initiative or Passive Perception on a character whose block gives them (section 3.5). */
export function pcNumbersFromBlock(name: string): string {
  return `${name}'s initiative and Passive Perception come from the stat block. Change them there.`;
}

/** The refusal of a Wild Shape mark anywhere but beside the SRD creature a character's own actor takes the shape of (section 3.6). */
export const WILD_SHAPE_ALONE = "Wild Shape goes with the SRD creature a character takes the shape of";

/** What shape a character is in (section 3.6): none, Wild Shape, or another shape such as Polymorph, by the SRD creature linked on its actor. */
export type PcShape = "none" | "wild" | "other";

export function pcShape(character: Pick<Character, "actor">): PcShape {
  if (character.actor.srdId === undefined) return "none";
  return character.actor.wildShape ? "wild" : "other";
}

/** The physical abilities a Wild Shape takes from the creature. The character keeps the rest. */
const BEAST_ABILITIES = ["str", "dex", "con"] as const;

/**
 * A character's numbers in Wild Shape with a stat block (section 3.6, SRD
 * 5.2.1 Druid): the creature's Strength, Dexterity and Constitution, the
 * character's own Intelligence, Wisdom and Charisma, and for each save and
 * skill the higher of the character's rule on those modifiers, its
 * proficiencies and adjustments kept, and the creature's printed bonus. A
 * check is the modifier and the checks bonus, and the spell numbers stay
 * the character's. `beast` is the creature's numbers from doc 1's SrdRolls.
 */
export function shapedNumbers(character: Pick<Character, "stats" | "level">, beast: RollNumbers): RollNumbers | null {
  const stats = character.stats;
  if (!stats) return null;
  const mods: Partial<Record<AbilityKey, number>> = {};
  for (const a of BEAST_ABILITIES) mods[a] = beast.abilities[a].mod;
  const d = derive(stats, pcLevel(character.level), mods);
  const abilities = {} as RollNumbers["abilities"];
  for (const a of ABILITY_KEYS) {
    const save = Math.max(d.saves[a].total, beast.abilities[a].save);
    abilities[a] = d.allChecks !== 0 ? { mod: d.mods[a], save, check: d.checks[a].total } : { mod: d.mods[a], save };
  }
  const skills: RollNumbers["skills"] = {};
  for (const s of SKILL_KEYS) {
    const usual = SKILLS[s].ability;
    const printed = beast.skills[s] ?? beast.abilities[usual].check ?? beast.abilities[usual].mod;
    skills[s] = Math.max(d.skills[s].total, printed);
  }
  const own = pcDerived(stats, character.level);
  const out: RollNumbers = { abilities, skills };
  if (own.spell) {
    out.spellDc = own.spell.dc.total;
    out.spellAttack = own.spell.attack.total;
  }
  if (own.allSaves !== 0) out.deathSave = own.allSaves;
  return out;
}

/** A Wild Shape's initiative with a stat block: the creature's Dexterity modifier, then Alert, the checks bonus and the initiative adjustment (section 3.6). */
export function shapedInitiative(character: Pick<Character, "stats" | "level">, beast: RollNumbers): number | null {
  const stats = character.stats;
  if (!stats) return null;
  return derive(stats, pcLevel(character.level), { dex: beast.abilities.dex.mod }).initiative.total;
}

/**
 * A shape's start and end on a character's own actor (W7B-P-9), after the
 * patch is applied. A patch that takes a shape from none keeps the
 * character's AC and speeds from before it, as the creature's take their
 * place. A patch that also sets the temporary HP, in a shape other than Wild
 * Shape such as Polymorph, marks that pool as the shape's (`shapeTemp`). A
 * change from one creature to another keeps the first AC and speeds, and a
 * pool it sets is the new shape's in the same way. The patch that ends the
 * shape puts the AC and speeds back, unless it sets them itself, and empties
 * the pool while the mark holds. Only damage keeps the mark: any other
 * source that sets the pool takes it away (shared/rules/hp.ts), so the end
 * never takes temporary HP that came from elsewhere (W7-SOL-06).
 */
export function withUnshaped(before: Actor, after: Actor, patch: Pick<ActorPatch, "ac" | "speeds" | "hp" | "srdId">): Actor {
  const was = before.srdId !== undefined;
  const is = after.srdId !== undefined;
  const shapesPool = patch.hp?.temp !== undefined && after.wildShape === undefined && after.hp.temp > 0;
  if (!was && is) return { ...after, unshaped: { ac: before.ac, speeds: before.speeds, ...(shapesPool ? { shapeTemp: true as const } : {}) } };
  if (after.unshaped === undefined) return after;
  if (was && is) {
    // Only a change of creature gives a pool. Any other patch that sets it is another source, which hp.ts has already unmarked.
    if (patch.srdId === undefined || patch.hp?.temp === undefined) return after;
    const { shapeTemp: _first, ...kept } = after.unshaped;
    return { ...after, unshaped: shapesPool ? { ...kept, shapeTemp: true } : kept };
  }
  if (!was) return after;
  const { unshaped, ...out } = after;
  if (patch.ac === undefined) out.ac = unshaped.ac;
  if (patch.speeds === undefined) out.speeds = unshaped.speeds;
  if (unshaped.shapeTemp && patch.hp?.temp === undefined) out.hp = { ...out.hp, temp: 0 };
  return out;
}

/**
 * A hand-made or older file's Wild Shape marks within the rule: only on a
 * character's own actor and only beside its SRD creature (section 3.6). The
 * AC and speeds a shape keeps go the same way: a file whose character is in
 * no shape, or a token's own actor, has none to put back.
 */
export function withShapeRules<S extends { characters: Record<string, Character>; tokens: Record<string, Token> }>(state: S): S {
  let characters: Record<string, Character> | null = null;
  for (const [id, character] of Object.entries(state.characters)) {
    if (character.actor.srdId !== undefined || (character.actor.wildShape === undefined && character.actor.unshaped === undefined)) continue;
    const { wildShape: _alone, unshaped: _kept, ...actor } = character.actor;
    characters ??= { ...state.characters };
    characters[id] = { ...character, actor };
  }
  let tokens: Record<string, Token> | null = null;
  for (const [id, token] of Object.entries(state.tokens)) {
    if (!("inline" in token.actor) || (token.actor.inline.wildShape === undefined && token.actor.inline.unshaped === undefined)) continue;
    const { wildShape: _theirs, unshaped: _kept, ...actor } = token.actor.inline;
    tokens ??= { ...state.tokens };
    tokens[id] = { ...token, actor: { inline: actor } };
  }
  return characters || tokens ? { ...state, ...(characters ? { characters } : {}), ...(tokens ? { tokens } : {}) } : state;
}

/** Weapons by name, then spells by level and name, then other rolls by name, each tie by id. */
export function sortedRolls(rolls: readonly PcRoll[]): PcRoll[] {
  const kindRank = { weapon: 0, spell: 1, other: 2 } as const;
  return [...rolls].sort((a, b) => {
    const kind = kindRank[a.kind] - kindRank[b.kind];
    if (kind !== 0) return kind;
    if (a.kind === "spell") {
      const level = (a.level ?? 0) - (b.level ?? 0);
      if (level !== 0) return level;
    }
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The modifier a roll adds: its ability's, the spellcasting ability's for `spell`, else 0. */
export function rollMod(stats: PcStats, derived: PcDerived, roll: Pick<PcRoll, "ability">): number {
  if (roll.ability === undefined) return 0;
  if (roll.ability === "spell") return stats.spellAbility === undefined ? 0 : derived.mods[stats.spellAbility];
  return derived.mods[roll.ability];
}

function scaledDice(terms: Formula, times: number): Formula {
  if (times === 1) return terms;
  return terms.map((t): Term => (t.kind === "dice" ? { ...t, count: t.count * times, ...(t.keep ? { keep: { high: t.keep.high, n: t.keep.n * times } } : {}) } : t));
}

/** A formula as canonical text that parseFormula accepts, or null when it no longer does (a later grammar, or past a bound). */
function canonical(terms: Formula): string | null {
  const text = formatFormula(terms);
  return parseFormula(text).ok ? text : null;
}

function partTerms(part: Pick<PcDice, "formula" | "mod" | "grows">, mod: number, level: number | undefined): Formula | null {
  const parsed = parseFormula(part.formula);
  if (!parsed.ok) return null;
  let terms = part.grows ? scaledDice(parsed.formula, cantripTier(level)) : parsed.formula;
  if (part.mod && mod !== 0) terms = [...terms, { kind: "number", sign: mod < 0 ? -1 : 1, value: Math.abs(mod) }];
  return canonical(terms) === null ? null : terms;
}

/** One part's dice at the character's level: a cantrip's grown by its tier, and the modifier added. Null when its formula does not read. */
export function partFormula(part: Pick<PcDice, "formula" | "mod" | "grows">, mod: number, level: number | undefined): string | null {
  const terms = partTerms(part, mod, level);
  return terms ? formatFormula(terms) : null;
}

/** A part's `upcast` for so many slot levels above the spell's own. */
function upcastTerms(per: Formula, extra: number): Formula {
  return per.map((t): Term => (t.kind === "dice" ? { ...t, count: t.count * extra } : { ...t, value: t.value * extra }));
}

function joined(formulas: readonly string[]): string | null {
  if (formulas.length === 0) return null;
  const parsed = parseFormula(formulas.join("+"));
  return parsed.ok ? canonical(parsed.formula) : null;
}

function upcastText(upcast: string | undefined): string | undefined {
  if (upcast === undefined) return undefined;
  const parsed = parseFormula(upcast);
  return parsed.ok ? (canonical(parsed.formula) ?? undefined) : undefined;
}

/** A DC as dice.roll carries it. */
function rollDc(dc: number): number {
  return clamp(dc, LIMITS.rollDcMin, LIMITS.rollDcMax);
}

/** A spell's name as the SRD's table keys it: any case, either apostrophe. */
function spellKey(name: string): string {
  return name.trim().toLowerCase().replace(/[’']/g, "'");
}

const SRD_ON_PASS = new Map(AREA_SPELLS.filter((s) => s.onPass !== undefined).map((s) => [spellKey(s.name), s.onPass!]));

/**
 * What the SRD 5.2.1 says a pass takes for a spell of this name, from the
 * area spells' table checked against its text, or undefined.
 */
export function srdOnPass(roll: Pick<PcRoll, "name" | "kind">): "half" | "none" | undefined {
  return roll.kind === "spell" ? SRD_ON_PASS.get(spellKey(roll.name)) : undefined;
}

/**
 * What a pass takes for a roll whose `onPass` was never typed nor read
 * (W7B-P-2). An unset value is not known, so it must never become "none"
 * and outrank the SRD's half. The SRD's rule for a spell of this name comes
 * first. Without one, a cantrip's pass takes none and anything else halves,
 * as the rules give for most saves that deal damage.
 */
export function unknownOnPass(roll: Pick<PcRoll, "name" | "kind" | "level">): "half" | "none" {
  return srdOnPass(roll) ?? (roll.kind === "spell" && roll.level === 0 ? "none" : "half");
}

/** One roll of a block as doc 1's NamedRoll at a level, for the editor's and the view's readings of a roll as it stands. */
export function namedRollOf(stats: PcStats, level: number | undefined, roll: PcRoll): NamedRoll {
  return namedRoll(stats, pcDerived(stats, level), roll);
}

/** One roll as doc 1's NamedRoll (section 3.4). */
function namedRoll(stats: PcStats, d: PcDerived, roll: PcRoll): NamedRoll {
  const m = rollMod(stats, d, roll);
  const spell = roll.kind === "spell";
  const out: NamedRoll = { key: roll.id, name: roll.name, section: spell ? "spells" : "actions", damage: [] };
  if (spell && roll.level !== undefined) out.level = roll.level;
  if (roll.attack) {
    // A spell attack is the spellcasting modifier plus the proficiency bonus, whatever an old draft or a crafted op says of `prof`.
    out.attack = m + (spell || roll.attack.prof ? d.pb : 0) + roll.attack.bonus + (spell ? (stats.adjust.spellAttack ?? 0) : 0);
  }
  if (roll.save) {
    const dc = roll.save.dc ?? 8 + m + d.pb + (roll.save.bonus ?? 0) + (spell ? (stats.adjust.spellDc ?? 0) : 0);
    out.save = { ability: roll.save.ability, dc: rollDc(dc), onPass: roll.save.onPass ?? unknownOnPass(roll) };
  }
  const heals: string[] = [];
  const healUpcasts: string[] = [];
  const plain: string[] = [];
  for (const part of roll.dice) {
    const formula = partFormula(part, m, d.level);
    if (formula === null) continue;
    const upcast = upcastText(part.upcast);
    if (part.type === "healing") {
      heals.push(formula);
      if (upcast !== undefined) healUpcasts.push(upcast);
    } else if (part.type !== undefined) {
      const damage: DamagePart = { formula, type: part.type };
      if (upcast !== undefined) damage.upcast = upcast;
      if (part.optional) {
        damage.optional = true;
        if (part.name !== undefined) damage.name = part.name;
      }
      out.damage.push(damage);
    } else plain.push(formula);
  }
  const heal = joined(heals);
  if (heal !== null) {
    const upcast = joined(healUpcasts);
    out.heal = upcast !== null ? { formula: heal, upcast } : { formula: heal };
  }
  const dice = joined(plain);
  if (dice !== null) out.dice = dice;
  // Improved Critical names weapon attacks, so spells and other rolls crit on 20 alone.
  if (roll.kind === "weapon" && stats.critOn !== undefined) out.critOn = stats.critOn;
  return out;
}

const namedCache = new WeakMap<Character, NamedRoll[]>();

/**
 * A character's rolls as doc 1's NamedRoll (section 3.4), weapons, then
 * spells by level, then other rolls. In a shape its own rolls give way to
 * the creature's, which come from that creature's block (docs/design-v1-roll-options.md):
 * Wild Shape keeps only the other rolls, and another shape none. Empty
 * without a block. Cached per character object, since an entity is
 * never changed in place.
 */
export function pcNamedRolls(character: Character): NamedRoll[] {
  const known = namedCache.get(character);
  if (known) return known;
  const stats = character.stats;
  let out: NamedRoll[] = [];
  const shape = pcShape(character);
  if (stats && shape !== "other") {
    const d = pcDerived(stats, character.level);
    // Wild Shape casts no spells and wields no weapons, so only the character's other rolls stay.
    out = sortedRolls(stats.rolls.filter((r) => shape === "none" || r.kind === "other")).map((roll) => namedRoll(stats, d, roll));
  }
  namedCache.set(character, out);
  return out;
}

/** Dice added to a formula, joined to a die of the same size where there is one: 8d6 and 2d6 make 10d6. */
function withAdded(base: Formula, added: Formula): Formula {
  const out = [...base];
  for (const term of added) {
    const at = term.kind === "dice" && term.sign === 1 && !term.keep ? out.findIndex((t) => t.kind === "dice" && t.sign === 1 && !t.keep && t.sides === term.sides) : -1;
    const found = out[at];
    if (found && found.kind === "dice" && term.kind === "dice") out[at] = { ...found, count: found.count + term.count } satisfies DiceTerm;
    else out.push(term);
  }
  return out;
}

function upcastAt(formula: string, upcast: string | undefined, extra: number): string {
  if (upcast === undefined || extra <= 0) return formula;
  const base = parseFormula(formula);
  const per = parseFormula(upcast);
  if (!base.ok || !per.ok) return formula;
  return canonical(withAdded(base.formula, upcastTerms(per.formula, extra))) ?? formula;
}

/**
 * Whether a roll stays within the dice's bounds at its largest: at level 20
 * and, for a spell that scales, cast with a 9th-level slot, each part
 * reading as a formula and all of them together within one roll's dice
 * (docs/design-v1-dice.md 3.2). The editor refuses one that does not, so a
 * roll never grows past what can be rolled as the character levels up.
 */
export function pcRollFits(stats: PcStats, roll: PcRoll): boolean {
  const mod = rollMod(stats, pcDerived(stats, 20), roll);
  const extra = roll.kind === "spell" && roll.level !== undefined && roll.level >= 1 ? 9 - roll.level : 0;
  let dice = 0;
  for (const part of roll.dice) {
    let terms = partTerms(part, mod, 20);
    if (terms === null) return false;
    if (part.upcast !== undefined && part.type !== undefined && extra > 0) {
      const per = parseFormula(part.upcast);
      if (!per.ok) return false;
      terms = withAdded(terms, upcastTerms(per.formula, extra));
      if (canonical(terms) === null) return false;
    }
    for (const t of terms) if (t.kind === "dice") dice += t.count;
  }
  return dice <= LIMITS.dicePerOp;
}

/**
 * A spell's higher slots (section 3.4): from its own level to 9, each damage
 * part and its healing gaining their `upcast` per slot above it, the plain
 * roll and `level` unchanged, so a stepper's range never moves. Null for a
 * roll that is no leveled spell or that scales with no slot.
 */
export function pcSlots(character: Character, key: string): { from: number; at(slot: number): NamedRoll } | null {
  const named = pcNamedRolls(character).find((r) => r.key === key);
  if (!named || named.section !== "spells" || named.level === undefined || named.level < 1) return null;
  if (!named.damage.some((p) => p.upcast !== undefined) && named.heal?.upcast === undefined) return null;
  const from = named.level;
  return {
    from,
    at(slot) {
      const extra = clamp(Math.floor(slot), from, 9) - from;
      if (extra === 0) return named;
      const out: NamedRoll = { ...named, damage: named.damage.map((p) => ({ ...p, formula: upcastAt(p.formula, p.upcast, extra) })) };
      if (named.heal) out.heal = { ...named.heal, formula: upcastAt(named.heal.formula, named.heal.upcast, extra) };
      return out;
    },
  };
}

const DEFENSE_KIND = { resistant: "resist", immune: "immune", vulnerable: "vulnerable" } as const;

/**
 * A character's damage defenses and Evasion (section 3.6), from its block,
 * in the damage types' order. A shape takes the creature's defenses from
 * its block instead. Wild Shape keeps Evasion, and another shape takes it
 * away too.
 */
export function pcDefenses(character: Pick<Character, "stats" | "actor">): { defenses: Defense[]; evasion: boolean } {
  const stats = character.stats;
  const shape = pcShape(character);
  if (!stats || shape === "other") return { defenses: [], evasion: false };
  // Evasion is a class feature the druid keeps in Wild Shape. The creature's block gives its own damage defenses.
  return { defenses: shape === "wild" ? [] : statsDefenses(stats), evasion: stats.evasion === true };
}

/** The damage defenses a block holds in doc 3's `Defense` shape, unqualified, whatever shape its character is in, for the block's own view. */
export function statsDefenses(stats: Pick<PcStats, "defenses">): Defense[] {
  const defenses: Defense[] = [];
  for (const type of DAMAGE_TYPES) {
    const kind = stats.defenses[type];
    if (kind !== undefined) defenses.push({ kind: DEFENSE_KIND[kind], of: type, source: "Stat block" });
  }
  return defenses;
}
