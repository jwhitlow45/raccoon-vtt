import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHARACTER_CHANGED, serializedBytes, LIMITS } from "../limits.ts";
import type { Character, DdbBase, PcRoll, PcStats } from "../model.ts";
import { canApply } from "../permissions.ts";
import { ddbSyncForImport, ddbSyncPatchSchema, pcStatsForImport, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { stampedAt } from "../reducer/tokens.ts";
import type { PcFill } from "./pcFill.ts";
import {
  afterSync,
  bulkIds,
  bulkPressed,
  bulkToggle,
  defaultTicks,
  fieldOf,
  hash12,
  leavesAsIs,
  planSync,
  rollHash,
  recordFits,
  rollKeys,
  sameRecord,
  syncPatch,
  syncResult,
  undoSync,
  withField,
  SYNC_FIELD_KEYS,
  SYNC_GROUPS,
  type FieldKey,
  type FieldValue,
  type SyncCharacter,
  type SyncInput,
  type SyncPlan,
} from "./pcSync.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";
import { DM, P1, actor, character, room } from "../testutil.ts";

/**
 * The re-sync merge (docs/design-v1-resync.md 2 and 5): a table of each
 * field's and each roll's cases, then the cases the note names one by one.
 * The randomized test of section 5 is in pcSync.random.test.ts.
 */

const AT = "2026-10-20T19:00:00.000Z";
const SHEET = "https://www.dndbeyond.com/characters/12345678";

const empty = (): PcStats => structuredClone(EMPTY_PC_STATS) as PcStats;

/** Every part of a block as a whole read gives it. */
export function fillOf(stats: PcStats, over: Partial<PcFill> = {}, actorOver: PcFill["actor"] = {}): PcFill {
  return {
    source: "ddb",
    stats: {
      abilities: stats.abilities,
      saves: stats.saves,
      skills: stats.skills,
      adjust: stats.adjust,
      defenses: stats.defenses,
      spellAbility: stats.spellAbility ?? null,
      jack: stats.jack === true,
      alert: stats.alert === true,
      evasion: stats.evasion === true,
      critOn: stats.critOn ?? null,
      rolls: stats.rolls,
    },
    level: 5,
    name: "Bree",
    actor: { ac: 15, hpMax: 38, speeds: { walk: 30 }, sheetUrl: SHEET, ...actorOver },
    warnings: [],
    read: { weapon: true, spell: true, other: true },
    ...over,
  };
}

function baseOf(stats: PcStats, extra: Partial<DdbBase> = {}): DdbBase {
  const f = fillOf(stats).stats;
  const { rolls: _rolls, ...parts } = f;
  return { ...parts, level: 5, ac: 15, hpMax: 38, speeds: { walk: 30 }, ...extra };
}

function bree(stats: PcStats | undefined, over: Partial<SyncCharacter> = {}): SyncCharacter {
  const c: SyncCharacter = { name: "Bree", level: 5, actor: actor({ ac: 15, hp: { cur: 20, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "", sheetUrl: SHEET }), ...over };
  if (stats) c.stats = stats;
  return c;
}

function plan(c: SyncCharacter, fill: PcFill, mode: SyncInput["mode"] = "resync"): SyncPlan {
  return planSync({ mode, stats: c.stats, level: c.level, character: c, fill });
}

/** The character after Apply with these ticks, as the server leaves it. */
function applied(c: SyncCharacter, p: SyncPlan, ticks: ReadonlySet<string> = defaultTicks(p)): SyncCharacter {
  const sent = syncPatch(c, syncResult(p, ticks));
  return sent ? afterSync(c, sent.patch, AT) : c;
}

/** A first sync from no block, which takes everything read. */
function synced(fill: PcFill, over: Partial<SyncCharacter> = {}): SyncCharacter {
  const c = bree(undefined, over);
  return applied(c, plan(c, fill));
}

let next = 0;
/** The rolls as a new read gives them: each with a new id, as the reader makes. */
function read(rolls: readonly PcRoll[]): PcRoll[] {
  return rolls.map((r) => ({ ...r, id: `read-${++next}`, ddb: true }));
}

const longsword = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "x", name: "Longsword", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "slashing" }], ...over });
const shortbow = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "x", name: "Shortbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", mod: true, type: "piercing" }], ...over });
const shillelagh = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "x", name: "Shillelagh", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "bludgeoning" }], ...over });
const moonbeam = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "x", name: "Moonbeam", kind: "spell", ability: "spell", level: 2, save: { ability: "con" }, dice: [{ formula: "2d10", type: "radiant" }], ...over });
const wildfire = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "x", name: "Wild Companion", kind: "other", dice: [{ formula: "1d4" }], ...over });

function item(p: SyncPlan, id: string) {
  return p.items.find((i) => i.id === id);
}

/** Three distinct values for a field where it has them, two for a flag or a save. */
function valuesOf(key: FieldKey): FieldValue[] {
  if (key.startsWith("abilities.")) return [10, 13, 16];
  if (key.startsWith("saves.") || key === "jack" || key === "alert" || key === "evasion") return [false, true];
  if (key.startsWith("skills.")) return [null, "prof", "expert"];
  if (key.startsWith("adjust.")) return [0, 1, 2];
  if (key.startsWith("defenses.")) return [null, "resistant", "immune"];
  if (key === "spellAbility") return [null, "wis", "cha"];
  if (key === "critOn") return [20, 19, 18];
  throw new Error(key);
}

