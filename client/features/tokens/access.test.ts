import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import type { ActorPatch, TokenPatch } from "#shared/protocol.ts";
import type { RoomState } from "#shared/model.ts";
import { DM, P1, P2, character, companionBlock, room, token } from "#shared/testutil.ts";
import { characterAccess, editsPcStats, ownsToken, tokenAccess } from "./access.ts";
import { resizePatch } from "./resize.ts";

const deps = { canUseAsset: () => true };

function fixture(): RoomState {
  const state = room();
  state.characters.hero = character("hero", { ownerIds: ["p1"] });
  state.tokens.pc = token("pc", { kind: "pc", name: "Hero", actor: { ref: "hero" }, ownerIds: [] });
  state.tokens.familiar = token("familiar", { kind: "npc", name: "Owl", ownerIds: ["p1"] });
  state.tokens.goblin = token("goblin");
  // Hero's companion, played by whoever plays Hero (docs/design-v1-combat-flow.md 3.6.4).
  state.tokens.spirit = token("spirit", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "hero", turn: "shared" } });
  // A stat block Hero keeps, which Hero's player may link to the spirit (docs/design-v1-companion-stat-blocks.md 4.1).
  state.companionBlocks.b1 = companionBlock("b1", "hero");
  return state;
}

/** One valid sample value per patchable field, so canApply gets a well-formed op. */
const TOKEN_SAMPLES: { [K in keyof TokenPatch]-?: TokenPatch[K] } = {
  sceneId: "s1",
  kind: "npc",
  name: "Renamed",
  publicName: "Someone",
  nameHidden: true,
  image: { assetId: "a1", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
  size: "large",
  w: 2,
  h: 2,
  x: 4,
  y: 4,
  elevation: 10,
  height: 10,
  rotation: 90,
  disposition: "ally",
  visibility: "dm",
  fogExempt: true,
  locked: true,
  layer: "object",
  ownerIds: ["p1"],
  hpVisibility: "exact",
  number: 3,
  notes: "Wears a red cloak",
  altImages: [{ assetId: "a2", crop: { cx: 0, cy: 0, zoom: 1 } }],
  rangeRings: [30, 60],
  light: { bright: 20, dim: 20 },
  partyVision: true,
  companion: { of: "hero", turn: "shared" },
  companionReaction: true,
  actor: { ac: 15 },
};

const ACTOR_SAMPLES: { [K in keyof ActorPatch]-?: ActorPatch[K] } = {
  hp: { max: 30 },
  ac: 15,
  speeds: { walk: 25 },
  initBonus: 3,
  initScore: 13,
  passivePerception: 14,
  senses: "Darkvision 60 ft.",
  creatureType: "Humanoid",
  cr: "1",
  xp: 200,
  srdId: "goblin-warrior",
  monsterId: "m1",
  blockId: "b1",
  wildShape: true,
  sheetUrl: "https://example.com/sheet",
  legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 },
  notes: "note",
  dmNotes: "secret",
};

describe("ownership", () => {
  test("counts directly and through the token's character", () => {
    const state = fixture();
    assert.equal(ownsToken(state, "p1", state.tokens.pc!), true);
    assert.equal(ownsToken(state, "p1", state.tokens.familiar!), true);
    assert.equal(ownsToken(state, "p1", state.tokens.goblin!), false);
    assert.equal(ownsToken(state, "p2", state.tokens.pc!), false);
    assert.equal(ownsToken(state, null, state.tokens.pc!), false);
  });

  test("a player's projection of someone else's token has no owner list, and that means not theirs", () => {
    const state = fixture();
    const p2View = projectState(state, P2, { sceneId: null }) as unknown as RoomState;
    const pc = p2View.tokens.pc!;
    assert.equal(ownsToken(p2View, "p2", pc), false);
    const p1View = projectState(state, P1, { sceneId: null }) as unknown as RoomState;
    assert.equal(ownsToken(p1View, "p1", p1View.tokens.pc!), true);
  });
});

