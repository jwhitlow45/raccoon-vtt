import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { migrateSnapshot, SNAPSHOT_VERSION } from "../migrate.ts";
import { canApply } from "../permissions.ts";
import { clientOpSchema, type Op } from "../protocol.ts";
import { apply, DM, P1, room } from "../testutil.ts";
import { critRuleOf } from "./crit.ts";

describe("the room's critical hit rule (docs/design-v1-dice.md, critical hit rules)", () => {
  test("a room or a snapshot from before the setting rolls crits by the 2024 rule", () => {
    const state = room();
    delete state.meta.settings.critRule;
    assert.equal(critRuleOf(state.meta.settings), "rollTwice");
    const loaded = migrateSnapshot(JSON.parse(JSON.stringify(state)), SNAPSHOT_VERSION);
    assert.equal(loaded.meta.settings.critRule, undefined, "a live room loads its snapshot as it was stored");
    assert.equal(critRuleOf(loaded.meta.settings), "rollTwice");
    assert.equal(critRuleOf({ critRule: "doubleTotal" }), "doubleTotal");
  });

  test("the DM picks any of the four rules, a player picks none, and no other value passes", () => {
    for (const critRule of ["rollTwice", "maxPlusRoll", "doubleDice", "doubleTotal"]) {
      const op = { t: "room.update", settings: { critRule } };
      assert.ok(clientOpSchema.safeParse(op).success, critRule);
      assert.equal(critRuleOf(apply(room(), op as Op).meta.settings), critRule);
    }
    assert.equal(clientOpSchema.safeParse({ t: "room.update", settings: { critRule: "tripleDice" } }).success, false);
    const op = { t: "room.update", settings: { critRule: "maxPlusRoll" } } as Op;
    assert.equal(canApply(op, DM, room(), { canUseAsset: () => true }).ok, true);
    assert.equal(canApply(op, P1, room(), { canUseAsset: () => true }).ok, false);
  });
});
