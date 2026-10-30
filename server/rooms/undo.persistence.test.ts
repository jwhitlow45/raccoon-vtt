import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION, migrateOp, migrateSnapshot, opMigrations, runMigrations, snapshotMigrations } from "#shared/migrate.ts";
import { room } from "#shared/testutil.ts";
import { loadRoom, type Pool } from "./persistence.ts";
import { parseRoomState } from "./stateSchema.ts";

describe("batch A snapshot and replay boundary", () => {
  test("op 34 and snapshot 30 append identity steps without changing older contents", () => {
    assert.equal(OP_VERSION, 34);
    assert.equal(SNAPSHOT_VERSION, 30);
    const op = { t: "log.chat", text: "historical line" };
    const state = room();
    assert.equal(runMigrations(op, 33, 34, opMigrations), op);
    assert.equal(runMigrations(state, 29, 30, snapshotMigrations), state);
    assert.deepEqual(migrateOp(op, 33), op);
    assert.deepEqual(migrateSnapshot(state, 29), state);
  });

  test("a snapshot containing the new correction event validates for storage and import", () => {
    const state = room();
    const stored = { ...state, log: [{ id: "5:900000", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "correction", from: "undo", scope: "setup", label: "changing Bree's stat block" } }] };
    const parsed = parseRoomState(stored);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
    if (parsed.ok) assert.deepEqual(parsed.state.log, stored.log);
  });

  test("v30 with an empty replay tail loads and retains correction log ids", async () => {
    const state = { ...room(), log: [{ id: "5:900000", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "correction", from: "redo", scope: "play", label: "moving Bree" } }] };
    const query = async (sql: string) => ({ rows: sql.includes("room_snapshots") ? [{ seq: "5", state, schema_version: 30 }] : [] });
    const db = { query, connect: async () => { throw new Error("read-only fixture"); } } as unknown as Pool;
    const reasons: string[] = [];
    const loaded = await loadRoom(db, "R", (_seq, reason) => reasons.push(reason));
    assert.deepEqual(reasons, []);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.seq, 5);
    assert.deepEqual(loaded.state.log, state.log);
  });

  test("the previous snapshot reader refuses v30 before reading any correction event", () => {
    const state = room();
    const oldSteps = snapshotMigrations.filter((step) => step.to <= 29);
    assert.throws(() => runMigrations(state, 30, 29, oldSteps), /cannot migrate from version 30 down to 29/);
  });
});
