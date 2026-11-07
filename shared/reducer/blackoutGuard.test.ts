import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { RoomState } from "../model.ts";
import { opSchema, type Op } from "../protocol.ts";
import { canApply } from "../permissions.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, apply, env, refused, room, scene } from "../testutil.ts";
import { PLAYERS_ELSEWHERE } from "./room.ts";

/**
 * `view.blackout`'s guard (docs/design/design-v1-qol.md 6, D-261106-172): the DM
 * menu's Show players <scene> sends the move, then the lift naming that
 * scene, and the server lifts only while the players are there. A lift the
 * move lost to, or a scene gone since, leaves the blackout on.
 */
const blackedOut = (): RoomState => {
  const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }), s3: scene("s3", { order: 2 }) } });
  return apply(state, { t: "view.blackout", blackout: true });
};
const lift = (sceneId: string): Op => ({ t: "view.blackout", blackout: false, whilePlayersOn: sceneId });

describe("a blackout lifted while the players are on a scene", () => {
  test("applies on the scene the move just sent them to, and the reveal is the move then the lift", () => {
    const moved = apply(blackedOut(), { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2);
    assert.equal(moved.meta.view.blackout, true, "the move alone keeps the blackout");
    const result = applyOp(moved, lift("s2"), DM, env(3));
    assert.ok(result.ok);
    assert.deepEqual(result.state.meta.view, { follow: false, blackout: false });
    assert.equal(result.state.meta.playerSceneId, "s2");
    assert.deepEqual(result.touched, [keys.meta]);
  });

  test("is refused once another DM moved the players on, and the blackout stays", () => {
    let state = apply(blackedOut(), { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2);
    state = apply(state, { t: "room.setPlayerScene", sceneId: "s3" }, { memberId: "dm2", role: "dm" }, 3);
    const r = refused(state, lift("s2"), DM, 4);
    assert.deepEqual([r.code, r.message], ["invalid", PLAYERS_ELSEWHERE]);
  });

  test("is refused when the move was refused, so the players never left the old scene", () => {
    const state = blackedOut();
    assert.equal(refused(state, { t: "room.setPlayerScene", sceneId: "gone" }, DM, 2).code, "gone");
    assert.equal(refused(state, lift("gone"), DM, 3).message, PLAYERS_ELSEWHERE);
  });

  test("is refused for a scene deleted since, which moved the players off it", () => {
    let state = apply(blackedOut(), { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2);
    state = apply(state, { t: "scene.delete", sceneId: "s2" }, DM, 3);
    assert.notEqual(state.meta.playerSceneId, "s2");
    assert.equal(refused(state, lift("s2"), DM, 4).message, PLAYERS_ELSEWHERE);
    assert.equal(state.meta.view.blackout, true);
  });

  test("guards a blackout turned on the same way, and an unguarded change applies wherever the players are, as before", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
    assert.equal(refused(state, { t: "view.blackout", blackout: true, whilePlayersOn: "s2" }).message, PLAYERS_ELSEWHERE);
    assert.equal(apply(state, { t: "view.blackout", blackout: true, whilePlayersOn: "s1" }).meta.view.blackout, true);
    const on = apply(state, { t: "view.blackout", blackout: true });
    assert.equal(apply(on, { t: "view.blackout", blackout: false }, DM, 2).meta.view.blackout, false);
    assert.equal(apply(apply(on, { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2), { t: "view.blackout", blackout: false }, DM, 3).meta.view.blackout, false);
  });

  test("is still the DM's alone", () => {
    const moved = apply(blackedOut(), { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2);
    const decision = canApply(lift("s2"), P1, moved, { canUseAsset: () => true });
    assert.ok(!decision.ok && decision.code === "forbidden");
    assert.ok(canApply(lift("s2"), DM, moved, { canUseAsset: () => true }).ok);
  });

  test("names its scene by an id, as every op does", () => {
    assert.ok(opSchema.safeParse(lift("s2")).success);
    assert.ok(!opSchema.safeParse({ t: "view.blackout", blackout: false, whilePlayersOn: "" }).success);
    assert.ok(!opSchema.safeParse({ t: "view.blackout", blackout: false, whilePlayersOn: "x".repeat(65) }).success);
    assert.ok(!opSchema.safeParse({ t: "view.blackout", blackout: false, whilePlayersOn: null }).success);
  });
});
