import { ddbCharacterId } from "../ddb/link.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type Actor, type Character, type DdbBase, type DdbSync, type PcRoll, type PcStats, type SkillKey } from "../model.ts";
import { expectOf } from "../permissions.ts";
import { hash128, stableStringify } from "../project.ts";
import { MAX_PC_ROLLS, type ActorPatch, type CharacterExpect, type CharacterPatch, type DdbSyncPatch, type ExpectPart, type PcStatsPatch } from "../protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "./damage.ts";
import type { PcFill } from "./pcFill.ts";
import { applyPcStatsPatch, EMPTY_PC_STATS, pcDerived } from "./pcStats.ts";

/**
 * A D&D Beyond sync merged three ways (docs/design-v1-resync.md 2): the
 * record's base `b`, the character now `c` and D&D Beyond now `n`, per
 * field and per roll. What only D&D Beyond changed comes in, what the
 * player changed is kept with an offer to overwrite it, and a field or
 * roll D&D Beyond did not read is left alone. Pure functions over plain
 * data, so the dialog, the editor and a randomized test run the same rule.
 * The words are the client's (client/features/pcstats/resync.ts).
 *
 * `planSync` lists every item with its default, ticks change only the
 * items they name (`syncResult`), and `syncPatch` and `undoSync` turn a
 * result into the one op Apply sends and the one Undo sends.
 */

/** The groups of Changes and Different, in their order (3.3). */
export const SYNC_GROUPS = ["Ability scores", "Saves and skills", "Bonuses", "Spellcasting", "Features", "Defenses", "Rolls"] as const;
export type SyncGroup = (typeof SYNC_GROUPS)[number];

const ADJUST_FIELDS = ["allSaves", "allChecks", "init", "passive", "spellDc", "spellAttack"] as const;
type AdjustField = (typeof ADJUST_FIELDS)[number];

/** One field of the block a sync compares (2.3), or one of the five beside it. */
export type FieldKey =
  | `abilities.${AbilityKey}`
  | `saves.${AbilityKey}`
  | `skills.${SkillKey}`
  | `adjust.saves.${AbilityKey}`
  | `adjust.skills.${SkillKey}`
  | `adjust.${AdjustField}`
  | `defenses.${DamageType}`
  | "spellAbility"
  | "jack"
  | "alert"
  | "evasion"
  | "critOn"
  | ActorField;

/** The five fields beside the block that keep their tick (2.2). */
export type ActorField = "level" | "ac" | "hpMax" | "speeds" | "senses";

/** The lines of Also set (3.3), the five ticked fields, the sheet link and the name. */
export type AlsoKey = ActorField | "sheetUrl" | "name";

/**
 * A field's value as a sync compares it: a score, proficient or not, a
 * skill's "prof", "expert" or null, a bonus (0 for none), a defense or
 * null, a spellcasting ability or null, a flag, the critical range's
 * lowest number (20 for none), the level, AC, max HP, speeds or senses.
 */
export type FieldValue = number | boolean | string | null | Actor["speeds"] | undefined;

/** Where the merge stands with the record (1.3): no block yet, no record, a record of another number, or the same source. */
export type SyncSource = "first" | "none" | "relinked" | "same";

/** What a sync does with a roll (2.4), named by its row. */
export type RollCase =
  /** D&D Beyond has a roll the block lacks: it comes in. */
  | "add"
  /** Changed there and untouched here: updated in place. */
  | "update"
  /** Removed there and untouched here: it goes. */
  | "remove"
  /** Edited here, the same there: kept, with Overwrite. */
  | "edited"
  /** Edited here and changed there to something else: kept, tagged, with Overwrite. */
  | "conflict"
  /** Edited here and removed there: kept as the player's own, with Remove it. */
  | "goneThere"
  /** Removed here, still there: stays removed, with Add it back. */
  | "deleted"
  /** The player's own roll of the same name, unlike D&D Beyond's: linked, kept or taken by its section. */
  | "sameName";

/** A read roll with what finds it again (2.1): its key and its content's hash. */
export type ReadRoll = { roll: PcRoll; k: string; h: string };

export type SyncSection = "changes" | "kept" | "different" | "replaces";

export type FieldItem = {
  type: "field";
  id: string;
  key: FieldKey;
  group: SyncGroup;
  section: SyncSection;
  /** The record's value, when it has one. */
  base?: FieldValue;
  now: FieldValue;
  theirs: FieldValue;
  /** Changed here and in D&D Beyond, to different values. */
  conflict: boolean;
};

export type RollItem = {
  type: "roll";
  id: string;
  group: "Rolls";
  section: SyncSection;
  case: RollCase;
  /** The block's roll, absent for one D&D Beyond adds or one the player removed. */
  mine?: PcRoll;
  /** D&D Beyond's, absent for one it removed. */
  theirs?: ReadRoll;
  conflict: boolean;
};

export type SyncItem = FieldItem | RollItem;

export type AlsoItem = {
  type: "also";
  id: `also:${AlsoKey}`;
  key: AlsoKey;
  now: FieldValue;
  theirs: FieldValue;
  /** Ticked until the player unticks it. The name alone starts unticked. */
  on: boolean;
};

/** What a sync works from (2.2): the block and level it merges into, the character beside them, and the read. */
export type SyncInput = {
  /** "resync" for the dialog, "editor" for the stat block editor's D&D Beyond step, which fills where the dialog keeps. */
  mode: "resync" | "editor";
  /** The block merged into: the character's, or the editor's draft. Undefined with no block, a first sync. */
  stats: PcStats | undefined;
  level: number | undefined;
  /** The character as the merge sees it. In the editor, a record from an earlier fill before Save has no `at` yet. */
  character: Pick<Character, "name" | "actor"> & { ddbSync?: DdbSyncPatch };
  fill: PcFill;
};

export type SyncPlan = {
  input: SyncInput;
  source: SyncSource;
  /** The D&D Beyond number read, or the record's when the read names none. */
  from: string | undefined;
  /** Changes, Kept, Different and Replaces, in the review's order within each. */
  items: SyncItem[];
  also: AlsoItem[];
  /** The player's own rolls a sync keeps and never records. */
  ownRolls: number;
  /** In a shape, so AC and Speed are not read (2.3). */
  shaped: "wild" | "other" | null;
  /** The losses warning's facts (3.3), or null. */
  losses: SyncLosses | null;
  /** How the rolls stand, for syncResult. */
  rolls: RollPlan;
};

