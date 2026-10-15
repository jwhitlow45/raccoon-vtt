import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MoveAnyToken, RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, character, reveal, room, token } from "#shared/testutil.ts";
import { canDragToken } from "./dragRights.ts";

/** Tokens of every kind of ownership and lock, some hidden or in the dark. */
function fixture(who: MoveAnyToken): RoomState {
  const state = room();
  state.meta.settings.playersMoveAny = who;
  state.scenes.s1!.fogEnabled = true;
  state.characters.hero = character("hero", { ownerIds: ["p1"] });
  state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "hero" }, x: 1, y: 1 });
  state.tokens.owl = token("owl", { ownerIds: ["p2"], x: 2, y: 1 });
  state.tokens.goblin = token("goblin", { x: 3, y: 1 });
  state.tokens.statue = token("statue", { locked: true, x: 4, y: 1 });
  state.tokens.mine = token("mine", { ownerIds: ["p1"], locked: true, x: 1, y: 2 });
  state.tokens.hidden = token("hidden", { visibility: "dm", x: 2, y: 2 });
  state.tokens.ownHidden = token("ownHidden", { visibility: "dm", ownerIds: ["p1"], x: 3, y: 2 });
  state.tokens.dark = token("dark", { x: 20, y: 20 });
  reveal(state, "s1", { x: 0, y: 0, w: 8, h: 8 });
  return state;
}

describe("which tokens the map lets a member drag", () => {
  test("agrees with the server for every setting, player and token", () => {
    const settings: MoveAnyToken[] = ["none", "all", ["p1"], ["p2"], []];
    for (const who of settings) {
      const state = fixture(who);
      for (const viewer of [P1, P2]) {
        const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
        for (const t of Object.values(view.tokens)) {
          const offered = canDragToken({ token: t, role: viewer.role, memberId: viewer.memberId, characters: view.characters, settings: view.meta.settings });
          const taken = canApply({ t: "token.move", tokenId: t.id, x: 0, y: 0 }, viewer, state, { canUseAsset: () => true }).ok;
          assert.equal(offered, taken, `${JSON.stringify(who)}: ${viewer.memberId} dragging ${t.id}`);
        }
      }
    }
  });

  test("the DM drags every token but a locked one, which the lock says to unlock first", () => {
    const state = fixture("none");
    const view = projectState(state, DM, { sceneId: "s1" }) as unknown as RoomState;
    for (const t of Object.values(view.tokens)) {
      assert.equal(canDragToken({ token: t, role: "dm", memberId: DM.memberId, characters: view.characters, settings: view.meta.settings }), !t.locked, t.id);
    }
  });

  test("a chosen player drags others' tokens, and an unchosen one only their own", () => {
    const state = fixture(["p2"]);
    const drags = (viewer: typeof P1) => {
      const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
      return Object.values(view.tokens)
        .filter((t) => canDragToken({ token: t, role: "player", memberId: viewer.memberId, characters: view.characters, settings: view.meta.settings }))
        .map((t) => t.id)
        .sort();
    };
    assert.deepEqual(drags(P1), ["ownHidden", "pc"]);
    assert.deepEqual(drags(P2), ["goblin", "owl", "pc"]);
  });
});
