import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, DdbSync, PcRoll, PcStats } from "../model.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { clientOpSchema, SYNC_AT_AHEAD, type CharacterPatch, type DdbSyncPatch, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { EMPTY_PC_STATS, pcNumbersFromBlock, pcStatsTooBig } from "../rules/pcStats.ts";
import { actor, apply, AT, character, DM, env, refused, room, token } from "../testutil.ts";

/** The reducer's rules for a character's stat block (docs/design-v1-pc-stats.md 3.5). */

const BLOCK: PcStats = {
  ...structuredClone(EMPTY_PC_STATS as PcStats),
  abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 14, cha: 10 },
  skills: { perception: "prof" },
};

function withBree(overrides: Partial<Character> = {}) {
  return room({
    characters: { bree: character("bree", { name: "Bree", level: 5, actor: actor({ initBonus: 0, passivePerception: 10 }), ...overrides }) },
    tokens: { t: token("t", { kind: "pc", actor: { ref: "bree" } }) },
  });
}

const update = (patch: CharacterPatch): Op => ({ t: "character.update", characterId: "bree", patch });

/** A roll at its bounds, for the size rule. */
function bigRoll(id: string): PcRoll {
  return { id, name: "x".repeat(60), kind: "weapon", attack: { prof: true, bonus: 0 }, dice: Array.from({ length: 4 }, () => ({ formula: "1".repeat(40), type: "fire" as const })) };
}

