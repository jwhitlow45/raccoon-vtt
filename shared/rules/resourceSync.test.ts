import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClassResource, PcStats } from "../model.ts";
import { ddbSyncPatchSchema } from "../protocol.ts";
import { levelUps } from "./classResources.ts";
import type { FillResource, PcFill } from "./pcFill.ts";
import { afterSync, bulkIds, bulkToggle, defaultTicks, hash12, leavesAsIs, planSync, syncPatch, syncResult, undoSync, type ResourceItem, type SyncCharacter, type SyncInput, type SyncPlan } from "./pcSync.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";
import { readResources, resourceHash } from "./resourceSync.ts";
import { actor } from "../testutil.ts";

/**
 * The class resources' merge (docs/design-v1-ddb-resources.md 4): one row
 * per case of 4.2, the counts spent of 4.3, the levels of 4.4, and the
 * findings the note names one by one. The randomized invariants are in
 * pcSync.random.test.ts.
 */

const AT = "2026-10-24T10:00:00.000Z";
const SHEET = "https://www.dndbeyond.com/characters/12345678";
const block = (): PcStats => structuredClone(EMPTY_PC_STATS) as PcStats;

/** A read of class resources, whole unless told. */
function fill(resources: FillResource[] | undefined, over: Partial<PcFill> = {}): PcFill {
  return {
    source: "ddb",
    stats: { rolls: [] },
    level: 5,
    actor: { sheetUrl: SHEET },
    warnings: [],
    read: { weapon: true, spell: true, other: true, resource: true },
    ...(resources ? { resources } : {}),
    ...over,
  };
}

const notWhole = (resources: FillResource[]) => fill(resources, { read: { weapon: true, spell: true, other: true, resource: false } });

/** D&D Beyond's resources as the reader gives them. */
const RAGE: FillResource = { name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 3, classId: "barbarian", used: 0 };
const cd = (classId: "cleric" | "paladin", max = 2, used = 0): FillResource => ({ name: "Channel Divinity", max, reset: "shortOne", preset: `${classId}-channel-divinity`, level: classId === "cleric" ? 2 : 3, classId, used });
const dice = (classId?: "fighter", over: Partial<FillResource> = {}): FillResource => ({ name: "Superiority Dice", max: 4, reset: "short", ...(classId ? { classId } : {}), used: 0, ...over });
const breath: FillResource = { name: "Breath Weapon", max: 3, reset: "long", used: 0 };

/** Bree with a block, so a sync is not a first one, and the resources and record given. */
function bree(over: Partial<SyncCharacter> = {}): SyncCharacter {
  return { name: "Bree", level: 5, stats: block(), actor: actor({ hp: { cur: 20, max: 38, temp: 0 }, sheetUrl: SHEET }), ...over };
}

let ids = 0;
function plan(c: SyncCharacter, f: PcFill, mode: SyncInput["mode"] = "resync", over: Partial<SyncInput> = {}): SyncPlan {
  return planSync({ mode, stats: c.stats, level: c.level, character: c, fill: f, newId: () => `new${++ids}`, ...over });
}

/** The character after Apply with these ticks, as the server leaves it. */
function applied(c: SyncCharacter, p: SyncPlan, ticks: ReadonlySet<string> = defaultTicks(p)): SyncCharacter {
  const sent = syncPatch(c, syncResult(p, ticks));
  return sent ? afterSync(c, sent.patch, AT) : c;
}

/** Bree synced once from a whole read, so the record links what came in. */
function synced(resources: FillResource[], over: Partial<SyncCharacter> = {}): SyncCharacter {
  const c = bree(over);
  return applied(c, plan(c, fill(resources)));
}

const res = (p: SyncPlan): ResourceItem[] => p.items.filter((i): i is ResourceItem => i.type === "resource");
const caseOf = (p: SyncPlan, name: string) => res(p).find((i) => (i.mine ?? i.theirs!.resource).name === name)?.case;
const names = (c: SyncCharacter) => (c.resources ?? []).map((r) => r.name);
const byName = (c: SyncCharacter, name: string) => c.resources?.find((r) => r.name === name);
const kOf = (text: string) => `r:${hash12(text)}`;
const spend = (c: SyncCharacter, name: string, used: number): SyncCharacter => ({ ...c, resources: c.resources!.map((r) => (r.name === name ? { ...r, used } : r)) });
const edit = (c: SyncCharacter, name: string, patch: Partial<ClassResource>): SyncCharacter => ({ ...c, resources: c.resources!.map((r) => (r.name === name ? { ...r, ...patch } : r)) });
const removed = (c: SyncCharacter, name: string): SyncCharacter => ({ ...c, resources: c.resources!.filter((r) => r.name !== name) });