describe("each field three ways (2.2, 2.3)", () => {
  type Row = { name: string; b?: number; c: number; n: number; record: boolean; section: string | null; ends: "c" | "n" };
  const rows: Row[] = [
    { name: "a record and nothing changed", b: 0, c: 0, n: 0, record: true, section: null, ends: "c" },
    { name: "D&D Beyond changed it", b: 0, c: 0, n: 1, record: true, section: "changes", ends: "n" },
    { name: "the player changed it", b: 0, c: 1, n: 0, record: true, section: "kept", ends: "c" },
    { name: "both reached one value", b: 0, c: 1, n: 1, record: true, section: null, ends: "c" },
    { name: "both changed it apart", b: 0, c: 1, n: 2, record: true, section: "kept", ends: "c" },
    { name: "no record, alike", c: 0, n: 0, record: false, section: null, ends: "c" },
    { name: "no record, different", c: 0, n: 1, record: false, section: "different", ends: "c" },
    { name: "a record with no base for the field", c: 0, n: 1, record: true, section: "different", ends: "c" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      for (const key of SYNC_FIELD_KEYS) {
        const values = valuesOf(key);
        if (Math.max(row.b ?? 0, row.c, row.n) >= values.length) continue;
        const v = (i: number) => values[i]!;
        const stats = withField(empty(), key, v(row.c));
        const theirs = withField(empty(), key, v(row.n));
        const fill = fillOf(theirs);
        let base: DdbBase | undefined;
        if (row.record) {
          base = baseOf(withField(empty(), key, v(row.b ?? 0)));
          // The part that holds the field, left out of the base.
          if (row.b === undefined) delete base[key.split(".")[0] as keyof DdbBase];
        }
        const c = bree(stats, row.record ? { ddbSync: { at: AT, from: "12345678", base: base!, rolls: {} } } : {});
        const p = plan(c, fill);
        const found = item(p, `field:${key}`);
        assert.equal(found?.section ?? null, row.section, `${key}: listed`);
        if (found) assert.equal(found.type === "field" && found.conflict, row.name === "both changed it apart", `${key}: tagged`);
        const result = syncResult(p, defaultTicks(p));
        assert.deepEqual(fieldOf(result.stats, key), row.ends === "n" ? v(row.n) : v(row.c), `${key}: ends`);
        // Every read field's base becomes D&D Beyond's, whatever happened to it.
        const out = withField(empty(), key, fieldOf(fill.stats as PcStats, key));
        assert.deepEqual(fieldOf({ ...empty(), ...(result.record.base as Partial<PcStats>) } as PcStats, key), fieldOf(out, key), `${key}: base`);
        if (found && found.section !== "changes") {
          const taken = syncResult(p, new Set([...defaultTicks(p), found.id]));
          assert.deepEqual(fieldOf(taken.stats, key), v(row.n), `${key}: Overwrite or Take these`);
        }
      }
    });
  }

  test("a first sync, with no block, takes every field read, and a part the fill left out keeps no base", () => {
    const theirs = withField(withField(empty(), "abilities.wis", 16), "spellAbility", "wis");
    const fill = fillOf(theirs);
    delete fill.stats.defenses;
    const c = bree(undefined);
    const p = plan(c, fill);
    assert.equal(p.source, "first");
    assert.deepEqual(
      p.items.filter((i) => i.type === "field").map((i) => [i.id, i.section]),
      [
        ["field:abilities.wis", "changes"],
        ["field:spellAbility", "changes"],
      ],
    );
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.stats.spellAbility, "wis");
    assert.equal(result.record.base.defenses, undefined);
  });

  test("a part not read changes nothing and keeps its base", () => {
    const stats = withField(empty(), "spellAbility", "cha");
    const base = baseOf(withField(empty(), "spellAbility", "int"));
    const c = bree(stats, { ddbSync: { at: AT, from: "12345678", base, rolls: {} } });
    const fill = fillOf(withField(empty(), "spellAbility", "wis"));
    delete fill.stats.spellAbility;
    const p = plan(c, fill);
    assert.equal(item(p, "field:spellAbility"), undefined);
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.stats.spellAbility, "cha");
    assert.equal(result.record.base.spellAbility, "int");
  });

  test("the editor with no record fills, listing what it replaces with Keep mine", () => {
    const c = bree(withField(empty(), "spellAbility", "cha"));
    const p = plan(c, fillOf(withField(empty(), "spellAbility", "wis")), "editor");
    assert.equal(item(p, "field:spellAbility")?.section, "replaces");
    assert.equal(syncResult(p, defaultTicks(p)).stats.spellAbility, "wis");
    assert.equal(syncResult(p, new Set([...defaultTicks(p), "field:spellAbility"])).stats.spellAbility, "cha", "Keep mine");
  });

  test("the editor with a record and no base for Spellcasting ability keeps Charisma under Different", () => {
    const base = baseOf(empty());
    delete base.spellAbility;
    const c = bree(withField(empty(), "spellAbility", "cha"), { ddbSync: { at: AT, from: "12345678", base, rolls: {} } });
    const p = plan(c, fillOf(withField(empty(), "spellAbility", "wis")), "editor");
    assert.equal(item(p, "field:spellAbility")?.section, "different");
    assert.equal(syncResult(p, defaultTicks(p)).stats.spellAbility, "cha");
  });

  test("the request's druid: a Charisma caster set by hand is kept on every re-sync, and Overwrite takes Wisdom", () => {
    const first = synced(fillOf(withField(empty(), "spellAbility", "wis")));
    const mine = { ...first, stats: { ...first.stats!, spellAbility: "cha" as const } };
    const fill = fillOf(withField(empty(), "spellAbility", "wis"));
    const p = plan(mine, fill);
    assert.equal(item(p, "field:spellAbility")?.section, "kept");
    const kept = applied(mine, p);
    assert.equal(kept.stats!.spellAbility, "cha");
    // Kept, then D&D Beyond moves on: listed again, tagged.
    const again = plan(kept, fillOf(withField(empty(), "spellAbility", "int")));
    const row = item(again, "field:spellAbility");
    assert.equal(row?.section, "kept");
    assert.equal(row?.type === "field" && row.conflict, true);
    assert.equal(applied(kept, again, new Set(["field:spellAbility"])).stats!.spellAbility, "int");
  });

  test("saves in a new order change nothing, and a save that changes writes the list in ability order", () => {
    const first = synced(fillOf({ ...empty(), saves: ["wis", "int"] }));
    assert.deepEqual(first.stats!.saves, ["int", "wis"]);
    const reordered = { ...first, stats: { ...first.stats!, saves: ["wis", "int"] as PcStats["saves"] } };
    const p = plan(reordered, fillOf({ ...empty(), saves: ["int", "wis"] }));
    assert.equal(p.items.length, 0);
    assert.equal(syncPatch(reordered, syncResult(p, defaultTicks(p))), null, "nothing to send");
    const more = plan(reordered, fillOf({ ...empty(), saves: ["dex", "int", "wis"] }));
    const result = syncResult(more, defaultTicks(more));
    assert.deepEqual(result.stats.saves, ["dex", "int", "wis"]);
  });
});

