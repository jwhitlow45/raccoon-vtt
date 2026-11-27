import "../../lib/testing/touchDevice.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keepModel, withoutModel } from "#shared/imageRef.ts";
import type { ImageRef, ModelRef, RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, entry, env, P1, room, token } from "#shared/testutil.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { wearing } from "../models/session.ts";
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
  imageOps,
  ownerOps,
  ownersLit,
  sharedElevation,
  sharedImage,
  shownRowOps,
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

  test("Hidden turned off shows the tokens' hidden rows to players too, and leaves other rows and a fight-less room alone", () => {
    const state = setup();
    for (const id of ["g1", "g2"]) state.tokens[id] = { ...state.tokens[id]!, visibility: "dm" };
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: null,
      entries: [entry("r1", { tokenId: "g1", value: 15, hidden: true }), entry("r2", { tokenId: "g2", value: 12, hidden: true }), entry("r3", { tokenId: "wolf", value: 10, hidden: true }), entry("r4", { tokenId: "pc", value: 8 })],
    };
    const rowsFor = (s: RoomState) => projectState(s, P1, { sceneId: "s1" }).encounter?.entries.map((e) => e.id) ?? [];
    assert.deepEqual(rowsFor(state), ["r4"], "Ayla's player sees only Ayla's row");
    assert.deepEqual(shownRowOps(state.encounter, ["g1", "g2"]), [
      { t: "encounter.update", entryId: "r1", patch: { hidden: false } },
      { t: "encounter.update", entryId: "r2", patch: { hidden: false } },
    ]);
    assert.deepEqual(shownRowOps(null, ["g1"]), []);
    // The group's bar: the tokens' change and their rows, as the server takes them.
    const tokens = [state.tokens.g1!, state.tokens.g2!];
    const patch = flagPatch(tokens, "hidden");
    assert.deepEqual(patch, { visibility: "all" });
    const shown = applyAll(state, [...updateManyOps(["g1", "g2"], patch), ...shownRowOps(state.encounter, ["g1", "g2"])]);
    assert.deepEqual(rowsFor(shown), ["r1", "r2", "r4"]);
    assert.equal(shown.encounter!.entries.find((e) => e.id === "r3")!.hidden, true, "another token's hidden row stays hidden");
    // A token alone, as its bar and the panel's switch send it.
    const one = applyAll(state, [{ t: "token.update", tokenId: "g1", patch: { visibility: "all" } }, ...shownRowOps(state.encounter, ["g1"])]);
    assert.deepEqual(rowsFor(one), ["r1", "r4"]);
    // The tracker can still hide a shown token's row on its own.
    const rehidden = applyAll(shown, [{ t: "encounter.update", entryId: "r1", patch: { hidden: true } }]);
    assert.equal(rehidden.tokens.g1!.visibility, "all");
    assert.deepEqual(rowsFor(rehidden), ["r2", "r4"]);
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

describe("a group's image changes with 3D models (docs/design/design-v1-token-models.md 3.4)", () => {
  const model = (assetId: string): ModelRef => ({ assetId, side: 1.4, anchorY: 0.8, boxes: Array.from({ length: 8 }, (): [number, number, number, number] => [20, 10, 80, 95]) });
  const face = (assetId: string, sheet?: string): ImageRef => ({ assetId, crop: { cx: 0.5, cy: 0.5, zoom: 1 }, ...(sheet ? { model: model(sheet) } : {}) });
  function group(): RoomState {
    return room({
      tokens: {
        a: token("a", { name: "Goblin", image: face("goblin", "goblin-sheet") }),
        b: token("b", { name: "Wolf", image: { icon: "lorc/wolf-head", color: "#336699", model: model("wolf-sheet") } }),
        c: token("c", { name: "Orc", image: face("orc") }),
        d: token("d", { name: "Bat" }),
      },
    });
  }
  const tokens = (state: RoomState) => ["a", "b", "c", "d"].map((id) => state.tokens[id]!);

  test("3D model goes on each token's own picture, a token with none taking the front view, one token.update each in one undo step", () => {
    const state = group();
    const front = face("front");
    const ops = imageOps(tokens(state), (current) => wearing(current, model("new-sheet"), front));
    assert.deepEqual(ops.map((op) => (op.t === "token.update" ? op.tokenId : op.t)), ["a", "b", "c", "d"]);
    const sent: { op: ClientOp; group?: string }[] = [];
    let ids = 0;
    dispatchGesture({ dispatch: (op, opts) => (sent.push({ op, ...(opts?.group ? { group: opts.group } : {}) }), sent.length), newId: () => `g${++ids}` }, ops);
    assert.deepEqual(new Set(sent.map((s) => s.group)), new Set(["g1"]), "one gesture, one undo step");
    const after = applyAll(state, ops);
    assert.deepEqual(after.tokens.a!.image, face("goblin", "new-sheet"));
    assert.deepEqual(after.tokens.b!.image, { icon: "lorc/wolf-head", color: "#336699", model: model("new-sheet") });
    assert.deepEqual(after.tokens.c!.image, face("orc", "new-sheet"));
    assert.deepEqual(after.tokens.d!.image, face("front", "new-sheet"));
  });

  test("Change image keeps each token's own model, and one already wearing the result is left alone", () => {
    const state = group();
    const next = face("hooded");
    const after = applyAll(state, imageOps(tokens(state), (current) => keepModel(next, current)));
    assert.deepEqual(after.tokens.a!.image, face("hooded", "goblin-sheet"));
    assert.deepEqual(after.tokens.b!.image, face("hooded", "wolf-sheet"));
    assert.deepEqual(after.tokens.c!.image, face("hooded"));
    assert.deepEqual(after.tokens.d!.image, face("hooded"));
    assert.deepEqual(imageOps(tokens(after), (current) => keepModel(next, current)), [], "nothing changes a second time");
  });

  test("Remove model takes each one's off and keeps each picture, and Remove takes both off every token with an image", () => {
    const state = group();
    const ops = imageOps(tokens(state), (current) => (current ? withoutModel(current) : null));
    assert.deepEqual(ops.map((op) => (op.t === "token.update" ? op.tokenId : op.t)), ["a", "b"], "only those with a model change");
    const after = applyAll(state, ops);
    assert.deepEqual([after.tokens.a!.image, after.tokens.b!.image, after.tokens.c!.image], [face("goblin"), { icon: "lorc/wolf-head", color: "#336699" }, face("orc")]);
    const removed = applyAll(state, imageOps(tokens(state), () => null));
    assert.deepEqual(["a", "b", "c", "d"].map((id) => removed.tokens[id]!.image), [undefined, undefined, undefined, undefined]);
    assert.equal(imageOps(tokens(state), () => null).length, 3, "the token with no image sends nothing");
  });
});
