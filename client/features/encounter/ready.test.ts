import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { playerPlays, projectState } from "#shared/project.ts";
import type { Actor, RoomState } from "#shared/model.ts";
import { apply, character, DM, entry, P1, P2, room, token } from "#shared/testutil.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { fireOps, reactionTarget, readiedEffect, readyOp, rowTarget } from "./ready.ts";

const deps = { canUseAsset: () => true };

/** Thorn, a PC played by p1, and a goblin, in a fight that has reached Thorn's turn. */
function fight(): RoomState {
  let state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Thorn" });
  state.tokens.pc = token("pc", { kind: "pc", name: "Thorn", actor: { ref: "c1" }, x: 1, y: 1 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 3, y: 3 });
  state = apply(state, {
    t: "encounter.start",
    entries: [
      { id: "n1", tokenId: "pc", value: 15 },
      { id: "n2", tokenId: "gob", value: 10 },
    ],
  });
  return apply(state, { t: "encounter.next" }, DM, 2);
}

const thornActor = (state: RoomState): Actor => state.characters.c1!.actor;

describe("Hold and Ready markers", () => {
  test("a readied action holds until the start of the creature's next turn, and Previous puts it back", () => {
    let state = fight();
    const op = readyOp({ target: { tokenId: "pc" }, answer: { kind: "row", entryId: "n1" }, trigger: "  if the door opens  ", id: "r1" });
    assert.ok(canApply(op, P1, state, deps).ok, "the owner readies their own action");
    state = apply(state, op, P1, 3);
    assert.deepEqual(readiedEffect(thornActor(state).effects)?.label, "if the door opens");
    // The goblin's turn: the marker holds through it.
    state = apply(state, { t: "encounter.next" }, DM, 4);
    assert.ok(readiedEffect(thornActor(state).effects));
    // Thorn's next turn starts: the marker is gone, with a line in the log.
    const atGoblin = state;
    state = apply(state, { t: "encounter.next" }, DM, 5);
    assert.equal(readiedEffect(thornActor(state).effects), undefined);
    assert.ok(state.log.some((e) => e.data?.type === "effect" && e.data.key === "readied" && e.data.action === "expire"));
    state = apply(state, { t: "encounter.prev" }, DM, 6);
    assert.deepEqual(thornActor(state).effects, thornActor(atGoblin).effects);
  });

  test("when it fires the marker goes and the reaction is spent, and the owner may do both", () => {
    let state = apply(fight(), readyOp({ target: { tokenId: "pc" }, answer: { kind: "row", entryId: "n1" }, trigger: "", id: "r1" }), DM, 3);
    assert.equal(readiedEffect(thornActor(state).effects)?.label, undefined, "an empty trigger leaves no label");
    state = apply(state, { t: "encounter.next" }, DM, 4);
    const ops = fireOps({ target: { tokenId: "pc" }, effectId: "r1", answer: { kind: "row", entryId: "n1" } });
    for (const [i, op] of ops.entries()) {
      assert.ok(canApply(op, P1, state, deps).ok, `${op.t} by the owner`);
      assert.equal(canApply(op, P2, state, deps).ok, false, `${op.t} by another player`);
      state = apply(state, op, P1, 5 + i);
    }
    assert.equal(readiedEffect(thornActor(state).effects), undefined);
    assert.equal(state.encounter!.entries.find((e) => e.id === "n1")!.reactionUsed, true);
    // Its turn clears the spent reaction as before.
    state = apply(state, { t: "encounter.next" }, DM, 7);
    assert.equal(state.encounter!.entries.find((e) => e.id === "n1")!.reactionUsed, false);
  });

  test("everyone who sees a monster sees that it readied, only the DM its trigger unless the DM shows it, and nobody the marker the DM hides", () => {
    let state = apply(fight(), readyOp({ target: { tokenId: "gob" }, answer: { kind: "row", entryId: "n2" }, trigger: "when Thorn moves", id: "r2" }), DM, 3);
    const goblin = (s: RoomState, viewer: typeof P1) => {
      const seen = projectState(s, viewer, { sceneId: "s1" }).tokens.gob!;
      return readiedEffect("inline" in seen.actor ? seen.actor.inline.effects : []);
    };
    assert.deepEqual(goblin(state, P1), { id: "r2", key: "readied", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "n2" } } });
    assert.equal(goblin(state, DM)?.label, "when Thorn moves");
    const show = { t: "actor.effect.update", target: { tokenId: "gob" }, effectId: "r2", patch: { triggerShown: true } } as const;
    assert.equal(canApply(show, P1, state, deps).ok, false, "only the DM shows it");
    state = apply(state, show, DM, 4);
    assert.equal(goblin(state, P1)?.label, "when Thorn moves");
    state = apply(state, { t: "actor.effect.update", target: { tokenId: "gob" }, effectId: "r2", patch: { triggerShown: false, hiddenFromPlayers: true } }, DM, 5);
    assert.equal(goblin(state, P1), undefined);
  });

  test("a party member's trigger is the whole table's, as its player typed it", () => {
    const state = apply(fight(), readyOp({ target: { tokenId: "pc" }, answer: { kind: "row", entryId: "n1" }, trigger: "if the door opens", id: "r1" }), P1, 3);
    assert.equal(readiedEffect(projectState(state, P2, { sceneId: "s1" }).characters.c1!.actor.effects)?.label, "if the door opens");
    // A familiar a player owns, on its own token, the same.
    const pet = apply(state, { t: "token.create", token: { id: "owl", sceneId: "s1", kind: "npc", name: "Owl", size: "tiny", x: 2, y: 2, ownerIds: ["p1"], actor: { inline: thornActor(state) } } }, DM, 4);
    const owl = projectState(pet, P2, { sceneId: "s1" }).tokens.owl!;
    assert.equal(readiedEffect("inline" in owl.actor ? owl.actor.inline.effects : [])?.label, "if the door opens");
  });

  test("a creature only a DM owns keeps its trigger from players, a player made DM included", () => {
    let state = fight();
    state.tokens.gob = { ...state.tokens.gob!, ownerIds: ["dm1"] };
    state = apply(state, readyOp({ target: { tokenId: "gob" }, answer: { kind: "row", entryId: "n2" }, trigger: "when Thorn moves", id: "r2" }), DM, 3);
    const label = (s: RoomState) => {
      const seen = projectState(s, P1, { sceneId: "s1" }).tokens.gob!;
      return readiedEffect("inline" in seen.actor ? seen.actor.inline.effects : [])?.label;
    };
    assert.equal(label(state), undefined, "owned by the DM");
    // p2 played the goblin and was made a DM: the owner id stays, but it is no player's now.
    const promoted = { ...state, tokens: { ...state.tokens, gob: { ...state.tokens.gob!, ownerIds: ["p2"] } } };
    assert.equal(label(promoted), "when Thorn moves", "while p2 is a player");
    promoted.members = { ...promoted.members, p2: { ...promoted.members.p2!, kind: "dm" } };
    assert.equal(label(promoted), undefined);
    assert.equal(playerPlays(promoted, { token: promoted.tokens.gob! }), false, "so the DM's switch to show it appears");
  });

  test("a player who owns a token of an unowned character plays it, and gets its trigger as they may change it", () => {
    let state = fight();
    state.characters.c2 = character("c2", { ownerIds: [], name: "Hireling" });
    state.tokens.hire = token("hire", { kind: "npc", name: "Hireling", actor: { ref: "c2" }, ownerIds: ["p1"], x: 2, y: 2 });
    state = apply(state, { t: "encounter.add", entries: [{ id: "n3", tokenId: "hire", value: 5 }] }, DM, 3);
    const op = readyOp({ target: { tokenId: "hire" }, answer: { kind: "row", entryId: "n3" }, trigger: "if the guard looks away", id: "r3" });
    assert.ok(canApply(op, P1, state, deps).ok, "the token's owner may ready it");
    state = apply(state, op, P1, 4);
    for (const viewer of [P1, P2]) {
      assert.equal(readiedEffect(projectState(state, viewer, { sceneId: "s1" }).characters.c2!.actor.effects)?.label, "if the guard looks away");
    }
    assert.equal(playerPlays(state, { character: state.characters.c2! }), true);
  });

  test("a row names its creature by token, or by character for a row without one", () => {
    const view = { tokens: { pc: token("pc", { actor: { ref: "c1" } }) }, characters: { c1: character("c1") } };
    assert.deepEqual(rowTarget(view, entry("n1", { tokenId: "pc" })), { tokenId: "pc" });
    assert.deepEqual(rowTarget(view, entry("n2", { characterId: "c1" })), { characterId: "c1" });
    assert.equal(rowTarget(view, entry("n3", { tokenId: "elsewhere" })), null);
    assert.equal(rowTarget(view, entry("n4", { label: "Lair" })), null);
  });
});