export type SyncLosses = { level?: { from: number; to: number }; spellAbility?: true; proficiencies?: number; defenses?: number; rolls?: number };

type RollSlot = { roll: PcRoll; entry?: { k: string; h: string }; item?: RollItem };

type RollPlan = {
  /** The block's rolls in order, each with its entry after the sync and its item when it has one. */
  slots: RollSlot[];
  /** Rolls D&D Beyond adds and those the player removed, in the read's order. */
  extra: RollItem[];
  /** Entries for rolls the block no longer holds, of a kind not read whole: kept as they were. */
  orphans: [string, { k: string; h: string }][];
  /** The removed markers that stay, oldest first, before this sync's new ones. */
  gone: string[];
  /** The player's own rolls D&D Beyond has too, left unlinked since the record had no room for them. */
  unlinked: PcRoll[];
};

export type SyncResult = {
  stats: PcStats;
  level: number | undefined;
  /** The fields beside the block the sync sets, as ticked. */
  also: { level?: number; name?: string; ac?: number; hpMax?: number; speeds?: Actor["speeds"]; senses?: string; sheetUrl?: string };
  record: DdbSyncPatch;
  /** The done line's counts (3.4). */
  counts: { cameIn: number; removed: number; cameBack: number; stayed: number };
  /** D&D Beyond's rolls left out for room (2.4). */
  notFit: number;
  /** The removed markers the 40 cap drops (2.1), each `k`, with the name this read gives it if any. */
  goneDropped: { k: string; name?: string }[];
  /** A proficiency coming in beside a kept bonus on the same save or skill (3.3). */
  besideBonus: { on: { save: AbilityKey } | { skill: SkillKey }; bonus: number; total: number }[];
};

/** The first 12 hex digits of `hash128`, as every hash of the record is (2.1). */
export function hash12(text: string): string {
  return hash128(text).slice(0, 12);
}

const KIND_LETTER: Record<PcRoll["kind"], "w" | "s" | "o"> = { weapon: "w", spell: "s", other: "o" };
const LETTER_KIND = { w: "weapon", s: "spell", o: "other" } as const;

/** "w:longsword", "s:fireball:3": a roll's key before the count that tells two alike apart. */
export function rollKeyText(roll: Pick<PcRoll, "kind" | "name" | "level">): string {
  const name = roll.name.toLowerCase().replace(/\s+/g, " ").trim();
  return roll.kind === "spell" ? `s:${name}:${roll.level ?? 0}` : `${KIND_LETTER[roll.kind]}:${name}`;
}

/** Each roll's `k`, in order: the second of two alike is "#2", the third "#3". */
export function rollKeys(rolls: readonly Pick<PcRoll, "kind" | "name" | "level">[]): string[] {
  const seen = new Map<string, number>();
  return rolls.map((roll) => {
    const text = rollKeyText(roll);
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return `${KIND_LETTER[roll.kind]}:${hash12(n === 1 ? text : `${text}#${n}`)}`;
  });
}