describe("the key and the hash (4.1)", () => {
  test("a class feature keys by its class and name, anything else by its name, and a second of one key is #2", () => {
    const reads = readResources([RAGE, breath, { ...breath }, dice()]);
    assert.deepEqual(
      reads.map((r) => r.k),
      [kOf("barbarian:rage"), kOf("breath weapon"), kOf("breath weapon#2"), kOf("superiority dice")],
    );
    assert.equal(readResources([{ ...RAGE, name: "Ki Points", classId: "monk" }])[0]!.k, kOf("monk:focus points"), "D&D Beyond's own names run through the table");
  });

  test("h hashes the name, count, rest and pool alone, never what is spent or the bookkeeping", () => {
    const r: ClassResource = { id: "a", name: "Rage", max: 3, used: 2, reset: "shortOne", preset: "barbarian-rage", level: 3, atLevel: 3, edited: true };
    assert.equal(resourceHash(r), resourceHash({ name: "Rage", max: 3, reset: "shortOne" }));
    assert.notEqual(resourceHash(r), resourceHash({ ...r, pool: true }));
  });
});

describe("the cases (4.2)", () => {
  test("added there: added at the end with its spent count, and recorded", () => {
    const c = synced([{ ...RAGE, used: 1 }, breath]);
    assert.deepEqual(names(c), ["Rage", "Breath Weapon"]);
    assert.deepEqual(byName(c, "Rage"), { id: byName(c, "Rage")!.id, name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 3, atLevel: 5, used: 1 });
    assert.equal(Object.keys(c.ddbSync!.res!).length, 2);
    assert.equal(c.ddbSync!.res![hash12(byName(c, "Rage")!.id)]!.k, kOf("barbarian:rage"));
    assert.ok(ddbSyncPatchSchema.safeParse(c.ddbSync).success);
  });

  test("changed there: updated in place, its id and spent count kept, the count cut to the new one", () => {
    const c = spend(synced([{ ...RAGE, max: 4 }]), "Rage", 4);
    const p = plan(c, fill([RAGE]));
    assert.equal(caseOf(p, "Rage"), "update");
    const after = applied(c, p);
    assert.equal(byName(after, "Rage")!.id, byName(c, "Rage")!.id);
    assert.equal(byName(after, "Rage")!.max, 3);
    assert.equal(byName(after, "Rage")!.used, 3);
  });

  test("removed there, read whole: removed. Not read whole: kept with its entry", () => {
    const c = synced([RAGE, breath]);
    assert.equal(caseOf(plan(c, fill([RAGE])), "Breath Weapon"), "remove");
    assert.deepEqual(names(applied(c, plan(c, fill([RAGE])))), ["Rage"]);
    const p = plan(c, notWhole([RAGE]));
    assert.equal(caseOf(p, "Breath Weapon"), undefined);
    const kept = applied(c, p);
    assert.deepEqual(names(kept), ["Rage", "Breath Weapon"]);
    assert.equal(kept.ddbSync!.res![hash12(byName(c, "Breath Weapon")!.id)]!.k, kOf("breath weapon"));
  });

  test("changed here: kept, with Overwrite. Both changed: tagged. Both reached it: nothing", () => {
    const c = edit(synced([RAGE]), "Rage", { max: 5, edited: true });
    const p = plan(c, fill([RAGE]));
    assert.equal(caseOf(p, "Rage"), "edited");
    assert.equal(byName(applied(c, p), "Rage")!.max, 5);
    const over = applied(c, p, new Set([`res:${kOf("barbarian:rage")}`]));
    assert.equal(byName(over, "Rage")!.max, 3);
    assert.equal(byName(over, "Rage")!.edited, undefined, "Overwrite drops edited");
    assert.equal(byName(over, "Rage")!.atLevel, 5, "and sets atLevel");
    assert.ok(!leavesAsIs(p, syncResult(p, new Set([`res:${kOf("barbarian:rage")}`]))), "an Overwrite is something new");
    const both = plan(c, fill([{ ...RAGE, max: 4 }]));
    assert.equal(caseOf(both, "Rage"), "conflict");
    assert.equal(res(both)[0]!.conflict, true);
    assert.deepEqual(res(plan(c, fill([{ ...RAGE, max: 5 }]))), [], "D&D Beyond reached the same count");
  });

  test("changed here, removed there: kept as the player's own with Remove it, its entry dropped", () => {
    const c = edit(synced([RAGE]), "Rage", { max: 5 });
    const p = plan(c, fill([]));
    assert.equal(caseOf(p, "Rage"), "goneThere");
    const kept = applied(c, p);
    assert.deepEqual(names(kept), ["Rage"]);
    assert.equal(kept.ddbSync!.res, undefined);
    assert.deepEqual(names(applied(c, p, new Set([`res:${kOf("barbarian:rage")}`]))), []);
  });

  test("removed here: stays removed as a marker, and Add it back takes a new id and D&D Beyond's spent count", () => {
    const c = removed(synced([RAGE]), "Rage");
    const p = plan(c, fill([{ ...RAGE, used: 2 }]));
    assert.equal(caseOf(p, "Rage"), "deleted");
    const stays = applied(c, p);
    assert.deepEqual(names(stays), []);
    assert.deepEqual(stays.ddbSync!.gone, [kOf("barbarian:rage")]);
    const again = plan(stays, fill([{ ...RAGE, used: 2 }]));
    assert.equal(caseOf(again, "Rage"), "deleted", "a marker holds it removed on the next sync too");
    const back = applied(stays, again, new Set([`res:${kOf("barbarian:rage")}`]));
    assert.equal(byName(back, "Rage")!.used, 2);
    assert.equal(back.ddbSync!.gone, undefined);
  });

  test("removed, then added again by hand: linked in its place, the marker goes, one Rage after Overwrite all (OP-7)", () => {
    const fresh: ClassResource = { id: "typed", name: "Rage", max: 2, used: 0, reset: "shortOne", preset: "barbarian-rage", level: 1, atLevel: 5 };
    for (const [asMarker, read] of [[false, fill([RAGE])], [true, fill([RAGE])], [true, notWhole([RAGE])]] as const) {
      let c = removed(synced([RAGE]), "Rage");
      if (asMarker) c = applied(c, plan(c, fill([RAGE])));
      assert.equal(c.ddbSync!.gone !== undefined, asMarker);
      c = { ...c, resources: [fresh] };
      const p = plan(c, read);
      assert.equal(caseOf(p, "Rage"), "sameName", asMarker ? "marker" : "entry");
      assert.ok(!res(p).some((i) => i.case === "deleted"));
      const all = applied(c, p, bulkToggle(bulkIds(p, "different"), defaultTicks(p)));
      assert.deepEqual(names(all), ["Rage"]);
      assert.equal(byName(all, "Rage")!.id, "typed");
      assert.equal(all.ddbSync!.gone, undefined);
    }
  });

  test("removed here and there: the marker leaves once a whole read lacks it, and stays while the read is not whole", () => {
    const c = applied(removed(synced([RAGE, breath]), "Rage"), plan(removed(synced([RAGE, breath]), "Rage"), fill([RAGE, breath])));
    assert.deepEqual(c.ddbSync!.gone, [kOf("barbarian:rage")]);
    assert.deepEqual(applied(c, plan(c, notWhole([breath]))).ddbSync!.gone, [kOf("barbarian:rage")]);
    assert.equal(applied(c, plan(c, fill([breath]))).ddbSync!.gone, undefined);
  });

  test("a removed one's entry becomes a marker of its own key when the read does not meet it, whole or not read at all", () => {
    const c = removed(synced([RAGE, breath]), "Rage");
    for (const read of [notWhole([breath]), fill(undefined)]) {
      const after = applied(c, plan(c, read));
      assert.deepEqual(after.ddbSync!.gone, [kOf("barbarian:rage")], JSON.stringify(read.resources?.length));
      assert.deepEqual(Object.keys(after.ddbSync!.res!), [hash12(byName(c, "Breath Weapon")!.id)], "entries never outnumber the resources");
    }
  });

  test("two entries of one key: the second is the player's own, never removed for want of a read", () => {
    const c0 = synced([RAGE]);
    const copy: ClassResource = { ...byName(c0, "Rage")!, id: "copy" };
    const c = { ...c0, resources: [...c0.resources!, copy], ddbSync: { ...c0.ddbSync!, res: { ...c0.ddbSync!.res, [hash12("copy")]: c0.ddbSync!.res![hash12(byName(c0, "Rage")!.id)]! } } };
    const p = plan(c, fill([RAGE]));
    assert.ok(!res(p).some((i) => i.case === "remove" || i.case === "goneThere"));
    assert.deepEqual(names(applied(c, p)), ["Rage", "Rage"]);
  });

  test("the player's own: kept and never recorded", () => {
    const own: ClassResource = { id: "own", name: "Grit", max: 2, used: 1, reset: "short" };
    const c = synced([RAGE], { resources: [own] });
    assert.deepEqual(names(c), ["Grit", "Rage"]);
    assert.equal(c.ddbSync!.res![hash12("own")], undefined);
  });

  test("same name without a record: alike links silently, else Different in the dialog and Replaces in the editor", () => {
    const alike: ClassResource = { id: "typed", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 3, atLevel: 5 };
    const c = bree({ resources: [alike] });
    const p = plan(c, fill([RAGE]));
    assert.deepEqual(res(p), []);
    const linked = applied(c, p);
    assert.equal(linked.ddbSync!.res![hash12("typed")]!.k, kOf("barbarian:rage"));
    const unlike = bree({ resources: [{ ...alike, max: 5 }] });
    assert.equal(res(plan(unlike, fill([RAGE])))[0]!.section, "different");
    assert.equal(res(plan(unlike, fill([RAGE]), "editor"))[0]!.section, "replaces");
    assert.equal(byName(applied(unlike, plan(unlike, fill([RAGE]))), "Rage")!.max, 5, "kept unless ticked");
  });

  test("no room: past 12 an addition is left out, not recorded, with its count for the line", () => {
    const twelve: ClassResource[] = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const c = bree({ resources: twelve });
    const p = plan(c, fill([RAGE, breath]));
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.resourcesNotFit, 2);
    assert.equal(result.resources!.length, 12);
    assert.equal(result.record.res, undefined);
  });

  test("12 read into an empty list come in, and the record holds 12", () => {
    const reads = Array.from({ length: 12 }, (_, i): FillResource => ({ name: `Use ${i}`, max: 1, reset: "long" }));
    const c = synced(reads);
    assert.equal(c.resources!.length, 12);
    assert.equal(Object.keys(c.ddbSync!.res!).length, 12);
  });
});

