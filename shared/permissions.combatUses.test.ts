import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { TURN_OVER, canApply, type PermissionDeps } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { DM, P1, P2, actor, character, room, scene, token } from "./testutil.ts";

/**
 * Who may spend a creature's uses (docs/design-v1-combat-controls.md 3.1):
 * the DM, and the creature's owners, as `actor.deathSave` is permitted. A
 * creature a player cannot see is `gone`, as a missing one is, so no player
 * can probe a monster's uses.
 */
const deps: PermissionDeps = { canUseAsset: () => true };
const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

function setup(): RoomState {
  return room({
    scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) },
    tokens: {
      dragon: token("dragon", { actor: { inline: actor({ legendary }) } }),
      lent: token("lent", { ownerIds: ["p1"], actor: { inline: actor({ legendary }) } }),
      hidden: token("hidden", { visibility: "dm", actor: { inline: actor({ legendary }) } }),
      thorn: token("thorn", { kind: "pc", actor: { ref: "thorn" } }),
    },
    characters: { thorn: character("thorn", { ownerIds: ["p1"], resources: [{ id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" }] }) },
  });
}

const spend = (target: { tokenId: string } | { characterId: string }, use: Extract<Op, { t: "actor.use" }>["use"] = { kind: "resist" }): Op => ({ t: "actor.use", target, use });

describe("actor.use permissions (docs/design-v1-combat-controls.md 3.1)", () => {
  test("the DM spends any creature's uses, and even the DM's Regeneration waits for its creature's turn", () => {
    for (const id of ["dragon", "lent", "hidden"]) assert.deepEqual(canApply(spend({ tokenId: id }), DM, setup(), deps), { ok: true });
    assert.deepEqual(canApply(spend({ characterId: "thorn" }, { kind: "resource", id: "rage" }), DM, setup(), deps), { ok: true }, "the DM may spend a resource for a player who is away");
    const regen = canApply(spend({ tokenId: "dragon" }, { kind: "regenerate", key: "traits:regeneration", amount: 10, record: 1 }), DM, setup(), deps);
    assert.ok(!regen.ok && regen.message === TURN_OVER, "refused before anything is drawn or healed");
  });

  test("an owner spends their own creature's, a lent monster's included", () => {
    assert.deepEqual(canApply(spend({ tokenId: "lent" }), P1, setup(), deps), { ok: true });
    assert.deepEqual(canApply(spend({ tokenId: "thorn" }, { kind: "resource", id: "rage" }), P1, setup(), deps), { ok: true });
    assert.deepEqual(canApply(spend({ characterId: "thorn" }, { kind: "resource", id: "rage" }), P1, setup(), deps), { ok: true });
  });

  test("a player never spends another's, and a hidden creature is not there", () => {
    assert.equal(canApply(spend({ tokenId: "dragon" }), P1, setup(), deps).ok, false);
    const mine = canApply(spend({ tokenId: "dragon" }), P1, setup(), deps);
    assert.ok(!mine.ok && mine.code === "forbidden");
    const theirs = canApply(spend({ characterId: "thorn" }, { kind: "resource", id: "rage" }), P2, setup(), deps);
    assert.ok(!theirs.ok && theirs.code === "forbidden");
    const hidden = canApply(spend({ tokenId: "hidden" }), P1, setup(), deps);
    const missing = canApply(spend({ tokenId: "nobody" }), P1, setup(), deps);
    assert.deepEqual(hidden, missing, "a hidden monster answers as a missing one");
    assert.ok(!hidden.ok && hidden.code === "gone");
  });

  test("a player lent only a character's token spends none of its class resources, after the token is checked as there", () => {
    const state = setup();
    state.tokens.thorn = { ...state.tokens.thorn!, ownerIds: ["p2"] };
    const rage = spend({ tokenId: "thorn" }, { kind: "resource", id: "rage" });
    const lent = canApply(rage, P2, state, deps);
    assert.ok(!lent.ok && lent.code === "forbidden");
    assert.deepEqual(canApply(rage, P1, state, deps), { ok: true }, "the character's own player still does");
    assert.deepEqual(canApply(spend({ tokenId: "thorn" }), P2, state, deps), { ok: true }, "and the lent player's other uses stand");
    state.tokens.thorn = { ...state.tokens.thorn!, sceneId: "s2" };
    const away = canApply(rage, P2, state, deps);
    assert.ok(!away.ok && away.code === "gone", "a token on another scene is not there for them");
  });
});
