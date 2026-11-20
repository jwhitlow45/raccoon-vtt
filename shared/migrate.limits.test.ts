import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION, PLAYER_LIMITS_OP_VERSION, PLAYER_LIMITS_SNAPSHOT_VERSION, SNAPSHOT_VERSION, migrateOp, migrateSnapshot, opMigrations, playerLimitsOps, runMigrations, snapshotMigrations } from "./migrate.ts";
import { clientOpSchema, opSchema } from "./protocol.ts";
import { room } from "./testutil.ts";

describe("op version 61 and snapshot 47, player limits", () => {
  const ops = [
    { t: "scene.delete", sceneId: "s1", leavePlayers: true },
    { t: "actor.effect.update", target: { characterId: "c1" }, effectId: "unconscious@0", patch: { hiddenFromPlayers: true }, as: "0192f0aa-0000-7000-8000-000000000001" },
    { t: "sys.rideEnd", templates: ["a1", "a2"], drawings: [] },
    { t: "sys.share", shares: [{ sceneId: "s1", share: 78_643 }] },
  ];

  test("keeps stored ops and snapshots unchanged through the identity steps", () => {
    assert.equal(PLAYER_LIMITS_OP_VERSION, 61);
    assert.equal(PLAYER_LIMITS_SNAPSHOT_VERSION, 47);
    assert.ok(OP_VERSION >= 61);
    assert.ok(SNAPSHOT_VERSION >= 47);
    for (const op of ops) {
      assert.equal(runMigrations(op, 60, 61, opMigrations), op);
      assert.equal(migrateOp(op, 61), op);
      assert.ok(opSchema.safeParse(op).success, op.t);
    }
    const state = room({ memoryShared: { s1: { sceneId: "s1", rev: 0, share: 1_024 } } });
    assert.equal(runMigrations(state, 46, 47, snapshotMigrations), state);
    assert.equal(migrateSnapshot(state, 46), state);
  });

  test("the server's own ops never come from a device", () => {
    for (const op of ops.slice(2)) assert.equal(clientOpSchema.safeParse(op).success, false, op.t);
    for (const op of ops.slice(0, 2)) assert.ok(clientOpSchema.safeParse(op).success, op.t);
  });

  test("gates the rules at 61", () => {
    assert.deepEqual([playerLimitsOps(1), playerLimitsOps(60), playerLimitsOps(61), playerLimitsOps(undefined)], [false, false, true, true]);
  });

  test("a build at 60 and 46 refuses a room from this one", () => {
    assert.throws(() => runMigrations(ops[0], 61, 60, opMigrations), /down/);
    assert.throws(() => runMigrations(room(), 47, 46, snapshotMigrations), /down/);
  });
});