describe("uses spent (4.3)", () => {
  test("a linked resource keeps the room's count, with D&D Beyond's offered unticked, and ticked it takes D&D Beyond's", () => {
    const c = spend(synced([RAGE]), "Rage", 2);
    const p = plan(c, fill([RAGE]));
    assert.deepEqual(res(p), []);
    assert.deepEqual(p.spent.map((s) => [s.theirs, s.now]), [[0, 2]]);
    assert.ok(!defaultTicks(p).has(p.spent[0]!.id), "unticked");
    const result = syncResult(p, defaultTicks(p));
    assert.deepEqual(result.spent, [{ id: p.spent[0]!.id, name: "Rage", max: 3, theirs: 0, now: 2 }]);
    assert.equal(syncPatch(c, result), null, "unticked, nothing new: Done sends nothing");
    assert.equal(result.counts.stayed, 1);
    const ticked = applied(c, p, new Set([p.spent[0]!.id]));
    assert.equal(byName(ticked, "Rage")!.used, 0);
  });

  test("ticked, D&D Beyond's count is cut to the count the sync leaves", () => {
    const c = spend(synced([{ ...RAGE, max: 4 }]), "Rage", 1);
    const p = plan(c, fill([{ ...RAGE, max: 2, used: 4 }]));
    assert.equal(byName(applied(c, p, new Set([...defaultTicks(p), p.spent[0]!.id])), "Rage")!.used, 2);
    assert.equal(syncResult(p, new Set()).spent[0]!.theirs, 2);
  });

  test("no spent count read: no line, and a new resource starts with none spent", () => {
    const { used: _u, ...noCount } = RAGE;
    const c = synced([noCount]);
    assert.equal(byName(c, "Rage")!.used, 0);
    assert.deepEqual(plan(spend(c, "Rage", 2), fill([noCount])).spent, []);
  });
});