describe("a character's stat block in the reducer", () => {
  test("a first patch builds on the empty block, and later ones replace only the parts they name", () => {
    let s = apply(withBree(), update({ stats: { abilities: BLOCK.abilities } }));
    const first = s.characters.bree!.stats!;
    assert.deepEqual(first, { ...EMPTY_PC_STATS, abilities: BLOCK.abilities });
    s = apply(s, update({ stats: { skills: { stealth: "expert" }, jack: true } }));
    const next = s.characters.bree!.stats!;
    assert.deepEqual(next.abilities, BLOCK.abilities, "a part left out keeps its value");
    assert.deepEqual(next.skills, { stealth: "expert" }, "a part named is replaced whole");
    assert.equal(next.jack, true);
    s = apply(s, update({ stats: { jack: null } }));
    assert.equal("jack" in s.characters.bree!.stats!, false, "null takes an optional part away");
  });

  test("an empty patch adds the empty block", () => {
    const s = apply(withBree(), update({ stats: {} }));
    assert.deepEqual(s.characters.bree!.stats, EMPTY_PC_STATS);
    assert.equal(s.characters.bree!.actor.initBonus, 0);
    assert.equal(s.characters.bree!.actor.passivePerception, 10);
  });

  test("initiative and Passive Perception follow the block on create, on update and on a level change", () => {
    const created = apply(room(), { t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: actor({ initBonus: 9, passivePerception: 30 }), level: 5, stats: BLOCK } });
    assert.equal(created.characters.c!.actor.initBonus, 3);
    assert.equal(created.characters.c!.actor.passivePerception, 10 + 2 + 3);
    let s = apply(withBree(), update({ stats: BLOCK }));
    assert.equal(s.characters.bree!.actor.initBonus, 3);
    assert.equal(s.characters.bree!.actor.passivePerception, 15);
    s = apply(s, update({ level: 9 }));
    assert.equal(s.characters.bree!.actor.passivePerception, 16, "a level change moves it");
    s = apply(s, update({ level: null }));
    assert.equal(s.characters.bree!.actor.passivePerception, 14, "an unset level reads as 1");
  });

  test("a typed initiative or Passive Perception is refused once a block gives them, from the DM too and through a PC token", () => {
    const s = apply(withBree(), update({ stats: BLOCK }));
    const message = pcNumbersFromBlock("Bree");
    assert.deepEqual(refused(s, update({ actor: { initBonus: 5 } })), { ok: false, code: "invalid", message });
    assert.deepEqual(refused(s, update({ actor: { passivePerception: 12 } })), { ok: false, code: "invalid", message });
    assert.deepEqual(refused(s, { t: "token.update", tokenId: "t", patch: { actor: { initBonus: 5 } } }), { ok: false, code: "invalid", message });
    assert.deepEqual(refused(withBree(), update({ stats: BLOCK, actor: { initBonus: 5 } })), { ok: false, code: "invalid", message }, "a patch that adds a block");
    // The rest of the actor stays open to edits.
    const hurt = apply(s, update({ actor: { ac: 17, hp: { cur: 5 } } }));
    assert.equal(hurt.characters.bree!.actor.ac, 17);
    assert.equal(hurt.characters.bree!.actor.initBonus, 3);
  });

  test("removing the block keeps the last numbers, and they are typed again after", () => {
    let s = apply(withBree(), update({ stats: BLOCK }));
    s = apply(s, update({ stats: null }));
    assert.equal(s.characters.bree!.stats, undefined);
    assert.equal(s.characters.bree!.actor.initBonus, 3);
    assert.equal(s.characters.bree!.actor.passivePerception, 15);
    s = apply(s, update({ actor: { initBonus: 1 } }));
    assert.equal(s.characters.bree!.actor.initBonus, 1);
    const both = apply(apply(withBree(), update({ stats: BLOCK })), update({ stats: null, actor: { passivePerception: 11 } }));
    assert.equal(both.characters.bree!.actor.passivePerception, 11, "a patch that removes the block may type them at once");
  });

  test("a block that would end past 12 KiB is refused with quota, though the patch alone fits its own bound", () => {
    const full: PcStats = { ...BLOCK, adjust: { saves: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, allSaves: 1, allChecks: 1 } };
    const s = apply(withBree(), update({ stats: full }));
    // Rolls that fill the patch's own bound to within a few bytes: the parts the block keeps beside them take it past.
    const rolls: PcRoll[] = [];
    while (serializedBytes({ rolls: [...rolls, bigRoll(`r${rolls.length}`)] }) <= LIMITS.pcStatsBytes - 16) rolls.push(bigRoll(`r${rolls.length}`));
    const op = update({ stats: { rolls } });
    assert.equal(clientOpSchema.safeParse(op).success, true, "the patch passes the schema");
    assert.deepEqual(refused(s, op), { ok: false, code: "quota", message: pcStatsTooBig("Bree") });
    assert.equal(pcStatsTooBig("Bree"), "Bree's stat block can be at most 12 KiB. Remove a few rolls.");
    // The same rolls on a character with the empty block fit, since it keeps less beside them.
    const small = apply(withBree(), update({ stats: { rolls: rolls.slice(0, -2) } }));
    assert.equal(small.characters.bree!.stats!.rolls.length, rolls.length - 2);
  });

  test("an undo puts back the block and the two actor numbers together", () => {
    const before = apply(withBree(), update({ stats: BLOCK }));
    const r = applyOp(before, update({ stats: { abilities: { ...BLOCK.abilities, dex: 20, wis: 20 } } }), DM, env(2));
    assert.ok(r.ok);
    assert.equal(r.state.characters.bree!.actor.initBonus, 5);
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 3);
    assert.deepEqual(undone.characters.bree!.stats, before.characters.bree!.stats);
    assert.equal(undone.characters.bree!.actor.initBonus, 3);
    assert.equal(undone.characters.bree!.actor.passivePerception, 15);
  });
});

/** A sync's record as its patch sends it, with no `at` (docs/design-v1-resync.md 2.1). */
const RECORD: DdbSyncPatch = {
  from: "123456789",
  base: { abilities: BLOCK.abilities, spellAbility: "cha", level: 5, ac: 15, hpMax: 38 },
  rolls: { "0123456789ab": { k: "w:00000000000a", h: "abcdef012345" } },
  gone: ["s:00000000000b"],
};
const LATER = "2026-10-20T18:30:00.000Z";

