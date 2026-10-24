import { LIMITS } from "../limits.ts";
import type { AbilityKey, ClassResource } from "../model.ts";

/**
 * The SRD 5.2.1 class resources a player can add as presets
 * (docs/design-v1-combat-controls.md 7.1 and Appendix A): each class
 * feature with a count of uses that a rest brings back, the class level it
 * starts at, its count by class level, and the rest that brings it back.
 * The app does not know a character's classes, so the player picks the
 * class and its level, and these fill the counts.
 *
 * Left out on purpose: features that only cast a named spell (Favored
 * Enemy, Faithful Steed), Spellcasting itself, and options of other books
 * (Superiority Dice). A player types those as their own.
 */

export const CLASS_IDS = ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const CLASS_NAMES: Record<ClassId, string> = {
  barbarian: "Barbarian",
  bard: "Bard",
  cleric: "Cleric",
  druid: "Druid",
  fighter: "Fighter",
  monk: "Monk",
  paladin: "Paladin",
  ranger: "Ranger",
  rogue: "Rogue",
  sorcerer: "Sorcerer",
  warlock: "Warlock",
  wizard: "Wizard",
};

/** The abilities a count can follow: "a number of times equal to your Wisdom modifier (minimum of once)". */
export type CountAbility = Extract<AbilityKey, "wis" | "cha">;

/**
 * How a preset counts its uses: from its class's table, as `[class level,
 * count]` steps with the first at the level it starts, as a multiple of
 * the class level (Lay on Hands is five times it), or from an ability
 * modifier, at least 1.
 */
export type PresetCount =
  | { by: "table"; steps: readonly (readonly [level: number, count: number])[] }
  | { by: "level"; times: number }
  | { by: "modifier"; ability: CountAbility };

export type ClassPreset = {
  /** The id a resource stores as `preset`, its class first, so the Cleric's and the Paladin's Channel Divinity stay two. */
  id: string;
  classId: ClassId;
  /** The feature's name as SRD 5.2.1 prints it. */
  name: string;
  /** The SRD 5.2.1 subclass the feature belongs to, when it is a subclass's. */
  subclass?: string;
  /** The class level it starts at. */
  unlock: number;
  count: PresetCount;
  reset: ClassResource["reset"];
  /** The class level from which either rest gives every use back (Font of Inspiration). */
  shortFrom?: number;
  /** Its uses are an amount to spend, not a count of uses. */
  pool?: true;
};

const one = (unlock: number, reset: ClassResource["reset"] = "long") => ({ unlock, count: { by: "table", steps: [[unlock, 1]] } as const, reset });