describe("levels (4.4)", () => {
  test("a linked preset takes the read's class level and the level the sync leaves, with Level ticked or not, and alone is nothing new (OP-6, OP-19)", () => {
    const start = bree({ level: 4 });
    const c = applied(start, plan(start, fill([{ ...RAGE, level: 4 }], { level: 4 })));
    assert.equal(byName(c, "Rage")!.atLevel, 4);
    const p = plan(c, fill([{ ...RAGE, level: 5 }], { level: 5 }));
    assert.deepEqual(res(p), [], "no line");
    const ticked = applied(c, p);
    assert.deepEqual([byName(ticked, "Rage")!.level, byName(ticked, "Rage")!.atLevel, ticked.level], [5, 5, 5]);
    assert.deepEqual(levelUps(ticked.resources, ticked.level), [], "not asked to update afterwards");
    const unticked = syncResult(p, new Set());
    assert.deepEqual([unticked.resources![0]!.level, unticked.resources![0]!.atLevel], [5, 4], "Level unticked: the character's level");
    // Only the bookkeeping differs: the write rides with no other, so the review has nothing new and Done sends nothing.
    const alone = edit(ticked, "Rage", { level: 4, atLevel: 4 });
    const p2 = plan(alone, fill([{ ...RAGE, level: 5 }], { level: 5 }));
    const r2 = syncResult(p2, defaultTicks(p2));
    assert.ok(leavesAsIs(p2, r2));
    assert.equal(syncPatch(alone, r2), null);
  });
});

