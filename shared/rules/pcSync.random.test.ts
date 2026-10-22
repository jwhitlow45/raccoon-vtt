import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, serializedBytes } from "../limits.ts";
import type { Character, PcRoll, PcStats, RoomState } from "../model.ts";
import { canApply, expectOf } from "../permissions.ts";
import { ddbSyncForImport, ddbSyncPatchSchema, EXPECT_PARTS, MAX_PC_ROLLS, opSchema, pcStatsForImport, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { stampedAt } from "../reducer/tokens.ts";
import { DM, P1, character as testCharacter, actor as testActor, room } from "../testutil.ts";
import type { PcFill } from "./pcFill.ts";
import {
  afterSync,
  defaultTicks,
  fieldOf,
  hash12,
  planSync,
  rollHash,
  rollKeys,
  sameRecord,
  sensesWords,
  SYNC_FIELD_KEYS,
  syncPatch,
  syncResult,
  takesTheirs,
  undoSync,
  withField,
  type ActorField,
  type FieldKey,
  type FieldValue,
  type SyncPlan,
  type SyncResult,
} from "./pcSync.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";

/**
 * The re-sync merge under many random sequences (docs/design-v1-resync.md
 * 5): syncs, edits by the player and by D&D Beyond, deletions, a kind
 * read in part, parts left out, shapes, relinks, the editor's mode, the
 * 40-roll cap and the 40 markers, each sync applied and then undone
 * through the real reducer. Section 5's eight invariants are checked at
 * every step, each with its exceptions.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const pick = <T>(r: R, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const chance = (r: R, p: number) => r() < p;

function valuesOf(key: FieldKey): FieldValue[] {
  if (key.startsWith("abilities.")) return [8, 10, 13, 16, 18];
  if (key.startsWith("saves.") || key === "jack" || key === "alert" || key === "evasion") return [false, true];
  if (key.startsWith("skills.")) return [null, "prof", "expert"];
  if (key.startsWith("adjust.")) return [0, 1, 2, -1];
  if (key.startsWith("defenses.")) return [null, "resistant", "immune"];
  if (key === "spellAbility") return [null, "wis", "cha", "int"];
  if (key === "critOn") return [20, 19, 18];
  throw new Error(key);
}

/** The fields most rolls of the dice change, so a step changes a few of them, as a level-up or an edit does. */
const HOT: FieldKey[] = ["abilities.wis", "abilities.dex", "saves.wis", "skills.stealth", "skills.perception", "adjust.skills.stealth", "adjust.init", "spellAbility", "jack", "critOn", "defenses.fire", "defenses.poison"];

const NAMES: { kind: PcRoll["kind"]; name: string; level?: number }[] = [
  { kind: "weapon", name: "Longsword" },
  { kind: "weapon", name: "Shortbow" },
  { kind: "weapon", name: "Dagger" },
  { kind: "weapon", name: "Sling" },
  { kind: "spell", name: "Shillelagh", level: 0 },
  { kind: "spell", name: "Moonbeam", level: 2 },
  { kind: "spell", name: "Cure Wounds", level: 1 },
  { kind: "spell", name: "Thunderwave", level: 1 },
  { kind: "other", name: "Wild Companion" },
  { kind: "other", name: "Second Wind" },
];

let ids = 0;
const newId = (prefix: string) => `${prefix}${++ids}`;

function randomRoll(r: R, prefix: string, name = pick(r, NAMES)): PcRoll {
  const roll: PcRoll = { id: newId(prefix), name: name.name, kind: name.kind, dice: [{ formula: pick(r, ["1d4", "1d6", "1d8", "2d6"]), type: pick(r, ["fire", "slashing", "radiant"] as const) }] };
  if (name.level !== undefined) roll.level = name.level;
  if (chance(r, 0.6)) roll.attack = { prof: true, bonus: pick(r, [0, 1, 2]) };
  else roll.save = { ability: pick(r, ["con", "dex", "wis"] as const) };
  return roll;
}

/** What D&D Beyond holds for the character: a whole block, the fields beside it, and its number. */
type Truth = { stats: PcStats; level: number; ac: number; hpMax: number; speeds: { walk: number; fly?: number }; senses?: string; name: string; number: string };

function randomTruth(r: R, filler: boolean): Truth {
  let stats = structuredClone(EMPTY_PC_STATS) as PcStats;
  for (const key of SYNC_FIELD_KEYS) if (chance(r, HOT.includes(key) ? 0.6 : 0.08)) stats = withField(stats, key, pick(r, valuesOf(key)));
  const count = filler ? 36 + Math.floor(r() * 10) : Math.floor(r() * 9);
  const rolls: PcRoll[] = [];
  for (let i = 0; i < count; i++) rolls.push(filler && i >= 6 ? { id: newId("t"), name: `Roll ${i}`, kind: pick(r, ["weapon", "spell", "other"] as const), level: 1, dice: [{ formula: "1d4" }] } : randomRoll(r, "t"));
  stats.rolls = rolls.map((roll) => (roll.kind === "spell" ? roll : (({ level: _level, ...rest }) => rest)(roll)));
  return { stats, level: 1 + Math.floor(r() * 20), ac: 10 + Math.floor(r() * 8), hpMax: 10 + Math.floor(r() * 60), speeds: chance(r, 0.2) ? { walk: 30, fly: 30 } : { walk: pick(r, [25, 30, 35]) }, ...(chance(r, 0.5) ? { senses: `Darkvision ${pick(r, [60, 120])} ft.` } : {}), name: pick(r, ["Bree", "Bree Tallow"]), number: "12345678" };
}

/** D&D Beyond moves on: a few fields, a roll changed, one removed, one added. */
function changeTruth(r: R, t: Truth): Truth {
  let stats = { ...t.stats, rolls: [...t.stats.rolls] };
  for (const key of HOT) if (chance(r, 0.15)) stats = withField(stats, key, pick(r, valuesOf(key)));
  if (stats.rolls.length > 0 && chance(r, 0.3)) {
    const i = Math.floor(r() * stats.rolls.length);
    stats.rolls[i] = { ...stats.rolls[i]!, dice: [{ formula: pick(r, ["1d10", "3d6", "1d12"]) }] };
  }
  if (stats.rolls.length > 0 && chance(r, 0.25)) stats.rolls.splice(Math.floor(r() * stats.rolls.length), 1);
  if (chance(r, 0.3)) stats.rolls.push(randomRoll(r, "t"));
  return {
    ...t,
    stats,
    level: chance(r, 0.2) ? Math.min(20, t.level + 1) : t.level,
    ac: chance(r, 0.15) ? t.ac + 1 : t.ac,
    hpMax: chance(r, 0.2) ? t.hpMax + 7 : t.hpMax,
    speeds: chance(r, 0.1) ? { walk: t.speeds.walk + 5 } : t.speeds,
    number: chance(r, 0.05) ? "87654321" : t.number,
  };
}

/**
 * A read of the truth: a part sometimes left out, a kind sometimes read in
 * part and marked so, the reader's 40-roll cut, and new ids every time.
 */
function readOf(r: R, t: Truth): PcFill {
  const s = t.stats;
  const fill: PcFill = {
    source: "ddb",
    stats: {
      abilities: s.abilities,
      saves: s.saves,
      skills: s.skills,
      adjust: s.adjust,
      defenses: s.defenses,
      spellAbility: s.spellAbility ?? null,
      jack: s.jack === true,
      alert: s.alert === true,
      evasion: s.evasion === true,
      critOn: s.critOn ?? null,
      rolls: [],
    },
    level: t.level,
    name: t.name,
    actor: { ac: t.ac, hpMax: t.hpMax, speeds: t.speeds, sheetUrl: `https://www.dndbeyond.com/characters/${t.number}` },
    warnings: [],
    read: { weapon: true, spell: true, other: true },
  };
  if (t.senses) fill.actor.senses = t.senses;
  for (const part of ["abilities", "saves", "skills", "adjust", "defenses", "spellAbility", "jack", "alert", "evasion", "critOn"] as const) if (chance(r, 0.06)) delete fill.stats[part];
  for (const part of ["ac", "hpMax", "speeds", "senses"] as const) if (chance(r, 0.06)) delete fill.actor[part];
  if (chance(r, 0.06)) delete fill.level;
  let rolls = s.rolls.map((roll) => ({ ...roll, id: newId("read"), ddb: true as const }));
  for (const kind of ["weapon", "spell", "other"] as const) {
    if (!chance(r, 0.12)) continue;
    fill.read![kind] = false;
    rolls = rolls.filter((roll) => roll.kind !== kind || chance(r, 0.5));
  }
  if (rolls.length > MAX_PC_ROLLS) {
    for (const lost of rolls.slice(MAX_PC_ROLLS)) fill.read![lost.kind] = false;
    rolls = rolls.slice(0, MAX_PC_ROLLS);
  }
  fill.stats.rolls = rolls;
  return fill;
}

/** The player changes a few fields, edits, deletes and adds rolls, takes or ends a shape. */
function edit(r: R, c: Character): Character {
  const next: Character = { ...c, actor: { ...c.actor } };
  if (next.stats) {
    let stats = { ...next.stats, rolls: [...next.stats.rolls] };
    for (const key of HOT) if (chance(r, 0.1)) stats = withField(stats, key, pick(r, valuesOf(key)));
    if (stats.rolls.length > 0 && chance(r, 0.3)) {
      const i = Math.floor(r() * stats.rolls.length);
      stats.rolls[i] = { ...stats.rolls[i]!, attack: { prof: true, bonus: pick(r, [3, 4]) } };
    }
    if (stats.rolls.length > 0 && chance(r, 0.25)) stats.rolls.splice(Math.floor(r() * stats.rolls.length), 1);
    if (stats.rolls.length < MAX_PC_ROLLS && chance(r, 0.2)) stats.rolls.push(randomRoll(r, "own"));
    next.stats = stats;
  }
  if (chance(r, 0.1)) next.level = 1 + Math.floor(r() * 20);
  if (chance(r, 0.1)) next.actor.ac = 10 + Math.floor(r() * 8);
  if (chance(r, 0.1)) next.actor.senses = "";
  if (chance(r, 0.1)) next.actor.speeds = { ...next.actor.speeds, hover: true };
  if (chance(r, 0.15)) next.actor.hp = { ...next.actor.hp, cur: 1 + Math.floor(r() * next.actor.hp.max) };
  if (chance(r, 0.1)) {
    if (next.actor.srdId) {
      delete next.actor.srdId;
      delete next.actor.wildShape;
    } else {
      next.actor.srdId = "brown-bear";
      if (chance(r, 0.7)) next.actor.wildShape = true;
    }
  }
  return next;
}

const STATS_PART_OF = (key: FieldKey) => key.split(".")[0] as keyof PcStats;

function actorValue(c: Character, key: ActorField): FieldValue {
  switch (key) {
    case "level":
      return c.level;
    case "ac":
      return c.actor.ac;
    case "hpMax":
      return c.actor.hp.max;
    case "speeds":
      return { walk: c.actor.speeds.walk, ...(c.actor.speeds.fly ? { fly: c.actor.speeds.fly } : {}) };
    case "senses":
      return sensesWords(c.actor.senses);
  }
}

function fillActorValue(fill: PcFill, key: ActorField, shaped: boolean): FieldValue {
  switch (key) {
    case "level":
      return fill.level;
    case "ac":
      return shaped ? undefined : fill.actor.ac;
    case "hpMax":
      return fill.actor.hpMax;
    case "speeds":
      return shaped || !fill.actor.speeds ? undefined : { walk: fill.actor.speeds.walk, ...(fill.actor.speeds.fly ? { fly: fill.actor.speeds.fly } : {}) };
    case "senses":
      return fill.actor.senses === undefined ? undefined : sensesWords(fill.actor.senses);
  }
}

function baseActorValue(c: Character, key: ActorField): FieldValue {
  const base = c.ddbSync?.base;
  if (!base) return undefined;
  if (key === "senses") return base.senses === undefined ? undefined : sensesWords(base.senses);
  if (key === "speeds") return base.speeds ? { walk: base.speeds.walk, ...(base.speeds.fly ? { fly: base.speeds.fly } : {}) } : undefined;
  return base[key];
}

const ACTOR_FIELDS: ActorField[] = ["level", "ac", "hpMax", "speeds", "senses"];

/** The character a result leaves, through the real reducer, and its Undo. */
function throughReducer(state: RoomState, c: Character, sent: NonNullable<ReturnType<typeof syncPatch>>, seq: number): { after: Character; afterState: RoomState } {
  const op: Op = { t: "character.update", characterId: c.id, patch: sent.patch, expect: sent.expect };
  assert.equal(opSchema.safeParse(op).success, true, `the op parses: ${JSON.stringify(opSchema.safeParse(op).error?.issues.slice(0, 2))}`);
  const allowed = canApply(op, P1, state, { canUseAsset: () => true });
  assert.ok(allowed.ok, "its expect matches the character the review saw");
  const at = new Date(Date.UTC(2026, 9, 21, 19, 0, seq)).toISOString();
  const applied = applyOp(state, op, DM, { seq, at });
  assert.ok(applied.ok, applied.ok ? "" : applied.message);
  return { after: applied.state.characters[c.id]!, afterState: applied.state };
}

function checkStep(r: R, state: RoomState, c: Character, fill: PcFill, mode: "resync" | "editor", seq: number): Character {
  const plan = planSync({ mode, stats: c.stats, level: c.level, character: c, fill });
  const record = plan.source === "same" ? c.ddbSync : undefined;
  const shaped = c.actor.srdId !== undefined;
  const stats = c.stats ?? (EMPTY_PC_STATS as PcStats);

  const none = new Set<string>();
  const all = new Set<string>([...plan.items.filter((i) => i.section === "kept" || i.section === "different").map((i) => i.id), ...plan.also.map((a) => a.id)]);
  const r0 = syncResult(plan, none);
  const rd = syncResult(plan, defaultTicks(plan));
  const ra = syncResult(plan, all);
  const entriesBefore = record?.rolls ?? {};
  const kOfEntry = (res: SyncResult, id: string) => res.record.rolls[hash12(id)]?.k;
  // Each read roll's key and content, as the merge finds them.
  const readKeys = rollKeys(fill.stats.rolls);
  const readByK = new Map(fill.stats.rolls.map((roll, i) => [readKeys[i]!, rollHash(roll)]));
  const whole = (k: string) => fill.read?.[({ w: "weapon", s: "spell", o: "other" } as const)[k[0] as "w" | "s" | "o"]] ?? true;

  // 1. With a record and nothing ticked to take, every field and roll the player changed ends as it was, and none they deleted comes back.
  if (record && mode === "resync") {
    for (const key of SYNC_FIELD_KEYS) {
      const b = fieldOfBase(c, key);
      const now = fieldOf(stats, key);
      if (b === undefined || !same(b, now)) assert.deepEqual(fieldOf(r0.stats, key), now, `1: ${key} kept`);
    }
    for (const key of ACTOR_FIELDS) assert.equal(r0.also[key === "level" ? "level" : key], undefined, `1: ${key} untouched`);
    assert.equal(r0.also.name, undefined);
    for (const roll of stats.rolls) {
      const entry = entriesBefore[hash12(roll.id)];
      if (entry && rollHash(roll) === entry.h) continue;
      assert.deepEqual(r0.stats.rolls.find((x) => x.id === roll.id), roll, `1: the player's roll ${roll.name} kept`);
    }
    const held = new Set(stats.rolls.map((roll) => hash12(roll.id)));
    const removed = new Set([...Object.entries(entriesBefore).filter(([id]) => !held.has(id)).map(([, e]) => e.k), ...(record.gone ?? [])]);
    // An entry of a removed roll may stay while its kind is not read whole, but no roll in the block comes back to it.
    for (const roll of r0.stats.rolls) {
      const k = r0.record.rolls[hash12(roll.id)]?.k;
      if (k !== undefined && removed.has(k)) assert.ok(held.has(hash12(roll.id)), "1: a removed roll stays removed");
    }
  }

  // 2. With a record, every field and roll the player did not change ends as D&D Beyond's where it was read.
  if (record) {
    for (const key of SYNC_FIELD_KEYS) {
      const b = fieldOfBase(c, key);
      const theirs = fieldOf(fillStats(fill), key);
      if (!readsField(fill, key) || b === undefined || !same(b, fieldOf(stats, key))) continue;
      assert.deepEqual(fieldOf(rd.stats, key), theirs, `2: ${key} comes in`);
    }
    for (const key of ACTOR_FIELDS) {
      const theirs = fillActorValue(fill, key, shaped);
      const b = baseActorValue(c, key);
      if (theirs === undefined || (b !== undefined && !same(b, actorValue(c, key)))) continue;
      const ends = rd.also[key] === undefined ? actorValue(c, key) : key === "senses" ? sensesWords(rd.also.senses!) : key === "speeds" ? { walk: rd.also.speeds!.walk, ...(rd.also.speeds!.fly ? { fly: rd.also.speeds!.fly } : {}) } : rd.also[key];
      assert.deepEqual(ends, theirs, `2: ${key} comes in, ticked`);
    }
    for (const roll of stats.rolls) {
      const entry = entriesBefore[hash12(roll.id)];
      if (!entry || rollHash(roll) !== entry.h || plan.rolls.slots.some((s) => s.roll === roll && !s.entry && !s.item)) continue;
      const after = rd.stats.rolls.find((x) => x.id === roll.id);
      const theirs = readByK.get(entry.k);
      if (theirs !== undefined) assert.equal(after && rollHash(after), theirs, `2: ${roll.name} takes D&D Beyond's`);
      else if (whole(entry.k)) assert.equal(after, undefined, `2: ${roll.name} removed there goes`);
      else assert.deepEqual(after, roll, `3: ${roll.name} of a kind not read whole stays`);
    }
    if (rd.notFit === 0 && plan.rolls.unlinked.length === 0) {
      const claimed = new Set([...Object.values(entriesBefore).map((e) => e.k), ...(record.gone ?? [])]);
      const linked = new Set(Object.values(rd.record.rolls).map((e) => e.k));
      for (const k of readByK.keys()) if (!claimed.has(k)) assert.ok(linked.has(k), "2: a roll D&D Beyond added comes in, or links the player's own");
    }
  }

  // Hover is the player's, which no read has, so whatever a sync sets of the speeds keeps it.
  for (const res of [rd, ra]) if (res.also.speeds) assert.equal(res.also.speeds.hover, c.actor.speeds.hover, "Hover kept");

  // 3. A field not read, or a roll of a kind not read whole, never changes, and its base or entry stays.
  for (const res of [r0, rd, ra]) {
    for (const key of SYNC_FIELD_KEYS) {
      if (readsField(fill, key)) continue;
      assert.deepEqual(fieldOf(res.stats, key), fieldOf(stats, key), `3: ${key} not read`);
      if (record) assert.deepEqual((res.record.base as Record<string, unknown>)[STATS_PART_OF(key)], (record.base as Record<string, unknown>)[STATS_PART_OF(key)], `3: ${key}'s base`);
    }
    for (const key of ACTOR_FIELDS) if (fillActorValue(fill, key, shaped) === undefined) assert.equal(res.also[key], undefined, `3: ${key} not read`);
    for (const roll of stats.rolls) {
      const entry = record?.rolls[hash12(roll.id)];
      if (!entry || readByK.has(entry.k) || whole(entry.k)) continue;
      if (plan.rolls.slots.some((s) => s.roll === roll && !s.entry && !s.item)) continue;
      assert.deepEqual(res.stats.rolls.find((x) => x.id === roll.id), roll, "3: a roll of a kind not read whole stays");
      assert.deepEqual(res.record.rolls[hash12(roll.id)], entry, "3: and its entry");
    }
  }

  // 4. With every Overwrite and Take these ticked, every read field ends as D&D Beyond's, and the synced rolls equal its rolls.
  if (mode === "resync") {
    for (const key of SYNC_FIELD_KEYS) if (readsField(fill, key)) assert.deepEqual(fieldOf(ra.stats, key), fieldOf(fillStats(fill), key), `4: ${key}`);
    for (const key of ACTOR_FIELDS) {
      const theirs = fillActorValue(fill, key, shaped);
      if (theirs === undefined || same(theirs, actorValue(c, key))) continue;
      const ends = key === "senses" ? sensesWords(ra.also.senses!) : key === "speeds" ? { walk: ra.also.speeds!.walk, ...(ra.also.speeds!.fly ? { fly: ra.also.speeds!.fly } : {}) } : ra.also[key];
      assert.deepEqual(ends, theirs, `4: ${key}`);
    }
    if (ra.notFit === 0 && plan.rolls.unlinked.length === 0) {
      const linked = new Map(ra.stats.rolls.flatMap((roll) => (kOfEntry(ra, roll.id) ? [[kOfEntry(ra, roll.id)!, roll] as const] : [])));
      for (const [k, h] of readByK) {
        if (process.env.SYNC_DEBUG && (linked.get(k) && rollHash(linked.get(k)!)) !== h) console.log(JSON.stringify({ k, h, got: linked.get(k), block: stats.rolls.map((x) => [x.id, x.name, rollHash(x), entriesBefore[hash12(x.id)]]), reads: fill.stats.rolls.map((x) => [x.id, x.name, rollHash(x)]), items: plan.items.filter((i) => i.type === "roll").map((i) => [i.id, i.type === "roll" && i.case, i.section]), slots: plan.rolls.slots.map((s) => [s.roll.name, s.entry, s.item?.case]), source: plan.source, mode }, null, 0));
        assert.equal(linked.get(k) && rollHash(linked.get(k)!), h, "4: every roll D&D Beyond has, as it has it");
      }
      for (const [k] of linked) if (!readByK.has(k)) assert.equal(whole(k), false, "4: a synced roll it lacks is of a kind not read whole");
    }
  }

  // The ticks of this step, at random.
  const ticks = new Set<string>([...plan.items.map((i) => i.id), ...plan.also.map((a) => a.id)].filter(() => chance(r, 0.5)));
  const result = syncResult(plan, ticks);

  // 6. Ids stay, are unique, at most 40, and the block and record pass their schemas and sizes.
  const blockIds = new Set(stats.rolls.map((roll) => roll.id));
  const outIds = result.stats.rolls.map((roll) => roll.id);
  assert.equal(new Set(outIds).size, outIds.length, "6: unique ids");
  assert.ok(outIds.length <= MAX_PC_ROLLS, "6: at most 40");
  for (const roll of result.stats.rolls) if (!blockIds.has(roll.id)) assert.ok(fill.stats.rolls.some((x) => x.id === roll.id), "6: a new roll takes the read's id");
  const size = serializedBytes(result.stats);
  if (size <= LIMITS.pcStatsBytes) assert.equal(pcStatsForImport.safeParse(result.stats).success, true, "6: the block passes");
  assert.equal(ddbSyncPatchSchema.safeParse(result.record).success, true, `6: the record passes: ${JSON.stringify(ddbSyncPatchSchema.safeParse(result.record).error?.issues.slice(0, 2))}`);
  assert.ok(Object.keys(result.record.rolls).length <= MAX_PC_ROLLS);

  // 8. Every changed or kept item has one line, and the done line's counts add up.
  const lineIds = [...plan.items.map((i) => i.id), ...plan.also.map((a) => a.id)];
  assert.equal(new Set(lineIds).size, lineIds.length, "8: one line each");
  const fieldKeys = lineIds.map((id) => id.replace(/^(field|also):/, ""));
  assert.equal(new Set(fieldKeys).size, fieldKeys.length, "8: a field never in two sections");
  const n = result.counts;
  assert.equal(n.cameIn + n.removed + n.cameBack + n.stayed + result.notFit, plan.items.length + plan.also.length, "8: the counts add up");
  for (const item of plan.items) if (item.section === "changes") assert.equal(takesTheirs(item, ticks), true);

  const sent = syncPatch(c, result);
  if (!sent) {
    // Nothing to send means nothing would change: the block, the fields beside it and the record are as they are.
    assert.deepEqual(result.stats, stats);
    assert.ok(c.ddbSync && sameRecord(result.record, c.ddbSync));
    return c;
  }

  // 7. The undo patch, applied after the sync's, gives back everything, exactly the current and maximum HP included.
  const { after, afterState } = throughReducer(state, c, sent, seq);
  const simulated = afterSync(c, sent.patch, after.ddbSync!.at);
  assert.deepEqual(expectOf(simulated, EXPECT_PARTS), expectOf(after, EXPECT_PARTS), "7: the device works out what the server holds");
  assert.equal(ddbSyncForImport.safeParse(after.ddbSync).success, true, "6: the stored record passes");
  assert.ok(serializedBytes(after.ddbSync) <= LIMITS.ddbSyncBytes);
  for (const roll of stats.rolls) {
    const out = after.stats!.rolls.find((x) => x.id === roll.id);
    if (out) assert.equal(out.id, roll.id, "6: a roll that stays keeps its id");
  }
  const undo = undoSync(c, sent.patch, stampedAt({ t: "character.update", characterId: c.id, patch: sent.patch, expect: sent.expect }, afterState));
  assert.ok(undo, "7: Undo is offered");
  const undoOp: Op = { t: "character.update", characterId: c.id, patch: undo.patch, expect: undo.expect };
  assert.equal(opSchema.safeParse(undoOp).success, true);
  assert.ok(canApply(undoOp, P1, afterState, { canUseAsset: () => true }).ok, "7: Undo's expect matches what Apply left");
  const back = applyOp(afterState, undoOp, DM, { seq: seq + 1, at: "2026-10-22T19:00:00.000Z" });
  assert.ok(back.ok);
  const restored = back.state.characters[c.id]!;
  assert.deepEqual(restored.stats, c.stats, "7: the block");
  assert.equal(restored.level, c.level);
  assert.equal(restored.name, c.name);
  assert.equal(restored.actor.ac, c.actor.ac);
  assert.deepEqual(restored.actor.speeds, c.actor.speeds);
  assert.equal(restored.actor.senses, c.actor.senses);
  assert.equal(restored.actor.sheetUrl, c.actor.sheetUrl);
  assert.deepEqual([restored.actor.hp.cur, restored.actor.hp.max], [c.actor.hp.cur, c.actor.hp.max], "7: exactly the HP");
  assert.deepEqual(restored.ddbSync, c.ddbSync, "7: the record");

  // 5. The new base is D&D Beyond's for every read field, and a re-sync at once with the same data brings nothing in.
  for (const key of SYNC_FIELD_KEYS) if (readsField(fill, key)) assert.deepEqual(fieldOfBase(after, key), fieldOf(fillStats(fill), key), `5: ${key}'s base`);
  if (result.notFit === 0 && result.goneDropped.length === 0) {
    const again = planSync({ mode, stats: after.stats, level: after.level, character: after, fill: { ...fill, stats: { ...fill.stats, rolls: fill.stats.rolls.map((roll) => ({ ...roll, id: newId("again") })) } } });
    assert.deepEqual(again.items.filter((i) => i.section === "changes").map((i) => i.id), [], "5: nothing comes in");
    const notTaken = (id: string) => !takesTheirs([...plan.items, ...plan.also].find((x) => x.id === id)!, ticks);
    const expected = new Set([
      ...plan.items.filter((i) => i.section !== "changes" && notTaken(i.id) && !(i.type === "roll" && i.case === "goneThere")).map((i) => i.id),
      ...plan.also.filter((a) => !ticks.has(a.id) && a.key !== "name" && a.key !== "sheetUrl").map((a) => `field:${a.key}`),
    ]);
    assert.deepEqual(new Set(again.items.map((i) => i.id)), expected, "5: the kept list is the same, a roll removed there while edited listed once");
    assert.deepEqual(new Set(again.also.map((a) => a.key)), new Set(plan.also.filter((a) => !ticks.has(a.id) && (a.key === "name" || a.key === "sheetUrl")).map((a) => a.key)));
    if (again.items.length === 0 && again.also.length === 0) assert.equal(syncPatch(after, syncResult(again, new Set())), null, "5: Done sends nothing");
  }
  return after;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fillStats(fill: PcFill): PcStats {
  const f = fill.stats;
  return {
    abilities: f.abilities ?? EMPTY_PC_STATS.abilities,
    saves: f.saves ?? [],
    skills: f.skills ?? {},
    adjust: f.adjust ?? {},
    defenses: f.defenses ?? {},
    rolls: f.rolls,
    ...(f.spellAbility ? { spellAbility: f.spellAbility } : {}),
    ...(f.jack ? { jack: true as const } : {}),
    ...(f.alert ? { alert: true as const } : {}),
    ...(f.evasion ? { evasion: true as const } : {}),
    ...(f.critOn ? { critOn: f.critOn } : {}),
  };
}

function readsField(fill: PcFill, key: FieldKey): boolean {
  return fill.stats[STATS_PART_OF(key) as keyof PcFill["stats"]] !== undefined;
}

function fieldOfBase(c: Pick<Character, "ddbSync">, key: FieldKey): FieldValue {
  const base = c.ddbSync?.base;
  if (!base || (base as Record<string, unknown>)[STATS_PART_OF(key)] === undefined) return undefined;
  const asStats = fillStats({ source: "ddb", stats: { ...base, rolls: [] }, actor: {}, warnings: [] });
  return fieldOf(asStats, key);
}

/** One random life of Bree: where she starts, then up to six syncs with edits on both sides between them. */
function life(seed: number): void {
  const r = rng(seed);
  const filler = chance(r, 0.1);
  let truth = randomTruth(r, filler);
  const start = pick(r, ["none", "typed", "imported"] as const);
  let c: Character = testCharacter("bree", {
    name: "Bree",
    ownerIds: ["p1"],
    actor: testActor({ ac: 15, hp: { cur: 20, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "", sheetUrl: "https://www.dndbeyond.com/characters/12345678" }),
    level: 5,
  });
  if (start === "typed") c.stats = { ...(structuredClone(EMPTY_PC_STATS) as PcStats), spellAbility: "cha", rolls: [randomRoll(r, "own"), randomRoll(r, "own")] };
  if (start === "imported") c.stats = { ...(structuredClone(EMPTY_PC_STATS) as PcStats), rolls: truth.stats.rolls.slice(0, 5).map((roll) => ({ ...roll, id: newId("old"), ddb: true as const })) };
  let state: RoomState = room({ characters: { bree: c } });
  const steps = 1 + Math.floor(r() * 6);
  for (let step = 0; step < steps; step++) {
    if (step > 0 && chance(r, 0.7)) truth = changeTruth(r, truth);
    if (step > 0 && chance(r, 0.7)) c = edit(r, c);
    state = { ...state, characters: { ...state.characters, bree: c } };
    const fill = readOf(r, truth);
    const mode = chance(r, 0.2) ? "editor" : "resync";
    c = checkStep(r, state, c, fill, mode, 10 + step * 2);
    state = { ...state, characters: { ...state.characters, bree: c } };
  }
}

test("a re-sync's eight invariants hold over many random lives (docs/design-v1-resync.md 5)", () => {
  const runs = Number(process.env.SYNC_RUNS ?? 600);
  for (let seed = 1; seed <= runs; seed++) {
    try {
      life(seed);
    } catch (err) {
      throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
    }
  }
});

/** The cap on removed markers over a long life: deletions under incomplete reads keep at most 40, dropping the oldest first. */
test("40 markers hold over many deletions under incomplete reads", () => {
  const r = rng(7);
  const rolls = Array.from({ length: 40 }, (_, i): PcRoll => ({ id: newId("t"), name: `Blade ${i}`, kind: "weapon", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6" }] }));
  const truth: Truth = { ...randomTruth(r, false), stats: { ...(structuredClone(EMPTY_PC_STATS) as PcStats), rolls } };
  let c: Character = testCharacter("bree", { name: "Bree", ownerIds: ["p1"], actor: testActor({ sheetUrl: "https://www.dndbeyond.com/characters/12345678" }), level: 5 });
  let state = room({ characters: { bree: c } });
  const read = (whole: boolean) => {
    const fill = readOf(rng(1), truth);
    fill.stats = { ...fill.stats, rolls: truth.stats.rolls.map((roll) => ({ ...roll, id: newId("read"), ddb: true as const })) };
    fill.read = { weapon: whole, spell: true, other: true };
    return fill;
  };
  const first = planSync({ mode: "resync", stats: undefined, level: 5, character: c, fill: read(true) });
  c = throughReducer(state, c, syncPatch(c, syncResult(first, defaultTicks(first)))!, 1).after;
  const dropped: string[] = [];
  for (let i = 0; i < 45 && c.stats!.rolls.length > 0; i++) {
    c = { ...c, stats: { ...c.stats!, rolls: c.stats!.rolls.slice(1) } };
    state = { ...state, characters: { bree: c } };
    const p = planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill: read(false) });
    const result = syncResult(p, new Set());
    dropped.push(...result.goneDropped.map((d) => d.k));
    c = throughReducer(state, c, syncPatch(c, result)!, 2 + i).after;
    assert.ok((c.ddbSync!.gone?.length ?? 0) <= 40);
  }
  assert.equal(c.ddbSync!.gone!.length, 40);
  assert.equal(dropped.length, 0, "40 deletions of 40 rolls fit exactly");
});
