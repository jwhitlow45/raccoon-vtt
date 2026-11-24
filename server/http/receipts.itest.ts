import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Socket as NetSocket } from "node:net";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { LIMITS } from "#shared/limits.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import { sortedJson } from "#shared/sortedJson.ts";
import type { LogEntry } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { heldOpLines, ReceiptLines } from "../rooms/logHistory.ts";
import { ScanCancelledError } from "../rooms/logScanBudget.ts";
import { commitBatch, pruneReceipts } from "../rooms/persistence.ts";
import { failCommits, lineNumber, startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";

/**
 * The receipt lookup's archive reads (log history, server stage B): an op
 * whose lines have left the live log is read by the caller's own streams
 * and the op's seq once the room's metadata is complete, by the raw query
 * while it is not, and both give the same parts. Every step on the lookup's
 * connection is bounded and stops at the request's cancel.
 */

type Lookup = { parts: ({ part: number; state: "committed"; seq: number; lines: LogEntry[] } | { part: number; state: "refused"; code: string; message: string })[] };

/**
 * Waits up to 2 s for no statement in `sent` to wait on a lock, and fails
 * naming every statement waiting then. Other work can wait on the same
 * lock meanwhile and is no part of the lookup: a room's quota check after
 * it stores a snapshot, or the receipt sweep, reads roll_receipts too. The
 * server shows at most the first 1023 bytes of a statement's text.
 */
async function noneWaiting(pool: pg.Pool, sent: readonly string[], what: string): Promise<void> {
  const ours = (text: string) => text !== "" && sent.some((s) => s.startsWith(text));
  let waits: string[] = [];
  for (let i = 0; i < 100; i++) {
    waits = (await pool.query<{ query: string }>("select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows.map((r) => r.query);
    if (!waits.some(ours)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`${what}. Statements waiting on a lock: ${JSON.stringify(waits)}`);
}

/** Whether each connection in the pool has the statement timeout it started with, checked once every one is idle. */
async function ownTimeouts(pool: pg.Pool): Promise<boolean[]> {
  const clients = await Promise.all(Array.from({ length: pool.totalCount }, () => pool.connect()));
  try {
    return await Promise.all(clients.map(async (c) => (await c.query<{ own: boolean }>("select setting = reset_val as own from pg_settings where name = 'statement_timeout'")).rows[0]!.own));
  } finally {
    for (const c of clients) c.release();
  }
}

/**
 * Holds back the bytes of the next statement sent from `pool` whose text
 * holds `marker`, and every write and close after it on that connection,
 * until `release`, which sends them in order and says whether it held any.
 * As far as the client knows the statement has gone, while its backend
 * still waits for it: a cancel request now reaches the backend between
 * statements, where PostgreSQL discards it, as it does when the request
 * beats a statement sent a moment before the deadline.
 */
function holdStatement(pool: pg.Pool, marker: string): { release(): Promise<boolean>; restore(): void } {
  type Held = { write: unknown[] } | { close: () => void };
  let flush: (() => Promise<void>) | null = null;
  const restores: (() => void)[] = [];
  const wrapped = new WeakSet<NetSocket>();
  const onAcquire = (client: pg.PoolClient) => {
    const stream = (client as unknown as { connection: { stream: NetSocket } }).connection.stream;
    if (wrapped.has(stream)) return;
    wrapped.add(stream);
    const own = { write: stream.write, end: stream.end, destroy: stream.destroy };
    const queue: Held[] = [];
    let holding = false;
    const unwrap = () => Object.assign(stream, own);
    const send = (args: unknown[]) => new Promise<void>((resolve) => {
      const done = args.find((a) => typeof a === "function") as ((err?: Error | null) => void) | undefined;
      (own.write as (...a: unknown[]) => boolean).call(stream, args[0], (err?: Error | null) => {
        done?.(err);
        resolve();
      });
    });
    stream.write = ((...args: unknown[]) => {
      const chunk = args[0];
      if (!holding && flush === null && Buffer.isBuffer(chunk) && chunk.includes(marker)) {
        holding = true;
        flush = async () => {
          unwrap();
          for (const item of queue) {
            if ("write" in item) await send(item.write);
            else item.close();
          }
        };
      }
      if (!holding) return (own.write as (...a: unknown[]) => boolean).apply(stream, args);
      queue.push({ write: args });
      return true;
    }) as NetSocket["write"];
    for (const name of ["end", "destroy"] as const) {
      stream[name] = ((...args: unknown[]) => {
        if (!holding) return (own[name] as (...a: unknown[]) => NetSocket).apply(stream, args);
        queue.push({ close: () => (own[name] as (...a: unknown[]) => NetSocket).apply(stream, args) });
        return stream;
      }) as never;
    }
    restores.push(() => {
      if (!holding) unwrap();
    });
  };
  pool.on("acquire", onAcquire);
  return {
    release: async () => {
      const held = flush as (() => Promise<void>) | null;
      if (!held) return false;
      await held();
      return true;
    },
    restore: () => {
      pool.off("acquire", onAcquire);
      for (const r of restores) r();
    },
  };
}

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

  /** The statements the lookups send from here until the test sets `beforeQuery` again. */
  function recordSent(): string[] {
    const sent: string[] = [];
    beforeQuery = async (text) => void sent.push(text);
    return sent;
  }

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
    assert.equal(heldOpLines(state, { memberId: pipId, role: "player" }, lineNumber(rolled)), null, "the roll's lines have left the live log");
    const nulls = await t.pool.query("select 1 from room_log where room_id = $1 and seq is null", [roomId]);
    assert.equal(nulls.rowCount, 0, "this server wrote every row with its metadata");

    const indexed = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
    assert.equal(indexed.statusCode, 200, indexed.body);
    const body = indexed.json<Lookup>();
    assert.equal(indexed.body, sortedJson(body), "the reply lists every object's keys in sorted order");
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
    assert.equal(heldOpLines(t.manager.get(roomId)!.committed.state, { memberId: pipId, role: "player" }, lineNumber(rolled)), null);
    const holder = await t.pool.connect();
    const sent = recordSent();
    try {
      await holder.query("begin");
      await holder.query("lock table room_log_access in access exclusive mode");
      const started = Date.now();
      const res = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json<{ error: string }>().error, "busy");
      assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
      assert.ok(sent.some((s) => s.includes("room_log_access")), "the lookup read by the access key");
      await noneWaiting(t.pool, sent, "the lookup's statement no longer waits on the lock: its backend was told to stop");
    } finally {
      beforeQuery = null;
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
    const sent = recordSent();
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
      assert.ok(sent.some((s) => s.includes(table)), `the route reached the ${stage}`);
      await noneWaiting(t.pool, sent, "the route's backend is no longer waiting on the lock");
    } finally {
      beforeQuery = null;
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await dm.get(`/api/rooms/${roomId}/receipts/${uuidv7()}`)).statusCode, 200);
  });

  test("a receipt committed while the lookup reads the rows is left out of it, as of its arrival, and the next lookup reads its lines from the room", async () => {
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
      assert.deepEqual(res.json<Lookup>(), { parts: [] }, "the op arrived after the lookup did");
      const next = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(next.statusCode, 200, next.body);
      const parts = next.json<Lookup>().parts;
      assert.equal(parts.length, 1);
      const part = parts[0]!;
      assert.ok(part.state === "committed" && part.seq === lineNumber(rolled));
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
    const sent = recordSent();
    try {
      await holder.query("begin");
      // A row lock would not stop a select: only a lock on the table does.
      await holder.query("lock table roll_receipts in access exclusive mode");
      const started = Date.now();
      const res = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(res.statusCode, 503, res.body);
      assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
      assert.ok(sent.some((s) => s.includes("distinct on (part)")), "the lookup sent its receipt read");
      await noneWaiting(t.pool, sent, "the receipt read no longer waits on the lock");
    } finally {
      beforeQuery = null;
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await pip.get(`/api/rooms/${roomId}/receipts/${tag}`)).statusCode, 200);
  });

  for (const [stage, lock, marker] of [
    ["receipt read", "lock table roll_receipts in access exclusive mode", "distinct on (part)"],
    ["grant read", "lock table grants in access exclusive mode", "from grants g"],
  ] as const) test(`a ${stage} whose backend has the deadline's cancel request before the statement is stopped by PostgreSQL in the time it had left, and its pool keeps no timeout`, async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts cancel lost");
    const pip = t.client();
    await pip.join(roomId, "Pip");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    const tag = uuidv7();
    await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
    const hold = holdStatement(t.pool, marker);
    const holder = await t.pool.connect();
    const sent = recordSent();
    try {
      await holder.query("begin");
      await holder.query(lock);
      const res = await pip.get(`/api/rooms/${roomId}/receipts/${tag}`);
      assert.equal(res.statusCode, 503, res.body);
      // The deadline's cancel request has gone, to a backend still waiting for the statement, which discarded it.
      assert.ok(await hold.release(), `the ${stage} was held back`);
      await noneWaiting(t.pool, sent, `the ${stage} no longer waits on the lock: PostgreSQL stopped it by itself`);
    } finally {
      beforeQuery = null;
      hold.restore();
      await holder.query("rollback");
      holder.release();
    }
    assert.equal((await pip.get(`/api/rooms/${roomId}/receipts/${tag}`)).statusCode, 200);
    assert.ok((await ownTimeouts(t.pool)).every(Boolean), "every connection back in the pool has its own statement timeout again");
  });

  test("a statement PostgreSQL stops at the deadline fails as cancelled, with no cancel request or abort to stop it", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Receipts stopped by the server");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const pipSocket = await t.connect(roomId, pip);
    await pipSocket.snapshot(uuidv7());
    const tag = uuidv7();
    await pipSocket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op);
    const { state, through } = t.manager.get(roomId)!.committed;
    // A view whose live log has lost the op's lines, so the lookup reads them from the archive.
    const view = { state: { ...state, log: [] }, through };
    const lines = new ReceiptLines({ pool: t.pool, cancel: () => Promise.resolve() });
    const never = new AbortController().signal;
    const read = (stopAt: number) => lines.withQueries(never, (q) => q.query("select 1 from roll_receipts limit 1"), stopAt);
    for (const [what, table, left, work] of [
      ["a receipt read", "roll_receipts", 200, read],
      ["a receipt read past its deadline as it goes out", "roll_receipts", -50, read],
      ["a lookup's line read", "room_log", 200, (stopAt: number) => lines.lookup(roomId, { memberId: pipId, role: "player" }, tag, never, view, Date.now() + 60_000, stopAt)],
    ] as const) {
      const holder = await t.pool.connect();
      try {
        await holder.query("begin");
        await holder.query(`lock table ${table} in access exclusive mode`);
        const started = performance.now();
        await assert.rejects(work(started + left), ScanCancelledError, what);
        assert.ok(performance.now() - started < 2_000, `${what}: stopped at its deadline, not at the client's query timeout`);
      } finally {
        await holder.query("rollback");
        holder.release();
      }
    }
  });
});

