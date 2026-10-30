import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { heldOpLines, ReceiptLines } from "../rooms/logHistory.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";
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
        receipts: { deadlineMs: 400 },
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
});

/** A connection whose answers a test controls: pending queries fail when it is destroyed, as a real one's do. */
class Fake extends EventEmitter {
  readonly steps: string[] = [];
  hang = false;
  fail = false;
  #pending: ((err: Error) => void)[] = [];
  query(config: { text: string }): Promise<{ rows: unknown[] }> {
    this.steps.push(config.text.trim().split(/\s+/).slice(0, 2).join(" "));
    if (this.fail) return Promise.reject(new Error("statement failed"));
    if (this.hang) return new Promise((_resolve, reject) => this.#pending.push(reject));
    return Promise.resolve({ rows: [] });
  }
  release(destroy?: boolean): void {
    this.steps.push(destroy ? "destroy" : "release");
    if (destroy) for (const reject of this.#pending.splice(0)) reject(new Error("Connection terminated"));
  }
}

describe("a receipt lookup's connection, every step bounded and cancellable", () => {
  const viewer = { memberId: "p1", role: "player" as const };

  test("a checkout the pool does not give in time fails busy, and a connection handed over after is destroyed", async () => {
    let hand!: (c: Fake) => void;
    const lines = new ReceiptLines({ pool: { connect: () => new Promise((resolve) => (hand = resolve as never)) } as never, checkoutMs: 50 });
    const started = Date.now();
    await assert.rejects(lines.read("ROOM", [1], viewer, new AbortController().signal), ScanBusyError);
    assert.ok(Date.now() - started < 1_000);
    const late = new Fake();
    hand(late);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(late.steps, ["destroy"], "nothing runs on it");
  });

  test("a cancel during a checkout ends the wait at once", async () => {
    const abort = new AbortController();
    const lines = new ReceiptLines({ pool: { connect: () => new Promise(() => undefined) } as never, checkoutMs: 60_000 });
    const reading = lines.read("ROOM", [1], viewer, abort.signal);
    abort.abort(new Error("client went away"));
    await assert.rejects(reading, ScanCancelledError);
  });

  test("a cancel during a statement sends the backend a cancel request, then destroys the connection, with no more SQL", async () => {
    const conn = new Fake();
    conn.hang = true;
    const order: string[] = [];
    const lines = new ReceiptLines({
      pool: { connect: () => Promise.resolve(conn) } as never,
      cancel: async () => {
        order.push(`cancel after ${conn.steps.join(",")}`);
      },
    });
    const abort = new AbortController();
    const reading = lines.read("ROOM", [1, 2], viewer, abort.signal);
    await new Promise((r) => setImmediate(r));
    abort.abort(new Error("deadline"));
    await assert.rejects(reading, ScanCancelledError);
    assert.deepEqual(order, ["cancel after select entry"], "the cancel request first, before the connection goes");
    assert.deepEqual(conn.steps, ["select entry", "destroy"]);
  });

  test("a failed statement destroys the connection after a cancel request, and a lookup that ends well returns it", async () => {
    const conn = new Fake();
    conn.fail = true;
    let cancels = 0;
    const lines = new ReceiptLines({ pool: { connect: () => Promise.resolve(conn) } as never, cancel: async () => void cancels++ });
    await assert.rejects(lines.read("ROOM", [1], viewer, new AbortController().signal), /statement failed/);
    assert.deepEqual(conn.steps, ["select entry", "destroy"]);
    assert.equal(cancels, 1);
    const good = new Fake();
    const ok = new ReceiptLines({ pool: { connect: () => Promise.resolve(good) } as never });
    assert.deepEqual([...(await ok.read("ROOM", [1, 1, 2], viewer, new AbortController().signal)).keys()], [1, 2]);
    assert.deepEqual(good.steps, ["select entry", "select entry", "release"]);
  });
});
