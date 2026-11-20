import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER, thornToken, tower } from "./floorLinksTestutil.ts";
import { visionRules } from "./ruleHooks.ts";
import { token } from "./testutil.ts";

/*
 * Sight by class (docs/design/design-v1-floors.md phase 4, 7.2): every
 * reader of a floor's sight asks `visionRules.sightFor` with the class it
 * reads, which joins it through the floor's openings. Until joins are
 * built, each class reads its floor's own answer.
 */

describe("sight by class, each floor's own answer until joins are built (7.2)", () => {
  test("the union is partySight, the shared class holderSight with no one on a per-player floor and partySight elsewhere, a holder their own", () => {
    const lit = { on: true, light: "bright" as const };
    const state = tower({ tokens: { thorn: thornToken({ sceneId: UPPER }), bree: token("bree", { kind: "pc", ownerIds: ["p2"], sceneId: GROUND, x: 5, y: 5 }) } });
    state.scenes = { ...state.scenes, [GROUND]: { ...state.scenes[GROUND]!, fogEnabled: true, vision: lit }, [UPPER]: { ...state.scenes[UPPER]!, fogEnabled: true, vision: { ...lit, perPlayer: true } } };
    state.holders = { [UPPER]: { sceneId: UPPER, rev: 0, entries: [{ memberId: "p1", on: true }] } };
    const tiles = (sceneId: string, cls: Parameters<typeof visionRules.sightFor>[2]) => [...visionRules.sightFor(state, sceneId, cls).tiles];
    for (const sceneId of [GROUND, UPPER]) {
      assert.deepEqual(tiles(sceneId, "union"), [...visionRules.partySight(state, sceneId).tiles], sceneId);
      assert.deepEqual(tiles(sceneId, { holder: "p1" }), [...visionRules.holderSight(state, sceneId, "p1").tiles], sceneId);
    }
    assert.deepEqual(tiles(GROUND, "shared"), [...visionRules.partySight(state, GROUND).tiles]);
    assert.deepEqual(tiles(UPPER, "shared"), [...visionRules.holderSight(state, UPPER, null).tiles]);
    assert.ok(tiles(GROUND, "shared").length > 0, "Bree sees on Ground floor");
    assert.ok(tiles(UPPER, "union").length > 0, "Thorn sees on Upper floor");
    assert.notDeepEqual(tiles(UPPER, "shared"), tiles(UPPER, "union"), "Thorn's sight is Ana's own on Upper floor");
  });
});