/** A roll's content as `h` hashes it (2.1): all but its id, its `ddb` mark and what a pass takes, which is the player's to set. */
export function rollHash(roll: PcRoll): string {
  const { id: _id, ddb: _ddb, ...rest } = roll;
  if (rest.save?.onPass !== undefined) {
    const { onPass: _onPass, ...save } = rest.save;
    rest.save = save;
  }
  return hash12(stableStringify(rest));
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/* The fields of the block, each with how a block, a base and a fill hold it. */

type Unit = {
  key: FieldKey;
  group: SyncGroup;
  /** D&D Beyond's value, or undefined when the fill left its part out. */
  read(fill: PcFill): FieldValue;
  /** The base's value, or undefined when the base has none for it. */
  base(base: DdbBase): FieldValue;
  now(stats: PcStats): FieldValue;
  put(stats: PcStats, value: FieldValue): PcStats;
};

function adjustOf(adjust: PcStats["adjust"] | undefined, path: readonly string[]): number {
  let at: unknown = adjust;
  for (const step of path) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[step] : undefined;
  return typeof at === "number" ? at : 0;
}

function withAdjust(stats: PcStats, path: readonly [string] | readonly [string, string], value: number): PcStats {
  const adjust: Record<string, unknown> = { ...stats.adjust };
  if (path.length === 1) {
    if (value === 0) delete adjust[path[0]];
    else adjust[path[0]] = value;
  } else {
    const map: Record<string, number> = { ...((adjust[path[0]] as Record<string, number> | undefined) ?? {}) };
    if (value === 0) delete map[path[1]];
    else map[path[1]] = value;
    if (Object.keys(map).length === 0) delete adjust[path[0]];
    else adjust[path[0]] = map;
  }
  return { ...stats, adjust: adjust as PcStats["adjust"] };
}

function flagUnit(key: "jack" | "alert" | "evasion"): Unit {
  return {
    key,
    group: "Features",
    read: (fill) => fill.stats[key],
    base: (base) => base[key],
    now: (stats) => stats[key] === true,
    put: (stats, value) => {
      const next = { ...stats };
      if (value === true) next[key] = true;
      else delete next[key];
      return next;
    },
  };
}

const UNITS: readonly Unit[] = [
  ...ABILITY_KEYS.map(
    (a): Unit => ({
      key: `abilities.${a}`,
      group: "Ability scores",
      read: (fill) => fill.stats.abilities?.[a],
      base: (base) => base.abilities?.[a],
      now: (stats) => stats.abilities[a],
      put: (stats, value) => ({ ...stats, abilities: { ...stats.abilities, [a]: value as number } }),
    }),
  ),
  ...ABILITY_KEYS.map(
    (a): Unit => ({
      key: `saves.${a}`,
      group: "Saves and skills",
      read: (fill) => (fill.stats.saves ? fill.stats.saves.includes(a) : undefined),
      base: (base) => (base.saves ? base.saves.includes(a) : undefined),
      now: (stats) => stats.saves.includes(a),
      // Written in ABILITY_KEYS order, so saves that compare as one set read as one list (2.2).
      put: (stats, value) => ({ ...stats, saves: ABILITY_KEYS.filter((k) => (k === a ? value === true : stats.saves.includes(k))) }),
    }),
  ),
  ...SKILL_KEYS.map(
    (s): Unit => ({
      key: `skills.${s}`,
      group: "Saves and skills",
      read: (fill) => (fill.stats.skills ? (fill.stats.skills[s] ?? null) : undefined),
      base: (base) => (base.skills ? (base.skills[s] ?? null) : undefined),
      now: (stats) => stats.skills[s] ?? null,
      put: (stats, value) => {
        const skills = { ...stats.skills };
        if (value === "prof" || value === "expert") skills[s] = value;
        else delete skills[s];
        return { ...stats, skills };
      },
    }),
  ),
  ...ABILITY_KEYS.map(
    (a): Unit => ({
      key: `adjust.saves.${a}`,
      group: "Bonuses",
      read: (fill) => (fill.stats.adjust ? adjustOf(fill.stats.adjust, ["saves", a]) : undefined),
      base: (base) => (base.adjust ? adjustOf(base.adjust, ["saves", a]) : undefined),
      now: (stats) => adjustOf(stats.adjust, ["saves", a]),
      put: (stats, value) => withAdjust(stats, ["saves", a], value as number),
    }),
  ),
  ...SKILL_KEYS.map(
    (s): Unit => ({
      key: `adjust.skills.${s}`,
      group: "Bonuses",
      read: (fill) => (fill.stats.adjust ? adjustOf(fill.stats.adjust, ["skills", s]) : undefined),
      base: (base) => (base.adjust ? adjustOf(base.adjust, ["skills", s]) : undefined),
      now: (stats) => adjustOf(stats.adjust, ["skills", s]),
      put: (stats, value) => withAdjust(stats, ["skills", s], value as number),
    }),
  ),
  ...ADJUST_FIELDS.map(
    (f): Unit => ({
      key: `adjust.${f}`,
      group: "Bonuses",
      read: (fill) => (fill.stats.adjust ? adjustOf(fill.stats.adjust, [f]) : undefined),
      base: (base) => (base.adjust ? adjustOf(base.adjust, [f]) : undefined),
      now: (stats) => adjustOf(stats.adjust, [f]),
      put: (stats, value) => withAdjust(stats, [f], value as number),
    }),
  ),
  {
    key: "spellAbility",
    group: "Spellcasting",
    read: (fill) => fill.stats.spellAbility,
    base: (base) => base.spellAbility,
    now: (stats) => stats.spellAbility ?? null,
    put: (stats, value) => {
      const next = { ...stats };
      if (value === null) delete next.spellAbility;
      else next.spellAbility = value as AbilityKey;
      return next;
    },
  },
  flagUnit("jack"),
  flagUnit("alert"),
  flagUnit("evasion"),
  {
    key: "critOn",
    group: "Features",
    read: (fill) => (fill.stats.critOn === undefined ? undefined : (fill.stats.critOn ?? 20)),
    base: (base) => (base.critOn === undefined ? undefined : (base.critOn ?? 20)),
    now: (stats) => stats.critOn ?? 20,
    put: (stats, value) => {
      const next = { ...stats };
      if (value === 19 || value === 18) next.critOn = value;
      else delete next.critOn;
      return next;
    },
  },
  ...DAMAGE_TYPES.map(
    (t): Unit => ({
      key: `defenses.${t}`,
      group: "Defenses",
      read: (fill) => (fill.stats.defenses ? (fill.stats.defenses[t] ?? null) : undefined),
      base: (base) => (base.defenses ? (base.defenses[t] ?? null) : undefined),
      now: (stats) => stats.defenses[t] ?? null,
      put: (stats, value) => {
        const defenses = { ...stats.defenses };
        if (value === "resistant" || value === "immune" || value === "vulnerable") defenses[t] = value;
        else delete defenses[t];
        return { ...stats, defenses };
      },
    }),
  ),
];

const UNIT_BY_KEY = new Map(UNITS.map((u) => [u.key, u]));

/** Every field of the block a sync compares, in the review's order. */
export const SYNC_FIELD_KEYS: readonly FieldKey[] = UNITS.map((u) => u.key);

/** A block field's value as a sync compares it. */
export function fieldOf(stats: PcStats, key: FieldKey): FieldValue {
  return UNIT_BY_KEY.get(key)?.now(stats);
}

/** The block with one field set, as a sync writes it. */
export function withField(stats: PcStats, key: FieldKey, value: FieldValue): PcStats {
  const unit = UNIT_BY_KEY.get(key);
  return unit ? unit.put(stats, value) : stats;
}

/* The five fields beside the block. */

type ActorRead = { now: FieldValue; theirs: FieldValue; base: FieldValue; read: boolean };

function speedsWithout(speeds: Actor["speeds"]): Actor["speeds"] {
  const out: Actor["speeds"] = { walk: speeds.walk };
  for (const kind of ["fly", "swim", "climb", "burrow"] as const) if (speeds[kind]) out[kind] = speeds[kind];
  return out;
}

/** Senses as a sync compares them: trimmed, without the closing full stop, so "Darkvision 60 ft." and "Darkvision 60 ft" are one value. */
export function sensesWords(senses: string): string {
  return senses.trim().replace(/\.$/, "");
}

function sameActorValue(key: ActorField, a: FieldValue, b: FieldValue): boolean {
  if (key === "speeds" && a && b && typeof a === "object" && typeof b === "object") return same(speedsWithout(a), speedsWithout(b));
  if (key === "senses" && typeof a === "string" && typeof b === "string") return sensesWords(a) === sensesWords(b);
  return same(a, b);
}

function actorRead(input: SyncInput, key: ActorField, base: DdbBase | undefined): ActorRead {
  const actor = input.character.actor;
  const fill = input.fill;
  // In a shape the AC and speeds are the creature's, and End the shape puts the character's back, so neither is read (W7B-P-9).
  const shaped = actor.srdId !== undefined;
  switch (key) {
    case "level":
      return { now: input.level, theirs: fill.level, base: base?.level, read: fill.level !== undefined };
    case "ac":
      return { now: actor.ac, theirs: fill.actor.ac, base: base?.ac, read: !shaped && fill.actor.ac !== undefined };
    case "hpMax":
      return { now: actor.hp.max, theirs: fill.actor.hpMax, base: base?.hpMax, read: fill.actor.hpMax !== undefined };
    case "speeds":
      return { now: actor.speeds, theirs: fill.actor.speeds, base: base?.speeds, read: !shaped && fill.actor.speeds !== undefined };
    case "senses":
      return { now: actor.senses, theirs: fill.actor.senses, base: base?.senses, read: fill.actor.senses !== undefined };
  }
}

const ACTOR_FIELDS: readonly ActorField[] = ["level", "ac", "hpMax", "speeds", "senses"];

/** The D&D Beyond number a fill read, from its sheet link. */
export function fillNumber(fill: PcFill): string | undefined {
  return fill.actor.sheetUrl ? (ddbCharacterId(fill.actor.sheetUrl) ?? undefined) : undefined;
}

function readWhole(fill: PcFill, letter: string): boolean {
  const kind = LETTER_KIND[letter as keyof typeof LETTER_KIND];
  return kind !== undefined && (fill.read?.[kind] ?? true);
}

function letterOf(k: string): string {
  return k.slice(0, 1);
}

/**
 * Every item of a sync with its default (2.2 to 2.4): what comes in, what
 * is kept with its offer, and the Also set lines, against the block and
 * character as they are now. A live change makes a new plan, whose ids
 * match the old one's where its items remain, so ticks carry over.
 */
export function planSync(input: SyncInput): SyncPlan {
  const { fill, character } = input;
  const record = character.ddbSync;
  const read = fillNumber(fill);
  const source: SyncSource = input.stats === undefined ? "first" : !record ? "none" : record.from !== undefined && read !== undefined && record.from !== read ? "relinked" : "same";
  const base = source === "same" ? record?.base : undefined;
  const stats = input.stats ?? (EMPTY_PC_STATS as PcStats);
  // Without a record to tell changes apart, the dialog keeps what differs and the editor fills, as an import does (2.2).
  const noBase: SyncSection = input.mode === "editor" && source !== "same" ? "replaces" : "different";
  const items: SyncItem[] = [];

  for (const unit of UNITS) {
    const theirs = unit.read(fill);
    if (theirs === undefined) continue;
    const now = unit.now(stats);
    const id = `field:${unit.key}`;
    if (source === "first") {
      if (!same(theirs, unit.now(EMPTY_PC_STATS as PcStats))) items.push({ type: "field", id, key: unit.key, group: unit.group, section: "changes", now, theirs, conflict: false });
      continue;
    }
    const b = base ? unit.base(base) : undefined;
    if (b === undefined) {
      if (!same(now, theirs)) items.push({ type: "field", id, key: unit.key, group: unit.group, section: noBase, now, theirs, conflict: false });
      continue;
    }
    const mine = !same(now, b);
    const there = !same(theirs, b);
    if (!mine && there) items.push({ type: "field", id, key: unit.key, group: unit.group, section: "changes", base: b, now, theirs, conflict: false });
    else if (mine && !same(theirs, now)) items.push({ type: "field", id, key: unit.key, group: unit.group, section: "kept", base: b, now, theirs, conflict: there });
  }

  const also: AlsoItem[] = [];
  for (const key of ACTOR_FIELDS) {
    const f = actorRead(input, key, base);
    if (!f.read || sameActorValue(key, f.now, f.theirs)) continue;
    // A kept one follows the three ways. Otherwise its line is in Also set, ticked, with a record or without (2.2).
    if (f.base !== undefined && !sameActorValue(key, f.now, f.base)) {
      items.push({ type: "field", id: `field:${key}`, key, group: "Features", section: "kept", base: f.base, now: f.now, theirs: f.theirs, conflict: !sameActorValue(key, f.theirs, f.base) });
    } else also.push({ type: "also", id: `also:${key}`, key, now: f.now, theirs: f.theirs, on: true });
  }
  const link = fill.actor.sheetUrl;
  const linkNow = character.actor.sheetUrl;
  if (link !== undefined && link !== linkNow) {
    // A sheet link the player chose stays theirs, unless it names another D&D Beyond character than the one read, so the next re-sync fetches this one.
    const other = linkNow !== undefined && read !== undefined && ddbCharacterId(linkNow) !== null && ddbCharacterId(linkNow) !== read;
    if (linkNow === undefined || other) also.push({ type: "also", id: "also:sheetUrl", key: "sheetUrl", now: linkNow, theirs: link, on: true });
  }
  if (fill.name !== undefined && fill.name !== character.name) also.push({ type: "also", id: "also:name", key: "name", now: character.name, theirs: fill.name, on: false });

  const rolls = planRolls(input, source, noBase);
  const rollItems = [...rolls.slots.flatMap((s) => (s.item ? [s.item] : [])), ...rolls.extra];
  const own = rolls.slots.filter((s) => !s.entry && !s.item).length;

  const ordered = [
    ...sectionItems(items, rollItems, "changes"),
    ...sectionItems(items, rollItems, "kept").sort((a, b) => Number(b.conflict) - Number(a.conflict)),
    ...sectionItems(items, rollItems, "different"),
    ...sectionItems(items, rollItems, "replaces"),
  ];
  const shape = character.actor.srdId === undefined ? null : character.actor.wildShape ? "wild" : "other";
  return {
    input,
    source,
    from: read ?? record?.from,
    items: ordered,
    also,
    ownRolls: own,
    shaped: shape,
    losses: lossesOf(input, source, base, rolls),
    rolls,
  };
}

function sectionItems(fields: readonly SyncItem[], rolls: readonly RollItem[], section: SyncSection): SyncItem[] {
  const out: SyncItem[] = [];
  for (const group of SYNC_GROUPS) {
    for (const item of fields) if (item.section === section && item.group === group) out.push(item);
    if (group === "Rolls") for (const item of rolls) if (item.section === section) out.push(item);
  }
  return out;
}

/**
 * How each roll stands (2.4). With a record, an entry links a block roll
 * by its id, and a `ddb` roll with none is the player's own. Without one,
 * a `ddb` roll counts as linked and untouched, found by its key, so a
 * first re-sync replaces an old import's rolls as the import did. Then a
 * read roll nothing claimed meets the player's own of the same key, and
 * whatever is left of the read comes in.
 */
function planRolls(input: SyncInput, source: SyncSource, noBase: SyncSection): RollPlan {
  const { fill } = input;
  const keys = rollKeys(fill.stats.rolls);
  const reads: ReadRoll[] = fill.stats.rolls.map((roll, i) => ({ roll, k: keys[i]!, h: rollHash(roll) }));
  const byK = new Map(reads.map((r) => [r.k, r]));
  const claimed = new Set<string>();
  const block = input.stats?.rolls ?? [];
  const record = source === "same" ? input.character.ddbSync : undefined;
  const slots: RollSlot[] = block.map((roll) => ({ roll }));
  const linked = new Map<number, { k: string; h: string }>();

  if (record) {
    const ids = new Map(block.map((roll, i) => [hash12(roll.id), i]));
    for (const [idHash, entry] of Object.entries(record.rolls)) {
      const i = ids.get(idHash);
      if (i !== undefined && !linked.has(i)) linked.set(i, entry);
    }
  } else if (source !== "first") {
    const imported = block.map((roll, i) => ({ roll, i })).filter((x) => x.roll.ddb === true);
    const importedKeys = rollKeys(imported.map((x) => x.roll));
    imported.forEach((x, j) => linked.set(x.i, { k: importedKeys[j]!, h: rollHash(x.roll) }));
  }

  const kSeen = new Set<string>();
  for (const [i, entry] of [...linked].sort((a, b) => a[0] - b[0])) {
    const slot = slots[i]!;
    // Two entries with one key would claim one read roll twice: the later is the player's own.
    if (kSeen.has(entry.k)) continue;
    kSeen.add(entry.k);
    const theirs = byK.get(entry.k);
    const content = rollHash(slot.roll);
    const touched = content !== entry.h;
    if (theirs) {
      claimed.add(theirs.k);
      slot.entry = { k: theirs.k, h: theirs.h };
      const id = `roll:${theirs.k}`;
      if (!touched && theirs.h !== entry.h) slot.item = { type: "roll", id, group: "Rolls", section: "changes", case: "update", mine: slot.roll, theirs, conflict: false };
      else if (touched && theirs.h === entry.h) slot.item = { type: "roll", id, group: "Rolls", section: "kept", case: "edited", mine: slot.roll, theirs, conflict: false };
      else if (touched && theirs.h !== content) slot.item = { type: "roll", id, group: "Rolls", section: "kept", case: "conflict", mine: slot.roll, theirs, conflict: true };
    } else if (readWhole(fill, letterOf(entry.k))) {
      const id = `roll:${entry.k}`;
      slot.item = touched
        ? { type: "roll", id, group: "Rolls", section: "kept", case: "goneThere", mine: slot.roll, conflict: false }
        : { type: "roll", id, group: "Rolls", section: "changes", case: "remove", mine: slot.roll, conflict: false };
    } else slot.entry = entry;
  }

  const extra: RollItem[] = [];
  const orphans: [string, { k: string; h: string }][] = [];
  let gone: string[] = [];
  if (record) {
    const held = new Set(block.map((roll) => hash12(roll.id)));
    const deleted = (k: string) => {
      const theirs = byK.get(k);
      if (!theirs || claimed.has(k)) return;
      claimed.add(k);
      extra.push({ type: "roll", id: `roll:${k}`, group: "Rolls", section: "kept", case: "deleted", theirs, conflict: false });
    };
    for (const [idHash, entry] of Object.entries(record.rolls)) {
      if (held.has(idHash)) continue;
      if (byK.has(entry.k)) deleted(entry.k);
      else if (!readWhole(fill, letterOf(entry.k))) orphans.push([idHash, entry]);
    }
    // A marker leaves only once its kind was read whole without it (2.4).
    for (const k of record.gone ?? []) {
      if (byK.has(k)) deleted(k);
      else if (readWhole(fill, letterOf(k))) continue;
      if (!gone.includes(k)) gone.push(k);
    }
    // Every newly removed roll joins the end, after the markers already held.
    gone = [...gone, ...extra.filter((x) => x.case === "deleted" && !gone.includes(x.theirs!.k)).map((x) => x.theirs!.k)];
  }

  /*
   * The record holds at most 40 entries. Those the sync keeps and the
   * orphans come first, so linking one of the player's own rolls takes only
   * the room left, and one that does not fit stays the player's own, its
   * read roll claimed so it never comes in beside it.
   */
  let room = MAX_PC_ROLLS - slots.filter((s) => s.entry).length - orphans.length;
  const unlinked: PcRoll[] = [];
  // The player's own rolls, in order, meet what is left of the read by key alone, so two of one name pair up in order.
  const ownBy = new Map<string, RollSlot[]>();
  for (const slot of slots) {
    if (slot.entry || slot.item) continue;
    const text = rollKeyText(slot.roll);
    ownBy.set(text, [...(ownBy.get(text) ?? []), slot]);
  }
  for (const theirs of reads) {
    if (claimed.has(theirs.k)) continue;
    const match = ownBy.get(rollKeyText(theirs.roll))?.shift();
    if (match) {
      claimed.add(theirs.k);
      if (room <= 0) {
        unlinked.push(match.roll);
        continue;
      }
      room--;
      match.entry = { k: theirs.k, h: theirs.h };
      if (rollHash(match.roll) !== theirs.h) match.item = { type: "roll", id: `roll:${theirs.k}`, group: "Rolls", section: source === "first" ? "changes" : noBase, case: "sameName", mine: match.roll, theirs, conflict: false };
      continue;
    }
    extra.push({ type: "roll", id: `roll:${theirs.k}`, group: "Rolls", section: "changes", case: "add", theirs, conflict: false });
  }
  // Additions and removed rolls in the read's order, as they would come in.
  const order = new Map(reads.map((r, i) => [r.k, i]));
  extra.sort((a, b) => order.get(a.theirs!.k)! - order.get(b.theirs!.k)!);
  return { slots, extra, orphans, gone, unlinked };
}

/** D&D Beyond's roll where the block's was, keeping its id, and what a pass takes while it still has a save (2.4). */
function takenRoll(mine: PcRoll, theirs: PcRoll): PcRoll {
  const out: PcRoll = { ...theirs, id: mine.id, ddb: true };
  if (theirs.save && theirs.save.onPass === undefined && mine.save?.onPass !== undefined) out.save = { ...theirs.save, onPass: mine.save.onPass };
  return out;
}

function lossesOf(input: SyncInput, source: SyncSource, base: DdbBase | undefined, rolls: RollPlan): SyncLosses | null {
  if (source === "first") return null;
  const stats = input.stats ?? (EMPTY_PC_STATS as PcStats);
  const fill = input.fill;
  const out: SyncLosses = {};
  // What was synced: the record's base where it has one, else the block as it is.
  const was = (unit: Unit): FieldValue => (base ? (unit.base(base) ?? unit.now(stats)) : unit.now(stats));
  const level = base?.level ?? input.level;
  if (fill.level !== undefined && level !== undefined && fill.level < level) out.level = { from: level, to: fill.level };
  const spell = UNIT_BY_KEY.get("spellAbility")!;
  if (fill.stats.spellAbility === null && was(spell) !== null) out.spellAbility = true;
  const count = (keys: (u: Unit) => boolean, on: (v: FieldValue) => boolean) => {
    let held = 0;
    let lost = 0;
    for (const unit of UNITS) {
      if (!keys(unit)) continue;
      const theirs = unit.read(fill);
      if (theirs === undefined) continue;
      if (!on(was(unit))) continue;
      held++;
      if (!on(theirs)) lost++;
    }
    return lost >= 6 && lost * 2 >= held ? lost : 0;
  };
  const proficiencies = count((u) => u.key.startsWith("saves.") || u.key.startsWith("skills."), (v) => v === true || v === "prof" || v === "expert");
  if (proficiencies) out.proficiencies = proficiencies;
  const defenses = count((u) => u.key.startsWith("defenses."), (v) => v !== null && v !== undefined);
  if (defenses) out.defenses = defenses;
  const synced = rolls.slots.filter((s) => s.entry || (s.item && s.item.case !== "sameName")).length;
  const removed = rolls.slots.filter((s) => s.item?.case === "remove" || s.item?.case === "goneThere").length;
  if (removed >= 6 && removed * 2 >= synced) out.rolls = removed;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The rows a bulk button covers (3.3): Overwrite all every kept row, Remove
 * it and Add it back included, Take these a group of Different, and Keep
 * all of yours or Keep these the editor's Replaces, whole or one group.
 */
export function bulkIds(plan: SyncPlan, section: "kept" | "different" | "replaces", group?: SyncGroup): string[] {
  return plan.items.filter((i) => i.section === section && (group === undefined || i.group === group)).map((i) => i.id);
}

/** A bulk button is pressed while every row it covers is ticked. */
export function bulkPressed(ids: readonly string[], ticks: ReadonlySet<string>): boolean {
  return ids.length > 0 && ids.every((id) => ticks.has(id));
}

/** A press ticks every row it covers, or, when it was pressed, unticks them. */
export function bulkToggle(ids: readonly string[], ticks: ReadonlySet<string>): Set<string> {
  const out = new Set(ticks);
  const pressed = bulkPressed(ids, ticks);
  for (const id of ids) {
    if (pressed) out.delete(id);
    else out.add(id);
  }
  return out;
}

/** The ticks a review opens with: every Also set line but the name. */
export function defaultTicks(plan: SyncPlan): Set<string> {
  return new Set(plan.also.filter((a) => a.on).map((a) => a.id));
}

/** Whether an item ends as D&D Beyond's, by its section and its tick. */
export function takesTheirs(item: SyncItem | AlsoItem, ticks: ReadonlySet<string>): boolean {
  if (item.type === "also") return ticks.has(item.id);
  switch (item.section) {
    case "changes":
      return true;
    case "replaces":
      return !ticks.has(item.id);
    default:
      return ticks.has(item.id);
  }
}

/**
 * The block, the fields beside it and the record a plan makes with these
 * ticks (2.2 to 2.4). The base of every field read becomes D&D Beyond's,
 * whether it was taken, kept or unticked, so a kept change is listed
 * again on every later re-sync. Every entry's `h` is D&D Beyond's.
 */
export function syncResult(plan: SyncPlan, ticks: ReadonlySet<string>): SyncResult {
  const { input } = plan;
  const start = input.stats ?? (EMPTY_PC_STATS as PcStats);
  let stats: PcStats = { ...start };
  const counts = { cameIn: 0, removed: 0, cameBack: 0, stayed: 0 };
  const also: SyncResult["also"] = {};
  let level = input.level;

  for (const item of plan.items) {
    if (item.type !== "field") continue;
    const take = takesTheirs(item, ticks);
    if (take) counts.cameIn++;
    else counts.stayed++;
    if (!take) continue;
    const unit = UNIT_BY_KEY.get(item.key);
    if (unit) stats = unit.put(stats, item.theirs);
    else setActorField(also, item.key as ActorField, item.theirs, input);
  }
  for (const line of plan.also) {
    if (!ticks.has(line.id)) {
      counts.stayed++;
      continue;
    }
    counts.cameIn++;
    if (line.key === "name") also.name = line.theirs as string;
    else if (line.key === "sheetUrl") also.sheetUrl = line.theirs as string;
    else setActorField(also, line.key, line.theirs, input);
  }
  if (also.level !== undefined) level = also.level;
  // A part that compares the same as before is the very part, so a patch never sends it (2.2).
  if (stats.saves.length === start.saves.length && stats.saves.every((a) => start.saves.includes(a))) stats.saves = start.saves;

  // The rolls: the block's in order, then what comes in, while a block and the record both have room.
  const rolls: PcRoll[] = [];
  const entries: [string, { k: string; h: string }][] = [];
  for (const slot of plan.rolls.slots) {
    const item = slot.item;
    if (!item) {
      rolls.push(slot.roll);
      if (slot.entry) entries.push([hash12(slot.roll.id), slot.entry]);
      continue;
    }
    const take = takesTheirs(item, ticks);
    switch (item.case) {
      case "update":
        counts.cameIn++;
        rolls.push(takenRoll(slot.roll, item.theirs!.roll));
        entries.push([hash12(slot.roll.id), slot.entry!]);
        break;
      case "remove":
        counts.removed++;
        break;
      case "goneThere":
        if (take) counts.removed++;
        else {
          counts.stayed++;
          rolls.push(slot.roll);
        }
        break;
      default:
        // Edited, both changed or the player's own of the same name: linked either way, with D&D Beyond's `h`.
        if (take) counts.cameIn++;
        else counts.stayed++;
        rolls.push(take ? takenRoll(slot.roll, item.theirs!.roll) : slot.roll);
        entries.push([hash12(slot.roll.id), slot.entry!]);
    }
  }
  const orphans = plan.rolls.orphans;
  let notFit = 0;
  const back = new Set<string>();
  for (const item of plan.rolls.extra) {
    const theirs = item.theirs!;
    if (item.case === "deleted") {
      if (!ticks.has(item.id)) {
        counts.stayed++;
        continue;
      }
      back.add(theirs.k);
    }
    if (rolls.length >= MAX_PC_ROLLS || entries.length + orphans.length >= MAX_PC_ROLLS || rolls.some((r) => r.id === theirs.roll.id)) {
      notFit++;
      continue;
    }
    if (item.case === "deleted") counts.cameBack++;
    else counts.cameIn++;
    rolls.push({ ...theirs.roll, ddb: true });
    entries.push([hash12(theirs.roll.id), { k: theirs.k, h: theirs.h }]);
  }
  stats = rolls.length === start.rolls.length && rolls.every((r, i) => r === start.rolls[i]) ? { ...stats, rolls: start.rolls } : { ...stats, rolls };

  // A removed roll that came back leaves the markers, and a new removal joins their end. Past 40, the oldest go (2.1).
  const marked = plan.rolls.gone.filter((k) => !back.has(k));
  const dropped = marked.length > MAX_PC_ROLLS ? marked.slice(0, marked.length - MAX_PC_ROLLS) : [];
  const gone = marked.slice(dropped.length);
  const names = new Map(plan.rolls.extra.map((x) => [x.theirs!.k, x.theirs!.roll.name]));

  const record: DdbSyncPatch = { base: nextBase(plan), rolls: Object.fromEntries([...entries, ...orphans]) };
  if (plan.from !== undefined) record.from = plan.from;
  if (gone.length > 0) record.gone = gone;

  const result: SyncResult = {
    stats,
    level,
    also,
    record,
    counts,
    notFit,
    goneDropped: dropped.map((k) => {
      const name = names.get(k);
      return name !== undefined ? { k, name } : { k };
    }),
    besideBonus: [],
  };
  result.besideBonus = besideBonus(plan, result, ticks);
  return result;
}

function setActorField(also: SyncResult["also"], key: ActorField, value: FieldValue, input: SyncInput): void {
  if (key === "level") also.level = value as number;
  else if (key === "ac") also.ac = value as number;
  else if (key === "hpMax") also.hpMax = value as number;
  // Hover is the player's, which a fill never reads (2.3).
  else if (key === "speeds") {
    const hover = input.character.actor.speeds.hover;
    also.speeds = { ...speedsWithout(value as Actor["speeds"]), ...(hover !== undefined ? { hover } : {}) };
  } else also.senses = value as string;
}

/** The new base: D&D Beyond's value for every part read, and the old base's for the rest when the source is the same (2.2). */
function nextBase(plan: SyncPlan): DdbBase {
  const { fill, character } = plan.input;
  const old = plan.source === "same" ? (character.ddbSync?.base ?? {}) : {};
  const out: DdbBase = { ...old };
  const f = fill.stats;
  if (f.abilities !== undefined) out.abilities = f.abilities;
  // Saves are a set, written in one order, so a list in another order is never a change.
  if (f.saves !== undefined) out.saves = ABILITY_KEYS.filter((a) => f.saves!.includes(a));
  if (f.skills !== undefined) out.skills = f.skills;
  if (f.adjust !== undefined) out.adjust = f.adjust;
  if (f.defenses !== undefined) out.defenses = f.defenses;
  if (f.spellAbility !== undefined) out.spellAbility = f.spellAbility;
  if (f.jack !== undefined) out.jack = f.jack;
  if (f.alert !== undefined) out.alert = f.alert;
  if (f.evasion !== undefined) out.evasion = f.evasion;
  if (f.critOn !== undefined) out.critOn = f.critOn;
  if (fill.level !== undefined) out.level = fill.level;
  const shaped = character.actor.srdId !== undefined;
  if (!shaped && fill.actor.ac !== undefined) out.ac = fill.actor.ac;
  if (fill.actor.hpMax !== undefined) out.hpMax = fill.actor.hpMax;
  if (!shaped && fill.actor.speeds !== undefined) out.speeds = speedsWithout(fill.actor.speeds);
  if (fill.actor.senses !== undefined) out.senses = fill.actor.senses;
  return out;
}

/** A proficiency the sync brings to a save or skill whose bonus the player keeps, which then counts both (3.3). */
function besideBonus(plan: SyncPlan, result: SyncResult, ticks: ReadonlySet<string>): SyncResult["besideBonus"] {
  const start = plan.input.stats;
  if (!start) return [];
  const out: SyncResult["besideBonus"] = [];
  const kept = new Map(plan.items.filter((i): i is FieldItem => i.type === "field" && !takesTheirs(i, ticks)).map((i) => [i.key, i]));
  const derived = pcDerived(result.stats, result.level);
  for (const a of ABILITY_KEYS) {
    const bonus = kept.get(`adjust.saves.${a}`);
    if (!bonus || bonus.now === 0) continue;
    if (!start.saves.includes(a) && result.stats.saves.includes(a)) out.push({ on: { save: a }, bonus: bonus.now as number, total: derived.saves[a].total });
  }
  for (const s of SKILL_KEYS) {
    const bonus = kept.get(`adjust.skills.${s}`);
    if (!bonus || bonus.now === 0) continue;
    if (start.skills[s] === undefined && result.stats.skills[s] !== undefined) out.push({ on: { skill: s }, bonus: bonus.now as number, total: derived.skills[s].total });
  }
  return out;
}

/**
 * HP under a new maximum, by the companion design's rule
 * (docs/design-v1-companion-stat-blocks.md 5.2): a living character at its
 * maximum stays at its new maximum, and any other keeps its HP, which the
 * server cuts to the maximum if higher. It never brings a character back
 * or puts one down, and never sets temporary HP.
 */
export function hpForMax(actor: Pick<Actor, "hp" | "life">, max: number): NonNullable<ActorPatch["hp"]> {
  const full = actor.life === "alive" && actor.hp.cur === actor.hp.max;
  return full ? { max, cur: max } : { max };
}

const STATS_PARTS = ["abilities", "saves", "skills", "adjust", "defenses", "rolls", "jack", "alert", "spellAbility", "critOn", "evasion"] as const satisfies readonly (keyof PcStats)[];

/** The parts of `next` that differ from `before`, each whole, and null for an optional one taken away. */
function statsPatchOf(before: PcStats, next: PcStats): PcStatsPatch {
  const patch: Record<string, unknown> = {};
  for (const part of STATS_PARTS) if (!same(before[part], next[part])) patch[part] = next[part] ?? null;
  return patch as PcStatsPatch;
}

/** A record as a patch sends it compared with one stored, `at` aside. */
export function sameRecord(a: Omit<DdbSync, "at"> & { at?: string }, b: (Omit<DdbSync, "at"> & { at?: string }) | undefined): boolean {
  if (!b) return false;
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  return same(x, y);
}

/** The character a sync starts from, as the dialog holds it. */
export type SyncCharacter = Pick<Character, "name" | "level" | "actor" | "stats" | "ddbSync">;

/**
 * The one `character.update` Apply sends (1.2, 4): every part and field the
 * result changes, the record whole without `at`, and an `expect` of each
 * part it writes and of the shape, since whether AC and Speed merge
 * depends on it. Null when nothing would change.
 */
export function syncPatch(character: SyncCharacter, result: SyncResult): { patch: CharacterPatch; expect: CharacterExpect } | null {
  const patch: CharacterPatch = {};
  const stats = statsPatchOf(character.stats ?? (EMPTY_PC_STATS as PcStats), result.stats);
  if (character.stats === undefined || Object.keys(stats).length > 0) patch.stats = stats;
  if (result.level !== character.level && result.level !== undefined) patch.level = result.level;
  if (result.also.name !== undefined && result.also.name !== character.name) patch.name = result.also.name;
  const actor: ActorPatch = {};
  const a = character.actor;
  if (result.also.ac !== undefined && result.also.ac !== a.ac) actor.ac = result.also.ac;
  if (result.also.speeds !== undefined && !same(result.also.speeds, a.speeds)) actor.speeds = result.also.speeds;
  if (result.also.senses !== undefined && result.also.senses !== a.senses) actor.senses = result.also.senses;
  if (result.also.sheetUrl !== undefined && result.also.sheetUrl !== a.sheetUrl) actor.sheetUrl = result.also.sheetUrl;
  if (result.also.hpMax !== undefined && result.also.hpMax !== a.hp.max) actor.hp = hpForMax(a, result.also.hpMax);
  if (Object.keys(actor).length > 0) patch.actor = actor;
  const changes = Object.keys(patch).length > 0;
  if (!changes && sameRecord(result.record, character.ddbSync)) return null;
  patch.ddbSync = result.record;
  return { patch, expect: expectOf(character, [...writtenParts(patch), "actor.shape"]) };
}

/** The parts of a character a patch writes, as `expect` names them. */
export function writtenParts(patch: CharacterPatch): ExpectPart[] {
  const out: ExpectPart[] = [];
  if (patch.stats) for (const part of Object.keys(patch.stats)) out.push(`stats.${part}` as ExpectPart);
  else if (patch.stats === null) out.push(...STATS_PARTS.map((p) => `stats.${p}` as ExpectPart));
  if (patch.level !== undefined) out.push("level");
  if (patch.name !== undefined) out.push("name");
  if (patch.actor?.ac !== undefined) out.push("actor.ac");
  if (patch.actor?.speeds !== undefined) out.push("actor.speeds");
  if (patch.actor?.senses !== undefined) out.push("actor.senses");
  if (patch.actor?.sheetUrl !== undefined) out.push("actor.sheetUrl");
  if (patch.actor?.hp !== undefined) out.push("actor.hp");
  if (patch.ddbSync !== undefined) out.push("ddbSync");
  return out;
}

/**
 * The character as Apply leaves it, from the character before and the
 * patch it sent, never from the view at the answer, which may hold a
 * later edit published in the same batch (4). The record takes the
 * server's `at`.
 */
export function afterSync(before: SyncCharacter, patch: CharacterPatch, at: string): SyncCharacter {
  const out: SyncCharacter = { ...before, actor: { ...before.actor } };
  if (patch.stats === null) delete out.stats;
  else if (patch.stats !== undefined) out.stats = applyPcStatsPatch(before.stats ?? (EMPTY_PC_STATS as PcStats), patch.stats);
  if (patch.level === null) delete out.level;
  else if (patch.level !== undefined) out.level = patch.level;
  if (patch.name !== undefined) out.name = patch.name;
  const a = patch.actor;
  if (a?.ac !== undefined) out.actor.ac = a.ac;
  if (a?.speeds !== undefined) out.actor.speeds = a.speeds;
  if (a?.senses !== undefined) out.actor.senses = a.senses;
  if (a?.sheetUrl === null) delete out.actor.sheetUrl;
  else if (a?.sheetUrl !== undefined) out.actor.sheetUrl = a.sheetUrl;
  if (a?.hp !== undefined) {
    // The server's own HP rule (rules/hp.ts applyHpSet): the maximum given, and the current cut to it.
    const max = a.hp.max ?? before.actor.hp.max;
    out.actor.hp = { ...before.actor.hp, max, cur: Math.min(max, Math.max(0, a.hp.cur ?? before.actor.hp.cur)) };
  }
  if (patch.ddbSync === null || patch.stats === null) delete out.ddbSync;
  else if (patch.ddbSync !== undefined) out.ddbSync = { ...patch.ddbSync, at: patch.ddbSync.at ?? at };
  return out;
}

/**
 * Undo the re-sync (1.2, 3.4): every part and field Apply wrote put back
 * as it was, the exact current and maximum HP, since the HP rule run
 * backwards would not give them back, and the record from before, its
 * `at` included, or none. Its `expect` is of the result Apply produced.
 * `stamped` is the `at` the server wrote on Apply's record, from Apply's
 * answer, never from the view: another device's later sync of an equal
 * record would pass for Apply's there, and Undo would take it back. Null
 * without it.
 */
export function undoSync(before: SyncCharacter, sent: CharacterPatch, stamped: string | undefined): { patch: CharacterPatch; expect: CharacterExpect } | null {
  if (!sent.ddbSync || stamped === undefined) return null;
  const after = afterSync(before, sent, stamped);
  const patch: CharacterPatch = {};
  if (sent.stats !== undefined) {
    if (before.stats === undefined) patch.stats = null;
    else {
      const parts: Record<string, unknown> = {};
      for (const part of Object.keys(sent.stats ?? {}) as (keyof PcStats)[]) parts[part] = before.stats[part] ?? null;
      patch.stats = parts as PcStatsPatch;
    }
  }
  if (sent.level !== undefined) patch.level = before.level ?? null;
  if (sent.name !== undefined) patch.name = before.name;
  const actor: ActorPatch = {};
  const s = sent.actor;
  if (s?.ac !== undefined) actor.ac = before.actor.ac;
  if (s?.speeds !== undefined) actor.speeds = before.actor.speeds;
  if (s?.senses !== undefined) actor.senses = before.actor.senses;
  if (s?.sheetUrl !== undefined) actor.sheetUrl = before.actor.sheetUrl ?? null;
  if (s?.hp !== undefined) actor.hp = { cur: before.actor.hp.cur, max: before.actor.hp.max };
  if (Object.keys(actor).length > 0) patch.actor = actor;
  patch.ddbSync = before.ddbSync ?? null;
  return { patch, expect: expectOf(after, [...writtenParts(patch), "actor.shape"]) };
}
