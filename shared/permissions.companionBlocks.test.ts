import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { canApply, type PermissionDeps } from "./permissions.ts";
import type { ActorPatch, CompanionBlockInput, Op, TokenInput } from "./protocol.ts";
import { DM, P1, P2, actor, character, companionBlock, imageRef, room, token } from "./testutil.ts";

/**
 * The permissions of companion stat blocks
 * (docs/design-v1-companion-stat-blocks.md 4.1): a character's players and
 * the DM keep its blocks, with no room setting, and a player never learns
 * that a block outside their view exists.
 */

/** Only the images named "mine" are the player's to use. The DM may use every image of the room. */
const deps: PermissionDeps = { canUseAsset: (memberId, assetId) => memberId === "dm1" || assetId.startsWith("mine") };

/** Bree, played by p1 and p2 together, Cy by p2 alone, and one block each. */
function setup(): RoomState {
  return room({
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }),
      cy: character("cy", { name: "Cy", ownerIds: ["p2"] }),
    },
    companionBlocks: { moth: companionBlock("moth", "bree"), wolf: companionBlock("wolf", "cy", { name: "Wolf" }) },
  });
}

function input(id: string, characterId: string, overrides: Partial<CompanionBlockInput> = {}): CompanionBlockInput {
  const { rev: _rev, ...block } = companionBlock(id, characterId);
  return { ...block, ...overrides };
}

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const create = (block: CompanionBlockInput): Op => ({ t: "companionBlock.create", block });

describe("a character's companion stat blocks", () => {
  test("its players create, edit and delete them with no room setting, a co-owner too", () => {
    const state = setup();
    assert.equal(state.meta.settings.playersCreateCharacters, false);
    for (const who of [P1, P2]) {
      assert.equal(decide(create(input("new", "bree")), who, state), "ok");
      assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { ac: 13 } }, who, state), "ok");
      assert.equal(decide({ t: "companionBlock.delete", blockId: "moth" }, who, state), "ok");
    }
  });

  test("another's character answers that it is not theirs on create, and its blocks are not there", () => {
    assert.equal(decide(create(input("new", "cy"))), "forbidden: that is not yours");
    assert.equal(decide({ t: "companionBlock.update", blockId: "wolf", patch: { ac: 13 } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.delete", blockId: "wolf" }), "gone: that is not here");
  });

  test("a block or a character that is not there answers alike, and a new id in use never says so", () => {
    assert.equal(decide(create(input("new", "nobody"))), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "missing", patch: { ac: 13 } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.delete", blockId: "missing" }), "gone: that is not here");
    // Cy's wolf is out of p1's view: its id answers as the id of nothing.
    assert.equal(decide(create(input("wolf", "bree"))), "gone: that is not here");
  });

  test("a picture must be one the player may use, on create and on edit", () => {
    assert.equal(decide(create(input("new", "bree", { defaultImage: imageRef("mine-moth") }))), "ok");
    assert.equal(decide(create(input("new", "bree", { defaultImage: imageRef("theirs") }))), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { defaultImage: imageRef("theirs") } }), "gone: that is not here");
    assert.equal(decide({ t: "companionBlock.update", blockId: "moth", patch: { defaultImage: null } }), "ok");
    // A shipped icon names no asset.
    assert.equal(decide(create(input("new", "bree", { defaultImage: { icon: "lorc/wolf-head", color: "#336699" } }))), "ok");
  });

  test("the DM may do all of it, on any character, with an image of the room", () => {
    const state = setup();
    for (const op of [
      create(input("new", "cy", { defaultImage: imageRef("theirs") })),
      { t: "companionBlock.update", blockId: "wolf", patch: { name: "Dire Wolf" } } as Op,
      { t: "companionBlock.delete", blockId: "moth" } as Op,
    ]) {
      assert.equal(decide(op, DM, state), "ok", op.t);
    }
    const noRoom: PermissionDeps = { canUseAsset: () => false };
    const d = canApply(create(input("new", "cy", { defaultImage: imageRef("elsewhere") })), DM, state, noRoom);
    assert.deepEqual(d, { ok: false, code: "gone", message: "that is not here" });
  });
});

