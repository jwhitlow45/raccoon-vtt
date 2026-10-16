import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { P1, apply, character, room, token } from "#shared/testutil.ts";
import { newCharacterState, onScene, playerToken } from "./playerCharacters.ts";

describe("a player's own characters", () => {
  const setup = () => {
    const state = room();
    state.meta.settings.playersCreateCharacters = true;
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    return state;
  };

  test("New character follows the setting and the cap of three", () => {
    const state = setup();
    assert.deepEqual(newCharacterState(state, "p1"), { allowed: true });
    state.characters.c2 = character("c2", { ownerIds: ["p1"] });
    state.characters.c3 = character("c3", { ownerIds: ["p1"] });
    assert.deepEqual(newCharacterState(state, "p1"), { allowed: false, reason: "full" });
    assert.deepEqual(newCharacterState(state, "p2"), { allowed: true });
    state.meta.settings.playersCreateCharacters = false;
    assert.deepEqual(newCharacterState(state, "p2"), { allowed: false, reason: "off" });
  });

  test("deleting one of three brings New character back", () => {
    const state = setup();
    state.characters.c2 = character("c2", { ownerIds: ["p1"] });
    state.characters.c3 = character("c3", { ownerIds: ["p1"] });
    assert.deepEqual(newCharacterState(state, "p1"), { allowed: false, reason: "full" });
    assert.deepEqual(newCharacterState(apply(state, { t: "character.delete", characterId: "c3" }, P1), "p1"), { allowed: true });
  });

  test("Place my token puts a token the server accepts in the middle of the view, once", () => {
    const state = setup();
    const scene = state.scenes.s1!;
    const op = playerToken({ view: state, scene, character: state.characters.c1!, memberId: "p1", center: { x: 5.2, y: 4.7 }, id: "t1" });
    assert.ok(op);
    assert.deepEqual([op.x, op.y], [5, 4]);
    const ok = canApply({ t: "token.create", token: op }, { memberId: "p1", role: "player" }, state, { canUseAsset: () => true });
    assert.ok(ok.ok, JSON.stringify(ok));
    state.tokens.t1 = token("t1", { kind: "pc", actor: { ref: "c1" }, x: 5, y: 4 });
    assert.ok(onScene(state, "c1", "s1"));
    assert.equal(playerToken({ view: state, scene, character: state.characters.c1!, memberId: "p1", center: { x: 5, y: 4 }, id: "t2" }), null);
  });

  test("never for someone else's character, another scene, or with the setting off", () => {
    const state = setup();
    const scene = state.scenes.s1!;
    assert.equal(playerToken({ view: state, scene, character: state.characters.c1!, memberId: "p2", center: { x: 1, y: 1 }, id: "t" }), null);
    assert.equal(playerToken({ view: state, scene: state.scenes.s2!, character: state.characters.c1!, memberId: "p1", center: { x: 1, y: 1 }, id: "t" }), null);
    state.meta.settings.playersCreateCharacters = false;
    assert.equal(playerToken({ view: state, scene, character: state.characters.c1!, memberId: "p1", center: { x: 1, y: 1 }, id: "t" }), null);
  });
});
