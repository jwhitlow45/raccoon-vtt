import { resourceNameKey } from "../ddb/resources.ts";
import type { ClassResource } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import { LIMITS } from "../limits.ts";
import { CLASS_IDS, presetById, type ClassId, type ResourceSent } from "./classResources.ts";
import type { FillResource } from "./pcFill.ts";
import type { RollCase, SyncSection, SyncSource } from "./pcSync.ts";

/**
 * A D&D Beyond sync's class resources merged three ways
 * (docs/design-v1-ddb-resources.md 4), beside the rolls of pcSync.ts and by
 * the same rule: one resource is one item, found again by the record's
 * entry for it, else by its class and name. What only D&D Beyond changed
 * comes in, what the player changed is kept with an offer to overwrite it,
 * and a resource the read did not see whole is left alone. The counts
 * spent are play, not the sheet: a new resource takes D&D Beyond's, and a
 * linked one keeps the room's unless its spent line is ticked (4.3).
 */

function hash12(text: string): string {
  return hash128(text).slice(0, 12);
}

/** A read resource with what finds it again: its `k`, the hash of its content, its name as keys read it, and the `k`s the class comparison meets (4.1, 4.2). */
export type ReadResource = {
  resource: FillResource;
  k: string;
  h: string;
  norm: string;
  /** Its place in the read. */
  index: number;
  /** Each `k` the class comparison meets, with the class it holds: the read's key with its class taken out, or with each SRD class put in. */
  alts: ReadonlyMap<string, ClassId | null>;
};

export type ResourceItem = {
  type: "resource";
  id: string;
  group: "Class resources";
  section: SyncSection;
  case: RollCase;
  /** The character's resource, absent for one D&D Beyond adds or one the player removed. */
  mine?: ClassResource;
  /** D&D Beyond's, absent for one it removed. */
  theirs?: ReadResource;
  conflict: boolean;
  /** The id a resource this brings in takes: an addition or Add it back. */
  fresh?: string;
};

/** A linked resource whose count spent differs in D&D Beyond (4.3): an Also set line, unticked. */
export type SpentItem = { type: "spent"; id: string; resourceId: string; theirs: number; now: number };

type Entry = { k: string; h: string };

export type ResourceSlot = {
  resource: ClassResource;
  /** Its entry after the sync. */
  entry?: Entry;
  /** The read it is linked to. */
  read?: ReadResource;
  item?: ResourceItem;
  spent?: SpentItem;
};

/** A removed marker of the record's, at its place in `gone`: it stays, takes a read's key, or leaves. */
type OldMarker = { k: string; at: number; item?: ResourceItem; leaves?: true };

export type ResourcePlan = {
  /** The read held class resources. Without, the list and the record's resource part stay as they are. */
  read: boolean;
  slots: ResourceSlot[];
  /** Resources D&D Beyond adds and those the player removed, in the read's order. */
  extra: ResourceItem[];
  /** The record's `r:` markers, in their place in `base`. */
  old: OldMarker[];
  /** Markers this sync adds, after every marker held: removed entries, by their own key or the read's. */
  added: { k: string; item?: ResourceItem }[];
  /** The `gone` list the markers were planned from, for their ages beside the rolls'. */
  base: readonly string[];
  /** The record's entries for the resources, kept as they were when nothing was read. */
  kept?: Record<string, Entry>;
  spent: SpentItem[];
};

/** A resource's content as `h` hashes it (4.1): its name, count, rest and pool, never what is spent or the bookkeeping. */
export function resourceHash(r: Pick<ClassResource, "name" | "max" | "reset" | "pool">): string {
  return hash12(stableStringify({ name: r.name, max: r.max, reset: r.reset, pool: r.pool === true ? true : undefined }));
}

/**
 * Each read resource's key (4.1): its class first for a class feature of
 * the 12 SRD classes, its name alone otherwise, and "#2" on a second of one
 * key. The class comparison's keys come with it.
 */
export function readResources(resources: readonly FillResource[]): ReadResource[] {
  const seen = new Map<string, number>();
  return resources.map((resource, index) => {
    const norm = resourceNameKey(resource.name);
    const text = resource.classId ? `${resource.classId}:${norm}` : norm;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    const suffix = n === 1 ? "" : `#${n}`;
    const alts = new Map<string, ClassId | null>();
    if (resource.classId) alts.set(`r:${hash12(`${norm}${suffix}`)}`, null);
    else for (const c of CLASS_IDS) alts.set(`r:${hash12(`${c}:${norm}${suffix}`)}`, c);
    return { resource, k: `r:${hash12(`${text}${suffix}`)}`, h: resourceHash(resource), norm, index, alts };
  });
}

