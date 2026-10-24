import type { AbilityKey } from "../model.ts";
import { fillResourceSchema, MAX_FILL_RESOURCES } from "../protocol.ts";
import { CLASS_IDS, CLASS_NAMES, presetCount, presetReset, presetsAt, type ClassId, type ClassPreset } from "../rules/classResources.ts";
import type { FillResource } from "../rules/pcFill.ts";
import { pcProficiency } from "../rules/pcStats.ts";

/**
 * A D&D Beyond character's limited uses read as class resources
 * (docs/design-v1-ddb-resources.md 1 to 3), beside the rolls and the block
 * that read.ts reads. The same rules as the rest of the reader: named paths
 * only, never a walk of the tree, every loop bounded, never throws, and a
 * missing or mistyped value is skipped, never assumed. It reads numbers,
 * ids and names, and never a description, a snippet or a limited use's own
 * name, so no D&D Beyond prose enters a room.
 *
 * The paths, each with a fixture in resources.test.ts, checked during the
 * build against public sample characters (1.1):
 *
 * | Path under `data` | Read as |
 * | --- | --- |
 * | `actions.class[]`, `actions.race[]`, `actions.feat[]` | the lists, in that order, 200 entries each |
 * | `A.name` | the resource's name |
 * | `A.limitedUse` | an object marks a resource, null or absent marks none |
 * | `A.limitedUse.maxUses` | the base count, already for the class level |
 * | `A.limitedUse.statModifierUsesId`, `.operator` | an ability modifier, 1 adds and 2 multiplies |
 * | `A.limitedUse.useProficiencyBonus`, `.proficiencyBonusOperator` | the proficiency bonus, 1 adds and 2 multiplies |
 * | `A.limitedUse.resetType` | 1 Short Rest, 2 Long Rest, 3 Dawn, 4 another way |
 * | `A.limitedUse.numberUsed` | the uses or amount spent |
 * | `A.limitedUse.minNumberConsumed`, `.maxNumberConsumed` | a pool's cost per use |
 * | `A.componentTypeId`, `A.componentId` | the source, 12168134 a class feature |
 * | `classes[].classFeatures[].definition.id`, `.requiredLevel`, `.name` | a class feature's class and level |
 * | `classes[].level`, `classes[].definition.name` | each class's level and class |
 */

type Obj = Record<string, unknown>;

/** Bounds on every list read, as read.ts bounds them. */
const MAX = { actions: 200, classes: 20, features: 300 };

/** D&D Beyond's component type of a class feature (1.1). */
const CLASS_FEATURE = 12168134;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

const UNSAFE_CHARS = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const MAX_NAME = 40;

/**
 * A name D&D Beyond gives, as one line of at most 40 code units, cut on a
 * whole character (3.1): the resource name's schema refuses half a
 * surrogate pair, which read.ts's cut by code unit could leave.
 */
export function resourceNameOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const clean = v.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  if (clean.length <= MAX_NAME) return clean;
  let cut = "";
  for (const ch of clean) {
    if (cut.length + ch.length > MAX_NAME - 1) break;
    cut += ch;
  }
  return `${cut.trimEnd()}…`;
}

/** D&D Beyond's own names for three pool presets (3.4), the 2024 name and the 2014 one, normalized. */
const DDB_NAMES: ReadonlyMap<string, string> = new Map([
  ["ki points", "focus points"],
  ["lay on hands: healing pool", "lay on hands"],
  ["lay on hands pool", "lay on hands"],
  ["font of magic: sorcery points", "sorcery points"],
]);

/**
 * A resource's name as a match and a sync key read it (3.4, 4.1): lower
 * case, curly apostrophes straight, spaces collapsed, then D&D Beyond's
 * own names for a preset's. So "Ki Points" meets the Focus Points preset
 * and "Nature's Veil" meets "Nature’s Veil".
 */
export function resourceNameKey(name: string): string {
  const plain = name.toLowerCase().replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, " ").trim();
  return DDB_NAMES.get(plain) ?? plain;
}