/** Appendix A, in its order: class by class, each feature at the level it starts. */
export const PRESETS: readonly ClassPreset[] = [
  { id: "barbarian-rage", classId: "barbarian", name: "Rage", unlock: 1, count: { by: "table", steps: [[1, 2], [3, 3], [6, 4], [12, 5], [17, 6]] }, reset: "shortOne" },
  { id: "barbarian-intimidating-presence", classId: "barbarian", name: "Intimidating Presence", subclass: "Path of the Berserker", ...one(14) },
  { id: "barbarian-persistent-rage", classId: "barbarian", name: "Persistent Rage", ...one(15) },
  { id: "bard-bardic-inspiration", classId: "bard", name: "Bardic Inspiration", unlock: 1, count: { by: "modifier", ability: "cha" }, reset: "long", shortFrom: 5 },
  { id: "cleric-channel-divinity", classId: "cleric", name: "Channel Divinity", unlock: 2, count: { by: "table", steps: [[2, 2], [6, 3], [18, 4]] }, reset: "shortOne" },
  { id: "cleric-divine-intervention", classId: "cleric", name: "Divine Intervention", ...one(10) },
  { id: "druid-wild-shape", classId: "druid", name: "Wild Shape", unlock: 2, count: { by: "table", steps: [[2, 2], [6, 3], [17, 4]] }, reset: "shortOne" },
  { id: "druid-natural-recovery", classId: "druid", name: "Natural Recovery", subclass: "Circle of the Land", ...one(6) },
  { id: "fighter-second-wind", classId: "fighter", name: "Second Wind", unlock: 1, count: { by: "table", steps: [[1, 2], [4, 3], [10, 4]] }, reset: "shortOne" },
  { id: "fighter-action-surge", classId: "fighter", name: "Action Surge", unlock: 2, count: { by: "table", steps: [[2, 1], [17, 2]] }, reset: "short" },
  { id: "fighter-indomitable", classId: "fighter", name: "Indomitable", unlock: 9, count: { by: "table", steps: [[9, 1], [13, 2], [17, 3]] }, reset: "long" },
  { id: "monk-focus-points", classId: "monk", name: "Focus Points", unlock: 2, count: { by: "level", times: 1 }, reset: "short", pool: true },
  { id: "monk-uncanny-metabolism", classId: "monk", name: "Uncanny Metabolism", ...one(2) },
  { id: "monk-wholeness-of-body", classId: "monk", name: "Wholeness of Body", subclass: "Warrior of the Open Hand", unlock: 6, count: { by: "modifier", ability: "wis" }, reset: "long" },
  { id: "paladin-lay-on-hands", classId: "paladin", name: "Lay on Hands", unlock: 1, count: { by: "level", times: 5 }, reset: "long", pool: true },
  { id: "paladin-channel-divinity", classId: "paladin", name: "Channel Divinity", unlock: 3, count: { by: "table", steps: [[3, 2], [11, 3]] }, reset: "shortOne" },
  { id: "paladin-holy-nimbus", classId: "paladin", name: "Holy Nimbus", subclass: "Oath of Devotion", ...one(20) },
  { id: "ranger-tireless", classId: "ranger", name: "Tireless", unlock: 10, count: { by: "modifier", ability: "wis" }, reset: "long" },
  { id: "ranger-natures-veil", classId: "ranger", name: "Nature’s Veil", unlock: 14, count: { by: "modifier", ability: "wis" }, reset: "long" },
  { id: "rogue-stroke-of-luck", classId: "rogue", name: "Stroke of Luck", ...one(20, "short") },
  { id: "sorcerer-innate-sorcery", classId: "sorcerer", name: "Innate Sorcery", unlock: 1, count: { by: "table", steps: [[1, 2]] }, reset: "long" },
  { id: "sorcerer-sorcery-points", classId: "sorcerer", name: "Sorcery Points", unlock: 2, count: { by: "level", times: 1 }, reset: "long", pool: true },
  { id: "sorcerer-sorcerous-restoration", classId: "sorcerer", name: "Sorcerous Restoration", ...one(5) },
  { id: "sorcerer-dragon-wings", classId: "sorcerer", name: "Dragon Wings", subclass: "Draconic Sorcery", ...one(14) },
  { id: "warlock-magical-cunning", classId: "warlock", name: "Magical Cunning", ...one(2) },
  { id: "warlock-dark-ones-own-luck", classId: "warlock", name: "Dark One’s Own Luck", subclass: "Fiend Patron", unlock: 6, count: { by: "modifier", ability: "cha" }, reset: "long" },
  { id: "warlock-hurl-through-hell", classId: "warlock", name: "Hurl Through Hell", subclass: "Fiend Patron", ...one(14) },
  { id: "wizard-arcane-recovery", classId: "wizard", name: "Arcane Recovery", ...one(1) },
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function presetById(id: string | undefined): ClassPreset | undefined {
  return id === undefined ? undefined : BY_ID.get(id);
}

/** A class's presets in Appendix A's order. */
export function classPresets(classId: ClassId): ClassPreset[] {
  return PRESETS.filter((p) => p.classId === classId);
}

/** The presets a class has at a class level. */
export function presetsAt(classId: ClassId, classLevel: number): ClassPreset[] {
  return classPresets(classId).filter((p) => classLevel >= p.unlock);
}

/**
 * A preset's count at a class level: null below the level it starts at,
 * and for a count from a modifier that is not known. A modifier count is
 * at least 1, and a count never passes what a resource may hold.
 */
export function presetCount(preset: ClassPreset, classLevel: number, modifier?: number | null): number | null {
  if (classLevel < preset.unlock) return null;
  const { count } = preset;
  if (count.by === "level") return Math.min(LIMITS.resourcePoolMax, count.times * classLevel);
  if (count.by === "modifier") return modifier === undefined || modifier === null ? null : Math.min(LIMITS.resourceMax, Math.max(1, modifier));
  let n = 0;
  for (const [level, steps] of count.steps) if (classLevel >= level) n = steps;
  return n;
}

/** The rest that brings a preset back at a class level. */
export function presetReset(preset: ClassPreset, classLevel: number): ClassResource["reset"] {
  return preset.shortFrom !== undefined && classLevel >= preset.shortFrom ? "short" : preset.reset;
}

/** A class resource as character.update sends it: no `used`, which the reducer keeps by id. */
export type ResourceInput = Omit<ClassResource, "used">;

/** What the stored list sends back unchanged: every resource but its `used`. */
export function asInputs(resources: readonly ClassResource[] | undefined): ResourceInput[] {
  return (resources ?? []).map(({ used: _used, ...rest }) => rest);
}

/**
 * A new resource from a preset at a class level, or null where the preset
 * has no count there. `characterLevel` is stored as `atLevel`, so a later
 * rise of the character's level can offer an update.
 */
export function fromPreset(preset: ClassPreset, input: { id: string; classLevel: number; characterLevel?: number; modifier?: number | null }): ResourceInput | null {
  const max = presetCount(preset, input.classLevel, input.modifier);
  if (max === null) return null;
  return {
    id: input.id,
    name: preset.name,
    max,
    reset: presetReset(preset, input.classLevel),
    ...(preset.pool ? { pool: true as const } : {}),
    preset: preset.id,
    level: input.classLevel,
    ...(input.characterLevel !== undefined ? { atLevel: input.characterLevel } : {}),
  };
}

/** A class whose presets were added at a lower character level than the character has now (7.1). */
export type LevelUp = {
  classId: ClassId;
  /** The class level the presets' counts were read at. */
  classLevel: number;
  /** That level plus the character's rise since, at most 20: the new class level's first guess. */
  guess: number;
};

/**
 * The classes to offer an update for, in the order their presets were
 * added: each with a preset whose `atLevel` the character's level has
 * passed. A multiclass character's rise may belong to another class, so
 * this only asks. A preset added with no character level never asks.
 */
export function levelUps(resources: readonly ClassResource[] | undefined, characterLevel: number | undefined): LevelUp[] {
  if (characterLevel === undefined) return [];
  const out: LevelUp[] = [];
  for (const r of resources ?? []) {
    const preset = presetById(r.preset);
    if (!preset || r.atLevel === undefined || r.atLevel >= characterLevel || r.level === undefined) continue;
    const guess = Math.min(20, r.level + characterLevel - r.atLevel);
    const known = out.find((u) => u.classId === preset.classId);
    if (!known) out.push({ classId: preset.classId, classLevel: r.level, guess });
    else if (r.level > known.classLevel || (r.level === known.classLevel && guess > known.guess)) Object.assign(known, { classLevel: r.level, guess });
  }
  return out;
}

/**
 * A class's presets read again at a new class level (7.1's Update): each
 * count from the new level, but one typed by hand (`edited`), and a
 * modifier count only where its modifier is known. The rest follows the
 * level where it was the preset's own (Bardic Inspiration from 5), and a
 * rest chosen by hand stays. Every one of the class's presets takes the
 * new class level and the character's level, so the update is asked once.
 * `add` goes at the end, as new resources do.
 */
export function updateClass(
  resources: readonly ClassResource[] | undefined,
  input: { classId: ClassId; classLevel: number; characterLevel: number; modifiers: Partial<Record<CountAbility, number>>; add?: readonly ResourceInput[] },
): ResourceInput[] {
  const out = asInputs(resources).map((r): ResourceInput => {
    const preset = presetById(r.preset);
    if (!preset || preset.classId !== input.classId) return r;
    const modifier = preset.count.by === "modifier" ? input.modifiers[preset.count.ability] : undefined;
    const count = r.edited ? null : presetCount(preset, input.classLevel, modifier);
    const ownReset = r.level === undefined || r.reset === presetReset(preset, r.level);
    return {
      ...r,
      max: count ?? r.max,
      reset: ownReset ? presetReset(preset, input.classLevel) : r.reset,
      level: input.classLevel,
      atLevel: input.characterLevel,
    };
  });
  return [...out, ...(input.add ?? [])];
}
