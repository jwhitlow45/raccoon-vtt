import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { COUNT_OP_VERSION, COUNT_SNAPSHOT_VERSION, OP_VERSION, SNAPSHOT_VERSION, runMigrations, snapshotMigrations } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { commitBatch, loadRoom } from "./persistence.ts";
import { startEngine, type Engine } from "./testing.ts";

/**
 * The room count in Postgres (counted.ts): each row's `pub`, `rooms.pub`
 * in the transaction of every commit that answered something, the snapshot
 * a room saved before the count writes in its first commit here, and a
 * load that resumes from the stored count.
 */

describe("the room count in Postgres", () => {
  let t: Engine;
  // The rooms' clock, which only the steps move, and the numbers follow it as in production. It starts at the
  // database's time, since a snapshot prunes covered rows by it.
  const clock = { now: Date.now() };
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { now: () => clock.now, numberClock: () => clock.now, snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  /** A room made here, unloaded, as a build before the count would have stored it: snapshot 43, two chats at op version 56, no count. */
  async function oldRoom(): Promise<{ roomId: string; owner: ReturnType<Engine["client"]>; base: number; dmId: string }> {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Before the count");
    const s = await t.connect(roomId, owner);
    await s.snapshot("c1");
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId, 1012, false);
    const { rows } = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    const base = Number(rows[0]!.seq);
    const dmId = Object.values(rows[0]!.state.members).find((m) => m.kind === "dm")!.id;
    await t.pool.query("update room_snapshots set schema_version = $2 where room_id = $1", [roomId, COUNT_SNAPSHOT_VERSION - 1]);
    for (const seq of [base + 1, base + 2]) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version) values ($1, $2, now(), $3, 'dm', $4::jsonb, $5)`,
        [roomId, seq, dmId, JSON.stringify({ t: "log.chat", text: `old ${seq}` }), COUNT_OP_VERSION - 1],
      );
    }
    const { rows: room } = await t.pool.query<{ pub: string | null }>("select pub::text from rooms where id = $1", [roomId]);
    assert.equal(room[0]?.pub, null);
    return { roomId, owner, base, dmId };
  }

  test("an old room's first commit, a refusal alone, stores the number and the snapshot at today's version, and a reload resumes past the number", async () => {
    const { roomId, owner, base } = await oldRoom();
    clock.now += 1_000;
    const s = await t.connect(roomId, owner);
    const snap = await s.snapshot("c2");
    assert.ok(snap.seq >= clock.now, "an old room's first read is numbered at the clock");
    clock.now += 1_000;
    const refused = await s.apply({ t: "undo", head: randomUUID() });
    assert.equal(refused.rejects?.length, 1);
    assert.equal(refused.seq, clock.now, "the refusal takes the clock's number");
    const refusedAt = clock.now;
    const stored = await t.pool.query<{ pub: string; seq: string; schema_version: number; state: RoomState }>(
      "select r.pub::text, s.seq::text, s.schema_version, s.state from rooms r join room_snapshots s on s.room_id = r.id where r.id = $1",
      [roomId],
    );
    const row = stored.rows[0]!;
    assert.equal(row.pub, String(refusedAt));
    assert.equal(row.schema_version, SNAPSHOT_VERSION);
    assert.equal(row.seq, String(base + 2), "the snapshot is the batch's state at the batch's seq");
    assert.throws(() => runMigrations(row.state, row.schema_version, COUNT_SNAPSHOT_VERSION - 1, snapshotMigrations), /down/, "an older build refuses it");

    clock.now += 1_000;
    const chat = await s.apply({ t: "log.chat", text: "counted" });
    assert.equal(chat.seq, clock.now);
    const chatAt = clock.now;
    const ops = await t.pool.query<{ seq: string; pub: string | null; op_version: number }>("select seq::text, pub::text, op_version from room_ops where room_id = $1 order by seq", [roomId]);
    assert.deepEqual(ops.rows, [
      { seq: String(base + 1), pub: null, op_version: COUNT_OP_VERSION - 1 },
      { seq: String(base + 2), pub: null, op_version: COUNT_OP_VERSION - 1 },
      { seq: String(base + 3), pub: String(chatAt), op_version: OP_VERSION },
    ]);
    const lines = await t.pool.query<{ id: string }>("select id from room_log where room_id = $1 and entry->>'text' = 'counted'", [roomId]);
    assert.deepEqual(lines.rows.map((r) => r.id), [`${chatAt}:0`]);

    // A refusal after the last row, then a crash: the reload keeps it in the count, not the snapshot's seq.
    clock.now += 1_000;
    const again = await s.apply({ t: "undo", head: randomUUID() });
    assert.equal(again.seq, clock.now);
    await t.manager.unload(roomId, 1012, false);
    await s.waitClosed();
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.seq, base + 3);
    assert.equal(loaded.pub, again.seq);
    clock.now += 1_000;
    const back = await t.connect(roomId, owner);
    assert.ok((await back.snapshot("c3")).seq >= clock.now, "the reload's read is numbered at the clock");
    clock.now += 1_000;
    assert.equal((await back.apply({ t: "log.chat", text: "after the reload" })).seq, clock.now);
  });

  test("a row at today's version replays at its own number, and one stored without a number stops the replay", async () => {
    const { roomId, base, dmId } = await oldRoom();
    await t.pool.query(
      `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version, pub) values ($1, $2, now(), $3, 'dm', $4::jsonb, $5, $6)`,
      [roomId, base + 3, dmId, JSON.stringify({ t: "log.chat", text: "numbered" }), OP_VERSION, base + 9],
    );
    await t.pool.query("update rooms set pub = $2 where id = $1", [roomId, base + 9]);
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.pub, base + 9);
    assert.deepEqual(loaded.state.log.slice(-3).map((l) => l.id), [`${base + 1}:0`, `${base + 2}:0`, `${base + 9}:0`]);
    await t.pool.query("update room_ops set pub = null where room_id = $1 and seq = $2", [roomId, base + 3]);
    const reasons: string[] = [];
    const stopped = await loadRoom(t.pool, roomId, (_seq, reason) => reasons.push(reason));
    assert.equal(stopped?.replayFailed, true);
    assert.deepEqual(reasons, [`op ${base + 3} has no number`]);
  });

  test("a commit that rolls back writes neither the count nor its snapshot, and one that holds nothing writes no count", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Rolled back");
    await t.manager.unload(roomId, 1012, false);
    const before = await t.pool.query<{ seq: string; schema_version: number }>("select seq::text, schema_version from room_snapshots where room_id = $1", [roomId]);
    const op = { seq: 1, pub: 1, at: new Date().toISOString(), actor: { memberId: "server", role: "dm" as const }, op: { t: "log.chat" as const, text: "once" }, log: [] };
    await commitBatch(t.pool, roomId, { ops: [op], watermarks: [], pub: 1 });
    // A watermark whose session is no uuid fails last, after the rows, the count and the snapshot were written in the transaction.
    const bad = [{ sessionId: "not a session", clientId: "c1", n: 1 }];
    await assert.rejects(commitBatch(t.pool, roomId, { ops: [{ ...op, seq: 2, pub: 7 }], watermarks: bad, pub: 7, snapshot: { seq: 2, json: JSON.stringify({ bogus: true }) } }));
    const after = await t.pool.query<{ pub: string; seq: string; schema_version: number }>("select r.pub::text, s.seq::text, s.schema_version from rooms r join room_snapshots s on s.room_id = r.id where r.id = $1", [roomId]);
    assert.equal(after.rows[0]?.pub, "1");
    assert.deepEqual({ seq: after.rows[0]?.seq, schema_version: after.rows[0]?.schema_version }, before.rows[0]);
    const rows = await t.pool.query<{ seq: string }>("select seq::text from room_ops where room_id = $1", [roomId]);
    assert.deepEqual(rows.rows.map((r) => r.seq), ["1"]);
    await commitBatch(t.pool, roomId, { ops: [], watermarks: [], pub: 9 });
    const empty = await t.pool.query<{ pub: string }>("select pub::text from rooms where id = $1", [roomId]);
    assert.equal(empty.rows[0]?.pub, "1", "a batch that answered nothing writes no count");
  });
});
