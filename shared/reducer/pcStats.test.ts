import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, PcRoll, PcStats } from "../model.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { clientOpSchema, type CharacterPatch, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { EMPTY_PC_STATS, pcNumbersFromBlock, pcStatsTooBig } from "../rules/pcStats.ts";
import { actor, apply, character, DM, env, refused, room, token } from "../testutil.ts";

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
