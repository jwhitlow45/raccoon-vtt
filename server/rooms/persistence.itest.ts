import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { OP_VERSION } from "#shared/migrate.ts";
import { room } from "#shared/testutil.ts";
import { SnapshotWriteTimeout, writeSnapshot, writeSnapshotJson, type Pool } from "./persistence.ts";
import { startEngine, type Engine } from "./testing.ts";

/*
 * A snapshot write (persistence.ts writeSnapshotJson) on Postgres: the row
 * and the prune of the rows it covers in one transaction, all of it within
 * one deadline from asking for the connection. Deadlines here are a second,
 * the production one's scale (SNAPSHOT_WRITE_MS) scaled down.
 */

const DEADLINE_MS = 1_000;

describe("a snapshot write's one transaction and deadline", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  /** A room with its snapshot row, never loaded, and an op row at `seq` older than an hour, which a snapshot at `seq` prunes. */
  async function stored(name: string): Promise<{ roomId: string; seq: number; row: () => Promise<{ seq: string; caps: boolean; ops: number }> }> {
    const { roomId } = await t.client().createRoom(name);
    const seq = 1_000_000;
    await t.pool.query(
      "insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version, pub) values ($1, $2, now() - interval '2 hours', 'server', 'dm', $3, $4, $2)",
      [roomId, seq, JSON.stringify({ t: "log.chat", text: "old" }), OP_VERSION],
    );
    const row = async () => {
      const snap = (await t.pool.query<{ seq: string; caps: boolean }>("select seq::text, caps_pending as caps from room_snapshots where room_id = $1", [roomId])).rows[0]!;
      const ops = (await t.pool.query("select 1 from room_ops where room_id = $1 and seq = $2", [roomId, seq])).rowCount ?? 0;
      return { ...snap, ops };
    };
    return { roomId, seq, row };
  }

  /** Holds `sql`'s row locks from a connection of its own until `ms` have passed. */
  async function holdFor(sql: string, params: unknown[], ms: number): Promise<{ done: Promise<void> }> {
    const holder = await t.pool.connect();
    await holder.query("begin");
    await holder.query(sql, params);
    const done = new Promise<void>((resolve) =>
      setTimeout(async () => {
        await holder.query("rollback");
        holder.release();
        resolve();
      }, ms),
    );
    return { done };
  }

  const json = JSON.stringify({ meta: { name: "written" } });

  test("a write within its deadline stores the row with its caps mark and prunes what it covers, together", async () => {
    const r = await stored("Snapshot written");
    await writeSnapshotJson(t.pool, r.roomId, r.seq, json, true, DEADLINE_MS);
    assert.deepEqual(await r.row(), { seq: String(r.seq), caps: true, ops: 0 });
  });

  test("a state written as a snapshot keeps the caps mark it is given, either way", async () => {
    for (const capsPending of [true, false]) {
      const r = await stored(`Snapshot caps ${capsPending}`);
      await writeSnapshot(t.pool, r.roomId, r.seq, room(), capsPending);
      assert.deepEqual(await r.row(), { seq: String(r.seq), caps: capsPending, ops: 0 });
    }
  });

  test("two statements that each take most of the deadline fail the write at it, and store nothing", async () => {
    const r = await stored("Snapshot slow statements");
    const before = await r.row();
    const snapshot = await holdFor("select 1 from room_snapshots where room_id = $1 for update", [r.roomId], DEADLINE_MS * 0.6);
    const op = await holdFor("select 1 from room_ops where room_id = $1 and seq = $2 for update", [r.roomId, r.seq], DEADLINE_MS * 1.5);
    const started = Date.now();
    await assert.rejects(writeSnapshotJson(t.pool, r.roomId, r.seq, json, true, DEADLINE_MS));
    const took = Date.now() - started;
    assert.ok(took >= DEADLINE_MS * 0.9 && took < DEADLINE_MS * 1.4, `failed at ${took} ms`);
    await Promise.all([snapshot.done, op.done]);
    assert.deepEqual(await r.row(), before, "the row and the prune went back together");
  });

  test("a checkout that takes most of the deadline leaves the statements only what is left", async () => {
    const r = await stored("Snapshot slow checkout");
    const before = await r.row();
    // The row stays locked 0.4 of the deadline past the checkout: within a deadline counted from the checkout's end.
    const snapshot = await holdFor("select 1 from room_snapshots where room_id = $1 for update", [r.roomId], DEADLINE_MS * 1.2);
    const slow: Pool = { query: t.pool.query.bind(t.pool), connect: async () => (await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 0.8)), t.pool.connect()) } as Pool;
    const started = Date.now();
    await assert.rejects(writeSnapshotJson(slow, r.roomId, r.seq, json, true, DEADLINE_MS));
    const took = Date.now() - started;
    assert.ok(took >= DEADLINE_MS * 0.9 && took < DEADLINE_MS * 1.4, `failed at ${took} ms`);
    await snapshot.done;
    assert.deepEqual(await r.row(), before);
  });

  test("a connection handed over past the deadline goes back unused", async () => {
    const r = await stored("Snapshot late checkout");
    const used: string[] = [];
    let released: boolean | undefined | "no" = "no";
    const late: Pool = {
      query: t.pool.query.bind(t.pool),
      connect: async () => {
        await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 1.3));
        const client = await t.pool.connect();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "query") return (text: string, values?: unknown[]) => (used.push(text), target.query(text, values));
            if (prop === "release") return (broken?: boolean) => ((released = broken), target.release(broken));
            return Reflect.get(target, prop, receiver);
          },
        });
      },
    } as Pool;
    const started = Date.now();
    await assert.rejects(writeSnapshotJson(late, r.roomId, r.seq, json, true, DEADLINE_MS), SnapshotWriteTimeout);
    assert.ok(Date.now() - started < DEADLINE_MS * 1.2);
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 0.5));
    assert.deepEqual(used, []);
    assert.notEqual(released, "no", "given back");
  });

  test("a statement that never answers ends at the deadline with its connection released as broken", async () => {
    const r = await stored("Snapshot stalled");
    const before = await r.row();
    let releasedBroken: boolean | undefined;
    const stalled: Pool = {
      query: t.pool.query.bind(t.pool),
      connect: async () => {
        const client = await t.pool.connect();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "query") return (text: string, values?: unknown[]) => (text.startsWith("delete from room_ops") ? new Promise(() => undefined) : target.query(text, values));
            if (prop === "release") return (broken?: boolean) => ((releasedBroken = broken), target.release(broken));
            return Reflect.get(target, prop, receiver);
          },
        }) as pg.PoolClient;
      },
    } as Pool;
    const started = Date.now();
    await assert.rejects(writeSnapshotJson(stalled, r.roomId, r.seq, json, true, DEADLINE_MS), SnapshotWriteTimeout);
    assert.ok(Date.now() - started < DEADLINE_MS * 1.2);
    assert.equal(releasedBroken, true);
    assert.deepEqual(await r.row(), before, "ending the connection ended its transaction");
  });
});
