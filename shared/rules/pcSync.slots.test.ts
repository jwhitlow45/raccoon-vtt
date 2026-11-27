import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHARACTER_CHANGED, LIMITS, serializedBytes } from "../limits.ts";
import type { Character, ClassLevel, PcStats, RoomState, Spent } from "../model.ts";
import { canApply } from "../permissions.ts";
import { opSchema, type DdbSyncPatch, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { stampedAt } from "../reducer/tokens.ts";
import type { PcFill } from "./pcFill.ts";
import { afterSync, defaultTicks, planSync, recordFits, syncPatch, syncResult, takesTheirs, undoSync, type SyncCharacter, type SyncPlan } from "./pcSync.ts";
import { EMPTY_PC_STATS } from "./pcStats.ts";
import { P1, actor, character, room } from "../testutil.ts";

/**
 * The classes in a re-sync (docs/design/design-v1-slots.md 6 and 8): one
 * field, as the level is, and an Undo that puts back the classes with the
 * exact counts spent before them, guarded by the use stamp, so any rest or
 * use since refuses it, even where every count reads the same. Apply and
 * Undo run through permissions and the reducer, as the server takes them.
 */

const SHEET = "https://www.dndbeyond.com/characters/12345678";
const empty = (): PcStats => structuredClone(EMPTY_PC_STATS) as PcStats;
const nine = (counts: number[]) => [...counts, ...Array<number>(9 - counts.length).fill(0)];
const wizard = (level: number): ClassLevel[] => [{ id: "wizard", level }];

function fillWith(classes: ClassLevel[] | undefined, over: Partial<PcFill> = {}): PcFill {
  return {
    source: "ddb",
    stats: { abilities: empty().abilities, rolls: [] },
    level: 5,
    name: "Bree",
    actor: { sheetUrl: SHEET },
    warnings: [],
    read: { weapon: true, spell: true, other: true },
    ...(classes ? { classes, classNames: classes.map((c) => (c.id === "other" ? "Artificer" : c.id)) } : {}),
    ...over,
  };
}

function planOf(c: SyncCharacter, fill: PcFill): SyncPlan {
  return planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill, newId: () => "n1" });
}

const AT = "2026-11-20T19:00:00.000Z";

/** Bree, a Wizard 5 already synced from D&D Beyond, with what she spent, in a room P1 plays her in. */
function synced(spent?: Spent, over: Partial<Character> = {}): RoomState {
  const first: SyncCharacter = { name: "Bree", level: 5, actor: actor({ hp: { cur: 30, max: 30, temp: 0 }, sheetUrl: SHEET }) };
  const p = planOf(first, fillWith(wizard(5)));
  const sent = syncPatch(first, syncResult(p, defaultTicks(p)))!;
  const after = afterSync(first, sent.patch, AT);
  const bree = character("bree", { ...after, ownerIds: ["p1"], ...(spent ? { spent } : {}), ...over });
  return room({ characters: { bree } });
}

/** An op through permissions and the reducer, as the server takes it, or the refusal's words. */
function through(state: RoomState, op: Op, seq: number): { state: RoomState } | { refused: string } {
  assert.ok(opSchema.safeParse(op).success, JSON.stringify(op));
  const allowed = canApply(op, P1, state, { canUseAsset: () => true });
  if (!allowed.ok) return { refused: allowed.message };
  const r = applyOp(state, op, P1, { seq, at: `2026-11-21T19:00:0${seq}.000Z` });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return { state: r.state };
}

function ok(r: ReturnType<typeof through>): RoomState {
  assert.ok("state" in r, "refused" in r ? r.refused : "");
  return r.state;
}

/** A re-sync's Apply with its default ticks, and the Undo it would send. */
function resync(state: RoomState, fill: PcFill, seq = 1): { applied: RoomState; undo: Op; apply: Op } {
  const bree = state.characters.bree!;
  const p = planOf(bree, fill);
  const sent = syncPatch(bree, syncResult(p, defaultTicks(p)))!;
  const apply: Op = { t: "character.update", characterId: "bree", patch: sent.patch, expect: sent.expect };
  const applied = ok(through(state, apply, seq));
  const back = undoSync(bree, sent.patch, stampedAt(apply, applied))!;
  return { applied, apply, undo: { t: "character.update", characterId: "bree", patch: back.patch, expect: back.expect } };
}

const slot = (level: number, back = false): Op => ({ t: "actor.use", target: { characterId: "bree" }, use: { kind: "slot", level }, ...(back ? { back: true as const } : {}) });
const rest = (kind: "short" | "long"): Op => ({ t: "actor.rest", target: { characterId: "bree" }, kind });