/** Applies the op at the given time, and as an op stored at `opVersion` when one is given. */
function applyAt(state: ReturnType<typeof withBree>, op: Op, at: string, opVersion?: number) {
  const r = applyOp(state, op, DM, { ...env(2), at, ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.message}`);
  return r;
}

describe("a character's D&D Beyond sync record in the reducer (docs/design-v1-resync.md 4)", () => {
  test("a record is stored as sent, with the op's time as its at", () => {
    const { state } = applyAt(withBree({ stats: BLOCK }), update({ stats: { saves: ["wis"] }, level: 5, ddbSync: RECORD }), LATER);
    assert.deepEqual(state.characters.bree!.ddbSync, { ...RECORD, at: LATER } satisfies DdbSync);
    assert.deepEqual(state.characters.bree!.stats!.saves, ["wis"], "the rest of the patch lands beside it");
  });

  test("an at the patch sends is kept, as the dialog's Undo sends the record before", () => {
    const before: DdbSyncPatch = { ...RECORD, at: AT };
    const { state } = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: before }), LATER);
    assert.equal(state.characters.bree!.ddbSync!.at, AT);
  });

  test("a new record replaces the old one whole, and a patch that names neither the record nor the block keeps it", () => {
    let s = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), AT).state;
    const next: DdbSyncPatch = { base: { level: 6 }, rolls: {} };
    s = applyAt(s, update({ ddbSync: next }), LATER).state;
    assert.deepEqual(s.characters.bree!.ddbSync, { ...next, at: LATER });
    s = applyAt(s, update({ level: 7, actor: { hp: { cur: 3 } }, stats: { jack: true } }), LATER).state;
    assert.deepEqual(s.characters.bree!.ddbSync, { ...next, at: LATER });
  });

  test("a record's stamp is the op's time, or 1 ms past the record it replaces when that is as late, so no two writes share one (RSBUILD-ASTRA-04)", () => {
    let s = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), LATER).state;
    assert.equal(s.characters.bree!.ddbSync!.at, LATER);
    s = applyAt(s, update({ ddbSync: RECORD }), LATER).state;
    assert.equal(s.characters.bree!.ddbSync!.at, "2026-10-20T18:30:00.001Z", "an equal record in the same millisecond");
    s = applyAt(s, update({ ddbSync: RECORD }), LATER).state;
    assert.equal(s.characters.bree!.ddbSync!.at, "2026-10-20T18:30:00.002Z");
    s = applyAt(s, update({ ddbSync: RECORD }), "2026-10-20T18:31:00.000Z").state;
    assert.equal(s.characters.bree!.ddbSync!.at, "2026-10-20T18:31:00.000Z", "a later time is the op's own");
    // A record from a clock a few hours ahead, within the day a write may be, is passed by 1 ms.
    const ahead = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: { ...RECORD, at: "2026-10-13T00:00:00.000Z" } }), AT).state;
    assert.equal(applyAt(ahead, update({ ddbSync: RECORD }), AT).state.characters.bree!.ddbSync!.at, "2026-10-13T00:00:00.001Z");
    // An at the patch sends is kept even when earlier, as Undo puts the record before back.
    assert.equal(applyAt(s, update({ ddbSync: { ...RECORD, at: AT } }), LATER).state.characters.bree!.ddbSync!.at, AT);
  });

  test("a record whose own at is more than a day past the op's time is refused, a day exactly is taken, and Undo's earlier at always is (RS-O-37)", () => {
    const s = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), LATER).state;
    const at = (when: string) => applyOp(s, update({ ddbSync: { ...RECORD, at: when } }), DM, { ...env(3), at: LATER });
    const day = at("2026-10-21T18:30:00.000Z");
    assert.ok(day.ok);
    assert.equal(day.state.characters.bree!.ddbSync!.at, "2026-10-21T18:30:00.000Z");
    const past = at("2026-10-21T18:30:00.001Z");
    assert.deepEqual(past.ok ? null : [past.code, past.message], ["invalid", SYNC_AT_AHEAD]);
    const far = at("9999-12-31T23:59:59.999Z");
    assert.equal(far.ok, false);
    const undo = at(AT);
    assert.ok(undo.ok, "an earlier server stamp, as Undo sends");
    assert.equal(undo.state.characters.bree!.ddbSync!.at, AT);
  });

  test("null drops the record and keeps the block", () => {
    const s = applyAt(applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), AT).state, update({ ddbSync: null }), LATER).state;
    assert.equal("ddbSync" in s.characters.bree!, false);
    assert.deepEqual(s.characters.bree!.stats, BLOCK);
  });

  test("removing the block drops the record, even one sent beside it, since its base then describes no block", () => {
    const synced = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), AT).state;
    const removed = applyAt(synced, update({ stats: null }), LATER).state;
    assert.equal("ddbSync" in removed.characters.bree!, false);
    assert.equal("stats" in removed.characters.bree!, false);
    const both = applyAt(synced, update({ stats: null, ddbSync: RECORD }), LATER).state;
    assert.equal("ddbSync" in both.characters.bree!, false);
  });

  test("a record past 6 KiB once its at is written is refused with quota", () => {
    const s = withBree({ stats: BLOCK });
    // Entries past the schema's 40 and senses padded to 10 bytes under the bound, so the size alone decides: the patch fits 6 KiB, and the time the reducer writes takes it past.
    const rolls: DdbSyncPatch["rolls"] = {};
    for (let n = 0; n < 100; n++) rolls[n.toString(16).padStart(12, "0")] = { k: "w:000000000000", h: "000000000000" };
    const unpadded: DdbSyncPatch = { ...RECORD, base: { ...RECORD.base, senses: "" }, rolls };
    const big: DdbSyncPatch = { ...unpadded, base: { ...unpadded.base, senses: "x".repeat(LIMITS.ddbSyncBytes - 10 - serializedBytes(unpadded)) } };
    assert.equal(serializedBytes(big), LIMITS.ddbSyncBytes - 10);
    assert.ok(serializedBytes({ ...big, at: AT }) > LIMITS.ddbSyncBytes);
    const r = applyOp(s, update({ ddbSync: big, level: 9 }), DM, env(2));
    assert.ok(!r.ok);
    assert.equal(r.code, "quota");
    assert.equal(r.message, "Bree's sync record would be too large to save.");
    const fits = applyAt(s, update({ ddbSync: { ...big, base: { ...big.base, senses: big.base.senses!.slice(40) } } }), AT).state;
    assert.ok(serializedBytes(fits.characters.bree!.ddbSync) <= LIMITS.ddbSyncBytes, "40 bytes less fits");
  });

  test("an undo of a sync puts back the character whole, its record or its lack of one included", () => {
    const before = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), AT).state;
    const r = applyAt(before, update({ ddbSync: { base: { level: 6 }, rolls: {} }, level: 6 }), LATER);
    const undone = apply(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo" }, DM, 3);
    assert.deepEqual(undone.characters.bree!.ddbSync, { ...RECORD, at: AT });
    const first = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), LATER);
    const none = apply(first.state, { t: "sys.restore", entries: first.inverse!, from: "undo" }, DM, 3);
    assert.equal("ddbSync" in none.characters.bree!, false);
  });

  test("an op stored before version 16 replays as it applied then: it writes no record or at, and removing the block keeps one", () => {
    const old = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD, level: 6 }), LATER, 15).state;
    assert.equal("ddbSync" in old.characters.bree!, false);
    assert.equal(old.characters.bree!.level, 6);
    const synced = applyAt(withBree({ stats: BLOCK }), update({ ddbSync: RECORD }), AT).state;
    const removed = applyAt(synced, update({ stats: null }), LATER, 15).state;
    assert.equal("stats" in removed.characters.bree!, false);
    assert.deepEqual(removed.characters.bree!.ddbSync, { ...RECORD, at: AT });
    const today = applyAt(synced, update({ stats: null }), LATER, 16).state;
    assert.equal("ddbSync" in today.characters.bree!, false, "a version 16 op takes today's rule");
  });
});