/** The class a preset names, when the resource's preset is one of today's. */
function presetClass(r: ClassResource): ClassId | undefined {
  return presetById(r.preset)?.classId;
}

/** The item whose rank list comes first, compared place by place. */
function byRank<T>(list: readonly T[], rank: (t: T) => readonly number[]): T | undefined {
  let best: { t: T; r: readonly number[] } | undefined;
  for (const t of list) {
    const r = rank(t);
    const i = best ? r.findIndex((v, j) => v !== best!.r[j]) : -1;
    if (!best || (i >= 0 && r[i]! < best.r[i]!)) best = { t, r };
  }
  return best?.t;
}

/** Among reads of one name, a class-unknown one first, then the classes in CLASS_IDS order, then the read's order (OP-24). */
function classOrder(r: ReadResource): number[] {
  const c = r.resource.classId;
  return [c === undefined ? 0 : 1, c ? CLASS_IDS.indexOf(c) : -1, r.index];
}

export type ResourcePlanInput = {
  mode: "resync" | "editor";
  source: SyncSource;
  /** Where a link without a record lands: Different in the dialog, Replaces in the editor. */
  noBase: SyncSection;
  resources: readonly FillResource[] | undefined;
  /** Whether the read was whole (3.2). */
  whole: boolean;
  /** The character's list, live. */
  list: readonly ClassResource[] | undefined;
  /** The record's resource part: its entries and its `gone`, of which the `r:` markers are this merge's. */
  record: { res?: Record<string, Entry>; gone?: readonly string[] } | undefined;
  newId: () => string;
};

/**
 * How each resource stands (4.2), in five passes, each finished before the
 * next, so a later pass never takes a read an earlier one paired.
 */