describe("classes in a re-sync (docs/design/design-v1-slots.md 8)", () => {
  test("a change there comes in on a ticked Also set line, and spent counts are never sent", () => {
    const state = synced();
    const p = planOf(state.characters.bree!, fillWith([{ id: "fighter", level: 3, third: true }, { id: "wizard", level: 2 }]));
    const line = p.also.find((a) => a.key === "classes")!;
    assert.ok(line.on);
    assert.deepEqual(line.names, ["fighter", "wizard"]);
    const sent = syncPatch(state.characters.bree!, syncResult(p, defaultTicks(p)))!;
    assert.deepEqual(sent.patch.classes, [{ id: "fighter", level: 3, third: true }, { id: "wizard", level: 2 }]);
    assert.equal(sent.patch.spent, undefined);
    assert.ok(sent.expect.classes, "Apply that writes classes expects them");
    assert.deepEqual(sent.patch.ddbSync!.base.classes, [{ id: "fighter", level: 3, third: true }, { id: "wizard", level: 2 }]);
  });

  test("the same classes in another order are no change, and classes not read leave them as they are", () => {
    const state = synced(undefined, { classes: [{ id: "cleric", level: 1 }, { id: "wizard", level: 4 }] });
    const bree = { ...state.characters.bree!, ddbSync: { ...state.characters.bree!.ddbSync!, base: { ...state.characters.bree!.ddbSync!.base, classes: [{ id: "wizard", level: 4 }, { id: "cleric", level: 1 }] as ClassLevel[] } } };
    assert.equal(planOf(bree, fillWith([{ id: "wizard", level: 4 }, { id: "cleric", level: 1 }])).also.some((a) => a.key === "classes"), false);
    assert.equal(planOf(bree, fillWith(undefined)).also.some((a) => a.key === "classes"), false);
  });

  test("a change made here is kept with Overwrite, as the level is", () => {
    const state = synced(undefined, { classes: wizard(6) });
    const p = planOf(state.characters.bree!, fillWith(wizard(7)));
    const kept = p.items.find((i) => i.type === "field" && i.key === "classes")!;
    assert.equal(kept.section, "kept");
    assert.equal(kept.conflict, true);
    assert.equal(takesTheirs(kept, defaultTicks(p)), false);
    assert.equal(syncPatch(state.characters.bree!, syncResult(p, defaultTicks(p)))!.patch.classes, undefined);
    const over = syncPatch(state.characters.bree!, syncResult(p, new Set([...defaultTicks(p), kept.id])))!;
    assert.deepEqual(over.patch.classes, wizard(7));
    const unchanged = planOf(state.characters.bree!, fillWith(wizard(5))).items.find((i) => i.type === "field" && i.key === "classes")!;
    assert.deepEqual([unchanged.section, unchanged.conflict], ["kept", false], "unchanged there: kept, with Overwrite");
  });

  test("a record with 12 classes at their widest stays within the 6 KiB a record may take", () => {
    const record: DdbSyncPatch = { base: { classes: [...(["barbarian", "bard", "cleric", "druid", "monk", "paladin", "ranger", "sorcerer", "warlock", "wizard"] as const).map((id) => ({ id, level: 1 })), { id: "fighter", level: 1, third: true }, { id: "rogue", level: 9, third: true }] }, rolls: {} };
    assert.ok(recordFits(record));
    // About 0.5 KB, which the record's 5.5 KB at every other bound leaves room for.
    assert.ok(serializedBytes(record.base.classes) < 600, `${serializedBytes(record.base.classes)} bytes`);
    assert.ok(LIMITS.ddbSyncBytes - 5_600 > serializedBytes(record.base.classes));
  });
});