describe("whose Reaction a creature spends (docs/design-v1-combat-flow.md 3.6.8)", () => {
  /** Thorn's fight with his Wildfire Spirit listed under him, his Spiritual Weapon not listed, and his owl taking its own turn. */
  function party(): RoomState {
    const state = fight();
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "c1", turn: "shared" } });
    state.tokens.sw = token("sw", { kind: "object", name: "Spiritual Weapon", ownerIds: ["p1"], companion: { of: "c1", turn: "none" } });
    state.tokens.owl = token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], companion: { of: "c1", turn: "own" } });
    return apply(state, { t: "encounter.add", entries: [{ id: "n3", tokenId: "owl", value: 5 }] }, DM, 3);
  }

  test("a creature with its own row spends that row's, a shared companion its own with its character's row, and none outside the fight or not listed", () => {
    const state = party();
    assert.deepEqual(reactionTarget(state, { tokenId: "pc" }), { kind: "row", entryId: "n1", tokenId: "pc" });
    assert.deepEqual(reactionTarget(state, { characterId: "c1" }), { kind: "row", entryId: "n1", tokenId: "pc" });
    assert.deepEqual(reactionTarget(state, { tokenId: "owl" }), { kind: "row", entryId: "n3", tokenId: "owl" });
    assert.deepEqual(reactionTarget(state, { tokenId: "ws" }), { kind: "companion", tokenId: "ws", entryId: "n1" });
    assert.equal(reactionTarget(state, { tokenId: "sw" }), null);
    assert.equal(reactionTarget({ ...state, encounter: null }, { tokenId: "ws" }), null);
  });

  test("the spirit's Ready counts Thorn's turn, and It fired spends the spirit's own Reaction, never Thorn's, built from its token alone", () => {
    let state = party();
    const answer = reactionTarget(state, { tokenId: "ws" })!;
    const ready = readyOp({ target: { tokenId: "ws" }, answer, trigger: "if a goblin comes near", id: "r9" });
    assert.ok(clientOpSchema.safeParse(ready).success);
    assert.ok(canApply(ready, P1, state, deps).ok);
    state = apply(state, ready, P1, 4);
    const fire = fireOps({ target: { tokenId: "ws" }, effectId: "r9", answer });
    assert.deepEqual(fire[1], { t: "token.update", tokenId: "ws", patch: { companionReaction: true } });
    for (const [i, op] of fire.entries()) {
      assert.ok(clientOpSchema.safeParse(op).success, op.t);
      assert.ok(canApply(op, P1, state, deps).ok, `${op.t} by the owner`);
      state = apply(state, op, P1, 5 + i);
    }
    assert.equal(state.tokens.ws!.companion?.reactionUsed, true);
    assert.equal(state.encounter!.entries.find((e) => e.id === "n1")!.reactionUsed, false, "Thorn's Reaction is untouched");
    const spirit = state.tokens.ws!.actor;
    assert.ok("inline" in spirit);
    assert.equal(readiedEffect(spirit.inline.effects), undefined);
  });
});