describe("GET /api/rooms/:id/receipts/:tag as of its arrival", () => {
  let t: Engine;
  /** Runs before each statement of a lookup, for the tests that hold one. */
  let beforeQuery: ((text: string) => Promise<void>) | null = null;
  before(async () => {
    t = await startEngine({ log: { receipts: { deadlineMs: 4_000, beforeQuery: (text) => beforeQuery?.(text) ?? Promise.resolve() } } });
  });
  after(() => t.close());

  type Party = { roomId: string; pip: TestClient; pipId: string; socket: Socket };
  async function party(name: string): Promise<Party> {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const socket = await t.connect(roomId, pip);
    await socket.snapshot(uuidv7());
    return { roomId, pip, pipId, socket };
  }

  const roll = (tag: string): Op => ({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] }) as Op;
  const lookup = async (p: Party, tag: string) => {
    const res = await p.pip.get(`/api/rooms/${p.roomId}/receipts/${tag}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json<Lookup>();
  };
  const seqs = (body: Lookup) => body.parts.map((part) => (part.state === "committed" ? part.seq : part.code));

  /** Holds the next lookup statement `matches` names until `release`, resolving `reached` once it waits. */
  function hold(matches: RegExp): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    beforeQuery = async (text) => {
      if (!matches.test(text)) return;
      beforeQuery = null;
      reached();
      await held;
    };
    return { reached: at, release };
  }

  /** A receipt of Pip's written straight into a table, `age` before the database's now. */
  const written = (table: "roll_receipts" | "roll_receipts_retired", p: Party, tag: string, seq: number, age: string, part = 0) =>
    t.pool.query(`insert into ${table} (room_id, member_id, tag, part, state, seq, at) values ($1, $2, $3, $4, 'committed', $5, now() - $6::interval)`, [p.roomId, p.pipId, tag, part, seq, age]);

  for (const lost of [null, "committed", "rolledBack"] as const) test(`a tag used again after its day copies its old row out once, its commit's answer ${lost ?? "kept"}`, async () => {
    const p = await party("Receipts retired");
    const tag = uuidv7();
    await written("roll_receipts", p, tag, 1, "25 hours");
    const old = (await t.pool.query<{ at: Date }>("select at from roll_receipts where room_id = $1 and tag = $2", [p.roomId, tag])).rows[0]!.at;
    const failing = lost === null ? null : failCommits(t.pool, [lost]);
    try {
      const rolled = await p.socket.apply(roll(tag));
      assert.ok(rolled.acks?.length, "the reuse is taken");
    } finally {
      failing?.restore();
    }
    const retired = await t.pool.query<{ seq: string; at: Date }>("select seq::text, at from roll_receipts_retired where room_id = $1 and tag = $2", [p.roomId, tag]);
    assert.deepEqual(retired.rows.map((r) => [r.seq, r.at.toISOString()]), [["1", old.toISOString()]], "the old row, once");
    const live = await t.pool.query<{ seq: string; at: Date }>("select seq::text, at from roll_receipts where room_id = $1 and tag = $2", [p.roomId, tag]);
    assert.equal(live.rows.length, 1);
    assert.ok(live.rows[0]!.at > old, "the new row replaced it");
    // A batch written again finds its own row in place, not older, and copies nothing.
    const again = { memberId: p.pipId, tag, part: 0, state: "committed" as const, seq: Number(live.rows[0]!.seq), code: null, message: null, at: live.rows[0]!.at.toISOString() };
    await commitBatch(t.pool, p.roomId, { ops: [], watermarks: [], receipts: [again] });
    assert.equal((await t.pool.query("select 1 from roll_receipts_retired where room_id = $1 and tag = $2", [p.roomId, tag])).rowCount, 1);
  });

  for (const lost of [null, "committed"] as const) test(`a lookup held from before a tag's reuse answers as one that ran before it, its commit's answer ${lost ?? "kept"}`, async () => {
    const p = await party("Receipts reused");
    const first = await p.socket.apply(roll(uuidv7()));
    const oldSeq = lineNumber(first);
    const tag = uuidv7();
    await written("roll_receipts", p, tag, oldSeq, "25 hours");
    const before = await lookup(p, tag);
    assert.deepEqual(seqs(before), [oldSeq]);
    const held = hold(/from roll_receipts/);
    const waiting = lookup(p, tag);
    await held.reached;
    const failing = lost === null ? null : failCommits(t.pool, [lost]);
    let newSeq: number;
    try {
      newSeq = lineNumber(await p.socket.apply(roll(tag)));
    } finally {
      failing?.restore();
    }
    held.release();
    assert.deepEqual(await waiting, before, "the same answer: the newest row before its tick");
    assert.deepEqual(seqs(await lookup(p, tag)), [newSeq], "a lookup after the reuse finds the new receipt");
  });

  test("a receipt read someone else cancels while the lookup has time left answers that error, not busy", async () => {
    const p = await party("Receipts cancelled by hand");
    const tag = uuidv7();
    await p.socket.apply(roll(tag));
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("lock table roll_receipts in access exclusive mode");
      const answer = p.pip.get(`/api/rooms/${p.roomId}/receipts/${tag}`);
      let pid: number | undefined;
      for (let i = 0; i < 100 && pid === undefined; i++) {
        pid = (await t.pool.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select distinct on (part)%'")).rows[0]?.pid;
        if (pid === undefined) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(pid !== undefined, "the receipt read waits on the lock");
      // As an operator's pg_cancel_backend would, with most of the lookup's 4 s left: no deadline of this request stopped it.
      await t.pool.query("select pg_cancel_backend($1)", [pid]);
      const res = await answer;
      assert.equal(res.statusCode, 500, res.body);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    await lookup(p, tag);
  });

  test("a lookup held across the sweep answers as one the sweep never met: unknown past 7 days, found inside them", async () => {
    const p = await party("Receipts swept");
    const tags = { far: uuidv7(), lagging: uuidv7(), inside: uuidv7() };
    const plant = async () => {
      await written("roll_receipts", p, tags.far, 1, "7 days 2 hours");
      await written("roll_receipts", p, tags.lagging, 1, "7 days 30 minutes");
      // Inside its 7 days by a second as the lookup arrives, and past them by the time the held lookup reads.
      await written("roll_receipts", p, tags.inside, 1, "7 days -1 second");
    };
    await plant();
    const quiet = { far: await lookup(p, tags.far), lagging: await lookup(p, tags.lagging), inside: await lookup(p, tags.inside) };
    assert.deepEqual([seqs(quiet.far), seqs(quiet.lagging), seqs(quiet.inside)], [[], [], [1]]);
    await t.pool.query("delete from roll_receipts where room_id = $1", [p.roomId]);
    await plant();
    const answers: Lookup[] = [];
    for (const tag of [tags.far, tags.lagging, tags.inside]) {
      const held = hold(/from grants g/);
      const waiting = lookup(p, tag);
      await held.reached;
      if (tag === tags.inside) await new Promise((r) => setTimeout(r, 1_500));
      await pruneReceipts(t.pool);
      held.release();
      answers.push(await waiting);
    }
    assert.deepEqual(answers, [quiet.far, quiet.lagging, quiet.inside]);
  });

  test("receipts sharing one time at their 7-day line answer alike: unknown at it, found a millisecond inside", async () => {
    const p = await party("Receipts tied");
    const own = t.manager.arrivalTick.bind(t.manager);
    let tick = 0;
    t.manager.arrivalTick = (at: number) => (tick = own(at));
    try {
      for (const [inside, expected] of [[0, []], [1, [1, 1, 1, 1, 1, 1]]] as const) {
        const tag = uuidv7();
        beforeQuery = async (text) => {
          if (!/from roll_receipts/.test(text)) return;
          beforeQuery = null;
          const at = new Date(tick - LIMITS.receiptDays * 86_400_000 + inside).toISOString();
          await t.pool.query("insert into roll_receipts (room_id, member_id, tag, part, state, seq, at) select $1, $2, $3, g, 'committed', 1, $4 from generate_series(0, 5) g", [p.roomId, p.pipId, tag, at]);
        };
        assert.deepEqual(seqs(await lookup(p, tag)), expected, `${inside} ms inside the line`);
      }
    } finally {
      t.manager.arrivalTick = own;
    }
  });

  test("receipts a day and six days old answer committed with their lines, and one past its 7 days unknown", async () => {
    const p = await party("Receipts older");
    const tag = uuidv7();
    const rolled = await p.socket.apply(roll(tag));
    const seq = lineNumber(rolled);
    for (const age of ["25 hours", "6 days"]) {
      await t.pool.query("update roll_receipts set at = now() - $3::interval where room_id = $1 and tag = $2", [p.roomId, tag, age]);
      const body = await lookup(p, tag);
      assert.deepEqual(seqs(body), [seq], age);
      const part = body.parts[0]!;
      assert.ok(part.state === "committed" && part.lines.length === 1 && part.lines[0]!.data?.type === "dice", `${age}: with its line`);
    }
    await t.pool.query("update roll_receipts set at = now() - interval '7 days 1 minute' where room_id = $1 and tag = $2", [p.roomId, tag]);
    assert.deepEqual(await lookup(p, tag), { parts: [] });
  });

  test("lookups that wait through their room's load answer by each receipt's own time as of their arrival, and the load reads the day's rows alone", async () => {
    const p = await party("Receipts through a load");
    const tags = { day: uuidv7(), week: uuidv7(), young: uuidv7() };
    // Inside 24 hours and inside 7 days by a second and a half as the lookups arrive, and past both once they read.
    await written("roll_receipts", p, tags.day, 1, "24 hours -1500 milliseconds");
    await written("roll_receipts", p, tags.week, 1, "7 days -1500 milliseconds");
    await written("roll_receipts", p, tags.young, 1, "1 hour");
    await written("roll_receipts", p, uuidv7(), 1, "10 days");
    await written("roll_receipts_retired", p, uuidv7(), 1, "10 days");
    await t.restart();
    const holder = await t.pool.connect();
    await holder.query("begin");
    await holder.query("lock table room_snapshots in access exclusive mode");
    const waiting = [lookup(p, tags.day), lookup(p, tags.week)];
    await new Promise((r) => setTimeout(r, 2_500));
    await holder.query("rollback");
    holder.release();
    assert.deepEqual((await Promise.all(waiting)).map(seqs), [[1], [1]]);
    assert.equal(t.manager.get(p.roomId)!.receiptCounts().room, 1, "the day's receipt alone in memory");
  });

  test("after a replay that stopped short, a committed receipt past it answers busy and one inside it is read", async () => {
    const p = await party("Receipts short replay");
    const kept = uuidv7();
    const seq = lineNumber(await p.socket.apply(roll(kept)));
    await t.restart();
    const { rows } = await t.pool.query<{ seq: string; pub: string }>("select max(seq)::text as seq, (select pub::text from rooms where id = $1) as pub from room_ops where room_id = $1", [p.roomId]);
    const next = Math.max(Number(rows[0]!.seq ?? 0), await snapshotSeq(p.roomId)) + 1;
    const pub = Number(rows[0]!.pub) + 1;
    await t.pool.query("insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version, pub) values ($1, $2, now(), $3, 'player', $4, $5, $6)", [p.roomId, next, p.pipId, JSON.stringify({ t: "token.delete", tokenId: "missing" }), OP_VERSION, pub]);
    const past = uuidv7();
    await written("roll_receipts", p, past, pub, "1 minute");
    assert.equal((await t.manager.acquire(p.roomId)).replayFailed, true);
    const busy = await p.pip.get(`/api/rooms/${p.roomId}/receipts/${past}`);
    assert.equal(busy.statusCode, 503, busy.body);
    assert.equal(busy.headers["retry-after"], "1");
    assert.deepEqual(seqs(await lookup(p, kept)), [seq]);
  });

  async function snapshotSeq(roomId: string): Promise<number> {
    return Number((await t.pool.query<{ seq: string }>("select seq::text from room_snapshots where room_id = $1", [roomId])).rows[0]?.seq ?? 0);
  }
});
