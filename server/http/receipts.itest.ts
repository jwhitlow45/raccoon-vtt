import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { heldOpLines } from "../rooms/logHistory.ts";
import { startEngine, type Engine } from "../rooms/testing.ts";

/**
 * The receipt lookup's archive reads (log history, server stage B): an op
 * whose lines have left the live log is read by the caller's own streams
 * and the op's seq once the room's metadata is complete, by the raw query
 * while it is not, and both give the same parts. Every step on the lookup's
 * connection is bounded and stops at the request's cancel.
 */

type Lookup = { parts: ({ part: number; state: "committed"; seq: number; lines: LogEntry[] } | { part: number; state: "refused"; code: string; message: string })[] };

describe("GET /api/rooms/:id/receipts/:tag from the archive", () => {
  let t: Engine;
  const appName = `rvtt-receipts-itest-${randomBytes(4).toString("hex")}`;
  /** Runs before each statement of a lookup, for the tests that hold one. */
  let beforeQuery: ((text: string) => Promise<void>) | null = null;
  before(async () => {
    t = await startEngine({
      log: {
        migration: {
          connect: async () => {
            const c = new pg.Client({ connectionString: t.config.DATABASE_URL, application_name: appName });
            c.on("error", () => undefined);
            await c.connect();
            return c;
          },
        },
        receipts: { deadlineMs: 400, beforeQuery: (text) => beforeQuery?.(text) ?? Promise.resolve() },
      },
    });
    t.app.logMigration.start();
    for (let i = 0; i < 1_000 && !t.app.logMigration.ready; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.app.logMigration.ready, "the index is ready");
  });
  after(() => t.close());

  /** Enough chats to move an earlier op's lines out of the live log, 50 a socket so no socket's op budget slows them. */
  async function fill(roomId: string, dm: ReturnType<Engine["client"]>): Promise<void> {
    for (let s = 0; s < 5; s++) {
      const socket = await t.connect(roomId, dm);
      await socket.snapshot(uuidv7());
      for (let i = 0; i < 50; i++) await socket.apply({ t: "log.chat", text: `filler ${s}.${i}` });
      socket.close();
    }
  }

  test("an op past the live log reads the same parts by the access key as by the raw query, and only for its own member", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts archived");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    await quin.join(roomId, "Quin");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    const tag = uuidv7();
    const rolled = await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "2d6+3", label: "Longsword" }] } as Op);
    assert.ok(rolled.acks?.length);
    await fill(roomId, dm);
    const state = t.manager.get(roomId)!.committed.state;
    assert.equal(heldOpLines(state, { memberId: pipId, role: "player" }, rolled.seq), null, "the roll's lines have left the live log");
    const nulls = await t.pool.query("select 1 from room_log where room_id = $1 and seq is null", [roomId]);
    assert.equal(nulls.rowCount, 0, "this server wrote every row with its metadata");

    const indexed = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
    assert.equal(indexed.statusCode, 200, indexed.body);
    const body = indexed.json<Lookup>();
    assert.equal(body.parts.length, 1);
    const part = body.parts[0]!;
    assert.ok(part.state === "committed" && part.lines.length === 1 && part.lines[0]!.data?.type === "dice");
    assert.deepEqual((await quin.get(`/api/rooms/${roomId}/receipts/${tag}`)).json<Lookup>(), { parts: [] }, "another member's tag reads as none");

    // A row an older server wrote sends the lookup to the raw query, with the same answer.
    await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, '0:99999', now(), $2)", [roomId, JSON.stringify({ id: "0:99999", at: new Date().toISOString(), kind: "chat", from: pipId, text: "old" })]);
    const raw = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.body, indexed.body);
  });

  test("a lookup whose archive read stalls past its deadline answers busy, and its statement is stopped on the server", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts stalled");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    const tag = uuidv7();
    const rolled = await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
    await fill(roomId, dm);
    assert.equal(heldOpLines(t.manager.get(roomId)!.committed.state, { memberId: pipId, role: "player" }, rolled.seq), null);
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("lock table room_log_access in access exclusive mode");
      const started = Date.now();
      const res = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json<{ error: string }>().error, "busy");
      assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
      // The lookup's statement no longer waits on the lock: its backend was told to stop.
      let waiting = 1;
      for (let i = 0; i < 100 && waiting > 0; i++) {
        waiting = (await t.pool.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%room_log_access%'")).rowCount ?? 0;
        if (waiting > 0) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(waiting, 0);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await pip.get(`/api/rooms/${roomId}/receipts/${tag}`)).statusCode, 200, "the next lookup is served");
  });

  for (const [stage, lock] of [
    ["grant read", "lock table grants in access exclusive mode"],
    ["receipt-limit read", "lock table rate_events in access exclusive mode"],
    ["receipt charge", "lock table rate_events in share mode"],
  ] as const) test(`the deadline bounds the ${stage}, cancels SQL and frees the connection`, async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipt admission deadline");
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query(lock);
      const started = Date.now();
      const res = await dm.get(`/api/rooms/${roomId}/receipts/${uuidv7()}`);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json<{ error: string }>().error, "busy");
      assert.ok(Date.now() - started < 3_000, "bounded by the configured receipt deadline");
      assert.equal((await t.pool.query("select 1 as unrelated")).rows[0]!.unrelated, 1);
      const table = stage === "grant read" ? "grants" : "rate_events";
      let waiting = 1;
      for (let i = 0; i < 100 && waiting > 0; i++) {
        waiting = (await t.pool.query(
          "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1",
          [`%${table}%`],
        )).rowCount ?? 0;
        if (waiting > 0) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(waiting, 0, "the route's backend is no longer waiting on the lock");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await dm.get(`/api/rooms/${roomId}/receipts/${uuidv7()}`)).statusCode, 200);
  });

  test("a receipt committed while the lookup reads the rows is projected against a state that holds its op, so its lines come back", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts racing");
    const pip = t.client();
    await pip.join(roomId, "Pip");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    // The archive refuses every line, so the op's lines live in the room's live log alone.
    const assets = t.app.assets as unknown as { archiveDiskOk: () => Promise<boolean> };
    const own = Object.getOwnPropertyDescriptor(assets, "archiveDiskOk");
    assets.archiveDiskOk = () => Promise.resolve(false);
    const tag = uuidv7();
    let reached!: () => void;
    const atRows = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    beforeQuery = async (text) => {
      if (!/from roll_receipts/.test(text)) return;
      beforeQuery = null;
      reached();
      await held;
    };
    try {
      const lookup = pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      await atRows;
      // The op commits while the lookup waits to read its receipt.
      const rolled = await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
      assert.ok(rolled.acks?.length);
      release();
      const res = await lookup;
      assert.equal(res.statusCode, 200, res.body);
      const parts = res.json<Lookup>().parts;
      assert.equal(parts.length, 1);
      const part = parts[0]!;
      assert.ok(part.state === "committed" && part.seq === rolled.seq);
      assert.equal(part.state === "committed" && part.lines.length, 1, "the op's line, from the state that holds it");
    } finally {
      beforeQuery = null;
      if (own) Object.defineProperty(assets, "archiveDiskOk", own);
      else delete (assets as { archiveDiskOk?: unknown }).archiveDiskOk;
    }
  });

  test("a lookup whose receipt rows are locked answers busy at its deadline, and its statement is stopped on the server", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts locked");
    const pip = t.client();
    await pip.join(roomId, "Pip");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    const tag = uuidv7();
    await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      // A row lock would not stop a select: only a lock on the table does.
      await holder.query("lock table roll_receipts in access exclusive mode");
      const started = Date.now();
      const res = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(res.statusCode, 503, res.body);
      assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
      let waiting = 1;
      for (let i = 0; i < 100 && waiting > 0; i++) {
        waiting = (await t.pool.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from roll_receipts%'")).rowCount ?? 0;
        if (waiting > 0) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(waiting, 0, "the receipt read no longer waits on the lock");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await pip.get(`/api/rooms/${roomId}/receipts/${tag}`)).statusCode, 200);
  });
});