describe("pairing by class (OP-3, ASTRA-1, ASTRA-10, ASTRA-11, OP-17, OP-18, OP-23)", () => {
  test("two Channel Divinities pair with the character's by class", () => {
    const c = synced([cd("cleric", 3), cd("paladin", 2)]);
    const again = plan(edit(c, "Channel Divinity", {}), fill([cd("paladin", 2), cd("cleric", 3)]));
    assert.deepEqual(res(again), []);
  });

  test("a Paladin 3 with a linked Channel Divinity gains Cleric 2, then loses it: the Paladin's keeps its id and spent count throughout", () => {
    const c = spend(synced([cd("paladin")]), "Channel Divinity", 1);
    const id = byName(c, "Channel Divinity")!.id;
    const gained = applied(c, plan(c, fill([cd("cleric"), cd("paladin")])));
    assert.equal(gained.resources!.length, 2);
    assert.deepEqual(gained.resources!.find((r) => r.id === id), { ...byName(c, "Channel Divinity")!, level: 3, atLevel: 5 });
    const lost = applied(gained, plan(gained, fill([cd("paladin")])));
    assert.deepEqual(lost.resources!.map((r) => [r.id, r.used]), [[id, 1]]);
  });

  test("only a Paladin preset held with no entry, Cleric 2/Paladin 3 read: the Paladin's keeps its id and spent count, the Cleric's is added (ASTRA-10)", () => {
    const pal: ClassResource = { id: "pal", name: "Channel Divinity", max: 2, used: 1, reset: "shortOne", preset: "paladin-channel-divinity", level: 3, atLevel: 5 };
    const c = bree({ resources: [pal] });
    const after = applied(c, plan(c, fill([cd("cleric"), cd("paladin")])));
    assert.deepEqual(after.resources!.map((r) => [r.id, r.preset, r.used]), [
      ["pal", "paladin-channel-divinity", 1],
      [after.resources![1]!.id, "cleric-channel-divinity", 0],
    ]);
    // With a linked one of that name beside it, passes 2 and 3 each pair once.
    const typed: ClassResource = { id: "typed", name: "Channel Divinity", max: 2, used: 0, reset: "shortOne" };
    const linked = synced([{ ...cd("cleric"), preset: undefined, level: undefined, classId: undefined }], { resources: [typed] });
    const both = { ...linked, resources: [...linked.resources!, pal] };
    const p = plan(both, fill([cd("cleric"), cd("paladin")]));
    const out = applied(both, p, bulkToggle(bulkIds(p, "kept"), defaultTicks(p)));
    assert.equal(out.resources!.length, 2);
    assert.equal(out.ddbSync!.res![hash12("pal")]!.k, kOf("paladin:channel divinity"));
    assert.equal(out.ddbSync!.res![hash12("typed")]!.k, kOf("cleric:channel divinity"));
  });

  test("a linked Fighter resource read from a response with no classes, then with them: the same id and the room's spent count (ASTRA-11, OP-18)", () => {
    let c = spend(synced([dice("fighter")]), "Superiority Dice", 3);
    const id = byName(c, "Superiority Dice")!.id;
    for (const read of [dice(), dice("fighter"), dice(), dice("fighter")]) {
      const p = plan(c, fill([read]));
      assert.deepEqual(res(p), [], JSON.stringify(read.classId));
      c = applied(c, p);
      assert.deepEqual([byName(c, "Superiority Dice")!.id, byName(c, "Superiority Dice")!.used], [id, 3]);
      assert.equal(c.ddbSync!.res![hash12(id)]!.k, readResources([read])[0]!.k, "its k follows the read");
    }
  });

  test("a linked one whose key lost its class meets its own preset's class first, then a class no own preset waits for (pass 2)", () => {
    const nameAlone = { ...cd("paladin"), preset: undefined, level: undefined, classId: undefined };
    const c0 = synced([nameAlone]);
    const pal = edit(c0, "Channel Divinity", { preset: "paladin-channel-divinity" });
    const toPaladin = applied(pal, plan(pal, fill([cd("cleric"), cd("paladin")])));
    assert.equal(toPaladin.ddbSync!.res![hash12(byName(pal, "Channel Divinity")!.id)]!.k, kOf("paladin:channel divinity"), "its preset's class, though the Cleric comes first");
    const ownCleric: ClassResource = { id: "cler", name: "Channel Divinity", max: 2, used: 0, reset: "shortOne", preset: "cleric-channel-divinity", level: 2, atLevel: 5 };
    const both = { ...c0, resources: [...c0.resources!, ownCleric] };
    const after = applied(both, plan(both, fill([cd("cleric"), cd("paladin")])));
    assert.equal(after.ddbSync!.res![hash12(byName(c0, "Channel Divinity")!.id)]!.k, kOf("paladin:channel divinity"), "the Cleric read waits for the own Cleric preset");
    assert.equal(after.ddbSync!.res![hash12("cler")]!.k, kOf("cleric:channel divinity"));
  });

  test("an own Paladin preset is never tied to the Cleric's read by name (pass 4)", () => {
    const pal: ClassResource = { id: "pal", name: "Channel Divinity", max: 2, used: 0, reset: "shortOne", preset: "paladin-channel-divinity", level: 3, atLevel: 5 };
    const p = plan(bree({ resources: [pal] }), fill([cd("cleric")]));
    assert.deepEqual(res(p).map((i) => i.case), ["add"]);
  });

  test("a linked Paladin preset whose read loses its class while the Cleric's stays: it stays on the Paladin read, and the Cleric's is added (pass 2)", () => {
    const c = spend(synced([cd("paladin")]), "Channel Divinity", 1);
    const unresolved = { ...cd("paladin"), classId: undefined };
    const after = applied(c, plan(c, fill([cd("cleric"), unresolved])));
    assert.deepEqual(after.resources!.map((r) => [r.preset, r.used]), [
      ["paladin-channel-divinity", 1],
      ["cleric-channel-divinity", 0],
    ]);
  });

  test("an Artificer feature keys by name alone on both sides", () => {
    const flash: FillResource = { name: "Flash of Genius", max: 3, reset: "long", used: 0 };
    const c = spend(synced([flash]), "Flash of Genius", 1);
    assert.equal(c.ddbSync!.res![hash12(byName(c, "Flash of Genius")!.id)]!.k, kOf("flash of genius"));
    assert.deepEqual(res(plan(c, fill([flash]))), []);
  });

  test("a typed Superiority Dice with no preset meets the read whose class resolved, and no second copy comes in (OP-17)", () => {
    const typed: ClassResource = { id: "typed", name: "Superiority Dice", max: 4, used: 2, reset: "short" };
    const c = applied(bree({ resources: [typed] }), plan(bree({ resources: [typed] }), fill([dice("fighter")])));
    assert.deepEqual(names(c), ["Superiority Dice"]);
    assert.equal(c.ddbSync!.res![hash12("typed")]!.k, kOf("fighter:superiority dice"));
  });

  test("a linked typed Rage keyed by name and an unlinked Rage preset, the read now the Barbarian's: the linked one keeps it (OP-23)", () => {
    const typed: ClassResource = { id: "typed", name: "Rage", max: 3, used: 2, reset: "shortOne" };
    const linked = synced([{ ...RAGE, preset: undefined, level: undefined, classId: undefined }], { resources: [typed] });
    const preset: ClassResource = { id: "preset", name: "Rage", max: 3, used: 0, reset: "shortOne", preset: "barbarian-rage", level: 3, atLevel: 5 };
    const c = { ...linked, resources: [...linked.resources!, preset] };
    const after = applied(c, plan(c, fill([RAGE])));
    assert.equal(after.ddbSync!.res![hash12("typed")]!.k, kOf("barbarian:rage"));
    assert.equal(after.ddbSync!.res![hash12("preset")], undefined, "the preset stays the player's own");
    assert.equal(after.resources!.find((r) => r.id === "typed")!.used, 2);
  });

  test("a typed Channel Divinity with no preset and two class reads: one links, the other is added (OP-20)", () => {
    const typed: ClassResource = { id: "typed", name: "Channel Divinity", max: 2, used: 0, reset: "shortOne" };
    const c = applied(bree({ resources: [typed] }), plan(bree({ resources: [typed] }), fill([cd("cleric"), cd("paladin")])));
    assert.equal(c.resources!.length, 2);
    assert.equal(c.ddbSync!.res![hash12("typed")]!.k, kOf("cleric:channel divinity"));
  });

  test("an own Ki Points and an own Lay on Hands Pool meet the presets' reads, curly apostrophes as straight (OP-12)", () => {
    const own: ClassResource[] = [
      { id: "ki", name: "Ki Points", max: 5, used: 0, reset: "short", pool: true },
      { id: "loh", name: "Lay on Hands Pool", max: 25, used: 0, reset: "long", pool: true },
      { id: "veil", name: "Nature's Veil", max: 3, used: 0, reset: "long" },
    ];
    const reads: FillResource[] = [
      { name: "Focus Points", max: 5, reset: "short", pool: true, preset: "monk-focus-points", level: 5, classId: "monk" },
      { name: "Lay on Hands", max: 25, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, classId: "paladin" },
      { name: "Nature’s Veil", max: 3, reset: "long", preset: "ranger-natures-veil", level: 14, classId: "ranger" },
    ];
    const p = plan(bree({ resources: own }), fill(reads));
    assert.deepEqual(res(p).map((i) => [i.mine?.id, i.case]), [
      ["ki", "sameName"],
      ["loh", "sameName"],
      ["veil", "sameName"],
    ]);
  });
});

