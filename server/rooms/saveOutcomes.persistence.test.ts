import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION, SNAPSHOT_VERSION, opMigrations, runMigrations, snapshotMigrations } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { AT, DM, actor, room, token } from "#shared/testutil.ts";
import { loadRoom, type Pool } from "./persistence.ts";
import { parseRoomState } from "./stateSchema.ts";

const id = uuidv7(Date.parse(AT));
const record = { memberId: DM.memberId, plan: id, revision: 3, state: "applied" as const, firstAppliedAt: AT, seq: 5 };
const state = () => ({ ...room(), saveOutcomes: { [id]: record } });

test("snapshot and export schema accept bounded lifecycle records and reject malformed metadata", () => {
  const parsed = parseRoomState(state());
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  if (parsed.ok) assert.deepEqual(parsed.state, state());
  for (const saveOutcomes of [
    { invalid: record }, { [id]: { ...record, rev: 1 } }, { [id]: { ...record, revision: 0 } },
    { [id]: { ...record, seq: Number.MAX_SAFE_INTEGER + 1 } }, { [id]: { ...record, firstAppliedAt: "yesterday" } },
    Object.fromEntries(Array.from({ length: 201 }, () => [uuidv7(), record])),
  ]) assert.equal(parseRoomState({ ...room(), saveOutcomes }).ok, false);
});

test("version 35/31 steps are identity migrations and A readers refuse 31 with empty ledger and replay tail", () => {
  assert.deepEqual([OP_VERSION, SNAPSHOT_VERSION], [35, 31]);
  const op = { t: "log.chat", text: "old chat" };
  assert.equal(runMigrations(op, 34, 35, opMigrations), op);
  const old = room();
  assert.equal(runMigrations(old, 30, 31, snapshotMigrations), old);
  for (const stored of [room(), { ...room(), saveOutcomes: {} }, state()]) {
    assert.throws(() => runMigrations(stored, 31, 30, snapshotMigrations.filter((s) => s.to <= 30)), /cannot migrate/);
  }
});

test("restart loads snapshot 31 lifecycle and A correction lines without inventing memory-only history", async () => {
  const stored = { ...state(), log: [{ id: "5:900000", at: AT, kind: "event", data: { type: "correction", from: "undo", scope: "setup", label: "changing a sheet" } }] };
  const query = async (sql: string) => ({ rows: sql.includes("room_snapshots") ? [{ seq: "5", state: stored, schema_version: 31 }] : [] });
  const db = { query, connect: async () => { throw new Error("read-only fixture"); } } as unknown as Pool;
  const failures: string[] = [];
  const loaded = await loadRoom(db, "SAVE", (_seq, reason) => failures.push(reason));
  assert.deepEqual(failures, []);
  assert.ok(loaded && !loaded.replayFailed);
  assert.equal(loaded.seq, 5);
  assert.deepEqual(loaded.state, stored);
});

test("stored op 33/34 fixtures retain HP, log numbering and A correction audiences under B replay", () => {
  const before = room({ tokens: { goblin: token("goblin", { actor: { inline: actor({ hp: { cur: 10, max: 10, temp: 0 } }) } }) } });
  const legacy = { t: "actor.outcome" as const, plan: "legacy-plan", targets: [{ target: { tokenId: "goblin" }, amount: 2 }] };
  for (const opVersion of [33, 34]) {
    const hit = applyOp(before, legacy, DM, { seq: 3, at: AT, opVersion });
    assert.ok(hit.ok);
    const restored = applyOp(hit.state, { t: "sys.restore", entries: hit.inverse!, from: "undo", scope: "play", correction: { label: "Fireball" } }, DM, { seq: 4, at: AT, opVersion });
    assert.ok(restored.ok);
    assert.equal((restored.state.tokens.goblin!.actor as { inline: { hp: { cur: number } } }).inline.hp.cur, 10);
    assert.equal((restored.state as RoomState & { saveOutcomes?: unknown }).saveOutcomes, undefined);
    assert.deepEqual(hit.log.map((line) => line.id), ["3:0"]);
    assert.equal(restored.log.filter((line) => line.data?.type === "correction").length, opVersion === 34 ? 1 : 0);
  }
});
