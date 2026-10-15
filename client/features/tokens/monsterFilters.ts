import { CONDITION_KEYS, CR_VALUES, type ConditionKey, type MonsterSize } from "#shared/model.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { SIZE_WORDS } from "#shared/statBlock.ts";
import { hasLairValues } from "./factory.ts";

/**
 * The monster browser's filters, modeled on D&D Beyond's monster listing
 * and limited to what an SRD 5.2.1 stat block holds (features section 15).
 * The encounter builder's search takes the same filters.
 *
 * A stat block is read into `MonsterFacts` once and kept for as long as the
 * monster object lives, so a keystroke or a tap only compares what was
 * already read. Immunities, resistances and vulnerabilities exist only as
 * stat block text, so they are read from the Markdown lines both sources
 * print the same way (shared/statBlock.ts writes a room's own monster
 * exactly as the SRD import wrote the SRD's).
 */

export const CREATURE_TYPES = [
  "aberration",
  "beast",
  "celestial",
  "construct",
  "dragon",
  "elemental",
  "fey",
  "fiend",
  "giant",
  "humanoid",
  "monstrosity",
  "ooze",
  "plant",
  "undead",
] as const;
export type CreatureType = (typeof CREATURE_TYPES)[number];

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** The nine alignments by the law and good axes, then Unaligned, as a 3 by 3 grid reads. */
export const ALIGNMENTS = [
  "lawful good",
  "neutral good",
  "chaotic good",
  "lawful neutral",
  "neutral",
  "chaotic neutral",
  "lawful evil",
  "neutral evil",
  "chaotic evil",
  "unaligned",
] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export const MOVEMENTS = ["fly", "hover", "swim", "climb", "burrow"] as const;
export type Movement = (typeof MOVEMENTS)[number];

export const SENSES = ["blindsight", "darkvision", "tremorsense", "truesight"] as const;
export type Sense = (typeof SENSES)[number];

export const SIZES = Object.keys(SIZE_WORDS) as MonsterSize[];

export type CrValue = (typeof CR_VALUES)[number];

/**
 * What the DM picked. Within a list of types, sizes or alignments a monster
 * needs any one, since it has only one of each. Within movement, senses
 * and the defenses it needs every one picked: "immune to Charmed and
 * Frightened" means both.
 */
export type MonsterFilters = {
  crMin: CrValue | null;
  crMax: CrValue | null;
  types: CreatureType[];
  sizes: MonsterSize[];
  alignments: Alignment[];
  /** Has legendary actions. */
  legendary: boolean;
  /** Has lair values: lair XP or more legendary uses in its lair. */
  lair: boolean;
  movement: Movement[];
  senses: Sense[];
  conditionImmunities: ConditionKey[];
  damageImmunities: DamageType[];
  resistances: DamageType[];
  vulnerabilities: DamageType[];
};

export const NO_FILTERS: MonsterFilters = {
  crMin: null,
  crMax: null,
  types: [],
  sizes: [],
  alignments: [],
  legendary: false,
  lair: false,
  movement: [],
  senses: [],
  conditionImmunities: [],
  damageImmunities: [],
  resistances: [],
  vulnerabilities: [],
};

/** One monster as the filters and the typed search see it. */
export type MonsterFacts = {
  /** Name, type and every size, lower case, for the typed words. */
  words: string;
  /** The challenge rating as a number, or null when it is not one. */
  cr: number | null;
  type: CreatureType | null;
  /** Both sizes of a "Medium or Small" block. */
  sizes: readonly MonsterSize[];
  alignment: Alignment | null;
  legendary: boolean;
  lair: boolean;
  movement: ReadonlySet<Movement>;
  senses: ReadonlySet<Sense>;
  conditionImmunities: ReadonlySet<ConditionKey>;
  damageImmunities: ReadonlySet<DamageType>;
  resistances: ReadonlySet<DamageType>;
  vulnerabilities: ReadonlySet<DamageType>;
};

/** "5", "1/4" or "05" as a number. Null for anything else, a zero denominator included. */
export function crValue(text: string): number | null {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] === undefined) return Number(m[1]);
  const denominator = Number(m[2]);
  return denominator === 0 ? null : Number(m[1]) / denominator;
}