export function planResources(input: ResourcePlanInput): ResourcePlan {
  const list = input.list ?? [];
  const slots: ResourceSlot[] = list.map((resource) => ({ resource }));
  // `none`, `relinked` and `first` ignore the record, so everything meets by class and name and the part is written fresh (OP-11, ASTRA-8).
  const record = input.source === "same" ? input.record : undefined;
  const base = record?.gone ?? [];
  const oldMarkers = (): OldMarker[] => base.flatMap((k, at) => (k.startsWith("r:") ? [{ k, at }] : []));
  if (!input.resources) {
    // Nothing read: the list stays, and so do its entries. An entry whose resource is gone becomes a marker, so entries never outnumber the resources (4.1).
    const ids = new Set(list.map((r) => hash12(r.id)));
    const entries = Object.entries(record?.res ?? {});
    const kept = Object.fromEntries(entries.filter(([id]) => ids.has(id)));
    const added = entries.filter(([id]) => !ids.has(id)).map(([, e]) => ({ k: e.k }));
    return { read: false, slots, extra: [], old: oldMarkers(), added, base, ...(Object.keys(kept).length > 0 ? { kept } : {}), spent: [] };
  }

  const reads = readResources(input.resources);
  const byK = new Map(reads.map((r) => [r.k, r]));
  const claimed = new Map<ReadResource, "held" | "own" | "removed">();
  const unclaimed = (r: ReadResource) => !claimed.has(r);

  // Each held resource's entry, by the hash of its id. A second entry of one key is the player's own.
  const linked = new Map<ResourceSlot, Entry>();
  const kSeen = new Set<string>();
  const index = new Map(slots.map((s) => [hash12(s.resource.id), s]));
  const held = new Set<string>();
  for (const [idHash, entry] of Object.entries(record?.res ?? {})) {
    const slot = index.get(idHash);
    if (!slot) continue;
    held.add(idHash);
    if (kSeen.has(entry.k) || linked.has(slot)) continue;
    kSeen.add(entry.k);
    linked.set(slot, entry);
  }
  const own = slots.filter((s) => !linked.has(s));
  const ownPresetClasses = (norm: string) => new Set(own.flatMap((s) => (s.read === undefined && resourceNameKey(s.resource.name) === norm ? [presetClass(s.resource)].filter((c): c is ClassId => c !== undefined) : [])));

  // 1. Exact.
  for (const [slot, entry] of linked) {
    const read = byK.get(entry.k);
    if (read && unclaimed(read)) {
      claimed.set(read, "held");
      slot.read = read;
    }
  }
  // 2. A class that moved (OP-18, OP-23, ASTRA-10, ASTRA-11).
  for (const [slot, entry] of linked) {
    if (slot.read || byK.has(entry.k)) continue;
    const pc = presetClass(slot.resource);
    const fits = reads.filter((r) => unclaimed(r) && r.alts.has(entry.k));
    // The exact class is pass 1's. Then its own preset's class, then one no own preset of the name waits for in pass 3 (ASTRA-10).
    const pick = byRank(fits, (r) => {
      const c = r.resource.classId;
      return [pc !== undefined && c === pc ? 0 : 1, c !== undefined && ownPresetClasses(r.norm).has(c) ? 1 : 0, ...classOrder(r)];
    });
    if (pick) {
      claimed.set(pick, "held");
      slot.read = pick;
    }
  }
  // 3. By class: an own preset meets its name in its preset's class.
  for (const slot of own) {
    const pc = presetClass(slot.resource);
    if (pc === undefined) continue;
    const norm = resourceNameKey(slot.resource.name);
    const read = reads.find((r) => unclaimed(r) && r.norm === norm && r.resource.classId === pc);
    if (read) {
      claimed.set(read, "own");
      slot.read = read;
    }
  }
  // 4. By name: an own preset only a read whose class is unknown, never another class's (OP-17, OP-20).
  for (const slot of own) {
    if (slot.read) continue;
    const norm = resourceNameKey(slot.resource.name);
    const preset = presetClass(slot.resource) !== undefined;
    const fits = reads.filter((r) => unclaimed(r) && r.norm === norm && (!preset || r.resource.classId === undefined));
    const read = byRank(fits, classOrder);
    if (read) {
      claimed.set(read, "own");
      slot.read = read;
    }
  }

  // The cases of the linked ones (4.2's table).
  for (const [slot, entry] of linked) {
    const read = slot.read;
    const content = resourceHash(slot.resource);
    const touched = content !== entry.h;
    if (read) {
      slot.entry = { k: read.k, h: read.h };
      const id = `res:${read.k}`;
      const mine = slot.resource;
      if (!touched && read.h !== entry.h) slot.item = { type: "resource", id, group: "Class resources", section: "changes", case: "update", mine, theirs: read, conflict: false };
      else if (touched && read.h === entry.h) slot.item = { type: "resource", id, group: "Class resources", section: "kept", case: "edited", mine, theirs: read, conflict: false };
      else if (touched && read.h !== content) slot.item = { type: "resource", id, group: "Class resources", section: "kept", case: "conflict", mine, theirs: read, conflict: true };
    } else if (input.whole) {
      const id = `res:${entry.k}`;
      slot.item = touched
        ? { type: "resource", id, group: "Class resources", section: "kept", case: "goneThere", mine: slot.resource, conflict: false }
        : { type: "resource", id, group: "Class resources", section: "changes", case: "remove", mine: slot.resource, conflict: false };
    } else slot.entry = entry;
  }
  for (const slot of own) {
    const read = slot.read;
    if (!read) continue;
    slot.entry = { k: read.k, h: read.h };
    if (resourceHash(slot.resource) !== read.h) slot.item = { type: "resource", id: `res:${read.k}`, group: "Class resources", section: input.noBase, case: "sameName", mine: slot.resource, theirs: read, conflict: false };
  }

  // 5. Removed here (ASTRA-12, OP-7, OP-24): a removed entry or a marker meets a read by its key, then by its class, and stays removed.
  const extra: ResourceItem[] = [];
  // Met by a read linked here, it goes.
  const meet = (k: string): { read: ReadResource; to: "deleted" | "drop" } | null => {
    const exact = byK.get(k);
    if (exact) return { read: exact, to: claimed.has(exact) ? "drop" : "deleted" };
    const fits = reads.filter((r) => r.alts.has(k));
    const free = byRank(fits.filter(unclaimed), classOrder);
    if (free) return { read: free, to: "deleted" };
    const taken = fits.find((r) => claimed.has(r));
    return taken ? { read: taken, to: "drop" } : null;
  };
  const deleted = (read: ReadResource): ResourceItem => {
    claimed.set(read, "removed");
    const item: ResourceItem = { type: "resource", id: `res:${read.k}`, group: "Class resources", section: "kept", case: "deleted", theirs: read, conflict: false, fresh: input.newId() };
    extra.push(item);
    return item;
  };
  const old: OldMarker[] = [];
  for (const m of oldMarkers()) {
    const met = meet(m.k);
    if (met?.to === "deleted") old.push({ ...m, item: deleted(met.read) });
    // Met by a resource linked here, the marker goes, so a removed resource added again by hand is that resource (OP-7).
    else if (met?.to === "drop") old.push({ ...m, leaves: true });
    else old.push(input.whole ? { ...m, leaves: true } : m);
  }
  const added: { k: string; item?: ResourceItem }[] = [];
  for (const [idHash, entry] of Object.entries(record?.res ?? {})) {
    if (held.has(idHash)) continue;
    const met = meet(entry.k);
    if (met?.to === "deleted") added.push({ k: met.read.k, item: deleted(met.read) });
    else if (!met && !input.whole) added.push({ k: entry.k });
  }

  /*
   * What no pass claimed comes in. No second copy comes in beside an own one
   * left of the same name and a matching class (OP-20): passes 3 and 4 give
   * every own one any such read first, so none is left beside one.
   */
  for (const read of reads) {
    if (claimed.has(read)) continue;
    claimed.set(read, "own");
    extra.push({ type: "resource", id: `res:${read.k}`, group: "Class resources", section: "changes", case: "add", theirs: read, conflict: false, fresh: input.newId() });
  }
  extra.sort((a, b) => a.theirs!.index - b.theirs!.index);

  // A linked one's count spent stays the room's, with D&D Beyond's offered unticked (4.3).
  const spent: SpentItem[] = [];
  for (const slot of slots) {
    const used = slot.read?.resource.used;
    if (!slot.read || used === undefined || used === slot.resource.used || slot.item?.case === "remove" || slot.item?.case === "goneThere") continue;
    slot.spent = { type: "spent", id: `spent:${slot.read.k}`, resourceId: slot.resource.id, theirs: used, now: slot.resource.used };
    spent.push(slot.spent);
  }
  return { read: true, slots, extra, old, added, base, spent };
}

