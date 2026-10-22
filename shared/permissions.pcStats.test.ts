import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHARACTER_CHANGED } from "./limits.ts";
import type { Character, PcStats, RoomState, Viewer } from "./model.ts";
import { canApply, expectHash, expectOf, SYNC_STAMP_FULL } from "./permissions.ts";
import { projectCharacter } from "./project.ts";
import { ddbSyncPatchSchema, EXPECT_PARTS, onPlayerUndoStack, type CharacterExpect, type CharacterPatch, type DdbSyncPatch, type Op, type PcStatsPatch } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { EMPTY_PC_STATS } from "./rules/pcStats.ts";
import { AT, DM, P1, P2, actor, character, effect, env, room } from "./testutil.ts";

/**
 * Who edits a character's stat block (docs/design-v1-pc-stats.md 4.1): the
 * DM and the character's players, co-owners included, with no room
 * setting, and no one else.
 */

const BLOCK: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), saves: ["dex"] };

/** Bree, played by p1 and p2 together, and Cy by p2 alone. */
function setup(): RoomState {
  return room({
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }),
      cy: character("cy", { name: "Cy", ownerIds: ["p2"] }),
    },
  });
}

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, { canUseAsset: () => true });
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const edit = (characterId: string, stats: PcStatsPatch | null): Op => ({ t: "character.update", characterId, patch: { stats } });

describe("stat block permissions", () => {
  test("an owner and a co-owner edit and remove their character's block, the DM any character's", () => {
    assert.equal(decide(edit("bree", BLOCK)), "ok");
    assert.equal(decide(edit("bree", { saves: ["con"] }), P2), "ok");
    assert.equal(decide(edit("bree", null)), "ok");
    assert.equal(decide(edit("cy", BLOCK), DM), "ok");
  });

  test("another player gets the refusal any field of a character they do not play gets", () => {
    assert.equal(decide(edit("cy", BLOCK)), "forbidden: that is not yours");
    assert.equal(decide(edit("cy", null)), "forbidden: that is not yours");
  });

  test("a player's new character may carry a block", () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = true;
    const op: Op = { t: "character.create", character: { id: "mine", name: "Mira", size: "medium", ownerIds: ["p1"], actor: actor({ dmNotes: "" }), stats: BLOCK } };
    assert.equal(decide(op, P1, state), "ok");
  });

  test("a player's undo never restores a character: a block edit is on no player's stack, and a restore of a character is refused", () => {
    assert.equal(onPlayerUndoStack(edit("bree", BLOCK)), false);
    const restore: Op = { t: "sys.restore", entries: [{ key: "character:bree", value: character("bree", { ownerIds: ["p1"], stats: BLOCK }) }], from: "undo" };
    assert.equal(decide(restore), "forbidden: only the DM can do that");
  });

  test("a character's players take a shape on it, and never link a room monster or shape another's character", () => {
    const shape = (characterId: string, actor: object): Op => ({ t: "character.update", characterId, patch: { actor } as never });
    assert.equal(decide(shape("bree", { srdId: "brown-bear", wildShape: true })), "ok");
    assert.equal(decide(shape("bree", { srdId: null }), P2), "ok");
    assert.equal(decide(shape("bree", { monsterId: "m1" })), "forbidden: owners cannot change monsterId");
    assert.equal(decide(shape("cy", { srdId: "brown-bear" })), "forbidden: that is not yours");
    assert.equal(decide(shape("cy", { monsterId: "m1" }), DM), "ok");
  });
});

/** A sync's record as its patch sends it (docs/design-v1-resync.md 2.1). */
const RECORD: DdbSyncPatch = { from: "123456789", base: { level: 6, ac: 15 }, rolls: { "0123456789ab": { k: "w:00000000000a", h: "abcdef012345" } } };

/** Bree with a block, a record, a DM's note and a hidden effect, played by p1 and p2, and Cy by p2 alone. */
function synced(): RoomState {
  const state = setup();
  state.characters.bree = character("bree", {
    name: "Bree",
    ownerIds: ["p1", "p2"],
    level: 5,
    stats: BLOCK,
    ddbSync: { ...RECORD, at: AT },
    actor: actor({ ac: 15, hp: { cur: 35, max: 38, temp: 0 }, dmNotes: "owes the thieves' guild", effects: [effect("hex", { hiddenFromPlayers: true })] }),
  });
  return state;
}

/** Bree as a player's own device holds her. */
function asSeen(state: RoomState, viewer: Viewer): Character {
  return projectCharacter(state, viewer, state.characters.bree!) as Character;
}

const sync = (patch: CharacterPatch, expect?: CharacterExpect): Op => ({ t: "character.update", characterId: "bree", patch, ...(expect ? { expect } : {}) });