describe("removed here across a class change (ASTRA-12, OP-24)", () => {
  test("a removed Superiority Dice, as an entry and as a marker, read resolved, unresolved and resolved: stays removed, the marker keeping its place", () => {
    let c = removed(synced([dice("fighter"), breath]), "Superiority Dice");
    for (const [i, read] of [dice("fighter"), dice(), dice("fighter")].entries()) {
      const p = plan(c, fill([breath, read]));
      assert.equal(caseOf(p, "Superiority Dice"), "deleted", `read ${i}`);
      c = applied(c, p);
      assert.deepEqual(names(c), ["Breath Weapon"]);
      assert.deepEqual(c.ddbSync!.gone, [readResources([read])[0]!.k], "the marker takes the read's key in its place");
    }
    const back = plan(c, fill([breath, dice()]));
    assert.equal(byName(applied(c, back, new Set([`res:${kOf("superiority dice")}`])), "Superiority Dice")!.used, 0);
  });

  test("a marker that fits several reads by its class meets the class-unknown one first, then CLASS_IDS order (OP-24)", () => {
    const c = removed(synced([dice()]), "Superiority Dice");
    const stays = applied(c, plan(c, fill([dice()])));
    assert.deepEqual(stays.ddbSync!.gone, [kOf("superiority dice")]);
    // Three reads the name-alone marker meets by taking their class out, in neither CLASS_IDS order nor its reverse.
    const p = plan(stays, fill([{ ...dice(), classId: "rogue" }, { ...dice(), classId: "barbarian" }, dice("fighter")]));
    const deleted = res(p).filter((i) => i.case === "deleted");
    assert.deepEqual(deleted.map((i) => i.theirs!.resource.classId), ["barbarian"], "the first class in CLASS_IDS");
    const adds = res(p).filter((i) => i.case === "add").map((i) => i.theirs!.resource.classId);
    assert.deepEqual(adds, ["rogue", "fighter"], "the others come in, in the read's order");
  });
});

