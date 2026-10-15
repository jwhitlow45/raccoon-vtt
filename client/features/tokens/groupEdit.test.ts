import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, env, P1, room, token } from "#shared/testutil.ts";
import {
  conditionLit,
  conditionOps,
  deleteButtonWords,
  deleteManyOps,
  elevationOps,
  fightCandidates,
  fightOps,
  flagLit,
  flagPatch,
  groupCreatures,
  groupOffers,
  ownerOps,
  ownersLit,
  sharedElevation,
  sharedImage,
  updateManyOps,
} from "./groupEdit.ts";

const deps = { canUseAsset: () => true };

function setup(): RoomState {
  return room({
    characters: { c1: character("c1", { name: "Ayla", actor: actor({ effects: [{ id: "e1", key: "frightened" }] }) }) },
    tokens: {
      pc: token("pc", { kind: "pc", name: "Ayla", actor: { ref: "c1" } }),
      pc2: token("pc2", { kind: "pc", name: "Ayla", actor: { ref: "c1" } }),
      wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], actor: { inline: actor() } }),
      g1: token("g1", { name: "Goblin", actor: { inline: actor({ effects: [{ id: "e2", key: "frightened" }, { id: "e3", key: "poisoned", hiddenFromPlayers: true }] }) } }),
      g2: token("g2", { name: "Goblin", elevation: 10, actor: { inline: actor() } }),
      chest: token("chest", { kind: "object", name: "Chest", actor: { inline: actor() } }),
    },
  });
}

/** Applies every op as `who`, permissions first, as the server would, and fails on any refusal. */
function applyAll(state: RoomState, ops: readonly ClientOp[], who = DM): RoomState {
  let s = state;
  ops.forEach((op, i) => {
    assert.ok(clientOpSchema.safeParse(op).success, `${op.t} is a valid op`);
    const allowed = canApply(op, who, s, deps);
    assert.ok(allowed.ok, `${op.t}: ${allowed.ok ? "" : allowed.message}`);
    const r = applyOp(s, op, who, env(i + 1));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    s = r.state;
  });
  return s;
}

const view = (state: RoomState, role: "dm" | "player", memberId: string) => ({ role, memberId, characters: state.characters, playersApplyDamage: false });

describe("what the group action bar offers", () => {
  test("the DM gets everything, and objects are left out of conditions", () => {
    const state = setup();
    const all = Object.values(state.tokens);
    assert.deepEqual(groupOffers(all, view(state, "dm", "dm1")), { conditions: true, elevation: true, dm: true });
    assert.equal(groupOffers([state.tokens.chest!], view(state, "dm", "dm1")).conditions, false, "only objects: nothing to put a condition on");
  });

  test("a player who selected their own creatures gets conditions and elevation and nothing they would be refused", () => {
    const state = setup();
    const own = [state.tokens.pc!, state.tokens.wolf!];
    assert.deepEqual(groupOffers(own, view(state, "player", "p1")), { conditions: true, elevation: true, dm: false });
    const mixed = [state.tokens.pc!, state.tokens.g1!];
    assert.deepEqual(groupOffers(mixed, view(state, "player", "p1")), { conditions: false, elevation: false, dm: false });
  });
});