// SRD monsters are one array for the page's life, and a room's own monster gets a new view object when it is edited (monsters/draft.ts viewOf), so an object never needs reading twice.
const read = new WeakMap<StatBlockMonster, MonsterFacts>();

export function monsterFacts(m: StatBlockMonster): MonsterFacts {
  let facts = read.get(m);
  if (!facts) {
    facts = readFacts(m);
    read.set(m, facts);
  }
  return facts;
}

const SIZE_PATTERN = "Tiny|Small|Medium|Large|Huge|Gargantuan";
/** The italic line under the name: "*Medium or Small Humanoid, Neutral*". */
const SIZE_LINE = new RegExp(`^\\*(?:${SIZE_PATTERN}) or (${SIZE_PATTERN})\\b`, "m");

/**
 * The first creature type named, with tags in brackets left out, so
 * "Dragon (Chromatic)" is a dragon and "Swarm of Tiny Beasts" a beast.
 */
const TYPE_WORD = /\b(aberration|beast|celestial|construct|dragon|elemental|fey|fiend|giant|humanoid|monstrosity|monstrosities|ooze|plant|undead)s?\b/;

function readFacts(m: StatBlockMonster): MonsterFacts {
  const alt = SIZE_LINE.exec(m.statBlock)?.[1]?.toLowerCase() as MonsterSize | undefined;
  const sizes = alt && alt !== m.size ? [m.size, alt] : [m.size];
  const type = TYPE_WORD.exec(m.type.toLowerCase().replace(/\([^)]*\)/g, " "))?.[1];
  const alignment = m.alignment.trim().toLowerCase().replace(/^typically\s+/, "");
  const immune = defenseWords(statLine(m.statBlock, "Immunities"));
  const speeds = m.speeds;
  return {
    words: `${m.name} ${m.type} ${sizes.join(" ")}`.toLowerCase(),
    cr: crValue(m.cr),
    type: type === undefined ? null : type === "monstrosities" ? "monstrosity" : (type as CreatureType),
    sizes,
    alignment: (ALIGNMENTS as readonly string[]).includes(alignment) ? (alignment as Alignment) : null,
    legendary: m.legendaryActions !== undefined || /^### Legendary Actions$/m.test(m.statBlock),
    lair: hasLairValues(m),
    movement: new Set(MOVEMENTS.filter((kind) => (kind === "hover" ? speeds.hover === true : (speeds[kind] ?? 0) > 0))),
    senses: new Set(SENSES.filter((sense) => new RegExp(`\\b${sense}\\b`, "i").test(m.senses))),
    conditionImmunities: only(immune, CONDITION_KEYS),
    damageImmunities: only(immune, DAMAGE_TYPES),
    resistances: only(defenseWords(statLine(m.statBlock, "Resistances")), DAMAGE_TYPES),
    vulnerabilities: only(defenseWords(statLine(m.statBlock, "Vulnerabilities")), DAMAGE_TYPES),
  };
}