describe("sources (OP-11, ASTRA-8)", () => {
  test("none, relinked and first ignore the record's resource part and markers, and link by name", () => {
    const c = removed(synced([RAGE, breath]), "Breath Weapon");
    const marked = applied(c, plan(c, fill([RAGE, breath])));
    assert.ok(marked.ddbSync!.gone!.length > 0);
    const relinked = plan(marked, fill([RAGE, breath], { actor: { sheetUrl: "https://www.dndbeyond.com/characters/99" } }));
    assert.equal(relinked.source, "relinked");
    assert.deepEqual(res(relinked).map((i) => i.case), ["add"], "Breath Weapon comes in, Rage links by name");
    const none = plan({ ...marked, ddbSync: undefined }, fill([RAGE, breath]));
    assert.deepEqual(res(none).map((i) => i.case), ["add"]);
    const after = applied({ ...marked, ddbSync: undefined }, none);
    assert.equal(after.ddbSync!.gone, undefined, "the part is written fresh");
  });

  test("a first sync with a typed Rage: every resource lacked comes in, Rage is Different in the dialog, kept unless ticked, and Replaces in the editor", () => {
    const typed: ClassResource = { id: "typed", name: "Rage", max: 2, used: 1, reset: "long" };
    const c: SyncCharacter = { name: "Bree", level: 5, actor: actor({ sheetUrl: SHEET }), resources: [typed] };
    const p = plan(c, fill([RAGE, { ...breath, used: 1 }]));
    assert.equal(p.source, "first");
    assert.deepEqual(res(p).map((i) => [i.case, i.section]), [
      ["add", "changes"],
      ["sameName", "different"],
    ]);
    const after = applied(c, p);
    assert.deepEqual([byName(after, "Rage")!.max, byName(after, "Breath Weapon")!.used], [2, 1]);
    assert.equal(res(plan(c, fill([RAGE]), "editor"))[0]!.section, "replaces");
  });

  test("pasted text, or no actions: no resources part, and the list and record's part stay", () => {
    const c = spend(synced([RAGE]), "Rage", 2);
    const p = plan(c, fill(undefined));
    assert.deepEqual(res(p), []);
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.resources, undefined);
    assert.deepEqual(result.record.res, c.ddbSync!.res);
  });
});