describe("conditions on a group", () => {
  test("a condition is lit when all have it and half lit when some do, a shared character counted once", () => {
    const state = setup();
    const creatures = groupCreatures([state.tokens.pc!, state.tokens.pc2!, state.tokens.g1!, state.tokens.chest!], state.characters);
    assert.deepEqual(creatures.map((c) => c.holder), ["character:c1", "token:g1"]);
    assert.equal(conditionLit(creatures, "frightened"), "all");
    assert.equal(conditionLit(creatures, "poisoned"), "some");
    assert.equal(conditionLit(creatures, "prone"), "none");
  });

  test("a tap adds to every creature that lacks it, as one op and one step", () => {
    const state = setup();
    let n = 0;
    const creatures = groupCreatures([state.tokens.pc!, state.tokens.g1!, state.tokens.g2!], state.characters);
    const ops = conditionOps(creatures, "poisoned", () => `new${n++}`);
    assert.equal(ops.length, 1);
    const next = applyAll(state, ops);
    assert.equal(conditionLit(groupCreatures([next.tokens.pc!, next.tokens.g1!, next.tokens.g2!], next.characters), "poisoned"), "all");
    const g1 = next.tokens.g1!;
    assert.equal("inline" in g1.actor && g1.actor.inline.effects.filter((e) => e.key === "poisoned").length, 1, "the one that had it keeps one");
  });

  test("a tap on a lit condition takes it off every one that has it, and Exhaustion goes on at level 1", () => {
    const state = setup();
    const creatures = groupCreatures([state.tokens.pc!, state.tokens.g1!], state.characters);
    const next = applyAll(state, conditionOps(creatures, "frightened", () => "x"));
    assert.equal(conditionLit(groupCreatures([next.tokens.pc!, next.tokens.g1!], next.characters), "frightened"), "none");
    const [op] = conditionOps(creatures, "exhaustion", (() => {
      let n = 0;
      return () => `ex${n++}`;
    })());
    assert.ok(op && op.t === "actor.effects");
    assert.deepEqual(op.add?.map((a) => a.effect.level), [1, 1]);
  });

  test("more than 100 creatures go out as several ops of at most 100", () => {
    const tokens = Array.from({ length: 230 }, (_, i) => token(`t${i}`, { actor: { inline: actor() } }));
    const ops = conditionOps(groupCreatures(tokens, {}), "prone", () => "id");
    assert.deepEqual(ops.map((op) => (op.t === "actor.effects" ? op.add?.length : 0)), [100, 100, 30]);
  });

  test("a player's tap on their own creatures is allowed, and one over another's is refused whole", () => {
    const state = setup();
    const own = groupCreatures([state.tokens.pc!, state.tokens.wolf!], state.characters);
    applyAll(state, conditionOps(own, "prone", () => "p"), P1);
    const [op] = conditionOps(groupCreatures([state.tokens.wolf!, state.tokens.g2!], state.characters), "prone", () => "q");
    assert.ok(op);
    assert.equal(canApply(op, P1, state, deps).ok, false);
  });
});