describe("a re-sync's Undo of the classes (docs/design/design-v1-slots.md 6)", () => {
  const spent = { slots: nine([1, 0, 2]) };

  test("Wizard 5 to 4 with level 3 slots spent, then Undo: Wizard 5 and its spent slots back", () => {
    const { applied, undo } = resync(synced(spent), fillWith(wizard(4)));
    assert.deepEqual(applied.characters.bree!.classes, wizard(4));
    assert.deepEqual(applied.characters.bree!.spent, { slots: nine([1]) }, "the clamp takes the level 3 slots");
    assert.deepEqual(undo.t === "character.update" && undo.patch.spent, spent);
    const back = ok(through(applied, undo, 2));
    assert.deepEqual(back.characters.bree!.classes, wizard(5));
    assert.deepEqual(back.characters.bree!.spent, spent);
  });

  for (const [what, between] of [
    ["a spend", slot(1)],
    ["a Restore", slot(1, true)],
    ["a Short Rest", rest("short")],
    ["a Long Rest", rest("long")],
  ] as const) {
    test(`with ${what} between, Undo is refused with today's stale words`, () => {
      const { applied, undo } = resync(synced(spent), fillWith(wizard(4)));
      const later = ok(through(applied, between, 2));
      assert.deepEqual(through(later, undo, 3), { refused: CHARACTER_CHANGED });
    });
  }

  test("every spent count clamped away, then a Long Rest that changes no count, then Undo: refused", () => {
    const { applied, undo } = resync(synced({ slots: nine([0, 0, 2]) }), fillWith(wizard(4)));
    assert.equal(applied.characters.bree!.spent, undefined);
    const rested = ok(through(applied, rest("long"), 2));
    assert.equal(rested.characters.bree!.spent, undefined, "the counts read the same");
    assert.deepEqual(through(rested, undo, 3), { refused: CHARACTER_CHANGED });
  });

  test("removing every class, then Undo, gives them back with their counts, and after a rest is refused", () => {
    const one = resync(synced(spent), fillWith([]));
    assert.equal(one.applied.characters.bree!.classes, undefined);
    assert.equal(one.applied.characters.bree!.spent, undefined);
    assert.deepEqual(ok(through(one.applied, one.undo, 2)).characters.bree!.spent, spent);
    const two = resync(synced(spent), fillWith([]));
    assert.deepEqual(through(ok(through(two.applied, rest("short"), 2)), two.undo, 3), { refused: CHARACTER_CHANGED });
  });

  test("a resources-only re-sync, a rest, then Undo: refused", () => {
    const rage = { name: "Rage", max: 3, reset: "shortOne" as const, preset: "barbarian-rage", level: 3, classId: "barbarian" as const, used: 0 };
    const state = synced(spent);
    const { applied, undo, apply } = resync(state, fillWith(wizard(5), { resources: [rage], read: { weapon: true, spell: true, other: true, resource: true } }));
    assert.ok(apply.t === "character.update" && apply.patch.resources && apply.patch.classes === undefined, "writes resources alone");
    assert.ok(undo.t === "character.update" && undo.expect?.classes, "its Undo expects the classes too");
    assert.ok("state" in through(applied, undo, 2), "with nothing since, Undo is taken");
    assert.deepEqual(through(ok(through(applied, rest("long"), 2)), undo, 3), { refused: CHARACTER_CHANGED });
  });

  test("a rest or a use during the review refuses Apply, when it writes classes or resources", () => {
    for (const between of [rest("short"), slot(1)]) {
      const state = synced(spent);
      const bree = state.characters.bree!;
      const p = planOf(bree, fillWith(wizard(4)));
      const sent = syncPatch(bree, syncResult(p, defaultTicks(p)))!;
      const later = ok(through(state, between, 1));
      assert.deepEqual(through(later, { t: "character.update", characterId: "bree", patch: sent.patch, expect: sent.expect }, 2), { refused: CHARACTER_CHANGED });
    }
    const rage = { name: "Rage", max: 3, reset: "shortOne" as const, preset: "barbarian-rage", level: 3, classId: "barbarian" as const, used: 0 };
    const state0 = synced(spent);
    const rp = planOf(state0.characters.bree!, fillWith(wizard(5), { resources: [rage], read: { weapon: true, spell: true, other: true, resource: true } }));
    const rsent = syncPatch(state0.characters.bree!, syncResult(rp, defaultTicks(rp)))!;
    assert.ok(rsent.patch.resources && rsent.patch.classes === undefined && rsent.expect.classes, "a resources write expects the classes");
    assert.deepEqual(through(ok(through(state0, rest("long"), 1)), { t: "character.update", characterId: "bree", patch: rsent.patch, expect: rsent.expect }, 2), { refused: CHARACTER_CHANGED });
    // A sync that writes neither leaves a rest during the review alone.
    const state = synced(spent);
    const p = planOf(state.characters.bree!, fillWith(wizard(5), { level: 6 }));
    const sent = syncPatch(state.characters.bree!, syncResult(p, defaultTicks(p)))!;
    assert.equal(sent.expect.classes, undefined);
    assert.ok("state" in through(ok(through(state, rest("short"), 1)), { t: "character.update", characterId: "bree", patch: sent.patch, expect: sent.expect }, 2));
  });

  test("a give back with nothing to give leaves the stamp, so Undo is still taken", () => {
    const { applied, undo } = resync(synced({ slots: nine([1]) }), fillWith(wizard(4)));
    const same = ok(through(applied, slot(2, true), 2));
    assert.equal(same.characters.bree!.useRev, applied.characters.bree!.useRev);
    assert.ok("state" in through(same, undo, 3));
  });
});