describe("read not whole (ASTRA-2, ASTRA-3)", () => {
  test("a linked, untouched resource the read left out, its count or rest unread: kept as it was, its entry kept", () => {
    const c = spend(synced([RAGE, breath]), "Rage", 1);
    const p = plan(c, notWhole([breath]));
    assert.deepEqual(res(p), []);
    const after = applied(c, p);
    assert.deepEqual(byName(after, "Rage"), byName(c, "Rage"));
    assert.deepEqual(after.ddbSync!.res, c.ddbSync!.res);
  });

  test("absent read.resource beside resources reads as not whole", () => {
    const c = synced([RAGE, breath]);
    const p = plan(c, fill([breath], { read: { weapon: true, spell: true, other: true } }));
    assert.equal(caseOf(p, "Rage"), undefined);
  });
});

describe("the shared markers (OP-10, ASTRA-9)", () => {
  test("40 markers of a roll kind not read, then a resource removed: the oldest roll marker goes, the joint list keeps 40", () => {
    const rollMarkers = Array.from({ length: 40 }, (_, i) => `o:${i.toString(16).padStart(12, "0")}`);
    const c0 = synced([RAGE]);
    const c = removed({ ...c0, ddbSync: { ...c0.ddbSync!, gone: rollMarkers } }, "Rage");
    const p = plan(c, fill([RAGE], { read: { weapon: true, spell: true, other: false, resource: true } }));
    const result = syncResult(p, defaultTicks(p));
    assert.equal(result.record.gone!.length, 40);
    assert.equal(result.record.gone!.at(-1), kOf("barbarian:rage"));
    assert.deepEqual(result.goneDropped, [{ k: rollMarkers[0] }]);
  });

  test("each kind passes the other's markers through in place, the rolls' new ones before the resources'", () => {
    const c0 = synced([RAGE]);
    const held = ["w:000000000001", kOf("old resource"), "s:000000000002"];
    const c = removed({ ...c0, ddbSync: { ...c0.ddbSync!, gone: held } }, "Rage");
    const p = plan(c, fill([RAGE], { read: { weapon: false, spell: false, other: false, resource: false } }));
    const result = syncResult(p, defaultTicks(p));
    assert.deepEqual(result.record.gone, [...held, kOf("barbarian:rage")]);
  });
});

describe("Apply's op, afterSync and Undo (5)", () => {
  test("expect names the resources whenever the list or the record's resource part changes, and Undo gives every count back", () => {
    const c = spend(synced([RAGE, breath]), "Rage", 2);
    const p = plan(c, fill([RAGE, { ...breath, max: 4 }, { name: "Luck Points", max: 3, reset: "long", used: 1 }]));
    const sent = syncPatch(c, syncResult(p, defaultTicks(p)))!;
    assert.ok(sent.patch.resources);
    assert.ok(sent.expect.resources);
    const after = afterSync(c, sent.patch, AT);
    assert.deepEqual(after.resources!.map((r) => [r.name, r.max, r.used]), [
      ["Rage", 3, 2],
      ["Breath Weapon", 4, 0],
      ["Luck Points", 3, 1],
    ]);
    const undo = undoSync(c, sent.patch, AT)!;
    assert.deepEqual(undo.patch.resources, c.resources);
    assert.ok(undo.expect.resources);
    assert.deepEqual(afterSync(after, undo.patch, AT).resources, c.resources);
  });

  test("a marker alone changes the record's resource part, so expect names the resources though the list is unchanged", () => {
    const c = removed(synced([RAGE, breath]), "Rage");
    const sent = syncPatch(c, syncResult(plan(c, fill([breath])), new Set()))!;
    assert.equal(sent.patch.resources, undefined);
    assert.ok(sent.expect.resources);
  });

  test("a re-sync at once with the same read brings nothing in", () => {
    const c = synced([RAGE, breath, cd("cleric")]);
    const p = plan(c, fill([RAGE, breath, cd("cleric")]));
    assert.deepEqual(res(p), []);
    assert.equal(syncPatch(c, syncResult(p, defaultTicks(p))), null);
  });
});