describe("a companion's stat block link", () => {
  /** Bree (p1 and p2 together) with her token and her spirit, Cy (p2) with a block of her own, and a token of Bree's p3 owns but not Bree. */
  function linked(): RoomState {
    const state = setup();
    state.members.p3 = { ...state.members.p2!, id: "p3", name: "p3" };
    state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 5, y: 5 });
    state.tokens.ws = token("ws", { kind: "npc", name: "Spirit", x: 6, y: 5, ownerIds: ["p1", "p2"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor() } });
    state.tokens.extra = token("extra", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p3"], x: 1, y: 1 });
    return state;
  }
  const link = (actorPatch: ActorPatch): Op => ({ t: "token.update", tokenId: "ws", patch: { actor: actorPatch } });
  const spirit = (inline: Partial<ReturnType<typeof actor>> = {}): Op => {
    const input: TokenInput = {
      id: "new",
      sceneId: "s1",
      kind: "npc",
      name: "Owl",
      size: "tiny",
      x: 4,
      y: 5,
      layer: "token",
      actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 }, dmNotes: "", ...inline }) },
      companion: { of: "bree", turn: "shared" },
    };
    return { t: "token.create", token: input };
  };

  test("its owners link an SRD block or one of the character's, change it and detach it", () => {
    const state = linked();
    for (const patch of [{ srdId: "owl" }, { blockId: "moth" }, { blockId: null }, { srdId: null }, { blockId: "moth", ac: 12, speeds: { walk: 5, fly: 60 } }] as ActorPatch[]) {
      assert.equal(decide(link(patch), P1, state), "ok", JSON.stringify(patch));
    }
  });

  test("they may not set the DM's fields: a room monster, legendary uses, the initiative score, type, CR, XP or the DM's notes", () => {
    const state = linked();
    for (const [field, value] of [
      ["monsterId", "m1"],
      ["legendary", { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 }],
      ["initScore", 12],
      ["creatureType", "Beast"],
      ["cr", "1"],
      ["xp", 25],
      ["dmNotes", "secret"],
    ] as const) {
      assert.equal(decide(link({ [field]: value } as ActorPatch), P1, state), `forbidden: owners cannot change ${field}`);
    }
  });

  test("a block of another character answers as one that is not there, on an update and on a new companion", () => {
    const state = linked();
    assert.equal(decide(link({ blockId: "wolf" }), P1, state), "gone: that is not here");
    assert.equal(decide(link({ blockId: "nothing" }), P1, state), "gone: that is not here");
    assert.equal(decide(spirit({ blockId: "wolf" }), P1, state), "gone: that is not here");
    assert.equal(decide(spirit({ blockId: "nothing" }), P1, state), "gone: that is not here");
    // Cy's player owns Cy, so the reducer's own rule answers them instead (another character's block).
    assert.equal(decide(link({ blockId: "wolf" }), P2, state), "ok");
  });

  test("a new companion may carry a link, and never the DM's fields", () => {
    const state = linked();
    assert.equal(decide(spirit({ srdId: "owl" }), P1, state), "ok");
    assert.equal(decide(spirit({ blockId: "moth" }), P1, state), "ok");
    for (const field of [{ initScore: 12 }, { creatureType: "Beast" }, { cr: "0" }, { xp: 10 }]) {
      assert.match(decide(spirit(field), P1, state), /^forbidden: a new companion leaves/, JSON.stringify(field));
    }
    assert.match(decide(spirit({ monsterId: "m1" }), P1, state), /^forbidden: a new companion starts/);
  });

  test("a player who owns a token of the character but not the character may not link its companion's block", () => {
    const state = linked();
    const p3 = { memberId: "p3", role: "player" as const };
    assert.equal(decide(link({ blockId: "moth" }), p3, state), "forbidden: that is not yours");
    assert.equal(decide(link({ srdId: "owl" }), p3, state), "forbidden: that is not yours");
  });

  test("the DM may set every link and field", () => {
    const state = linked();
    for (const patch of [{ monsterId: "m1" }, { blockId: "wolf" }, { srdId: "owl", initScore: 12, creatureType: "Beast", cr: "1", xp: 25 }] as ActorPatch[]) {
      assert.equal(decide(link(patch), DM, state), "ok", JSON.stringify(patch));
    }
  });
});
