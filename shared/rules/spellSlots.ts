import { HIT_DIE_SIZES, type ClassLevel, type HitDieSize, type Spent } from "../model.ts";
import { CLASS_IDS, type ClassId } from "./classResources.ts";

/**
 * Spell slots, Pact Magic slots and Hit Point Dice from a character's classes
 * (docs/design/design-v1-slots.md 2 and 5). The counts are derived here and
 * never stored, so the server stays their authority and a table fix is a
 * rules change behind an op gate like any other.
 *
 * Every row is typed from SRD 5.2.1: each full caster's Features table
 * (Bard, Cleric, Druid, Sorcerer, Wizard), the Paladin's and Ranger's, the
 * Warlock's Pact Magic columns, and the Multiclass Spellcaster table under
 * "Multiclassing", which is the full caster table. The one-third caster
 * table is the 2024 Player's Handbook's (Eldritch Knight, Arcane Trickster),
 * not SRD 5.2.1, and is labeled so wherever the app shows its numbers.
 */

/** At most this many classes on a character: each SRD class once and Other classes as fit. */
export const MAX_CLASSES = 12;
/** A character's level, and so the classes' sum, is at most 20. */
export const MAX_LEVEL = 20;
/** Spell slot levels 1 to 9. */
export const SLOT_LEVELS = 9;

/** Each class's Hit Point Die (SRD 5.2.1, each class's Core Traits). */
export const CLASS_DIE: Readonly<Record<ClassId, HitDieSize>> = {
  barbarian: 12,
  bard: 8,
  cleric: 8,
  druid: 8,
  fighter: 10,
  monk: 8,
  paladin: 10,
  ranger: 10,
  rogue: 8,
  sorcerer: 6,
  warlock: 8,
  wizard: 6,
};

/** The full caster classes, which add all their levels to a multiclass caster level. */
const FULL: ReadonlySet<ClassId> = new Set(["bard", "cleric", "druid", "sorcerer", "wizard"]);
/** The half casters, which add half their levels, rounded up. */
const HALF: ReadonlySet<ClassId> = new Set(["paladin", "ranger"]);
/** The classes whose subclass may cast by the one-third table. */
export const THIRD_CLASSES: ReadonlySet<ClassId> = new Set(["fighter", "rogue"]);
/** A third caster's Spellcasting starts at class level 3. */
export const THIRD_FROM = 3;

/** The full caster table, and the Multiclass Spellcaster table: row `n - 1` is level `n`'s slots by slot level. */
const FULL_TABLE: readonly (readonly number[])[] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** The Paladin's and Ranger's Spell Slots columns (2024 rules: Spellcasting from level 1). */
const HALF_TABLE: readonly (readonly number[])[] = [
  [2],
  [2],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2],
];

/** The one-third caster table (not SRD 5.2.1): nothing below level 3. */
const THIRD_TABLE: readonly (readonly number[])[] = [
  [],
  [],
  [2],
  [3],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 1],
];