describe("level, max HP, AC, Speed and senses keep their ticks (2.2, 2.3)", () => {
  test("a change there is a ticked Also set line, and unticked the value stays while the base moves, so the next sync keeps it", () => {
    const first = synced(fillOf(empty()));
    const fill = fillOf(empty(), { level: 6 }, { ac: 16 });
    const p = plan(first, fill);
    assert.deepEqual(
      p.also.map((a) => [a.key, a.on]),
      [
        ["level", true],
        ["ac", true],
      ],
    );
    const ticked = applied(first, p);
    assert.equal(ticked.level, 6);
    assert.equal(ticked.actor.ac, 16);
    const unticked = applied(first, p, new Set(["also:ac"]));
    assert.equal(unticked.level, 5, "unticked keeps the level");
    assert.equal(unticked.ddbSync!.base.level, 6, "and the base moves");
    const next = plan(unticked, fill);
    assert.equal(item(next, "field:level")?.section, "kept");
    assert.equal(next.also.length, 0);
  });

  test("a value the player changed is kept, Overwrite takes D&D Beyond's, and none shows in both sections", () => {
    const first = synced(fillOf(empty()));
    const mine = { ...first, actor: { ...first.actor, ac: 17 } };
    const p = plan(mine, fillOf(empty(), {}, { ac: 16 }));
    assert.equal(item(p, "field:ac")?.section, "kept");
    assert.equal(p.also.some((a) => a.key === "ac"), false);
    assert.equal(applied(mine, p).actor.ac, 17);
    assert.equal(applied(mine, p, new Set(["field:ac"])).actor.ac, 16);
  });

  test("Speed merges per kind and never touches Hover", () => {
    const first = synced(fillOf(empty()));
    const hovering = { ...first, actor: { ...first.actor, speeds: { walk: 30, hover: true } } };
    const p = plan(hovering, fillOf(empty(), {}, { speeds: { walk: 35, fly: 30 } }));
    assert.deepEqual(applied(hovering, p).actor.speeds, { walk: 35, fly: 30, hover: true });
    assert.equal(plan(hovering, fillOf(empty())).also.length, 0, "Hover alone is no difference");
  });

  test("Max HP by the companion rule: hurt keeps its HP, unhurt stays full, and a cut is exact on Undo", () => {
    const first = synced(fillOf(empty()));
    const hurt = { ...first, actor: { ...first.actor, hp: { cur: 20, max: 38, temp: 0 } } };
    const p = plan(hurt, fillOf(empty(), {}, { hpMax: 45 }));
    assert.deepEqual(applied(hurt, p).actor.hp, { cur: 20, max: 45, temp: 0 });
    const full = { ...first, actor: { ...first.actor, hp: { cur: 38, max: 38, temp: 0 } } };
    assert.deepEqual(applied(full, plan(full, fillOf(empty(), {}, { hpMax: 45 }))).actor.hp, { cur: 45, max: 45, temp: 0 });
    const high = { ...first, actor: { ...first.actor, hp: { cur: 35, max: 38, temp: 0 } } };
    const down = plan(high, fillOf(empty(), {}, { hpMax: 30 }));
    const sent = syncPatch(high, syncResult(down, defaultTicks(down)))!;
    const after = afterSync(high, sent.patch, AT);
    assert.deepEqual(after.actor.hp, { cur: 30, max: 30, temp: 0 });
    const undo = undoSync(high, sent.patch, AT)!;
    assert.deepEqual(undo.patch.actor?.hp, { cur: 35, max: 38 });
    assert.deepEqual(afterSync(after, undo.patch, AT).actor.hp, { cur: 35, max: 38, temp: 0 });
  });

  test("AC and Speed are not read in a shape: no line, base unchanged, and once the shape ends AC comes in under Also set", () => {
    const first = synced(fillOf(empty()));
    const shaped = { ...first, actor: { ...first.actor, srdId: "brown-bear", wildShape: true as const, ac: 11, speeds: { walk: 40, climb: 30 } } };
    const fill = fillOf(empty(), {}, { ac: 16 });
    const p = plan(shaped, fill);
    assert.equal(p.shaped, "wild");
    assert.equal(p.also.length, 0);
    const after = applied(shaped, p);
    assert.equal(after.ddbSync!.base.ac, 15, "the base keeps the last AC read");
    const ended = { ...after, actor: { ...after.actor, srdId: undefined, wildShape: undefined, ac: 15, speeds: { walk: 30 } } };
    delete ended.actor.srdId;
    delete ended.actor.wildShape;
    const again = plan(ended, fill);
    assert.deepEqual(
      again.also.map((a) => a.key),
      ["ac"],
    );
  });

  test("the name is always an unticked offer and never in the base", () => {
    const first = synced(fillOf(empty(), { name: "Bree Tallow" }));
    assert.equal(first.name, "Bree", "a first sync leaves the name");
    assert.equal("name" in first.ddbSync!.base, false);
    const p = plan(first, fillOf(empty(), { name: "Bree Tallow" }));
    assert.deepEqual(
      p.also.map((a) => [a.key, a.on]),
      [["name", false]],
    );
    assert.equal(applied(first, p, new Set(["also:name"])).name, "Bree Tallow");
  });

  test("a sheet link to another number than the read's is offered ticked, so the next re-sync fetches this one, and a relinked read compares nothing", () => {
    const first = synced(fillOf(empty()));
    const other = "https://www.dndbeyond.com/characters/87654321";
    const p = plan(first, fillOf(withField(empty(), "abilities.wis", 18), {}, { sheetUrl: other }));
    assert.equal(p.source, "relinked");
    assert.equal(item(p, "field:abilities.wis")?.section, "different");
    const line = p.also.find((a) => a.key === "sheetUrl");
    assert.equal(line?.on, true);
    const after = applied(first, p);
    assert.equal(after.actor.sheetUrl, other);
    assert.equal(after.ddbSync!.from, "87654321");
    // A link the player chose that is not D&D Beyond's stays theirs.
    const own = { ...first, actor: { ...first.actor, sheetUrl: "https://example.com/bree" } };
    assert.equal(plan(own, fillOf(empty())).also.length, 0);
  });
});