/** What the resource part of a result holds: the list sent, the record's entries, and the markers' fate. */
export type ResourceResult = {
  /** The list as it is sent, `used` only where the sync sets it. Undefined when nothing was read. */
  list: ResourceSent[] | undefined;
  res: Record<string, Entry> | undefined;
  /** The record's `r:` markers that stay, each with its age in `base`, then this sync's new ones. */
  old: { k: string; at: number }[];
  added: string[];
  counts: { cameIn: number; removed: number; cameBack: number; stayed: number };
  notFit: number;
  /** Each spent line: its count after the sync, and the counts spent there and here, cut to it (4.3). */
  spent: { id: string; name: string; max: number; theirs: number; now: number }[];
  /** The read's names by key, for the dropped markers' line. */
  names: Map<string, string>;
};

/** D&D Beyond's resource in the place of one here, keeping its id: the name, count, rest, pool, preset and level, and `atLevel` with a preset (4.2). */
function taken(mine: ClassResource, read: ReadResource, level: number | undefined): ResourceSent {
  const r = read.resource;
  return {
    id: mine.id,
    name: r.name,
    max: r.max,
    reset: r.reset,
    ...(r.pool ? { pool: true as const } : {}),
    ...(r.preset !== undefined ? { preset: r.preset } : {}),
    ...(r.level !== undefined ? { level: r.level } : {}),
    ...(r.preset !== undefined && level !== undefined ? { atLevel: level } : {}),
  };
}

function asSent({ used: _used, ...r }: ClassResource): ResourceSent {
  return r;
}

/**
 * The list, the entries and the markers a plan makes with these ticks
 * (4.2 to 4.4). `level` is the level the sync leaves, which every linked
 * preset the read matches takes as `atLevel` (OP-6).
 */