/** Pact Magic by Warlock level: the slots and their one level. */
const PACT_TABLE: readonly { slots: number; level: number }[] = [
  { slots: 1, level: 1 },
  { slots: 2, level: 1 },
  { slots: 2, level: 2 },
  { slots: 2, level: 2 },
  { slots: 2, level: 3 },
  { slots: 2, level: 3 },
  { slots: 2, level: 4 },
  { slots: 2, level: 4 },
  { slots: 2, level: 5 },
  { slots: 2, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
  { slots: 4, level: 5 },
  { slots: 4, level: 5 },
  { slots: 4, level: 5 },
  { slots: 4, level: 5 },
];

/** The Pact Magic row: how many slots and the level they all are. */
export type Pact = { slots: number; level: number };

/** What a character's classes give: nine slot counts (zeros included) and the Pact Magic row or null. */
export type Slots = { slots: number[]; pact: Pact | null };

/** Dice by size, only sizes the classes give, largest first. */
export type Dice = { d12?: number; d10?: number; d8?: number; d6?: number };

export type DieKey = "d12" | "d10" | "d8" | "d6";
export const DIE_KEYS: readonly DieKey[] = ["d12", "d10", "d8", "d6"];

export function dieKey(die: HitDieSize): DieKey {
  return `d${die}`;
}

function row(table: readonly (readonly number[])[], level: number): number[] {
  const out = Array<number>(SLOT_LEVELS).fill(0);
  const counts = level >= 1 ? (table[Math.min(MAX_LEVEL, level) - 1] ?? []) : [];
  counts.forEach((count, i) => (out[i] = count));
  return out;
}

/** Whether a class entry gives Spellcasting (not Pact Magic): a full or half caster, or a ticked Fighter or Rogue from level 3. */
function casts(entry: ClassLevel): boolean {
  if (entry.id === "other") return false;
  if (FULL.has(entry.id) || HALF.has(entry.id)) return true;
  return THIRD_CLASSES.has(entry.id) && entry.third === true && entry.level >= THIRD_FROM;
}

/**
 * A character's spell slots and Pact Magic slots. With Spellcasting from one
 * class only, that class's own table applies. With more, the multiclass
 * caster level adds full casters' levels, half casters' halves rounded up
 * and third casters' thirds rounded down, each class on its own, and reads
 * the full table. Pact Magic stays apart.
 */
export function slotsOf(classes: readonly ClassLevel[] | undefined): Slots {
  const list = classes ?? [];
  const casters = list.filter(casts);
  let slots = row(FULL_TABLE, 0);
  if (casters.length === 1) {
    const only = casters[0]! as Extract<ClassLevel, { id: ClassId }>;
    slots = row(FULL.has(only.id) ? FULL_TABLE : HALF.has(only.id) ? HALF_TABLE : THIRD_TABLE, only.level);
  } else if (casters.length > 1) {
    let level = 0;
    for (const entry of casters as Extract<ClassLevel, { id: ClassId }>[]) {
      if (FULL.has(entry.id)) level += entry.level;
      else if (HALF.has(entry.id)) level += Math.ceil(entry.level / 2);
      else level += Math.floor(entry.level / 3);
    }
    slots = row(FULL_TABLE, level);
  }
  const warlock = list.find((entry) => entry.id === "warlock");
  const pactRow = warlock && warlock.level >= 1 ? PACT_TABLE[Math.min(MAX_LEVEL, warlock.level) - 1] : undefined;
  return { slots, pact: pactRow ? { ...pactRow } : null };
}

/** An entry's Hit Point Die. */
export function dieOf(entry: ClassLevel): HitDieSize {
  return entry.id === "other" ? entry.die : CLASS_DIE[entry.id];
}

/** A character's Hit Point Dice: one per class level, dice of one size pooled. */
export function diceOf(classes: readonly ClassLevel[] | undefined): Dice {
  const out: Dice = {};
  for (const size of HIT_DIE_SIZES) {
    const count = (classes ?? []).filter((entry) => dieOf(entry) === size).reduce((sum, entry) => sum + entry.level, 0);
    if (count > 0) out[dieKey(size)] = count;
  }
  return out;
}

/** The classes' levels added up. */
export function levelOf(classes: readonly ClassLevel[] | undefined): number {
  return (classes ?? []).reduce((sum, entry) => sum + entry.level, 0);
}

/** Whether a character's classes give any spell slot or Pact Magic slot. */
export function hasSlots(classes: readonly ClassLevel[] | undefined): boolean {
  const { slots, pact } = slotsOf(classes);
  return pact !== null || slots.some((count) => count > 0);
}

/**
 * `spent` in its one normal form (D-261127-276): `slots` exactly nine counts,
 * present while one is above 0, `pact` and each die key only above 0, die
 * keys in d12, d10, d8, d6 order, and absent when nothing is spent. It
 * reshapes only. `spentWithin` also clamps to the counts.
 */
export function normalSpent(spent: Spent | undefined): Spent | undefined {
  if (!spent) return undefined;
  const out: Spent = {};
  const slots = Array.from({ length: SLOT_LEVELS }, (_, i) => Math.max(0, Math.trunc(spent.slots?.[i] ?? 0)));
  if (slots.some((count) => count > 0)) out.slots = slots;
  const pact = Math.max(0, Math.trunc(spent.pact ?? 0));
  if (pact > 0) out.pact = pact;
  const dice: NonNullable<Spent["dice"]> = {};
  for (const key of DIE_KEYS) {
    const count = Math.max(0, Math.trunc(spent.dice?.[key] ?? 0));
    if (count > 0) dice[key] = count;
  }
  if (Object.keys(dice).length > 0) out.dice = dice;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `spent` clamped to what the classes give, in normal form: what every write of it stores. */
export function spentWithin(spent: Spent | undefined, classes: readonly ClassLevel[] | undefined): Spent | undefined {
  if (!spent) return undefined;
  const { slots, pact } = slotsOf(classes);
  const dice = diceOf(classes);
  const dieCounts: NonNullable<Spent["dice"]> = {};
  for (const key of DIE_KEYS) dieCounts[key] = Math.min(spent.dice?.[key] ?? 0, dice[key] ?? 0);
  return normalSpent({
    slots: slots.map((most, i) => Math.min(spent.slots?.[i] ?? 0, most)),
    pact: Math.min(spent.pact ?? 0, pact?.slots ?? 0),
    dice: dieCounts,
  });
}

/**
 * Whether `spent` is already in normal form and within the classes' counts,
 * as an import must hold it. Keys compare sorted, since a stored state's
 * key order does not survive a jsonb round trip.
 */
export function isNormalSpent(spent: Spent | undefined, classes: readonly ClassLevel[] | undefined): boolean {
  return sorted(spentWithin(spent, classes)) === sorted(spent);
}

/** JSON with each object's keys sorted. Not project.ts stableStringify, whose module imports the protocol, which imports this one. */
function sorted(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

/**
 * Whether a list of classes keeps the caps (D-261127-099): at most 12
 * entries, each SRD class once, levels 1 to 20, adding up to at most 20,
 * a `third` only on a Fighter or Rogue. The protocol's schema says the
 * same, in its own words.
 */
export function classesFit(classes: readonly ClassLevel[]): boolean {
  if (classes.length > MAX_CLASSES) return false;
  const seen = new Set<string>();
  for (const entry of classes) {
    if (!Number.isInteger(entry.level) || entry.level < 1 || entry.level > MAX_LEVEL) return false;
    if (entry.id === "other") continue;
    if (!(CLASS_IDS as readonly string[]).includes(entry.id) || seen.has(entry.id)) return false;
    if (entry.third && !THIRD_CLASSES.has(entry.id)) return false;
    seen.add(entry.id);
  }
  return levelOf(classes) <= MAX_LEVEL;
}
