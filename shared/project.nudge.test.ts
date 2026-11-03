import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Viewer } from "./model.ts";
import { projectEntity, projectState } from "./project.ts";
import { keys } from "./keys.ts";
import { DM, P1, P2, room, token } from "./testutil.ts";

/*
 * A placement between squares in each copy of the room
 * (docs/design/design-v1-snap-off.md 5.6): it says only where in its box a
 * token the receiver already sees is drawn, so every copy that holds the
 * token holds it, and a token kept from a player takes its nudge with it.
 */

const DISPLAY: Viewer = { role: "player", memberId: "display:abcdefghijkl" };

function placed() {
  return room({
    tokens: {
      mine: token("mine", { ownerIds: ["p1"], x: 2, y: 2, nudge: { x: 3, y: -3 } }),
      seen: token("seen", { x: 5, y: 2, nudge: { x: -1, y: 2 } }),
      plain: token("plain", { x: 7, y: 2 }),
      hidden: token("hidden", { x: 9, y: 2, visibility: "dm", nudge: { x: 2, y: 2 } }),
    },
  });
}

describe("a nudge in each copy (5.6)", () => {
  test("the DM, the owner, another player and a table display get it on every token they receive", () => {
    const state = placed();
    for (const viewer of [DM, P1, P2, DISPLAY]) {
      const copy = projectState(state, viewer, { sceneId: "s1" });
      assert.deepEqual(copy.tokens.mine!.nudge, { x: 3, y: -3 }, `${viewer.memberId} mine`);
      assert.deepEqual(copy.tokens.seen!.nudge, { x: -1, y: 2 }, `${viewer.memberId} seen`);
      assert.ok(!("nudge" in copy.tokens.plain!), `${viewer.memberId} plain`);
    }
  });

  test("a token kept from players is kept whole, its nudge with it", () => {
    const state = placed();
    for (const viewer of [P1, P2, DISPLAY]) {
      assert.equal(projectState(state, viewer, { sceneId: "s1" }).tokens.hidden, undefined, viewer.memberId);
      assert.equal(projectEntity(keys.token("hidden"), state, viewer, { sceneId: "s1" }), null, viewer.memberId);
    }
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).tokens.hidden!.nudge, { x: 2, y: 2 });
  });
});