/** A DM's edit of what no player's copy holds: a note and a hidden effect. */
function dmSecretly(state: RoomState): RoomState {
  const noted = applyOp(state, { t: "character.update", characterId: "bree", patch: { actor: { dmNotes: "is the guild's spy" } } }, DM, env(2));
  assert.ok(noted.ok);
  const hidden = applyOp(noted.state, { t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: "mark", key: "blessed", hiddenFromPlayers: true } }, DM, env(3));
  assert.ok(hidden.ok, hidden.ok ? "" : hidden.message);
  return hidden.state;
}

describe("a re-sync's permissions (docs/design-v1-resync.md 4)", () => {
  test("an owner, a co-owner and the DM write the record, alone or with the block, and remove it", () => {
    assert.equal(decide(sync({ ddbSync: RECORD }), P1, synced()), "ok");
    assert.equal(decide(sync({ ddbSync: RECORD, stats: { saves: ["wis"] }, level: 6 }), P2, synced()), "ok");
    assert.equal(decide(sync({ ddbSync: null }), P1, synced()), "ok");
    assert.equal(decide(sync({ ddbSync: { ...RECORD, at: AT } }), DM, synced()), "ok");
  });

  test("another player hears that Cy is not theirs before any expect is read, a wrong one included", () => {
    const wrong: CharacterExpect = { level: "000000000000", ddbSync: "000000000000" };
    const toCy = (expect?: CharacterExpect): Op => ({ t: "character.update", characterId: "cy", patch: { ddbSync: RECORD }, ...(expect ? { expect } : {}) });
    assert.equal(decide(toCy(), P1, synced()), "forbidden: that is not yours");
    assert.equal(decide(toCy(wrong), P1, synced()), "forbidden: that is not yours");
    assert.equal(decide(toCy(wrong), DM, synced()), `invalid: ${CHARACTER_CHANGED}`, "the DM's own op is checked too");
  });

  test("an expect that still holds is taken, one that missed is refused in the one message, and none or a part left out is not checked", () => {
    const state = synced();
    const parts = ["stats.saves", "level", "actor.ac", "actor.shape", "ddbSync"] as const;
    const seen = expectOf(asSeen(state, P1), parts);
    const apply = (expect?: CharacterExpect) => sync({ stats: { saves: ["wis"] }, level: 6, actor: { ac: 16 }, ddbSync: RECORD }, expect);
    assert.equal(decide(apply(seen), P1, state), "ok");
    assert.equal(decide(apply(seen), DM, state), "ok");
    assert.equal(decide(apply(), P1, state), "ok");
    assert.equal(decide(apply({}), P1, state), "ok");
    const moved = structuredClone(state);
    moved.characters.bree!.actor.ac = 17;
    assert.equal(decide(apply(seen), P1, moved), `invalid: ${CHARACTER_CHANGED}`);
    assert.equal(decide(apply(seen), DM, moved), `invalid: ${CHARACTER_CHANGED}`);
    const { "actor.ac": _ac, ...withoutAc } = seen;
    assert.equal(decide(apply(withoutAc), P1, moved), "ok", "a part left out is not checked");
    assert.equal(CHARACTER_CHANGED, "This character changed since you looked. Check it again.");
  });

  test("every part's hash on a player's copy is the server's, so a DM's note or hidden effect never refuses a player's Apply", () => {
    const before = synced();
    const seenBefore = expectOf(asSeen(before, P1), EXPECT_PARTS);
    assert.deepEqual(seenBefore, expectOf(before.characters.bree!, EXPECT_PARTS));
    const after = dmSecretly(before);
    assert.notEqual(after.characters.bree!.actor.dmNotes, before.characters.bree!.actor.dmNotes);
    assert.equal(after.characters.bree!.actor.effects.length, 2);
    assert.deepEqual(expectOf(asSeen(after, P1), EXPECT_PARTS), seenBefore, "the player's copy hashes as before");
    assert.deepEqual(expectOf(after.characters.bree!, EXPECT_PARTS), seenBefore, "and so does the server's whole character");
    assert.equal(decide(sync({ ddbSync: RECORD, level: 6, stats: { saves: ["wis"] } }, seenBefore), P1, after), "ok");
  });

  test("an absent part hashes as null, HP as its current and maximum alone, and the shape as its SRD id and whether it is Wild Shape", () => {
    const state = synced();
    const bree = state.characters.bree!;
    const bare = character("bare", { name: "Bree" });
    assert.equal(expectHash(bare, "ddbSync"), expectHash(bare, "stats.saves"), "absent hashes alike in every part");
    assert.match(expectHash(bree, "ddbSync"), /^[0-9a-f]{12}$/);
    const temp = structuredClone(bree);
    temp.actor.hp.temp = 10;
    assert.equal(expectHash(temp, "actor.hp"), expectHash(bree, "actor.hp"), "temp HP is not in it");
    const hurt = structuredClone(bree);
    hurt.actor.hp.cur = 20;
    assert.notEqual(expectHash(hurt, "actor.hp"), expectHash(bree, "actor.hp"));
    const bear = structuredClone(bree);
    bear.actor.srdId = "brown-bear";
    assert.notEqual(expectHash(bear, "actor.shape"), expectHash(bree, "actor.shape"));
    const wild = structuredClone(bear);
    wild.actor.wildShape = true;
    assert.notEqual(expectHash(wild, "actor.shape"), expectHash(bear, "actor.shape"));
    assert.equal(expectHash(bear, "actor.ac"), expectHash(bree, "actor.ac"), "a shape alone leaves the AC's hash");
  });

  test("a block's parts and the record hash apart with no block and with a block that lacks them (RSBUILD-ASTRA-03)", () => {
    const bare = character("bare", { name: "Bree" });
    const unsynced = character("bree", { name: "Bree", stats: BLOCK });
    assert.equal(BLOCK.spellAbility, undefined);
    for (const part of ["stats.spellAbility", "stats.critOn", "ddbSync"] as const) assert.notEqual(expectHash(unsynced, part), expectHash(bare, part), part);
    assert.equal(expectHash(unsynced, "stats.spellAbility"), expectHash(unsynced, "stats.critOn"), "a block's absent parts hash alike");
    assert.equal(expectHash(unsynced, "level"), expectHash(bare, "level"), "the parts beside the block do not ask for one");
  });

  test("a sync write is refused when the record it replaces is at the schema's last millisecond, so no stored state fails to parse (RS-SOL-2)", () => {
    const at = (when: string) => {
      const state = synced();
      state.characters.bree!.ddbSync = { ...RECORD, at: when };
      return state;
    };
    const last = at("9999-12-31T23:59:59.999Z");
    assert.equal(decide(sync({ ddbSync: RECORD }), P1, last), `invalid: ${SYNC_STAMP_FULL}`);
    assert.equal(decide(sync({ ddbSync: RECORD }), DM, last), `invalid: ${SYNC_STAMP_FULL}`, "the DM's too");
    assert.equal(decide(sync({ ddbSync: { ...RECORD, at: AT } }), P1, last), "ok", "a record with its own at, as Undo sends, is stamped by no one");
    assert.equal(decide(sync({ ddbSync: null }), P1, last), "ok", "nor is a removal");
    assert.equal(decide(sync({ level: 6 }), P1, last), "ok");
    // One millisecond earlier, the write is taken and stores the last millisecond, which still parses.
    const nearly = at("9999-12-31T23:59:59.998Z");
    assert.equal(decide(sync({ ddbSync: RECORD }), P1, nearly), "ok");
    const r = applyOp(nearly, sync({ ddbSync: RECORD }), P1, env(2));
    assert.ok(r.ok);
    assert.equal(r.state.characters.bree!.ddbSync!.at, "9999-12-31T23:59:59.999Z");
    assert.equal(ddbSyncPatchSchema.safeParse(r.state.characters.bree!.ddbSync).success, true);
  });

  test("a block deleted by the DM between a player's review and Apply refuses the Apply, which would put a default block back (RSBUILD-ASTRA-03)", () => {
    const state = setup();
    state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"], level: 5, stats: BLOCK, actor: actor({ ac: 15 }) });
    const seen = asSeen(state, P1);
    // Two Applies: one writing an optional part the block lacks with the record, one writing the record beside the AC alone.
    const spell = sync({ stats: { spellAbility: "wis" }, ddbSync: RECORD }, expectOf(seen, ["stats.spellAbility", "ddbSync", "actor.shape"]));
    const record = sync({ actor: { ac: 16 }, ddbSync: RECORD }, expectOf(seen, ["actor.ac", "ddbSync", "actor.shape"]));
    assert.equal(decide(spell, P1, state), "ok");
    assert.equal(decide(record, P1, state), "ok");
    const deleted = applyOp(state, { t: "character.update", characterId: "bree", patch: { stats: null } }, DM, env(2));
    assert.ok(deleted.ok);
    assert.equal(deleted.state.characters.bree!.stats, undefined);
    assert.equal(decide(spell, P1, deleted.state), `invalid: ${CHARACTER_CHANGED}`);
    assert.equal(decide(record, P1, deleted.state), `invalid: ${CHARACTER_CHANGED}`);
    // Without the expect, the reducer would make a default block for the one part.
    const unchecked = applyOp(deleted.state, sync({ stats: { spellAbility: "wis" }, ddbSync: RECORD }), P1, env(3));
    assert.ok(unchecked.ok);
    assert.equal(unchecked.state.characters.bree!.stats?.spellAbility, "wis");
  });
});