/** A labeled line of the Markdown stat block, "**Immunities** Fire; Charmed", without its label and escapes. */
function statLine(statBlock: string, label: string): string {
  const line = new RegExp(`^\\*\\*${label}\\*\\* (.*)$`, "m").exec(statBlock)?.[1] ?? "";
  return line.replace(/\\([*_`\\])/g, "$1");
}

/**
 * The first word of each item in a defense line. The 2024 Immunities line
 * lists damage types, a semicolon, then conditions, and a word belongs to
 * one list or the other ("Poison" or "Poisoned"). An item with a
 * qualifier counts by its first word, as the stat block lists it:
 * "Charmed (except from its vampire master)" is a Charmed immunity. A 2014
 * clause such as "and Slashing from Nonmagical Attacks" counts as Slashing.
 */
function defenseWords(line: string): Set<string> {
  const words = new Set<string>();
  for (const item of line.toLowerCase().split(/[;,]/)) {
    const word = /^\s*(?:(?:and|or)\s+)?([a-z]+)/.exec(item)?.[1];
    if (word) words.add(word);
  }
  return words;
}

function only<T extends string>(words: ReadonlySet<string>, options: readonly T[]): ReadonlySet<T> {
  return new Set(options.filter((o) => words.has(o)));
}

/** The CR bounds picked, lowest first whichever way round they were picked, or null for none. */
export function crBounds(filters: Pick<MonsterFilters, "crMin" | "crMax">): { min: number; max: number } | null {
  if (filters.crMin === null && filters.crMax === null) return null;
  const a = filters.crMin === null ? 0 : (crValue(filters.crMin) ?? 0);
  const b = filters.crMax === null ? Infinity : (crValue(filters.crMax) ?? Infinity);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * The test the filters make, built once per change and run on every
 * monster. Null when no filter is on, so a list skips the work.
 */
export function filterTest(filters: MonsterFilters): ((f: MonsterFacts) => boolean) | null {
  if (filterCount(filters) === 0) return null;
  const cr = crBounds(filters);
  const all = <T>(picked: readonly T[], has: ReadonlySet<T>) => picked.every((p) => has.has(p));
  return (f) =>
    (cr === null || (f.cr !== null && f.cr >= cr.min && f.cr <= cr.max)) &&
    (filters.types.length === 0 || (f.type !== null && filters.types.includes(f.type))) &&
    (filters.sizes.length === 0 || f.sizes.some((s) => filters.sizes.includes(s))) &&
    (filters.alignments.length === 0 || (f.alignment !== null && filters.alignments.includes(f.alignment))) &&
    (!filters.legendary || f.legendary) &&
    (!filters.lair || f.lair) &&
    all(filters.movement, f.movement) &&
    all(filters.senses, f.senses) &&
    all(filters.conditionImmunities, f.conditionImmunities) &&
    all(filters.damageImmunities, f.damageImmunities) &&
    all(filters.resistances, f.resistances) &&
    all(filters.vulnerabilities, f.vulnerabilities);
}

/** "fire" to "Fire", "lawful good" to "Lawful Good". */
export function titleWords(text: string): string {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export const MOVEMENT_LABEL: Record<Movement, string> = {
  fly: "Can fly",
  hover: "Can hover",
  swim: "Can swim",
  climb: "Can climb",
  burrow: "Can burrow",
};

export type FilterChip = { key: string; label: string; without: MonsterFilters };

/** Each filter that is on, as a chip that names it and the filters without it, in the order the sheet lists them (MonsterFilters.tsx). */
export function filterChips(filters: MonsterFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.crMin !== null || filters.crMax !== null) {
    let low = filters.crMin;
    let high = filters.crMax;
    if (low !== null && high !== null && (crValue(low) ?? 0) > (crValue(high) ?? 0)) [low, high] = [high, low];
    const label = low === null ? `CR ${high} or lower` : high === null ? `CR ${low} or higher` : low === high ? `CR ${low}` : `CR ${low}–${high}`;
    chips.push({ key: "cr", label, without: { ...filters, crMin: null, crMax: null } });
  }
  const list = <K extends keyof MonsterFilters>(key: K, label: (value: string) => string) => {
    const picked = filters[key] as readonly string[];
    for (const value of picked) {
      chips.push({ key: `${key}:${value}`, label: label(value), without: { ...filters, [key]: picked.filter((p) => p !== value) } });
    }
  };
  list("types", titleWords);
  if (filters.legendary) chips.push({ key: "legendary", label: "Legendary", without: { ...filters, legendary: false } });
  if (filters.lair) chips.push({ key: "lair", label: "Has a lair", without: { ...filters, lair: false } });
  list("sizes", titleWords);
  list("conditionImmunities", (v) => `Immune: ${titleWords(v)}`);
  list("damageImmunities", (v) => `Immune: ${titleWords(v)}`);
  list("resistances", (v) => `Resists: ${titleWords(v)}`);
  list("vulnerabilities", (v) => `Vulnerable: ${titleWords(v)}`);
  list("movement", (v) => MOVEMENT_LABEL[v as Movement]);
  list("senses", titleWords);
  list("alignments", titleWords);
  return chips;
}

/**
 * The chip that takes focus after the one at `removed` goes, with `left`
 * chips remaining: the next one, which slid into its place, else the one
 * before it. Null when none are left, and the Filters button takes it.
 */
export function chipFocusAfter(removed: number, left: number): number | null {
  return left === 0 ? null : Math.min(removed, left - 1);
}

/** The filters sheet's count of what the search and the filters leave. Null while the SRD list loads. */
export function matchesText(count: number | null): string {
  if (count === null) return "Loading…";
  if (count === 0) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}

/** How many filters are on: one for a CR range, one for each value picked, one for each switch. */
export function filterCount(filters: MonsterFilters): number {
  return (
    (filters.crMin !== null || filters.crMax !== null ? 1 : 0) +
    filters.types.length +
    filters.sizes.length +
    filters.alignments.length +
    (filters.legendary ? 1 : 0) +
    (filters.lair ? 1 : 0) +
    filters.movement.length +
    filters.senses.length +
    filters.conditionImmunities.length +
    filters.damageImmunities.length +
    filters.resistances.length +
    filters.vulnerabilities.length
  );
}

/** The list with `value` added or taken out, kept in the options' order so chips stay in a stable order. */
export function toggled<T extends string>(options: readonly T[], picked: readonly T[], value: T): T[] {
  const on = !picked.includes(value);
  return options.filter((o) => (o === value ? on : picked.includes(o)));
}

/** The DM's filters on this device, per room, beside the auto initiative choice. */
export function filtersKey(roomId: string): string {
  return `rvtt.monsterFilters.${roomId}`;
}

export type FilterStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The room's stored filters, or none when storage is blocked. The storage
 * comes through a function, since in some private windows even reading
 * `localStorage` throws.
 */
export function readStoredFilters(storage: () => FilterStorage, roomId: string): MonsterFilters {
  try {
    return decodeFilters(storage().getItem(filtersKey(roomId)));
  } catch {
    return NO_FILTERS;
  }
}

/**
 * Keeps the room's filters, and takes the entry away once none are on.
 * False when storage is blocked, and the filters then last until the page
 * closes.
 */
export function storeFilters(storage: () => FilterStorage, roomId: string, filters: MonsterFilters): boolean {
  try {
    const key = filtersKey(roomId);
    if (filterCount(filters) === 0) storage().removeItem(key);
    else storage().setItem(key, encodeFilters(filters));
    return true;
  } catch {
    return false;
  }
}

export function encodeFilters(filters: MonsterFilters): string {
  return JSON.stringify(filters);
}

/**
 * Stored filters, keeping only values this version knows. A damaged entry,
 * or one from a version with other names, reads as no filters rather than
 * hiding monsters for a reason the DM cannot see.
 */
export function decodeFilters(raw: string | null): MonsterFilters {
  if (raw === null) return NO_FILTERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_FILTERS;
  }
  if (typeof parsed !== "object" || parsed === null) return NO_FILTERS;
  const o = parsed as Record<string, unknown>;
  const pick = <T extends string>(options: readonly T[], value: unknown): T[] => (Array.isArray(value) ? options.filter((x) => value.includes(x)) : []);
  const cr = (value: unknown): CrValue | null => (typeof value === "string" && (CR_VALUES as readonly string[]).includes(value) ? (value as CrValue) : null);
  return {
    crMin: cr(o.crMin),
    crMax: cr(o.crMax),
    types: pick(CREATURE_TYPES, o.types),
    sizes: pick(SIZES, o.sizes),
    alignments: pick(ALIGNMENTS, o.alignments),
    legendary: o.legendary === true,
    lair: o.lair === true,
    movement: pick(MOVEMENTS, o.movement),
    senses: pick(SENSES, o.senses),
    conditionImmunities: pick(CONDITION_KEYS, o.conditionImmunities),
    damageImmunities: pick(DAMAGE_TYPES, o.damageImmunities),
    resistances: pick(DAMAGE_TYPES, o.resistances),
    vulnerabilities: pick(DAMAGE_TYPES, o.vulnerabilities),
  };
}