describe("token access mirrors the server's permissions", () => {
  for (const tokenId of ["pc", "familiar", "goblin", "spirit"]) {
    test(`token.update fields on ${tokenId}`, () => {
      const state = fixture();
      for (const viewer of [DM, P1, P2]) {
        const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: state, token: state.tokens[tokenId]! });
        for (const field of Object.keys(TOKEN_SAMPLES) as (keyof TokenPatch)[]) {
          // A size is no field an owner edits but a resize, judged by its own rule (shared/rules/resize.ts).
          if (field === "actor" || field === "size") continue;
          const patch = { [field]: TOKEN_SAMPLES[field] } as TokenPatch;
          const allowed = canApply({ t: "token.update", tokenId, patch }, viewer, state, deps).ok;
          assert.equal(access.canEditToken(field), allowed, `${viewer.memberId} ${field} on ${tokenId}`);
        }
      }
    });
  }

  test("resize mirrors the server's resize rule: the DM, or an owner of an unlocked token of the six sizes (docs/design-v1-token-window.md 8.6)", () => {
    for (const variant of [{}, { locked: true }, { size: "custom" as const, w: 2, h: 3 }]) {
      const state = fixture();
      for (const id of ["pc", "familiar", "goblin", "spirit"]) state.tokens[id] = { ...state.tokens[id]!, ...variant };
      for (const viewer of [DM, P1, P2]) {
        for (const tokenId of ["pc", "familiar", "goblin", "spirit"]) {
          const t = state.tokens[tokenId]!;
          const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: state, token: t });
          const answer = resizePatch(state, t, { size: "large" }, viewer.role);
          const allowed = !("refused" in answer) && canApply({ t: "token.update", tokenId, patch: answer.patch }, viewer, state, deps).ok;
          assert.equal(access.resize, allowed, `${viewer.memberId} resizes ${tokenId} ${JSON.stringify(variant)}`);
        }
      }
    }
  });

  test("a companion's owner dismisses it, and the DM deletes instead", () => {
    const state = fixture();
    for (const viewer of [DM, P1, P2]) {
      const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: state, token: state.tokens.spirit! });
      const allowed = canApply({ t: "token.delete", tokenId: "spirit" }, viewer, state, deps).ok;
      assert.equal(access.dismiss || access.dm, allowed, viewer.memberId);
      assert.equal(access.companion, viewer.memberId !== "p2", `${viewer.memberId} changes what it is`);
    }
    assert.equal(tokenAccess({ role: "player", memberId: "p1", view: state, token: state.tokens.familiar! }).dismiss, false, "an owned token that is no companion");
  });

  test("actor fields go through the character for a PC, and owners never patch an inline actor but a companion's", () => {
    const state = fixture();
    for (const viewer of [DM, P1, P2]) {
      for (const tokenId of ["pc", "familiar", "goblin", "spirit"]) {
        const t = state.tokens[tokenId]!;
        const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: state, token: t });
        for (const field of Object.keys(ACTOR_SAMPLES) as (keyof ActorPatch)[]) {
          const actor = { [field]: ACTOR_SAMPLES[field] } as ActorPatch;
          const op =
            access.actorVia === "character" && viewer.role !== "dm"
              ? ({ t: "character.update", characterId: "hero", patch: { actor } } as const)
              : ({ t: "token.update", tokenId, patch: { actor } } as const);
          const allowed = canApply(op, viewer, state, deps).ok;
          assert.equal(access.canEditActor(field), allowed, `${viewer.memberId} ${field} on ${tokenId}`);
        }
      }
    }
  });

  test("a player who owns only a token of a character, as one lent to them, edits none of its card, as the server refuses (LP7-PC-6)", () => {
    const state = fixture();
    state.tokens.lent = token("lent", { kind: "pc", name: "Hero", actor: { ref: "hero" }, ownerIds: ["p2"] });
    const access = tokenAccess({ role: P2.role, memberId: P2.memberId, view: state, token: state.tokens.lent });
    assert.equal(access.owner, true, "the token stays theirs");
    for (const field of Object.keys(ACTOR_SAMPLES) as (keyof ActorPatch)[]) {
      const allowed = canApply({ t: "character.update", characterId: "hero", patch: { actor: { [field]: ACTOR_SAMPLES[field] } as ActorPatch } }, P2, state, deps).ok;
      assert.equal(allowed, false, `the server refuses ${field}`);
      assert.equal(access.canEditActor(field), false, field);
    }
  });

  test("HP: owners and the DM do everything, others only damage and heal when the room allows it", () => {
    const state = fixture();
    const goblin = state.tokens.goblin!;
    assert.equal(tokenAccess({ role: "dm", memberId: "dm1", view: state, token: goblin }).hp, "all");
    assert.equal(tokenAccess({ role: "player", memberId: "p1", view: state, token: goblin }).hp, "none");
    state.meta.settings.playersApplyDamage = true;
    const relative = tokenAccess({ role: "player", memberId: "p1", view: state, token: goblin });
    assert.equal(relative.hp, "relative");
    const damage = canApply({ t: "actor.hp", target: { tokenId: "goblin" }, change: { kind: "damage", amount: 3 } }, P1, state, deps);
    const set = canApply({ t: "actor.hp", target: { tokenId: "goblin" }, change: { kind: "set", cur: 3 } }, P1, state, deps);
    assert.equal(damage.ok, true);
    assert.equal(set.ok, false);
    const owner = tokenAccess({ role: "player", memberId: "p1", view: state, token: state.tokens.pc! });
    assert.deepEqual([owner.hp, owner.effects, owner.deathSaves, owner.life], ["all", true, true, false]);
  });
});

