import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "./model.ts";
import { alreadyFighting, canApply } from "./permissions.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, apply, character, entry, env, room, token } from "./testutil.ts";

/*
 * One Initiative row a creature (LP52B-INIT-ROWS, D-261128-039, 041, 045):
 * the server refuses a start or an add that names a creature twice, or one
 * with a row already, whole, in words a toast reads as they are. A player
 * counts the rows their copy holds and their own creatures' rows on any
 * scene or floor (D-261128-170), never a row the DM hides. Replay runs no
 * permission rule.
 */

const deps = { canUseAsset: () => true };
const ONE = "Shade is already in the fight.";
const BATCH = "Shade is already in the fight, so no one was added. Press again to add the rest.";

/** Shade with a token on each scene, a goblin, and a fight holding Shade A's row. */
function fight(hidden = false): RoomState {
  return room({
    characters: { shade: character("shade", { name: "Shade", ownerIds: ["p1"] }) },
    tokens: {
      sa: token("sa", { name: "Shade", kind: "pc", sceneId: "s2", ownerIds: ["p1"], actor: { ref: "shade" } }),
      sb: token("sb", { name: "Shade", kind: "pc", ownerIds: ["p1"], actor: { ref: "shade" } }),
      gob: token("gob", { name: "Goblin" }),
      orc: token("orc", { name: "Orc" }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-sa", { tokenId: "sa", hidden })] },
  });
}

const add = (...ids: string[]): Op => ({ t: "encounter.add", entries: ids.map((id) => ({ id: `n-${id}`, tokenId: id })) });

describe("one Initiative row a creature", () => {
  test("a second DM device adding Shade's other token is refused in her name, and a goblin goes", () => {
    const state = fight();
    assert.deepEqual(canApply(add("sb"), DM, state, deps), { ok: false, code: "forbidden", message: ONE });
    assert.deepEqual(canApply({ t: "encounter.add", entries: [{ id: "n-shade", characterId: "shade" }] }, DM, state, deps), { ok: false, code: "forbidden", message: ONE }, "her character row too");
    assert.deepEqual(canApply(add("gob"), DM, state, deps), { ok: true });
  });

  test("a batch with Shade B and a goblin is refused whole, in words that say no one was added, and the second press adds the goblin", () => {
    const state = fight();
    assert.deepEqual(canApply(add("sb", "gob"), DM, state, deps), { ok: false, code: "forbidden", message: BATCH });
    // The device then holds Shade A's row, so its second press offers the goblin alone.
    const after = apply(state, add("gob"), DM, 2);
    assert.deepEqual(after.encounter!.entries.map((e) => e.tokenId).sort(), ["gob", "sa"]);
  });

  test("a start or an add that names one creature twice is refused, a creature with no character in neutral words", () => {
    const none = { ...fight(), encounter: null };
    assert.deepEqual(canApply({ t: "encounter.start", entries: [{ id: "n1", tokenId: "sa" }, { id: "n2", tokenId: "sb" }] }, DM, none, deps), { ok: false, code: "forbidden", message: BATCH });
    assert.deepEqual(canApply({ t: "encounter.start", entries: [{ id: "n1", tokenId: "sb" }, { id: "n2", tokenId: "gob" }] }, DM, none, deps), { ok: true });
    assert.deepEqual(canApply({ t: "encounter.add", entries: [{ id: "n1", tokenId: "orc" }, { id: "n2", tokenId: "orc" }] }, DM, fight(), deps), {
      ok: false,
      code: "forbidden",
      message: "That creature is already in the fight, so no one was added. Press again to add the rest.",
    });
    const withOrc = apply(fight(), add("orc"), DM, 2);
    assert.deepEqual(canApply(add("orc"), DM, withOrc, deps), { ok: false, code: "forbidden", message: "That creature is already in the fight." });
    // Label rows name no creature, so two of them go.
    assert.deepEqual(canApply({ t: "encounter.add", entries: [{ id: "n1", label: "Lair" }, { id: "n2", label: "Lair" }] }, DM, fight(), deps), { ok: true });
  });

  test("a player's add of their own Shade B is refused while they see Shade A's row, and taken while the DM hides it", () => {
    // Shade A stands on s2, so the player's copy holds her row only with her token there.
    const seen = fight();
    seen.tokens.sa = { ...seen.tokens.sa!, sceneId: "s1", x: 9, y: 9 };
    assert.deepEqual(canApply(add("sb"), P1, seen, deps), { ok: false, code: "forbidden", message: ONE });
    const hidden = fight(true);
    hidden.tokens.sa = { ...hidden.tokens.sa!, sceneId: "s1", x: 9, y: 9 };
    assert.deepEqual(canApply(add("sb"), P1, hidden, deps), { ok: true }, "a row the DM hides never refuses a player, nor says it exists");
    const two = apply(hidden, add("sb"), P1, 2);
    assert.deepEqual(two.encounter!.entries.map((e) => e.tokenId).sort(), ["sa", "sb"], "two rows, as the DM may then remove one");
  });

  test("a player's add of their own creature is refused while it has a row on another scene, never by a row the DM hides there, and another player's creature is not theirs to count (LP62-INIT-1)", () => {
    // Shade A's row stands with her token on s2, which the player's copy does not hold.
    const elsewhere = fight();
    assert.equal(
      projectState(elsewhere, P1, { sceneId: "s1" }).encounter?.entries.some((e) => e.id === "e-sa"),
      false,
      "the copy drops her row",
    );
    assert.deepEqual(canApply(add("sb"), P1, elsewhere, deps), { ok: false, code: "forbidden", message: ONE });
    assert.deepEqual(canApply({ t: "encounter.add", entries: [{ id: "n-shade", characterId: "shade" }] }, P1, elsewhere, deps), { ok: false, code: "forbidden", message: ONE }, "her character row too");
    assert.deepEqual(canApply(add("sb"), P1, fight(true), deps), { ok: true }, "the DM hides her row there, so it never refuses, nor says it exists");
    // Mira is p2's: Shade's row elsewhere is no creature of theirs, and their own Mira's row there refuses their add as Shade's does.
    const two = fight();
    two.characters.mira = character("mira", { name: "Mira", ownerIds: ["p2"] });
    two.tokens.ma = token("ma", { name: "Mira", kind: "pc", sceneId: "s2", ownerIds: ["p2"], actor: { ref: "mira" } });
    two.tokens.mb = token("mb", { name: "Mira", kind: "pc", ownerIds: ["p2"], actor: { ref: "mira" } });
    assert.deepEqual(canApply(add("mb"), P2, two, deps), { ok: true }, "Shade's row refuses no one else's creature");
    const both = apply(two, add("ma"), DM, 2);
    assert.deepEqual(canApply(add("mb"), P2, both, deps), { ok: false, code: "forbidden", message: "Mira is already in the fight." });
    // A token p1 owns that stands for p2's Mira: her row on s2 is no creature p1 answers for, so their add never learns of it.
    both.tokens.mc = token("mc", { name: "Mira", kind: "pc", ownerIds: ["p1"], actor: { ref: "mira" } });
    assert.deepEqual(canApply(add("mc"), P1, both, deps), { ok: true });
  });

  test("a player's refusal comes after their own checks, so it never names a creature they do not own", () => {
    const state = fight();
    state.characters.mira = character("mira", { name: "Mira", ownerIds: ["p2"] });
    state.tokens.m1 = token("m1", { name: "Mira", kind: "pc", ownerIds: ["p2"], actor: { ref: "mira" } });
    state.tokens.m2 = token("m2", { name: "Mira", kind: "pc", ownerIds: ["p2"], actor: { ref: "mira" } });
    const refusal = canApply(add("m1", "m2"), P1, state, deps);
    assert.equal(refusal.ok, false);
    assert.ok(!refusal.ok && !refusal.message.includes("Mira"));
  });

  test("a stored op that made a second row replays to two rows, since replay runs no permission rule", () => {
    const result = applyOp(fight(), add("sb"), DM, env(7));
    assert.ok(result.ok);
    assert.deepEqual(result.state.encounter!.entries.map((e) => e.tokenId).sort(), ["sa", "sb"]);
  });

  test("the words read the character's name as the room holds it", () => {
    const state = fight();
    assert.equal(alreadyFighting(state, "character:shade", false), ONE);
    assert.equal(alreadyFighting(state, "character:gone", false), "That creature is already in the fight.");
    assert.equal(alreadyFighting(state, "token:gob", true), "That creature is already in the fight, so no one was added. Press again to add the rest.");
  });
});
