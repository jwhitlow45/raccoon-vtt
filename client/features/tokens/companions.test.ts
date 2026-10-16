import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { character, room, token } from "#shared/testutil.ts";
import {
  NEW_COMPANION,
  companionInput,
  companionSpot,
  draftError,
  linkPatch,
  makeCompanionPatch,
  playerPlacement,
  turnChoices,
  type CompanionDraft,
} from "./companions.ts";

/** Bree, whom Ana (p1) and Cy (p2) play, standing 10 ft up at 5,5 on the players' scene. */
function bree(): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, x: 5, y: 5, elevation: 10 });
  return state;
}

const spirit: CompanionDraft = { ...NEW_COMPANION, name: " Wildfire Spirit ", hp: 15, ac: 13 };
const weapon: CompanionDraft = { ...NEW_COMPANION, name: "Spiritual Weapon", what: "effect", turn: "none" };
const at = { id: "ws", sceneId: "s1", x: 6, y: 5, elevation: 10 };

describe("the companion form (docs/design-v1-combat-flow.md 3.6.3)", () => {
  test("a creature is an NPC with full HP, an effect an object with 0 of 0 HP and AC 0, both allies on the creatures layer, owned as the character, at its elevation", () => {
    const creature = companionInput(spirit, at, bree().characters.bree!);
    assert.equal(creature.kind, "npc");
    assert.equal(creature.name, "Wildfire Spirit");
    assert.ok("inline" in creature.actor);
    assert.deepEqual(creature.actor.inline.hp, { cur: 15, max: 15, temp: 0 });
    assert.equal(creature.actor.inline.ac, 13);
    assert.equal(creature.actor.inline.dmNotes, "");
    assert.deepEqual([creature.disposition, creature.layer, creature.ownerIds, creature.elevation], ["ally", "token", ["p1", "p2"], 10]);
    assert.deepEqual(creature.companion, { of: "bree", turn: "shared" });
    const effect = companionInput(weapon, { ...at, id: "sw" }, bree().characters.bree!);
    assert.equal(effect.kind, "object");
    assert.ok("inline" in effect.actor);
    assert.deepEqual([effect.actor.inline.hp, effect.actor.inline.ac], [{ cur: 0, max: 0, temp: 0 }, 0]);
    assert.deepEqual(effect.companion, { of: "bree", turn: "none" });
    for (const input of [creature, effect]) assert.ok(clientOpSchema.safeParse({ t: "token.create", token: input }).success);
    const bare = companionInput({ ...spirit, ac: null }, at, bree().characters.bree!).actor;
    assert.ok("inline" in bare);
    assert.equal(bare.inline.ac, 0, "an empty AC is stored as 0");
  });

  test("its errors: no name, a creature under 1 HP, an effect with its own turn", () => {
    assert.equal(draftError({ ...spirit, name: "  " }), "Give it a name.");
    assert.equal(draftError({ ...spirit, hp: null }), "A creature needs at least 1 HP.");
    assert.equal(draftError({ ...spirit, hp: 0 }), "A creature needs at least 1 HP.");
    assert.equal(draftError({ ...weapon, turn: "own" }), "An effect takes no turn of its own.");
    assert.equal(draftError(spirit), null);
    assert.equal(draftError(weapon), null, "an effect needs no HP");
  });

  test("the turn's choices name the character, and an effect is offered only Bree's turns", () => {
    assert.deepEqual(turnChoices("Bree", "creature").map((c) => c.label), ["On Bree's turn, listed under Bree", "On Bree's turn, not listed", "Its own turn"]);
    assert.deepEqual(turnChoices("Bree", "effect").map((c) => c.value), ["shared", "none"]);
  });
});