export function resourceResult(plan: ResourcePlan, ticks: ReadonlySet<string>, takes: (item: ResourceItem) => boolean, level: number | undefined): ResourceResult {
  const counts = { cameIn: 0, removed: 0, cameBack: 0, stayed: 0 };
  const names = new Map<string, string>();
  if (!plan.read) return { list: undefined, res: plan.kept, old: plan.old.map(({ k, at }) => ({ k, at })), added: plan.added.map((m) => m.k), counts, notFit: 0, spent: [], names };
  const list: ResourceSent[] = [];
  const entries: [string, Entry][] = [];
  const spentLines: ResourceResult["spent"] = [];
  for (const slot of plan.slots) {
    const item = slot.item;
    let out: ResourceSent | null = asSent(slot.resource);
    let replaced = false;
    if (item) {
      const take = takes(item);
      switch (item.case) {
        case "update":
          counts.cameIn++;
          out = taken(slot.resource, item.theirs!, level);
          replaced = true;
          break;
        case "remove":
          counts.removed++;
          out = null;
          break;
        case "goneThere":
          if (take) {
            counts.removed++;
            out = null;
          } else counts.stayed++;
          break;
        default:
          if (take) {
            counts.cameIn++;
            out = taken(slot.resource, item.theirs!, level);
            replaced = true;
          } else counts.stayed++;
      }
    }
    if (!out) continue;
    const read = slot.read;
    // Every linked preset the read matches takes its class level and the level the sync leaves, with no line (4.4).
    if (read && !replaced && read.resource.preset !== undefined && read.resource.preset === slot.resource.preset) {
      if (read.resource.level !== undefined) out.level = read.resource.level;
      if (level !== undefined) out.atLevel = level;
    }
    if (slot.spent) {
      if (ticks.has(slot.spent.id)) {
        counts.cameIn++;
        out.used = Math.min(slot.spent.theirs, out.max);
      } else counts.stayed++;
      spentLines.push({ id: slot.spent.id, name: out.name, max: out.max, theirs: Math.min(slot.spent.theirs, out.max), now: Math.min(slot.spent.now, out.max) });
    }
    list.push(out);
    if (slot.entry) entries.push([hash12(slot.resource.id), slot.entry]);
  }

  let notFit = 0;
  const back = new Set<ResourceItem>();
  for (const item of plan.extra) {
    const read = item.theirs!;
    names.set(read.k, read.resource.name);
    if (item.case === "deleted" && !ticks.has(item.id)) {
      counts.stayed++;
      continue;
    }
    if (list.length >= LIMITS.resourcesPerCharacter) {
      notFit++;
      continue;
    }
    const r = read.resource;
    const id = item.fresh!;
    list.push({
      id,
      name: r.name,
      max: r.max,
      reset: r.reset,
      ...(r.pool ? { pool: true as const } : {}),
      ...(r.preset !== undefined ? { preset: r.preset } : {}),
      ...(r.level !== undefined ? { level: r.level } : {}),
      ...(r.preset !== undefined && level !== undefined ? { atLevel: level } : {}),
      ...(r.used !== undefined ? { used: Math.min(r.used, r.max) } : {}),
    });
    entries.push([hash12(id), { k: read.k, h: read.h }]);
    if (item.case === "deleted") {
      counts.cameBack++;
      back.add(item);
    } else counts.cameIn++;
  }

  // A removed resource that came back leaves the markers, and one that stays removed takes the read's key (2.1's rule for rolls).
  const old: { k: string; at: number }[] = [];
  for (const m of plan.old) {
    if (m.leaves) continue;
    if (m.item) {
      if (!back.has(m.item)) old.push({ k: m.item.theirs!.k, at: m.at });
    } else old.push({ k: m.k, at: m.at });
  }
  const added = plan.added.flatMap((m) => (m.item ? (back.has(m.item) ? [] : [m.item.theirs!.k]) : [m.k]));
  return { list, res: entries.length > 0 ? Object.fromEntries(entries) : undefined, old, added, counts, notFit, spent: spentLines, names };
}

/** Two lists the same but for each preset's `level` and `atLevel`, which a sync writes with no line and never alone (OP-19). */
export function sameButLevels(a: readonly (ResourceSent | ClassResource)[] | undefined, b: readonly (ResourceSent | ClassResource)[] | undefined): boolean {
  const strip = (list: readonly (ResourceSent | ClassResource)[] | undefined) => (list ?? []).map(({ level: _l, atLevel: _a, ...r }) => r);
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

/** The record's resource part as `expect` reads a change to it: its entries and its `r:` markers. */
export function resourcePart(record: { res?: Record<string, Entry>; gone?: readonly string[] } | null | undefined): string {
  return stableStringify({ res: record?.res ?? null, gone: (record?.gone ?? []).filter((k) => k.startsWith("r:")) });
}

/** For the losses warning (6.1): the resources a read takes away, and how many were synced. */
export function resourceLosses(plan: ResourcePlan): number {
  const synced = plan.slots.filter((s) => s.entry || (s.item && s.item.case !== "sameName")).length;
  const removed = plan.slots.filter((s) => s.item?.case === "remove" || s.item?.case === "goneThere").length;
  return removed >= 3 && removed * 2 >= synced ? removed : 0;
}
