import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState, UseMark } from "../model.ts";
import { canApply } from "../permissions.ts";
import { clientOpSchema } from "../protocol.ts";
import { DM, P1, actor, apply, character, companionBlock, room, token } from "../testutil.ts";

/** In lair's counts and a stat block's link (docs/design-v1-combat-controls.md 2.4). */

const breath: UseMark = { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 };

function table(): RoomState {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ srdId: "adult-red-dragon", xp: 18_000, legendary: { actionsMax: 3, actionsUsed: 3, resistMax: 3, resistUsed: 2 }, uses: { "actions:fire-breath": breath } }) } }),
      lent: token("lent", { name: "Owlbear", ownerIds: ["p1"] }),
      druid: token("druid", { kind: "pc", name: "Bree", actor: { ref: "bree" } }),
    },
    characters: { bree: character("bree", { name: "Bree", actor: actor({ srdId: "brown-bear", wildShape: true, uses: { "actions:maul": { kind: "day", name: "Maul", used: 1, max: 1 } } }) }) },
  });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [{ id: "ed", tokenId: "dragon", value: 20, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }, { id: "el", tokenId: "lent", value: 10, tieOrder: 1, hidden: false, reactionUsed: false, inLair: false }] };
  return state;
}

const dragon = (s: RoomState): Actor => (s.tokens.dragon!.actor as { inline: Actor }).inline;

describe("In lair's counts (docs/design-v1-combat-controls.md 2.4)", () => {
  test("the row's creature takes the counts and XP the op carries, what it spent cut to them", () => {
    const lair = apply(table(), { t: "encounter.update", entryId: "ed", patch: { inLair: true }, counts: { actionsMax: 4, resistMax: 4, xp: 20_000 } });
    assert.equal(lair.encounter!.entries[0]!.inLair, true);
    assert.deepEqual(dragon(lair).legendary, { actionsMax: 4, actionsUsed: 3, resistMax: 4, resistUsed: 2 });
    assert.equal(dragon(lair).xp, 20_000);
    const out = apply(lair, { t: "encounter.update", entryId: "ed", patch: { inLair: false }, counts: { actionsMax: 2, resistMax: 1 } }, DM, 2);
    assert.deepEqual(dragon(out).legendary, { actionsMax: 2, actionsUsed: 2, resistMax: 1, resistUsed: 1 });
    assert.equal(dragon(out).xp, 20_000, "no XP in the op leaves it");
    const plain = apply(table(), { t: "encounter.update", entryId: "ed", patch: { inLair: true } });
    assert.deepEqual(dragon(plain).legendary, dragon(table()).legendary, "no block, no counts");
  });

  test("only the DM sends them, with the switch", () => {
    const op = { t: "encounter.update", entryId: "el", patch: { inLair: true }, counts: { actionsMax: 3, resistMax: 3 } } as const;
    assert.ok(clientOpSchema.safeParse(op).success, "the DM sends them with the switch");
    assert.equal(clientOpSchema.safeParse({ ...op, patch: { hidden: true } }).success, false, "never without it");
    assert.equal(canApply(op, P1, table(), { canUseAsset: () => true }).ok, false, "even for a creature the player owns");
  });
});

describe("a stat block's link (docs/design-v1-combat-controls.md 2.4)", () => {
  test("a new block takes the marks, and an edit that keeps it leaves them", () => {
    const relinked = apply(table(), { t: "token.update", tokenId: "dragon", patch: { actor: { srdId: "ancient-red-dragon" } } });
    assert.equal(dragon(relinked).uses, undefined);
    const kept = apply(table(), { t: "token.update", tokenId: "dragon", patch: { actor: { ac: 20 } } });
    assert.deepEqual(dragon(kept).uses, { "actions:fire-breath": breath });
    const detached = apply(table(), { t: "token.update", tokenId: "dragon", patch: { actor: { srdId: null } } });
    assert.equal(dragon(detached).uses, undefined);
    const unlinked = table();
    unlinked.tokens.lent = token("lent", { name: "Owlbear", ownerIds: ["p1"], actor: { inline: actor({ uses: { "actions:fire-breath": breath } }) } });
    const first = apply(unlinked, { t: "token.update", tokenId: "lent", patch: { actor: { srdId: "owlbear" } } });
    assert.equal((first.tokens.lent!.actor as { inline: Actor }).inline.uses, undefined, "a first link takes marks kept under none");
  });

  test("a shape's end takes the shape's marks, and the character's resources stay", () => {
    const state = table();
    state.characters.bree = { ...state.characters.bree!, resources: [{ id: "ws", name: "Wild Shape", max: 2, used: 1, reset: "shortOne" }] };
    const ended = apply(state, { t: "character.update", characterId: "bree", patch: { actor: { srdId: null } } });
    assert.equal(ended.characters.bree!.actor.uses, undefined);
    assert.equal(ended.characters.bree!.resources![0]!.used, 1);
  });

  test("a companion detached or given to another character lets its block go and takes the marks keyed by it, and an SRD link keeps them", () => {
    const moth: UseMark = { kind: "day", name: "Gust", used: 1, max: 1 };
    const state = room({
      characters: { c1: character("c1", { name: "Bree", ownerIds: ["p1"] }), c2: character("c2", { name: "Ash", ownerIds: ["p2"] }) },
      tokens: {
        spirit: token("spirit", { kind: "npc", name: "Moth Spirit", ownerIds: ["p1"], companion: { of: "c1", turn: "shared" }, actor: { inline: actor({ blockId: "cb0", uses: { "actions:gust": moth } }) } }),
        owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], companion: { of: "c1", turn: "shared" }, actor: { inline: actor({ srdId: "owl", uses: { "actions:talons": moth } }) } }),
      },
    });
    state.companionBlocks.cb0 = companionBlock("cb0", "c1");
    const inline = (s: RoomState, id: string): Actor => (s.tokens[id]!.actor as { inline: Actor }).inline;
    const detached = apply(state, { t: "token.update", tokenId: "spirit", patch: { companion: null } });
    assert.equal(inline(detached, "spirit").blockId, undefined);
    assert.equal(inline(detached, "spirit").uses, undefined);
    const given = apply(state, { t: "token.update", tokenId: "spirit", patch: { companion: { of: "c2", turn: "shared" } } });
    assert.equal(inline(given, "spirit").blockId, undefined);
    assert.equal(inline(given, "spirit").uses, undefined);
    const owl = apply(state, { t: "token.update", tokenId: "owl", patch: { companion: { of: "c2", turn: "shared" } } });
    assert.deepEqual(inline(owl, "owl").uses, { "actions:talons": moth });
  });
});