describe("where a player's companion goes", () => {
  test("the first free spot within 5 ft of the character, which the server takes", () => {
    const state = bree();
    const spot = companionSpot(state, state.tokens.bt!, { size: "small" });
    assert.deepEqual(spot, { x: 6, y: 5 });
    const placed = playerPlacement(state, state.characters.bree!, { size: "small" });
    assert.ok(placed.ok);
    const op = { t: "token.create" as const, token: companionInput(spirit, { id: "ws", sceneId: placed.sceneId, x: placed.x, y: placed.y, elevation: placed.elevation }, state.characters.bree!) };
    assert.ok(canApply(op, { memberId: "p1", role: "player" }, state, { canUseAsset: () => true }).ok);
  });

  test("taken spots are passed over, and none when every spot is taken or walled off", () => {
    const state = bree();
    state.tokens.east = token("east", { x: 6, y: 5 });
    assert.deepEqual(companionSpot(state, state.tokens.bt!, { size: "small" }), { x: 6, y: 6 });
    for (const [x, y] of [[4, 4], [5, 4], [6, 4], [4, 5], [6, 6], [4, 6], [5, 6]]) state.tokens[`t${x}${y}`] = token(`t${x}${y}`, { x: x!, y: y! });
    assert.equal(companionSpot(state, state.tokens.bt!, { size: "small" }), null);
    assert.deepEqual(playerPlacement(state, state.characters.bree!, { size: "small" }), { ok: false, reason: "No room next to Bree." });
    const walled = bree();
    walled.scenes.s1 = { ...walled.scenes.s1!, blockMovement: true };
    // A box of walls around Bree's cell.
    walled.buildChunks[chunkKey("s1", 0, 0)] = {
      sceneId: "s1",
      cx: 0,
      cy: 0,
      rev: 0,
      cells: {},
      edges: {},
      walls: [
        { id: "wallnorthaaa", a: [5, 5], b: [6, 5], f: { kind: "wall" } },
        { id: "walleastaaaa", a: [6, 5], b: [6, 6], f: { kind: "wall" } },
        { id: "wallsouthaaa", a: [5, 6], b: [6, 6], f: { kind: "wall" } },
        { id: "wallwestaaaa", a: [5, 5], b: [5, 6], f: { kind: "wall" } },
      ],
    };
    assert.equal(companionSpot(walled, walled.tokens.bt!, { size: "small" }), null);
    walled.scenes.s1 = { ...walled.scenes.s1!, blockMovement: false };
    assert.notEqual(companionSpot(walled, walled.tokens.bt!, { size: "small" }), null, "walls stop nothing on a scene that does not block moves");
  });

  test("with no token of the character on the players' scene, or no map, the button says why", () => {
    const away = bree();
    away.tokens.bt = { ...away.tokens.bt!, sceneId: "s2" };
    assert.deepEqual(playerPlacement(away, away.characters.bree!, { size: "small" }), { ok: false, reason: "Bree has no token on the map." });
    const dark = bree();
    dark.meta.view = { ...dark.meta.view, blackout: true };
    assert.deepEqual(playerPlacement(dark, dark.characters.bree!, { size: "small" }), { ok: false, reason: "No map to place it on yet." });
    dark.meta = { ...dark.meta, playerSceneId: null, view: { ...dark.meta.view, blackout: false } };
    assert.deepEqual(playerPlacement(dark, dark.characters.bree!, { size: "small" }), { ok: false, reason: "No map to place it on yet." });
  });
});

describe("the links the panel sends", () => {
  test("a turn edit of a spent companion and Make a companion send { of, turn } alone, which the schema takes", () => {
    const patch = linkPatch({ of: "bree", turn: "shared" }, { turn: "none" });
    assert.deepEqual(patch, { companion: { of: "bree", turn: "none" } });
    assert.ok(clientOpSchema.safeParse({ t: "token.update", tokenId: "ws", patch }).success);
    assert.deepEqual(makeCompanionPatch({ disposition: "hostile" }, "bree", "shared"), { companion: { of: "bree", turn: "shared" }, disposition: "ally" });
    assert.deepEqual(makeCompanionPatch({ disposition: "neutral" }, "bree", "own"), { companion: { of: "bree", turn: "own" } });
  });
});