const ABILITY_BY_ID: Record<number, AbilityKey> = { 1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha" };

type Kind = "class" | "race" | "feat";
const KINDS: readonly Kind[] = ["class", "race", "feat"];

/**
 * Whether every action list was read to its end: each is null, absent, or
 * a list of at most 200. One cut at its bound, or not a list, may hold a
 * linked resource or roll, so a merge must not read it as gone (rule 7 of
 * docs/design-v1-ddb-resources.md, DDBBUILD-ASTRA-01). read.ts says so once
 * for the other rolls and the class resources, which read the same lists.
 */
export function actionsWhole(data: Obj): boolean {
  const groups = obj(data.actions);
  if (!groups) return true;
  return KINDS.every((kind) => {
    const list = groups[kind];
    return list === null || list === undefined || (Array.isArray(list) && list.length <= MAX.actions);
  });
}

type ClassInfo = { classId: ClassId | undefined; level: number };
type Feature = { cls: number; requiredLevel: number; name: string | null };

/** Each class's level and SRD class, and each class feature's class and level by its id. */
function classesOf(data: Obj): { classes: ClassInfo[]; features: Map<number, Feature> } {
  const classes: ClassInfo[] = [];
  const features = new Map<number, Feature>();
  for (const raw of arr(data.classes, MAX.classes)) {
    const c = obj(raw);
    const def = obj(c?.definition);
    const level = num(c?.level);
    if (!c || !def || level === null) continue;
    const cname = typeof def.name === "string" ? def.name.trim().toLowerCase() : "";
    const classId = CLASS_IDS.find((id) => CLASS_NAMES[id].toLowerCase() === cname);
    const cls = classes.length;
    classes.push({ classId, level: Math.max(0, Math.round(level)) });
    for (const f of arr(c.classFeatures, MAX.features)) {
      const fdef = obj(obj(f)?.definition);
      const id = num(fdef?.id);
      const requiredLevel = num(fdef?.requiredLevel);
      if (id === null || requiredLevel === null || features.has(id)) continue;
      features.set(id, { cls, requiredLevel, name: resourceNameOf(fdef?.name) });
    }
  }
  return { classes, features };
}

/** One limited use as read, before the merges of 2.1. */
type Entry = {
  kind: Kind;
  name: string;
  norm: string;
  max: number;
  reset: "long" | "short";
  dawn: boolean;
  /** A pool by its cost fields, and the fixed cost above 1 its line names, else 0. */
  pool: boolean;
  cost: number;
  used: number | undefined;
  source: string | undefined;
  feature: Feature | undefined;
};

/** Lines a read resource gives, each kept only when its resource is among the 12 read. */
type ReadLines = { raised: { name: string; text: string }[]; costs: { name: string; text: string }[]; dawn: string[] };

/** Why an entry with a limited use is not a resource. `quiet` ones keep the read whole (3.2). */
type Skip = { why: "quiet" } | { why: "another"; name: string } | { why: "ability"; name: string } | { why: "proficiency"; name: string } | { why: "unread" };

function operatorOf(v: unknown): 1 | 2 | null {
  if (v === undefined || v === null) return 1;
  return v === 1 || v === 2 ? v : null;
}

/** The count by D&D Beyond's own rule (1.2), with this note's five choices. */
function countOf(base: number, ability: { mod: number; op: 1 | 2 } | null, pb: { value: number; op: 1 | 2 } | null): number {
  let initial = base;
  let least = 1;
  let scaled = 0;
  if (ability) {
    if (ability.op === 2) {
      scaled = ability.mod * initial;
      least = initial;
      initial = 0;
    } else scaled = ability.mod;
  }
  if (pb) {
    if (pb.op === 2) {
      scaled = (scaled + initial) * pb.value;
      least = initial;
      initial = 0;
    } else scaled += pb.value;
  }
  return Math.max(least, initial + scaled);
}

type Sources = { scoreMods: Record<AbilityKey, number> | null; level: number | null };

function entryOf(kind: Kind, a: Obj, lu: Obj, feature: Feature | undefined, src: Sources): Entry | Skip {
  const name = resourceNameOf(a.name);
  if (!name) return { why: "unread" };
  const resetType = lu.resetType;
  if (resetType === 4) return { why: "another", name };
  if (resetType !== 1 && resetType !== 2 && resetType !== 3) return { why: "unread" };

  const abilityId = lu.statModifierUsesId;
  const ability = abilityId === undefined || abilityId === null || abilityId === 0 ? null : (ABILITY_BY_ID[int(abilityId) ?? -1] ?? "bad");
  if (ability === "bad") return { why: "unread" };
  const abilityOp = ability ? operatorOf(lu.operator) : 1;
  const prof = lu.useProficiencyBonus === true;
  const profOp = prof ? operatorOf(lu.proficiencyBonusOperator) : 1;
  if (abilityOp === null || profOp === null) return { why: "unread" };

  const raw = lu.maxUses;
  let base: number;
  if (raw === null) {
    if (!ability && !prof) return { why: "unread" };
    base = 0;
  } else {
    const n = int(raw);
    if (n === null || n < -1) return { why: "unread" };
    // -1 reads as 0, as ddb-importer reads it, and a base of nothing with nothing beside it is no resource (1.2).
    base = Math.max(0, n);
    if (base === 0 && !ability && !prof) return { why: "quiet" };
  }
  if (ability && !src.scoreMods) return { why: "ability", name };
  if (prof && src.level === null) return { why: "proficiency", name };
  const max = countOf(base, ability ? { mod: src.scoreMods![ability], op: abilityOp } : null, prof ? { value: pcProficiency(src.level!), op: profOp } : null);
  if (max < 1) return { why: "quiet" };

  const minCost = int(lu.minNumberConsumed);
  const maxCost = int(lu.maxNumberConsumed);
  // The engine's cost per use, the least over 1. A range spends an amount, and a fixed cost above 1 is a pool of units (OP-8, D-261024-34).
  const least = Math.max(1, minCost ?? maxCost ?? 1);
  const range = maxCost !== null && maxCost > least;
  const fixed = !range && least > 1;

  const spent = int(lu.numberUsed);
  const typeId = num(a.componentTypeId);
  const componentId = num(a.componentId);
  return {
    kind,
    name,
    norm: resourceNameKey(name),
    max,
    reset: resetType === 1 ? "short" : "long",
    dawn: resetType === 3,
    pool: range || fixed,
    cost: fixed ? least : 0,
    used: spent !== null && spent >= 0 ? spent : undefined,
    source: typeId !== null && componentId !== null ? `${typeId}:${componentId}` : undefined,
    feature,
  };
}

/** "A", "A and B", "A, B and C", up to 8 names, then "and others", within the warnings' 400 characters. */
function names(list: readonly string[], room: number): string {
  let n = Math.min(8, list.length);
  for (;;) {
    const shown = list.slice(0, n);
    const more = list.length > n;
    const text = more ? `${shown.join(", ")} and others` : shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
    if (text.length <= room || n <= 1) return text;
    n--;
  }
}

/** A warning that names a list, its names shortened until it fits a warning's 400 characters. */
function named(list: readonly string[], one: (name: string) => string, many: (names: string) => string): string {
  if (list.length === 1) return one(list[0]!);
  const frame = many("").length;
  return many(names(list, 400 - frame));
}

export type ResourcesRead = {
  /** At most 12, in the order 2.1 gives. */
  resources: FillResource[];
  /** Read whole (3.2): a merge removes a linked resource only then. */
  whole: boolean;
  /** Check these lines, in 3.3's order. */
  warnings: string[];
};

/**
 * The character's limited uses as class resources (2, 3): `scoreMods` is
 * null when the scores were not read, and `level` when the classes were
 * not. `who` names the character in the cut's warning.
 */
export function readResources(data: Obj, src: Sources & { who: string }): ResourcesRead {
  const groups = obj(data.actions) ?? {};
  const { classes, features } = classesOf(data);
  const skips: Skip[] = [];
  let entries: Entry[] = [];
  let order = 0;
  const orderOf = new Map<Entry, number>();

  for (const kind of KINDS) {
    for (const raw of arr(groups[kind], MAX.actions)) {
      const a = obj(raw);
      if (!a || a.limitedUse === undefined || a.limitedUse === null) continue;
      const lu = obj(a.limitedUse);
      if (!lu) {
        skips.push({ why: "unread" });
        continue;
      }
      const feature = kind === "class" && num(a.componentTypeId) === CLASS_FEATURE ? features.get(num(a.componentId) ?? Number.NaN) : undefined;
      // classFeatures lists features the class has not reached yet (2.1, 1).
      if (feature && feature.requiredLevel > classes[feature.cls]!.level) continue;
      const read = entryOf(kind, a, lu, feature, src);
      if ("why" in read) skips.push(read);
      else {
        entries.push(read);
        orderOf.set(read, order++);
      }
    }
  }

  // 2.1, 2: one feature, one resource, named as the feature where one is, with the most spent.
  const bySource = new Map<string, Entry[]>();
  for (const e of entries) if (e.source !== undefined) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  entries = entries.filter((e) => {
    const group = e.source !== undefined ? bySource.get(e.source)! : [e];
    if (group.length === 1) return true;
    const keep = group.find((g) => g.feature?.name != null && g.name.toLowerCase() === g.feature.name.toLowerCase()) ?? group[0]!;
    if (keep !== e) return false;
    const spent = group.map((g) => g.used).filter((u): u is number => u !== undefined);
    if (spent.length > 0) e.used = Math.max(...spent);
    return true;
  });

  // The classes that hold a preset of a name at their level, in CLASS_IDS order, for the fallback (3.4) and OP-22.
  const presetOf = (classId: ClassId, level: number, norm: string): ClassPreset | undefined => presetsAt(classId, level).find((p) => resourceNameKey(p.name) === norm);
  const levelOf = (classId: ClassId): number | undefined => classes.find((c) => c.classId === classId)?.level;
  const holders = (norm: string): ClassId[] =>
    CLASS_IDS.filter((id) => {
      const level = levelOf(id);
      return level !== undefined && presetOf(id, level, norm) !== undefined;
    });

  // 2.1, 3: one name in one class, the highest feature level staying, else the first.
  // Unresolved class features, species traits and feats each count as no class, apart from one another.
  const classKey = (e: Entry) => (e.feature ? `c${e.feature.cls}` : e.kind);
  const kept: Entry[] = [];
  for (const e of entries) {
    const rival = kept.find((k) => k.norm === e.norm && classKey(k) === classKey(e));
    if (!rival) {
      kept.push(e);
      continue;
    }
    // Two class-unknown features of a name two classes hold stay two, so the fallback gives each its class (OP-22).
    if (!e.feature && e.kind === "class" && e.source !== rival.source && holders(e.norm).length >= 2) {
      kept.push(e);
      continue;
    }
    if ((e.feature?.requiredLevel ?? -1) > (rival.feature?.requiredLevel ?? -1)) kept[kept.indexOf(rival)] = e;
  }

  // Class features by class in CLASS_IDS order, then unresolved ones, then species traits, then feats (2.1).
  const rank = (e: Entry): number => {
    if (e.kind === "race") return 100;
    if (e.kind === "feat") return 101;
    if (!e.feature) return 99;
    const id = classes[e.feature.cls]!.classId;
    return id ? CLASS_IDS.indexOf(id) : 50 + e.feature.cls;
  };
  kept.sort((a, b) => rank(a) - rank(b) || orderOf.get(a)! - orderOf.get(b)!);

  const warnings: ReadLines = { raised: [], costs: [], dawn: [] };
  const resources: { resource: FillResource; entry: Entry }[] = [];
  const taken = new Map<string, Set<ClassId>>();
  for (const e of kept) {
    if (e.feature) {
      const id = classes[e.feature.cls]!.classId;
      if (id) taken.set(e.norm, new Set([...(taken.get(e.norm) ?? []), id]));
    }
  }
  let unread = 0;
  for (const e of kept) {
    let classId: ClassId | undefined;
    let preset: ClassPreset | undefined;
    let classLevel = 0;
    if (e.feature) {
      const c = classes[e.feature.cls]!;
      classId = c.classId;
      classLevel = c.level;
      preset = classId ? presetOf(classId, classLevel, e.norm) : undefined;
    } else if (e.kind === "class") {
      const fits = holders(e.norm);
      const free = fits.find((id) => !taken.get(e.norm)?.has(id));
      if (free) {
        classId = free;
        classLevel = levelOf(free)!;
        preset = presetOf(free, classLevel, e.norm);
        taken.set(e.norm, new Set([...(taken.get(e.norm) ?? []), free]));
      } else if (fits.length > 0) {
        // Past the classes that hold it, rule 3 against that name's resource in the fallback's first class, which stays (OP-25).
        continue;
      }
    }
    const resource: FillResource = preset ? fromPresetRead(e, preset, classLevel, src, warnings.raised) : fromOwnRead(e, warnings);
    if (classId) resource.classId = classId;
    if (resource.max > (resource.pool ? 200 : 99) || !fillResourceSchema.safeParse(resource).success) {
      unread++;
      continue;
    }
    resources.push({ resource, entry: e });
  }

  const over = Math.max(0, resources.length - MAX_FILL_RESOURCES);
  const out = resources.slice(0, MAX_FILL_RESOURCES);
  // Lines for resources the cut took say nothing true of the character's list.
  const shown = new Set(out.map((r) => r.resource.name));
  const ability = skips.flatMap((s) => (s.why === "ability" ? [s.name] : []));
  const prof = skips.flatMap((s) => (s.why === "proficiency" ? [s.name] : []));
  const another = skips.flatMap((s) => (s.why === "another" ? [s.name] : []));
  unread += skips.filter((s) => s.why === "unread").length;

  const lines: string[] = [];
  if (ability.length > 0) lines.push(named(ability, (n) => `${n}'s count comes from an ability score, which was not read, so it stays as it is.`, (ns) => `The counts of ${ns} come from an ability score, which was not read, so they stay as they are.`));
  if (prof.length > 0) lines.push(named(prof, (n) => `${n}'s count comes from the proficiency bonus, which needs the classes, so it stays as it is.`, (ns) => `The counts of ${ns} come from the proficiency bonus, which needs the classes, so they stay as they are.`));
  if (another.length > 0) lines.push(named(another, (n) => `${n} comes back another way in D&D Beyond, so it was left out. Add it as your own if it counts.`, (ns) => `${ns} come back another way in D&D Beyond, so they were left out. Add one as your own if it counts.`));
  const dawn = warnings.dawn.filter((n) => shown.has(n));
  if (dawn.length > 0) lines.push(named(dawn, (n) => `${n} comes back at dawn in D&D Beyond. Here a Long Rest brings it back.`, (ns) => `${ns} come back at dawn in D&D Beyond. Here a Long Rest brings them back.`));
  if (over > 0) {
    lines.push(
      over === 1
        ? `D&D Beyond has ${resources.length} class resources for ${src.who}, more than the ${MAX_FILL_RESOURCES} a character holds, so 1 was not read. Class resources here that it would change stay as they are.`
        : `D&D Beyond has ${resources.length} class resources for ${src.who}, more than the ${MAX_FILL_RESOURCES} a character holds, so ${over} were not read. Class resources here that they would change stay as they are.`,
    );
  }
  if (unread > 0) lines.push(unread === 1 ? "1 limited use in D&D Beyond could not be read, so it was left out." : `${unread} limited uses in D&D Beyond could not be read, so they were left out.`);
  for (const line of [...warnings.costs, ...warnings.raised]) if (shown.has(line.name)) lines.push(line.text);

  return {
    resources: out.map((r) => r.resource),
    whole: over === 0 && unread === 0 && ability.length === 0 && prof.length === 0 && actionsWhole(data),
    warnings: lines,
  };
}

/** A read that matches a preset (3.4): the preset's name, rest and pool, and D&D Beyond's count unless it is under the preset's. */
function fromPresetRead(e: Entry, preset: ClassPreset, classLevel: number, src: Sources, raised: ReadLines["raised"]): FillResource {
  const modifier = preset.count.by === "modifier" ? (src.scoreMods?.[preset.count.ability] ?? null) : undefined;
  const floor = presetCount(preset, classLevel, modifier);
  let max = e.max;
  if (floor !== null && e.max < floor) {
    max = floor;
    raised.push({ name: preset.name, text: `${preset.name} reads ${e.max} in D&D Beyond, fewer than a ${classNameOf(preset.classId)} ${classLevel}'s ${floor} by SRD 5.2.1, so it reads ${floor} here. Check it.` });
  }
  const out: FillResource = { name: preset.name, max, reset: presetReset(preset, classLevel), preset: preset.id, level: Math.min(20, Math.max(1, classLevel)) };
  if (preset.pool) out.pool = true;
  if (e.used !== undefined) out.used = Math.min(e.used, max);
  return out;
}

/** A read with no preset: D&D Beyond's name, count and rest, a pool by its cost fields. */
function fromOwnRead(e: Entry, warnings: ReadLines): FillResource {
  const out: FillResource = { name: e.name, max: e.max, reset: e.reset };
  if (e.pool) out.pool = true;
  if (e.used !== undefined) out.used = Math.min(e.used, e.max);
  if (e.cost > 1) warnings.costs.push({ name: e.name, text: `${e.name} costs ${e.cost} a use on D&D Beyond: spend ${e.cost} each time.` });
  if (e.dawn) warnings.dawn.push(e.name);
  return out;
}

function classNameOf(classId: ClassId): string {
  return CLASS_NAMES[classId];
}