describe("the group's other edits", () => {
  test("elevation moves each by the same step from its own height, in one gesture", () => {
    const state = setup();
    const tokens = [state.tokens.g1!, state.tokens.g2!];
    assert.equal(sharedElevation(tokens), null);
    const next = applyAll(state, elevationOps(tokens, 5));
    assert.deepEqual([next.tokens.g1!.elevation, next.tokens.g2!.elevation], [5, 15]);
    assert.equal(sharedElevation([next.tokens.g1!, { elevation: 5 }]), 5);
  });

  test("Hidden and Locked light for all, turn off for all when lit, else on for all", () => {
    const state = setup();
    state.tokens.g1 = { ...state.tokens.g1!, visibility: "dm" };
    const tokens = [state.tokens.g1, state.tokens.g2!];
    assert.equal(flagLit(tokens, "hidden"), "some");
    assert.deepEqual(flagPatch(tokens, "hidden"), { visibility: "dm" });
    const hidden = applyAll(state, updateManyOps(["g1", "g2"], flagPatch(tokens, "hidden")));
    assert.equal(flagLit([hidden.tokens.g1!, hidden.tokens.g2!], "hidden"), "all");
    assert.deepEqual(flagPatch([hidden.tokens.g1!, hidden.tokens.g2!], "hidden"), { visibility: "all" });
    assert.deepEqual(flagPatch(tokens, "locked"), { locked: true });
  });

  test("a group of 230 goes out in batches of 100", () => {
    const ids = Array.from({ length: 230 }, (_, i) => `t${i}`);
    assert.deepEqual(updateManyOps(ids, { locked: true }).map((op) => (op.t === "token.updateMany" ? op.tokenIds.length : 0)), [100, 100, 30]);
    assert.deepEqual(deleteManyOps(ids).map((op) => (op.t === "token.deleteMany" ? op.tokenIds.length : 0)), [100, 100, 30]);
  });

  test("owners: a member added to or taken off every token, each keeping its other owners", () => {
    const state = setup();
    state.tokens.g1 = { ...state.tokens.g1!, ownerIds: ["p2"] };
    const tokens = [state.tokens.wolf!, state.tokens.g1, state.tokens.g2!];
    assert.equal(ownersLit(tokens, "p1"), "some");
    const next = applyAll(state, ownerOps(tokens, "p1", true));
    assert.deepEqual([next.tokens.wolf!.ownerIds, next.tokens.g1!.ownerIds, next.tokens.g2!.ownerIds], [["p1"], ["p2", "p1"], ["p1"]]);
    assert.equal(ownersLit([next.tokens.wolf!, next.tokens.g1!, next.tokens.g2!], "p1"), "all");
    const off = applyAll(next, ownerOps([next.tokens.wolf!, next.tokens.g1!, next.tokens.g2!], "p1", false));
    assert.deepEqual([off.tokens.wolf!.ownerIds, off.tokens.g1!.ownerIds, off.tokens.g2!.ownerIds], [[], ["p2"], []]);
  });

  test("Delete takes every token with its rows, and Add to the fight adds only those not in it, or starts one", () => {
    const state = setup();
    let n = 0;
    const id = () => `row${n++}`;
    const started = applyAll(state, fightOps([state.tokens.g1!, state.tokens.g2!], state.encounter, id));
    assert.deepEqual(started.encounter?.entries.map((e) => e.tokenId).sort(), ["g1", "g2"]);
    const more = fightOps([started.tokens.g1!, started.tokens.wolf!], started.encounter, id);
    assert.deepEqual(more.map((op) => (op.t === "encounter.add" ? op.entries.map((e) => e.tokenId) : [])), [["wolf"]]);
    const gone = applyAll(started, deleteManyOps(["g1", "g2"]));
    assert.equal(gone.tokens.g1, undefined);
    assert.deepEqual(gone.encounter?.entries.length, 0);
  });

  test("the group's armed Delete is named by the question it shows (LP5-ROLLS-12)", () => {
    assert.deepEqual(deleteButtonWords(false, "Delete 3 tokens?"), { text: "Delete", label: "Delete" });
    assert.deepEqual(deleteButtonWords(true, "Delete 3 tokens?"), { text: "Delete 3 tokens?", label: "Delete 3 tokens?" });
    assert.deepEqual(deleteButtonWords(true), { text: "Sure?", label: "Tap again to delete" }, "one token's bar keeps its plain name for the second tap");
  });

  test("objects caught in the selection stay out of the fight, and only objects left out offer nothing to add (LP5-ROLLS-7)", () => {
    const state = setup();
    let n = 0;
    const id = () => `row${n++}`;
    const started = applyAll(state, fightOps([state.tokens.chest!, state.tokens.g1!], state.encounter, id));
    assert.deepEqual(started.encounter?.entries.map((e) => e.tokenId), ["g1"]);
    assert.deepEqual(fightCandidates([started.tokens.chest!, started.tokens.g1!], started.encounter), [], "the bar shows no Add to the fight");
    assert.deepEqual(fightCandidates([started.tokens.chest!, started.tokens.g2!], started.encounter).map((t) => t.id), ["g2"]);
  });

  test("tokens with no image share none, so the More sheet does not call them different (LPD-DMPHONE-5)", () => {
    const icon = { icon: "goblin", color: "#e5484d" } as const;
    assert.deepEqual(sharedImage([{}, {}, {}]), { same: true, image: undefined }, "three goblins drawing their initials");
    assert.deepEqual(sharedImage([{ image: icon }, { image: { ...icon } }]), { same: true, image: icon });
    assert.deepEqual(sharedImage([{ image: icon }, {}]), { same: false, image: undefined });
    assert.deepEqual(sharedImage([{ image: icon }, { image: { ...icon, color: "#3e8ef7" } }]), { same: false, image: undefined });
  });
});