describe("character access", () => {
  test("owners edit the whitelisted fields, others nothing", () => {
    const state = fixture();
    const hero = state.characters.hero!;
    for (const viewer of [DM, P1, P2]) {
      const access = characterAccess({ role: viewer.role, memberId: viewer.memberId, character: hero });
      for (const field of ["name", "size", "ownerIds", "defaultImage", "level"] as const) {
        const sample = { name: "New", size: "small", ownerIds: ["p2"], defaultImage: TOKEN_SAMPLES.image, level: 5 }[field];
        const allowed = canApply({ t: "character.update", characterId: "hero", patch: { [field]: sample } }, viewer, state, deps).ok;
        assert.equal(access.canEdit(field), allowed, `${viewer.memberId} ${field}`);
      }
      for (const field of Object.keys(ACTOR_SAMPLES) as (keyof ActorPatch)[]) {
        const actor = { [field]: ACTOR_SAMPLES[field] } as ActorPatch;
        const allowed = canApply({ t: "character.update", characterId: "hero", patch: { actor } }, viewer, state, deps).ok;
        assert.equal(access.canEditActor(field), allowed, `${viewer.memberId} actor.${field}`);
      }
    }
  });
});

describe("who may add, edit or shape a character's stat block", () => {
  test("the DM and the character's own players, never a player who owns only a token of it, such as a lent NPC, whom the editor and the server would refuse (ASTRA-18)", () => {
    const sage = character("sage", { ownerIds: [] });
    const bree = character("bree", { ownerIds: [P1.memberId] });
    const state: RoomState = room({ characters: { sage, bree }, tokens: { sageTok: token("sageTok", { kind: "npc", ownerIds: [P1.memberId], actor: { ref: "sage" } }) } });
    assert.equal(editsPcStats(DM, sage), true);
    assert.equal(editsPcStats(P1, bree), true);
    assert.equal(editsPcStats(P1, sage), false, "P1 rolls for Sage's token, but may not change Sage");
    assert.equal(ownsToken(state, P1.memberId, state.tokens.sageTok!), true, "the token stays theirs to roll for");
    assert.equal(editsPcStats(P2, bree), false);
    assert.equal(editsPcStats(null, bree), false);
    // The server agrees: a character.update from the lent token's owner is refused.
    assert.equal(canApply({ t: "character.update", characterId: "sage", patch: { notes: "x" } } as never, P1, state, deps).ok, false);
  });
});