describe("each roll's case (2.4)", () => {
  /** Bree synced with a Longsword, a Shortbow and Shillelagh, and the block's rolls by name. */
  function start() {
    const first = synced(fillOf({ ...empty(), rolls: read([longsword(), shortbow(), shillelagh()]) }));
    const by = (c: SyncCharacter, name: string) => c.stats!.rolls.find((r) => r.name === name);
    return { first, by };
  }
  const edit = (c: SyncCharacter, name: string, change: (r: PcRoll) => PcRoll | null): SyncCharacter => ({
    ...c,
    stats: { ...c.stats!, rolls: c.stats!.rolls.flatMap((r) => (r.name === name ? (change(r) ? [change(r)!] : []) : [r])) },
  });
  const ddb = (...rolls: PcRoll[]) => fillOf({ ...empty(), rolls: read(rolls) });
  const caseOf = (p: SyncPlan, name: string) => p.items.find((i) => i.type === "roll" && (i.mine?.name === name || i.theirs?.roll.name === name));

  test("D&D Beyond added it: it comes in with its mark, and a re-sync of the same data adds nothing", () => {
    const { first } = start();
    const p = plan(first, ddb(longsword(), shortbow(), shillelagh(), moonbeam()));
    const row = caseOf(p, "Moonbeam");
    assert.equal(row?.type === "roll" && row.case, "add");
    const after = applied(first, p);
    assert.equal(after.stats!.rolls.find((r) => r.name === "Moonbeam")?.ddb, true);
    assert.equal(plan(after, ddb(longsword(), shortbow(), shillelagh(), moonbeam())).items.length, 0);
  });

  test("removed there and untouched: it goes, and removed there but edited: kept as the player's own with Remove it", () => {
    const { first } = start();
    const p = plan(first, ddb(longsword(), shillelagh()));
    assert.equal(caseOf(p, "Shortbow")?.type === "roll" && (caseOf(p, "Shortbow") as { case: string }).case, "remove");
    assert.equal(applied(first, p).stats!.rolls.some((r) => r.name === "Shortbow"), false);
    const edited = edit(first, "Shortbow", (r) => ({ ...r, attack: { prof: true, bonus: 1 } }));
    const q = plan(edited, ddb(longsword(), shillelagh()));
    const row = caseOf(q, "Shortbow");
    assert.equal(row?.type === "roll" && row.case, "goneThere");
    assert.equal(row?.section, "kept");
    const kept = applied(edited, q);
    assert.equal(kept.stats!.rolls.some((r) => r.name === "Shortbow"), true);
    // Listed once, then the player's own.
    assert.equal(caseOf(plan(kept, ddb(longsword(), shillelagh())), "Shortbow"), undefined);
    assert.equal(applied(edited, q, new Set([row!.id])).stats!.rolls.some((r) => r.name === "Shortbow"), false, "Remove it");
  });

  test("a kind not read whole never removes, and its entry stays", () => {
    const { first, by } = start();
    const fill = ddb(longsword(), shortbow());
    fill.read = { weapon: true, spell: false, other: true };
    const p = plan(first, fill);
    assert.equal(caseOf(p, "Shillelagh"), undefined);
    const after = applied(first, p);
    const id = by(first, "Shillelagh")!.id;
    assert.deepEqual(after.ddbSync!.rolls[hash12(id)], first.ddbSync!.rolls[hash12(id)]);
    assert.equal(after.stats!.rolls.some((r) => r.id === id), true);
  });

  test("changed there and untouched: updated in place, its id kept, and On a pass kept only while it has a save", () => {
    const { first, by } = start();
    const p = plan(first, ddb(longsword({ dice: [{ formula: "1d10", mod: true, type: "slashing" }] }), shortbow(), shillelagh()));
    assert.equal((caseOf(p, "Longsword") as { case: string }).case, "update");
    const after = applied(first, p);
    assert.equal(by(after, "Longsword")!.id, by(first, "Longsword")!.id);
    assert.equal(by(after, "Longsword")!.dice[0]!.formula, "1d10");

    const beam = synced(fillOf({ ...empty(), rolls: read([moonbeam()]) }));
    const halves = edit(beam, "Moonbeam", (r) => ({ ...r, save: { ...r.save!, onPass: "half" } }));
    assert.equal(rollHash(halves.stats!.rolls[0]!), rollHash(beam.stats!.rolls[0]!), "On a pass is outside the hash");
    const up = applied(halves, plan(halves, fillOf({ ...empty(), rolls: read([moonbeam({ dice: [{ formula: "3d10", type: "radiant" }] })]) })));
    assert.equal(up.stats!.rolls[0]!.save?.onPass, "half");
    const unsaved = applied(halves, plan(halves, fillOf({ ...empty(), rolls: read([moonbeam({ save: undefined, attack: { prof: true, bonus: 0 } })]) })));
    assert.equal(unsaved.stats!.rolls[0]!.save, undefined);
  });

  test("the player edited it: kept with Overwrite, tagged when D&D Beyond changed it too, and nothing when both reached the same", () => {
    const { first } = start();
    const mine = edit(first, "Shillelagh", (r) => ({ ...r, dice: [{ formula: "1d8+1", mod: true, type: "bludgeoning" }] }));
    const p = plan(mine, ddb(longsword(), shortbow(), shillelagh()));
    const row = caseOf(p, "Shillelagh");
    assert.deepEqual([row?.type === "roll" && row.case, row?.conflict], ["edited", false]);
    const q = plan(mine, ddb(longsword(), shortbow(), shillelagh({ dice: [{ formula: "1d10", mod: true, type: "bludgeoning" }] })));
    const tagged = caseOf(q, "Shillelagh");
    assert.deepEqual([tagged?.type === "roll" && tagged.case, tagged?.conflict], ["conflict", true]);
    const kept = applied(mine, q);
    assert.equal(kept.stats!.rolls.find((r) => r.name === "Shillelagh")!.dice[0]!.formula, "1d8+1");
    // The entry takes D&D Beyond's content, so the kept roll reads as the player's change on every later sync.
    const entry = Object.values(kept.ddbSync!.rolls).find((e) => e.k.startsWith("s:"))!;
    assert.equal(entry.h, rollHash(shillelagh({ dice: [{ formula: "1d10", mod: true, type: "bludgeoning" }] })));
    const over = applied(mine, q, new Set([tagged!.id]));
    assert.equal(over.stats!.rolls.find((r) => r.name === "Shillelagh")!.dice[0]!.formula, "1d10");
    assert.equal(over.stats!.rolls.find((r) => r.name === "Shillelagh")!.ddb, true);
    const both = plan(mine, ddb(longsword(), shortbow(), shillelagh({ dice: [{ formula: "1d8+1", mod: true, type: "bludgeoning" }] })));
    assert.equal(caseOf(both, "Shillelagh"), undefined);
  });

  test("the player deleted it: it stays deleted, its marker joins gone, and Add it back brings it in with a new id", () => {
    const { first, by } = start();
    const removed = edit(first, "Shortbow", () => null);
    const p = plan(removed, ddb(longsword(), shortbow(), shillelagh()));
    const row = caseOf(p, "Shortbow");
    assert.deepEqual([row?.type === "roll" && row.case, row?.section], ["deleted", "kept"]);
    const after = applied(removed, p);
    assert.equal(after.stats!.rolls.some((r) => r.name === "Shortbow"), false);
    assert.equal(after.ddbSync!.gone?.length, 1);
    const again = plan(after, ddb(longsword(), shortbow(), shillelagh()));
    assert.equal((caseOf(again, "Shortbow") as { case: string }).case, "deleted", "still deleted on the next sync");
    const back = applied(after, again, new Set([row!.id]));
    const shot = back.stats!.rolls.find((r) => r.name === "Shortbow")!;
    assert.notEqual(shot.id, by(first, "Shortbow")!.id);
    assert.equal(back.ddbSync!.gone, undefined);
  });

  test("gone: a delete, a read with no weapons keeps the marker, a whole read still keeps it deleted, and one missing from a whole read lets it go", () => {
    const { first } = start();
    const removed = applied(edit(first, "Shortbow", () => null), plan(edit(first, "Shortbow", () => null), ddb(longsword(), shortbow(), shillelagh())));
    const noWeapons = ddb(shillelagh());
    noWeapons.read = { weapon: false, spell: true, other: true };
    const kept = applied(removed, plan(removed, noWeapons));
    assert.deepEqual(kept.ddbSync!.gone, removed.ddbSync!.gone);
    const whole = plan(kept, ddb(longsword(), shortbow(), shillelagh()));
    assert.equal((caseOf(whole, "Shortbow") as { case: string }).case, "deleted");
    const missing = applied(kept, plan(kept, ddb(longsword(), shillelagh())));
    assert.equal(missing.ddbSync!.gone, undefined);
  });

  test("40 markers and a new deletion under incomplete reads: the oldest goes, with its warning, and may come back later", () => {
    const { first } = start();
    const markers = Array.from({ length: 40 }, (_, i) => `w:${hash12(`old${i}`)}`);
    const full = { ...first, ddbSync: { ...first.ddbSync!, gone: markers } };
    const removed = edit(full, "Shortbow", () => null);
    // The weapons were cut, so no old marker can leave, and the Shortbow is still read.
    const fill = ddb(longsword(), shortbow(), shillelagh());
    fill.read = { weapon: false, spell: true, other: true };
    const p = plan(removed, fill);
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.record.gone!.length, 40);
    assert.deepEqual(result.goneDropped, [{ k: markers[0] }]);
    assert.equal(result.record.gone!.at(-1), rollKeys([shortbow()])[0]);
    // Incomplete reads keep the markers, and the cap holds over repeats.
    const partial = ddb(shillelagh());
    partial.read = { weapon: false, spell: true, other: true };
    let c = afterSync(removed, syncPatch(removed, result)!.patch, AT);
    for (let i = 0; i < 3; i++) c = applied(c, plan(c, partial));
    assert.equal(c.ddbSync!.gone!.length, 40);
  });

  test("the player's own roll is kept and never recorded, and one of a D&D Beyond roll's name is linked", () => {
    const { first } = start();
    const own = { ...first, stats: { ...first.stats!, rolls: [...first.stats!.rolls, wildfire({ id: "mine", name: "Healing Word Scroll", kind: "other" })] } };
    const p = plan(own, ddb(longsword(), shortbow(), shillelagh()));
    assert.equal(p.ownRolls, 1);
    assert.equal(applied(own, p).ddbSync!.rolls[hash12("mine")], undefined);

    // Typed by hand before any sync, then a sync with no record: alike is linked silently, unlike is Different.
    const typed = bree({ ...empty(), rolls: [longsword({ id: "a" }), shortbow({ id: "b", attack: { prof: true, bonus: 1 } })] });
    const q = plan(typed, ddb(longsword(), shortbow()));
    assert.equal(caseOf(q, "Longsword"), undefined);
    assert.deepEqual([(caseOf(q, "Shortbow") as { case: string }).case, caseOf(q, "Shortbow")?.section], ["sameName", "different"]);
    const linked = applied(typed, q);
    assert.ok(linked.ddbSync!.rolls[hash12("a")]);
    assert.ok(linked.ddbSync!.rolls[hash12("b")]);
    // Re-synced twice with the same data, the unlike one stays the player's, now kept with Overwrite.
    const twice = plan(linked, ddb(longsword(), shortbow()));
    assert.deepEqual([(caseOf(twice, "Shortbow") as { case: string }).case, caseOf(twice, "Shortbow")?.section], ["edited", "kept"]);
    assert.equal(applied(linked, twice).stats!.rolls.find((r) => r.id === "b")!.attack!.bonus, 1);
    // In the editor with no record it is replaced, unless Keep mine.
    const e = plan(typed, ddb(longsword(), shortbow()), "editor");
    assert.equal(caseOf(e, "Shortbow")?.section, "replaces");
    assert.equal(syncResult(e, defaultTicks(e)).stats.rolls.find((r) => r.id === "b")!.attack!.bonus, 0);
  });

  test("with no record, an old import's rolls count as linked and untouched, so a first re-sync replaces them by key", () => {
    const old = bree({ ...empty(), rolls: [longsword({ id: "a", ddb: true }), shortbow({ id: "b", ddb: true })] });
    const p = plan(old, ddb(longsword({ dice: [{ formula: "1d10", mod: true, type: "slashing" }] }), moonbeam()));
    assert.deepEqual(
      p.items.map((i) => [i.type === "roll" && i.case, i.section]),
      [
        ["update", "changes"],
        ["remove", "changes"],
        ["add", "changes"],
      ],
    );
    const after = applied(old, p);
    assert.equal(after.stats!.rolls.find((r) => r.id === "a")!.dice[0]!.formula, "1d10");
    // With a record, a marked roll with no entry is the player's own.
    const marked = { ...after, stats: { ...after.stats!, rolls: [...after.stats!.rolls, shortbow({ id: "c", ddb: true })] } };
    const q = plan(marked, ddb(longsword({ dice: [{ formula: "1d10", mod: true, type: "slashing" }] }), moonbeam()));
    assert.equal(q.ownRolls, 1);
  });

  test("two alike tell apart by their count, and the two-handed line is its own key", () => {
    const keys = rollKeys([longsword(), longsword(), longsword({ name: "Longsword (two hands)" }), moonbeam(), moonbeam({ level: 3 })]);
    assert.equal(new Set(keys).size, 5);
    assert.equal(keys[0], `w:${hash12("w:longsword")}`);
    assert.equal(keys[1], `w:${hash12("w:longsword#2")}`);
    assert.equal(keys[3], `s:${hash12("s:moonbeam:2")}`);
    assert.equal(rollHash(longsword({ id: "a" })), rollHash(longsword({ id: "b", ddb: true })), "id and the mark are outside the hash");
    const pair = synced(fillOf({ ...empty(), rolls: read([longsword(), longsword({ attack: { prof: true, bonus: 1 } })]) }));
    const again = plan(pair, fillOf({ ...empty(), rolls: read([longsword(), longsword({ attack: { prof: true, bonus: 1 } })]) }));
    assert.equal(again.items.length, 0);
  });

  test("no room: rolls past 40 are left out and not recorded, and come in once there is room", () => {
    const many = Array.from({ length: 39 }, (_, i) => wildfire({ name: `Roll ${i}` }));
    const first = synced(fillOf({ ...empty(), rolls: read(many) }));
    const p = plan(first, fillOf({ ...empty(), rolls: read([...many, longsword(), shortbow(), moonbeam()]) }));
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.stats.rolls.length, 40);
    assert.equal(result.notFit, 2);
    assert.equal(Object.keys(result.record.rolls).length, 40);
    const after = afterSync(first, syncPatch(first, result)!.patch, AT);
    const trimmed = { ...after, stats: { ...after.stats!, rolls: after.stats!.rolls.slice(0, 37) } };
    const later = syncResult(plan(trimmed, fillOf({ ...empty(), rolls: read([...many.slice(0, 37), longsword(), shortbow(), moonbeam()]) })), new Set());
    assert.ok(later.stats.rolls.some((r) => r.name === "Moonbeam"));
  });

  test("a link of the player's own roll waits when the record is full: 40 weapons synced, one deleted, an own spell, then a read of spells with the weapons unread (RSBUILD-ASTRA-01)", () => {
    const weapons = Array.from({ length: 40 }, (_, i) => longsword({ name: `Blade ${i}` }));
    const first = synced(fillOf({ ...empty(), rolls: read(weapons) }));
    assert.equal(Object.keys(first.ddbSync!.rolls).length, 40);
    const own = shillelagh({ id: "mine" });
    const edited = { ...first, stats: { ...first.stats!, rolls: [...first.stats!.rolls.slice(1), own] } };
    const fill = fillOf({ ...empty(), rolls: read([shillelagh(), moonbeam()]) });
    fill.read = { weapon: false, spell: true, other: true };
    const p = plan(edited, fill);
    assert.deepEqual(p.rolls.unlinked.map((r) => r.id), ["mine"], "39 kept entries and the deleted weapon's fill the record");
    const result = syncResult(p, defaultTicks(p));
    assert.equal(Object.keys(result.record.rolls).length, 40);
    assert.equal(ddbSyncPatchSchema.safeParse(result.record).success, true);
    assert.equal(result.record.rolls[hash12("mine")], undefined, "the own roll stays the player's own");
    assert.equal(result.stats.rolls.filter((r) => r.name === "Shillelagh").length, 1, "and its read roll never comes in beside it");
    assert.equal(result.notFit, 1, "Moonbeam waits for room too");
    assert.equal(syncPatch(edited, result), null, "nothing else changed, so nothing is sent");
    // Once an entry frees up, the next sync links it.
    const blade = edited.stats!.rolls.find((r) => r.name === "Blade 1")!;
    const freed = { ...edited, stats: { ...edited.stats!, rolls: edited.stats!.rolls.filter((r) => r !== blade) }, ddbSync: { ...edited.ddbSync!, rolls: Object.fromEntries(Object.entries(edited.ddbSync!.rolls).filter(([id]) => id !== hash12(blade.id))) } };
    const later = plan(freed, fill);
    assert.deepEqual(later.rolls.unlinked, []);
    assert.ok(syncResult(later, new Set()).record.rolls[hash12("mine")]);
  });

  test("a cut spell list never removes the spell the cut took, though a weapon was added before the cut", () => {
    const spells = Array.from({ length: 40 }, (_, i) => moonbeam({ name: `Spell ${i}` }));
    const first = synced(fillOf({ ...empty(), rolls: read(spells) }));
    // 41 at the source: a new weapon first pushes the last spell past the 40 read.
    const fill = fillOf({ ...empty(), rolls: read([longsword(), ...spells.slice(0, 39)]) });
    fill.read = { weapon: true, spell: false, other: true };
    const p = plan(first, fill);
    assert.equal(p.items.some((i) => i.type === "roll" && i.case === "remove"), false);
    const result = syncResult(p, defaultTicks(p));
    assert.ok(result.stats.rolls.some((r) => r.name === "Spell 39"));
    assert.equal(result.notFit, 1, "the weapon waits for room");
  });
});

describe("the review's checks (3.3)", () => {
  test("the losses warning: a lower level, the spellcasting ability gone, and six or more proficiencies at least half of those synced", () => {
    const skilled = { ...empty(), spellAbility: "wis" as const, skills: { arcana: "prof", history: "prof", nature: "prof", religion: "prof", insight: "prof", medicine: "prof", perception: "expert" } as PcStats["skills"] };
    const first = synced(fillOf(skilled, { level: 6 }));
    const p = plan(first, fillOf(empty(), { level: 1 }));
    assert.deepEqual(p.losses, { level: { from: 6, to: 1 }, spellAbility: true, proficiencies: 7 });
    assert.equal(plan(first, fillOf({ ...skilled, skills: { arcana: "prof" } }, { level: 6 })).losses?.proficiencies, 6);
    assert.equal(plan(first, fillOf(skilled, { level: 7 })).losses, null);
  });

  test("a proficiency coming in beside a kept bonus says what it rolls", () => {
    const first = synced(fillOf(empty()));
    const mine = { ...first, stats: { ...first.stats!, adjust: { skills: { stealth: 3 } } } };
    const p = plan(mine, fillOf({ ...empty(), skills: { stealth: "prof" } }));
    const result = syncResult(p, defaultTicks(p));
    assert.deepEqual(result.besideBonus, [{ on: { skill: "stealth" }, bonus: 3, total: 6 }]);
    assert.deepEqual(syncResult(p, new Set(["field:adjust.skills.stealth"])).besideBonus, [], "overwritten, the bonus goes");
  });

  test("the block's 12 KiB and the record's 6 KiB are what Apply checks, and a record at every bound fits", () => {
    const part = { formula: "1d4+1d4+1d4+1d4+1d4+1d4+1d4+1d4+1d4+1d4", mod: true as const, type: "fire" as const };
    const long = Array.from({ length: 40 }, (_, i) => wildfire({ name: `${"X".repeat(55)} ${i}`, dice: [part, part, part, part] }));
    const p = plan(bree(empty()), fillOf({ ...empty(), rolls: read(long) }));
    const result = syncResult(p, defaultTicks(p));
    assert.ok(serializedBytes(result.stats) > LIMITS.pcStatsBytes, "a block the review refuses");
    assert.ok(serializedBytes({ ...result.record, at: AT }) <= LIMITS.ddbSyncBytes);
    const every: DdbBase = {
      ...baseOf({ ...empty(), skills: Object.fromEntries(["arcana", "history"].map((s) => [s, "expert"])) as PcStats["skills"] }),
      senses: "暗".repeat(80),
    };
    const gone = Array.from({ length: 40 }, (_, i) => `o:${hash12(`g${i}`)}`);
    const record = { at: AT, from: "123456789012", base: every, rolls: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [hash12(`id${i}`), { k: `w:${hash12(`k${i}`)}`, h: hash12(`h${i}`) }])), gone };
    assert.equal(ddbSyncForImport.safeParse(record).success, true);
    assert.ok(serializedBytes(record) <= LIMITS.ddbSyncBytes);
  });

  test("every bulk button: Overwrite all covers Remove it and Add it back, Take these and Keep these one group, and each is pressed while all it covers are ticked", () => {
    const first = synced(fillOf({ ...empty(), rolls: read([longsword(), shortbow()]) }));
    const mine = {
      ...first,
      stats: { ...first.stats!, spellAbility: "cha" as const, rolls: first.stats!.rolls.filter((r) => r.name !== "Shortbow").map((r) => ({ ...r, attack: { prof: true, bonus: 2 } })) },
    };
    const p = plan(mine, fillOf({ ...empty(), spellAbility: "wis", rolls: read([longsword(), shortbow()]) }));
    const all = bulkIds(p, "kept");
    assert.equal(all.length, 3);
    let ticks = bulkToggle(all, defaultTicks(p));
    assert.equal(bulkPressed(all, ticks), true);
    const after = afterSync(mine, syncPatch(mine, syncResult(p, ticks))!.patch, AT);
    assert.equal(after.stats!.spellAbility, "wis");
    assert.deepEqual(after.stats!.rolls.map((r) => [r.name, r.attack!.bonus]).sort(), [["Longsword", 0], ["Shortbow", 0]]);
    ticks = bulkToggle(all, ticks);
    assert.equal(bulkPressed(all, ticks), false);

    const typed = bree({ ...empty(), spellAbility: "cha", abilities: { ...empty().abilities, wis: 12 } });
    const d = plan(typed, fillOf({ ...empty(), spellAbility: "wis", abilities: { ...empty().abilities, wis: 16 } }));
    const scores = bulkIds(d, "different", "Ability scores");
    assert.deepEqual(scores, ["field:abilities.wis"]);
    const took = syncResult(d, bulkToggle(scores, defaultTicks(d)));
    assert.deepEqual([took.stats.abilities.wis, took.stats.spellAbility], [16, "cha"]);
    const e = plan(typed, fillOf({ ...empty(), spellAbility: "wis", abilities: { ...empty().abilities, wis: 16 } }), "editor");
    const keep = syncResult(e, bulkToggle(bulkIds(e, "replaces"), defaultTicks(e)));
    assert.deepEqual([keep.stats.abilities.wis, keep.stats.spellAbility], [12, "cha"], "Keep all of yours");
    const one = syncResult(e, bulkToggle(bulkIds(e, "replaces", "Spellcasting"), defaultTicks(e)));
    assert.deepEqual([one.stats.abilities.wis, one.stats.spellAbility], [16, "cha"], "Keep these: Spellcasting");
  });

  test("what Apply sends passes the protocol, and Undo puts back the record before it, its time included", () => {
    const first = synced(fillOf(empty()));
    assert.equal(first.ddbSync!.at, AT);
    const p = plan(first, fillOf(withField(empty(), "abilities.wis", 18), { level: 6 }));
    const sent = syncPatch(first, syncResult(p, defaultTicks(p)))!;
    assert.equal(ddbSyncPatchSchema.safeParse(sent.patch.ddbSync).success, true);
    assert.equal(sent.patch.ddbSync!.at, undefined, "the server writes the time");
    assert.ok(sent.expect["actor.shape"], "the shape is always expected");
    assert.deepEqual(Object.keys(sent.expect).sort(), ["actor.shape", "ddbSync", "level", "stats.abilities"]);
    const after = afterSync(first, sent.patch, "2026-10-21T19:00:00.000Z");
    const undo = undoSync(first, sent.patch, "2026-10-21T19:00:00.000Z")!;
    assert.deepEqual(undo.patch.ddbSync, first.ddbSync);
    assert.equal(undo.patch.level, 5);
    assert.deepEqual(afterSync(after, undo.patch, AT), first);
    assert.equal(undoSync(first, sent.patch, undefined), null, "with no at in Apply's answer, Undo is off");
    assert.equal(pcStatsForImport.safeParse(after.stats).success, true);
  });

  test("a result leaves the character as it is only when no part, field or record would change, as Apply's null says (RS-O-31)", () => {
    const first = synced(fillOf(empty()));
    for (const mode of ["resync", "editor"] as const) {
      const same = plan(first, fillOf(empty()), mode);
      assert.equal(leavesAsIs(same, syncResult(same, defaultTicks(same))), true, mode);
      assert.equal(syncPatch(first, syncResult(same, defaultTicks(same))), null);
      const up = plan(first, fillOf(empty(), { level: 6 }), mode);
      assert.deepEqual(up.items.filter((i) => i.section === "changes"), [], "a level-up alone has no Changes line");
      assert.equal(leavesAsIs(up, syncResult(up, defaultTicks(up))), false, `${mode}: the level comes in`);
      assert.equal(leavesAsIs(up, syncResult(up, new Set())), false, `${mode}: unticked, the record still takes level 6`);
    }
    assert.equal(leavesAsIs(plan(bree(undefined), fillOf(empty())), syncResult(plan(bree(undefined), fillOf(empty())), new Set())), false, "a first sync makes a block");
  });

  test("a finished record fits only within the route's schema and 6 KiB, so Apply and Use it never send one the server refuses (RS-O-30)", () => {
    const entry = (i: number) => [i.toString(16).padStart(12, "0"), { k: `w:${i.toString(16).padStart(12, "0")}`, h: "abcdef012345" }] as const;
    const record = (n: number) => ({ base: {}, rolls: Object.fromEntries(Array.from({ length: n }, (_, i) => entry(i))) });
    assert.equal(recordFits(record(40)), true);
    assert.equal(recordFits(record(41)), false, "41 entries");
    assert.equal(recordFits({ ...record(0), gone: Array.from({ length: 41 }, (_, i) => `s:${i.toString(16).padStart(12, "0")}`) }), false, "41 markers");
    assert.equal(recordFits({ ...record(40), gone: Array.from({ length: 40 }, (_, i) => `s:${i.toString(16).padStart(12, "0")}`), base: { senses: "x".repeat(80) } }), true, "every bound at once still saves");
  });

  test("a second device's later sync of an equal record refuses the first device's Undo, which expects the at its own answer gave (RS-SOL-1)", () => {
    // Bree as synced, with Wisdom saves the player added since, and D&D Beyond now at level 6.
    const first = synced(fillOf(empty()));
    const bree0: Character = character("bree", { ...first, ownerIds: ["p1"], stats: { ...first.stats!, saves: ["wis"] } });
    const fill = fillOf(empty(), { level: 6 });
    const apply = (c: Character, ticks?: (p: SyncPlan) => Set<string>) => {
      const p = plan(c, fill);
      const sent = syncPatch(c, syncResult(p, ticks ? ticks(p) : defaultTicks(p)))!;
      return { sent, op: { t: "character.update", characterId: "bree", patch: sent.patch, expect: sent.expect } as Op };
    };
    const through = (state: ReturnType<typeof room>, op: Op, at: string) => {
      assert.ok(canApply(op, P1, state, { canUseAsset: () => true }).ok, "the op's expect holds");
      const r = applyOp(state, op, P1, { seq: 1, at });
      assert.ok(r.ok, r.ok ? "" : r.message);
      return r.state;
    };
    const T1 = "2026-10-21T19:00:00.000Z";
    const T2 = "2026-10-21T19:05:00.000Z";

    // Device A applies the level and keeps the saves. The answer gives the at the server wrote.
    const a = apply(bree0);
    assert.deepEqual(Object.keys(a.sent.patch).sort(), ["ddbSync", "level"]);
    const afterA = through(room({ characters: { bree: bree0 } }), a.op, T1);
    const stampedA = stampedAt(a.op, afterA);
    assert.equal(stampedA, T1);
    const undoA = undoSync(bree0, a.sent.patch, stampedA)!;
    const undoOp: Op = { t: "character.update", characterId: "bree", patch: undoA.patch, expect: undoA.expect };
    assert.ok(canApply(undoOp, P1, afterA, { canUseAsset: () => true }).ok, "with nothing since, A's Undo is taken");

    // Device B re-syncs from what A left and overwrites the saves, a part A never wrote. Its record equals A's, its at is later.
    const b = apply(afterA.characters.bree!, (p) => new Set([...defaultTicks(p), "field:saves.wis"]));
    assert.deepEqual(Object.keys(b.sent.patch).sort(), ["ddbSync", "stats"]);
    assert.ok(sameRecord(b.sent.patch.ddbSync!, afterA.characters.bree!.ddbSync), "B's record equals A's");
    const afterB = through(afterA, b.op, T2);
    assert.equal(stampedAt(b.op, afterB), T2);

    assert.deepEqual(canApply(undoOp, P1, afterB, { canUseAsset: () => true }), { ok: false, code: "invalid", message: CHARACTER_CHANGED });
    // Taken from the view, the at would be B's, and A's Undo would roll B's sync back.
    const fromView = undoSync(bree0, a.sent.patch, afterB.characters.bree!.ddbSync!.at)!;
    assert.ok(canApply({ t: "character.update", characterId: "bree", patch: fromView.patch, expect: fromView.expect }, P1, afterB, { canUseAsset: () => true }).ok);
  });

  test("an editor's Save of an equal record in the same millisecond as Apply gets its own stamp, so Apply's Undo is refused after it (RSBUILD-ASTRA-04)", () => {
    const first = synced(fillOf(empty()));
    const bree0: Character = character("bree", { ...first, ownerIds: ["p1"], stats: { ...first.stats!, saves: ["wis"] } });
    const p = plan(bree0, fillOf(empty(), { level: 6 }));
    const sent = syncPatch(bree0, syncResult(p, defaultTicks(p)))!;
    const T = "2026-10-21T19:00:00.000Z";
    const applyOpA: Op = { t: "character.update", characterId: "bree", patch: sent.patch, expect: sent.expect };
    const a = applyOp(room({ characters: { bree: bree0 } }), applyOpA, P1, { seq: 1, at: T });
    assert.ok(a.ok);
    const stampedA = stampedAt(applyOpA, a.state);
    assert.equal(stampedA, T);
    // Another device's editor Save carries the same record, with the saves set back, at the same clock time.
    const save: Op = { t: "character.update", characterId: "bree", patch: { stats: { saves: [] }, ddbSync: sent.patch.ddbSync! } };
    assert.ok(canApply(save, P1, a.state, { canUseAsset: () => true }).ok);
    const b = applyOp(a.state, save, P1, { seq: 2, at: T });
    assert.ok(b.ok);
    assert.ok(sameRecord(b.state.characters.bree!.ddbSync!, a.state.characters.bree!.ddbSync), "the same record");
    assert.equal(stampedAt(save, b.state), "2026-10-21T19:00:00.001Z", "its own stamp");
    const undo = undoSync(bree0, sent.patch, stampedA)!;
    assert.deepEqual(canApply({ t: "character.update", characterId: "bree", patch: undo.patch, expect: undo.expect }, P1, b.state, { canUseAsset: () => true }), { ok: false, code: "invalid", message: CHARACTER_CHANGED });
  });
});

/** The class resources as one more group of the review (docs/design-v1-ddb-resources.md 6.1). */
describe("class resources in the review", () => {
  const rage = (over: Partial<NonNullable<PcFill["resources"]>[number]> = {}) => ({ name: "Rage", max: 3, reset: "shortOne" as const, preset: "barbarian-rage", level: 3, classId: "barbarian" as const, used: 0, ...over });
  const withResources = (resources: NonNullable<PcFill["resources"]>, read = true): PcFill => fillOf(empty(), { resources, read: { weapon: true, spell: true, other: true, resource: read } });
  let n = 0;
  const planOf = (c: SyncCharacter, f: PcFill) => planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill: f, newId: () => `n${++n}` });

  test("Class resources is a group after Rolls", () => {
    assert.deepEqual(SYNC_GROUPS.slice(-2), ["Rolls", "Class resources"]);
  });

  test("Overwrite all covers a resource's Overwrite, Remove it and Add it back, and never a spent line", () => {
    const c0 = synced(withResources([rage(), { name: "Luck Points", max: 3, reset: "long" }, { name: "Grit", max: 2, reset: "short" }]));
    const rageId = c0.resources!.find((r) => r.name === "Rage")!.id;
    const c: SyncCharacter = {
      ...c0,
      resources: c0.resources!.filter((r) => r.name !== "Grit").map((r) => (r.id === rageId ? { ...r, max: 5, used: 2 } : r.name === "Luck Points" ? { ...r, max: 4 } : r)),
    };
    const p = planOf(c, withResources([rage(), { name: "Grit", max: 2, reset: "short" }]));
    const kept = bulkIds(p, "kept");
    assert.deepEqual(p.items.filter((i) => kept.includes(i.id)).map((i) => i.type === "resource" && i.case), ["edited", "goneThere", "deleted"]);
    assert.equal(p.spent.length, 1);
    assert.ok(!kept.includes(p.spent[0]!.id));
    const result = syncResult(p, bulkToggle(kept, defaultTicks(p)));
    assert.deepEqual(result.resources!.map((r) => [r.name, r.max]), [["Rage", 3], ["Grit", 2]]);
    assert.deepEqual(result.counts, { cameIn: 1, removed: 0, cameBack: 0, stayed: 1, resourcesRemoved: 1, resourcesBack: 1 });
  });

  test("the losses warning counts 3 or more resources taken away that are at least half of those synced", () => {
    const four = ["Rage", "Wild Shape", "Luck Points", "Grit"].map((name) => ({ name, max: 2, reset: "long" as const }));
    const c = synced(withResources(four));
    assert.equal(planOf(c, withResources(four.slice(0, 1))).losses?.resources, 3);
    assert.equal(planOf(c, withResources(four.slice(0, 2))).losses?.resources, undefined, "2 is fewer than 3");
    const seven = ["A", "B", "C", "D", "E", "F", "G"].map((name) => ({ name, max: 2, reset: "long" as const }));
    assert.equal(planOf(synced(withResources(seven)), withResources(seven.slice(0, 4))).losses?.resources, undefined, "3 of 7 is under half");
    assert.equal(planOf(c, withResources([], false)).losses, null, "a read not whole takes none away");
  });
});
