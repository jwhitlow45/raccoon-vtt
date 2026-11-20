import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "./app.ts";
import { ipKey } from "./auth/ipKey.ts";
import { testConfig } from "./auth/testing.ts";
import { sha256 } from "./auth/tokens.ts";
import { applySchema } from "./db.ts";
import { randomIp, Socket, TestClient } from "./rooms/testing.ts";
import { closeServer, shutDown } from "./shutdown.ts";

/**
 * A deploy's shutdown with sockets open (design 15.4, LP5-OPS-3): every
 * socket's session gets its last sight stamped, a slow client's included,
 * and nothing writes through the pool after it ends. The app here has a
 * pool of its own, which the shutdown ends, and a second pool checks the
 * rows and cleans up. The last test stops `server/main.ts` in a process of
 * its own, as a deploy does, so its exit code and time are the real ones.
 */

/** A pool whose queries go to `answer` first: one it answers, failed or held, never reaches the database. */
function poolWith(answer: (text: string, values: unknown[] | undefined) => Promise<never> | null): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
  const query = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<unknown>;
  pool.query = ((text: string, values?: unknown[]) => answer(text, values) ?? query(text, values)) as typeof pool.query;
  return pool;
}

/** Whether a pool query writes the snapshot of `roomId`. */
const snapshotOf = (roomId: string, text: string, values: unknown[] | undefined): boolean =>
  text.trimStart().startsWith("insert into room_snapshots") && values?.[0] === roomId;

/** Two rooms on `on`, each with a DM socket open and a change since its snapshot, ready for a stop. */
async function twoRooms(on: FastifyInstance): Promise<{ ids: [string, string]; sockets: Socket[]; lastSeq(roomId: string): Promise<number>; snapshotSeq(roomId: string): Promise<number | null> }> {
  const seqOf = async (sql: string, roomId: string): Promise<number | null> => (await check.query<{ seq: number | null }>(sql, [roomId])).rows[0]?.seq ?? null;
  const lastSeq = async (roomId: string) => (await seqOf("select max(seq)::int as seq from room_ops where room_id = $1", roomId)) ?? 0;
  const snapshotSeq = (roomId: string) => seqOf("select seq::int from room_snapshots where room_id = $1", roomId);
  const sockets: Socket[] = [];
  const ids: string[] = [];
  for (const name of ["Lost", "Kept"]) {
    const dm = client(() => on);
    const { roomId } = await dm.createRoom(name);
    const socket = await connect(roomId, dm, on);
    sockets.push(socket);
    await socket.apply({ t: "log.chat", text: `${name} before the stop` });
    assert.ok(((await snapshotSeq(roomId)) ?? -1) < (await lastSeq(roomId)), "the room's snapshot is behind its last op before the stop");
    ids.push(roomId);
  }
  return { ids: ids as [string, string], sockets, lastSeq, snapshotSeq };
}

/** Asserts `closing` fails naming only `rooms` as lost. */
async function losesOnly(closing: Promise<void>, rooms: Array<{ roomId: string; why: string }>): Promise<void> {
  await assert.rejects(closing, (err: { failures?: unknown }) => {
    assert.deepEqual(err.failures, [{ step: "rooms", reason: `${rooms.length} not saved`, rooms }]);
    return true;
  });
}

const config = testConfig({ TRUST_CF_CONNECTING_IP: "1" });
const userAgent = `raccoon-shutdown-itest/${randomBytes(6).toString("hex")}`;
let assetDir: string;
let appPool: pg.Pool;
let check: pg.Pool;
let app: FastifyInstance;
const rooms: string[] = [];
const ips: string[] = [];
let startedAt: Date;

before(async () => {
  assetDir = await mkdtemp(join(tmpdir(), "rvtt-shutdown-"));
  appPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
  check = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
  await applySchema(check);
  startedAt = (await check.query<{ now: Date }>("select now()")).rows[0]!.now;
  app = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool: appPool, ws: { closeGraceMs: 300 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

after(async () => {
  await check.query("delete from rooms where id = any($1::text[])", [rooms]);
  await check.query("delete from sessions where user_agent = $1", [userAgent]);
  const fragments = [...rooms, ...ips.map(ipKey)];
  await check.query("delete from rate_events where exists (select 1 from unnest($1::text[]) f where position(f in key) > 0)", [fragments]);
  await check.query("delete from rate_events where key = 'create:site' and at >= $1", [startedAt]);
  await check.end();
  await rm(assetDir, { recursive: true, force: true });
});

function client(on: () => FastifyInstance = () => app): TestClient {
  const ip = randomIp();
  ips.push(ip);
  return new TestClient(on, ip, userAgent, (roomId) => rooms.push(roomId));
}

async function connect(roomId: string, who: TestClient, on: FastifyInstance = app): Promise<Socket> {
  const address = on.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const socket = await Socket.open(`ws://127.0.0.1:${port}/ws?room=${roomId}`, {
    origin: config.publicOrigin,
    cookie: `rvtt=${who.token}`,
    "cf-connecting-ip": who.ip,
    "user-agent": userAgent,
  });
  await socket.snapshot(randomBytes(8).toString("hex"));
  return socket;
}

test("a shutdown with sockets open stamps every session's last sight, a slow client's too, and never writes after the pool ends", async () => {
  const dm = client();
  const player = client();
  const { roomId } = await dm.createRoom("Shutdown");
  await player.join(roomId, "Pip");
  const dmSocket = await connect(roomId, dm);
  const playerSocket = await connect(roomId, player);

  const hashes = [sha256(dm.token ?? ""), sha256(player.token ?? "")];
  await check.query("update sessions set last_seen_at = now() - interval '1 hour' where token_hash = any($1)", [hashes]);

  // The test config turns logging off, and the rooms log through the app's logger.
  const logged: string[] = [];
  const log = app.log as unknown as Record<"warn" | "error", (obj: unknown, msg?: string) => void>;
  for (const level of ["warn", "error"] as const) {
    log[level] = (obj, msg) => logged.push(`${msg ?? ""} ${JSON.stringify(obj)}`);
  }

  // The player's phone is slow to answer the close: it reads nothing until the server cuts it off.
  (playerSocket.ws as unknown as { _socket: NetSocket })._socket.pause();

  const started = Date.now();
  await closeServer(app, () => appPool.end());
  assert.ok(Date.now() - started < 10_000, "the slow client is cut off, not waited out");

  const { rows } = await check.query<{ fresh: boolean }>(
    "select last_seen_at > now() - interval '1 minute' as fresh from sessions where token_hash = any($1)",
    [hashes],
  );
  assert.deepEqual(
    rows.map((r) => r.fresh),
    [true, true],
    "both sessions were seen as their sockets closed",
  );
  assert.deepEqual(
    logged.filter((line) => /pool after calling end|last seen update failed/.test(line)),
    [],
  );
  dmSocket.ws.terminate();
  playerSocket.ws.terminate();
});

test("a shutdown during a log backfill batch stops it: the backend is told to stop, its connection and locks are gone, and the close is bounded", async () => {
  const tag = `rvtt-shutdown-logb-${randomBytes(4).toString("hex")}`;
  const ownPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
  let reached!: () => void;
  const inBatch = new Promise<void>((r) => (reached = r));
  const logApp = await buildApp({
    config: { ...config, ASSET_DIR: assetDir },
    pool: ownPool,
    log: {
      migration: {
        connect: async () => {
          const c = new pg.Client({ connectionString: config.DATABASE_URL, application_name: tag });
          c.on("error", () => undefined);
          await c.connect();
          return c;
        },
        batchRows: 20,
        onStep: async (step, signal) => {
          // The first batch holds its turn here, rows read and not yet completed, until the shutdown cancels it.
          if (step.kind === "batch") {
            reached();
            await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
          }
        },
      },
    },
  });
  await logApp.listen({ port: 0, host: "127.0.0.1" });
  const dm = new TestClient(() => logApp, randomIp(), userAgent, (roomId) => rooms.push(roomId));
  ips.push(dm.ip);
  const { roomId } = await dm.createRoom("Backfill at shutdown");
  // Rows an older server wrote, with no metadata, so a read queues the room for the backfill.
  await check.query(
    `insert into room_log (room_id, id, at, entry)
     select $1, g || ':0', now(), jsonb_build_object('id', g || ':0', 'at', now()::text, 'kind', 'chat', 'from', 'nobody', 'text', 'old ' || g)
     from generate_series(100, 160) g`,
    [roomId],
  );
  logApp.logMigration.start();
  for (let i = 0; i < 500 && !logApp.logMigration.ready; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(logApp.logMigration.ready);
  const page = await dm.get(`/api/rooms/${roomId}/log?limit=5`);
  assert.equal(page.statusCode, 200, page.body);
  await inBatch;
  const held = await check.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = $1 and datname = current_database()", [tag]);
  assert.equal(held.rows[0]!.n, 1, "the backfill's own connection");

  const started = Date.now();
  await closeServer(logApp, () => ownPool.end());
  assert.ok(Date.now() - started < 5_000, "bounded");
  let left = { backends: 1, locks: 1 };
  for (let i = 0; i < 100 && (left.backends > 0 || left.locks > 0); i++) {
    const { rows } = await check.query<{ backends: number; locks: number }>(
      `select (select count(*)::int from pg_stat_activity where application_name = $1 and datname = current_database()) as backends,
              (select count(*)::int from pg_locks where locktype = 'advisory' and classid::bigint = $2
                 and database = (select oid from pg_database where datname = current_database())) as locks`,
      [tag, 0x52565455],
    );
    left = rows[0]!;
    if (left.backends > 0 || left.locks > 0) await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(left, { backends: 0, locks: 0 }, "no backend or room lock of the backfill outlives the shutdown");
  const nulls = await check.query<{ n: number }>("select count(*)::int as n from room_log where room_id = $1 and seq is null", [roomId]);
  assert.equal(nulls.rows[0]!.n, 61, "the cut batch completed nothing");
});

test("a stop whose snapshot write fails for one room still saves the other, then fails naming the room it lost (LP44-OPS-1)", async () => {
  let failing = "";
  const pool = poolWith((text, values) => (snapshotOf(failing, text, values) ? Promise.reject(new Error("could not extend file: No space left on device")) : null));
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { ids, sockets, lastSeq, snapshotSeq } = await twoRooms(own);
  try {
    const [lost, kept] = ids;
    failing = lost;
    await losesOnly(
      closeServer(own, () => pool.end()),
      [{ roomId: lost, why: "snapshot not written" }],
    );
    assert.equal(await snapshotSeq(kept), await lastSeq(kept), "the other room saved at its last op");
  } finally {
    for (const socket of sockets) socket.ws.terminate();
  }
});

test("a stop whose snapshot write for one room never ends still saves the other, then fails at the rooms' deadline naming the room it lost (LP44-OPS-1)", async () => {
  let stuck = "";
  const pool = poolWith((text, values) => (snapshotOf(stuck, text, values) ? new Promise<never>(() => undefined) : null));
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 }, rooms: { closeTimeoutMs: 500 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { ids, sockets, lastSeq, snapshotSeq } = await twoRooms(own);
  try {
    const [lost, kept] = ids;
    stuck = lost;
    const started = Date.now();
    await losesOnly(
      closeServer(own, () => pool.end()),
      [{ roomId: lost, why: "timed out" }],
    );
    assert.ok(Date.now() - started < 5_000, "bounded by the rooms' deadline");
    assert.equal(await snapshotSeq(kept), await lastSeq(kept), "the other room saved at its last op");
  } finally {
    for (const socket of sockets) socket.ws.terminate();
  }
});

test("a stop whose room's unload throws still saves the other room, then fails naming the room it lost (LP44-OPS-1)", async () => {
  const pool = poolWith(() => null);
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { ids, sockets, lastSeq, snapshotSeq } = await twoRooms(own);
  try {
    const [lost, kept] = ids;
    const actor = await own.rooms.acquire(lost);
    actor.shutdown = () => Promise.reject(new Error("the room's state would not serialize"));
    await losesOnly(
      closeServer(own, () => pool.end()),
      [{ roomId: lost, why: "unload failed" }],
    );
    assert.equal(await snapshotSeq(kept), await lastSeq(kept), "the other room saved at its last op");
  } finally {
    for (const socket of sockets) socket.ws.terminate();
  }
});

test("a stop whose sockets' last-sight writes fail saves both rooms, then fails naming the writes (LP44-OPS-1)", async () => {
  let failing = false;
  const pool = poolWith((text) => (failing && text.startsWith("update sessions set last_seen_at") ? Promise.reject(new Error("the sessions table is locked")) : null));
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { ids, sockets, lastSeq, snapshotSeq } = await twoRooms(own);
  try {
    failing = true;
    await assert.rejects(closeServer(own, () => pool.end()), (err: { failures?: unknown }) => {
      assert.deepEqual(err.failures, [{ step: "socket writes", reason: "0 left running, 2 failed" }]);
      return true;
    });
    for (const roomId of ids) assert.equal(await snapshotSeq(roomId), await lastSeq(roomId), "each room saved at its last op");
  } finally {
    for (const socket of sockets) socket.ws.terminate();
  }
});

test("a stop that begins while a periodic snapshot is being written leaves the room's snapshot at its last commit and exits 0 (LP44-OPS-1)", async () => {
  // The room's first snapshot write is held until the stop has begun, so the stop meets it in flight, an older commit's.
  let roomId = "";
  let held: { seq: number; release(): void } | null = null;
  let heldStarted!: () => void;
  const started = new Promise<void>((resolve) => (heldStarted = resolve));
  const pool = poolWith((text, values) => {
    if (held || !snapshotOf(roomId, text, values)) return null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    held = { seq: Number(values?.[1]), release };
    heldStarted();
    return gate.then(() => pool.query(text, values)) as Promise<never>;
  });
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 }, rooms: { actor: { snapshotOps: 1 } } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const dm = client(() => own);
  roomId = (await dm.createRoom("Periodic")).roomId;
  const socket = await connect(roomId, dm, own);
  try {
    await socket.apply({ t: "log.chat", text: "The first change, whose snapshot is held." });
    await started;
    await socket.apply({ t: "log.chat", text: "A change after it." });
    const lastSeq = (await check.query<{ seq: number }>("select max(seq)::int as seq from room_ops where room_id = $1", [roomId])).rows[0]!.seq;
    assert.ok(held!.seq < lastSeq, `the write in flight holds seq ${held!.seq}, an older commit than ${lastSeq}`);

    const actor = await own.rooms.acquire(roomId);
    const codes: number[] = [];
    const stopping = shutDown(own, () => pool.end(), { exit: (code) => codes.push(code) });
    // Released only once the room is stopping, so its stop meets the write still in flight.
    for (let i = 0; i < 500 && !actor.closed; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(actor.closed, "the room is stopping");
    await new Promise((r) => setTimeout(r, 50));
    held!.release();
    await stopping;
    assert.deepEqual(codes, [0], "the stop exits 0");
    const stored = (await check.query<{ seq: number }>("select seq::int from room_snapshots where room_id = $1", [roomId])).rows[0]?.seq;
    assert.equal(stored, lastSeq, "the room's snapshot is at its last commit");
  } finally {
    socket.ws.terminate();
  }
});

/** A deferred: a promise and what settles it. */
function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(err: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A room on `on` with its DM's socket open and a change since its snapshot. */
async function roomWithChange(on: FastifyInstance, name: string): Promise<{ roomId: string; dm: TestClient; socket: Socket }> {
  const dm = client(() => on);
  const { roomId } = await dm.createRoom(name);
  const socket = await connect(roomId, dm, on);
  await socket.apply({ t: "log.chat", text: `${name} before the stop` });
  return { roomId, dm, socket };
}

test("a delete that unloaded its room and then fails while the server stops leaves the room unsaved, and the stop names it (LP44-OPS-1)", async () => {
  let doomed = "";
  const held = deferred();
  const deleteAnswer = deferred<never>();
  const pool = poolWith((text, values) => {
    if (!text.startsWith("delete from rooms where id = $1") || values?.[0] !== doomed) return null;
    held.resolve();
    return deleteAnswer.promise;
  });
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { roomId, dm, socket } = await roomWithChange(own, "Doomed");
  try {
    doomed = roomId;
    // The DM's delete has unloaded the room, with no snapshot, and waits on the database when the stop comes.
    const asked = dm.delete(`/api/rooms/${roomId}`, { name: "Doomed" }).catch(() => undefined);
    await held.promise;
    const roomsClosing = deferred();
    const close = own.rooms.close.bind(own.rooms);
    own.rooms.close = () => {
      const closing = close();
      roomsClosing.resolve();
      return closing;
    };
    const stopping = closeServer(own, () => pool.end());
    await roomsClosing.promise;
    deleteAnswer.reject(new Error("canceling statement due to statement timeout"));
    await losesOnly(stopping, [{ roomId, why: "delete failed" }]);
    await asked;
    assert.equal((await check.query("select 1 from rooms where id = $1", [roomId])).rowCount, 1, "the room is still there");
  } finally {
    socket.ws.terminate();
  }
});

test("a delete that fails during the sockets' grace, before the rooms close, still leaves the room named unsaved (OPS-SOL-4)", async () => {
  let doomed = "";
  const held = deferred();
  const deleteAnswer = deferred<never>();
  const pool = poolWith((text, values) => {
    if (!text.startsWith("delete from rooms where id = $1") || values?.[0] !== doomed) return null;
    held.resolve();
    return deleteAnswer.promise;
  });
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 1_000 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const lost = await roomWithChange(own, "Doomed");
  const kept = await roomWithChange(own, "Kept");
  try {
    doomed = lost.roomId;
    const asked = lost.dm.delete(`/api/rooms/${lost.roomId}`, { name: "Doomed" }).catch(() => undefined);
    await held.promise;
    // A phone slow to answer the close holds the sockets' grace open for its whole second.
    (kept.socket.ws as unknown as { _socket: NetSocket })._socket.pause();
    let roomsClosing = false;
    const close = own.rooms.close.bind(own.rooms);
    own.rooms.close = () => {
      roomsClosing = true;
      return close();
    };
    const stopping = closeServer(own, () => pool.end());
    await new Promise((r) => setTimeout(r, 100));
    deleteAnswer.reject(new Error("canceling statement due to statement timeout"));
    await asked;
    assert.equal(roomsClosing, false, "the delete failed before the rooms began to close");
    await losesOnly(stopping, [{ roomId: lost.roomId, why: "delete failed" }]);
  } finally {
    lost.socket.ws.terminate();
    kept.socket.ws.terminate();
  }
});

test("a delete that lands while the server stops a room leaves it deleted, and the stop exits 0 (LP44-OPS-1)", async () => {
  let watched = "";
  const deleted = deferred();
  // The stop's check of the room waits for the delete, so the room's row is gone when the stop reads it.
  const pool = poolWith((text, values) => {
    // The stop's read of the room's stored snapshot, not the quota check of its snapshot write, which the delete waits behind.
    if (!watched || values?.[0] !== watched || !text.includes("select seq::text from room_snapshots where room_id = $1")) return null;
    watched = "";
    return deleted.promise.then(() => pool.query(text, values)) as Promise<never>;
  });
  const own = await buildApp({ config: { ...config, ASSET_DIR: assetDir }, pool, ws: { closeGraceMs: 300 } });
  await own.listen({ port: 0, host: "127.0.0.1" });
  const { roomId, socket } = await roomWithChange(own, "Gone");
  try {
    const actor = await own.rooms.acquire(roomId);
    watched = roomId;
    const codes: number[] = [];
    const stopping = shutDown(own, () => pool.end(), { exit: (code) => codes.push(code) });
    for (let i = 0; i < 500 && !actor.closed; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(actor.closed, "the stop is unloading the room");
    // A delete request already past the server's close reaches the gateway now.
    assert.equal(await own.gateway.deleteRoom(roomId), true);
    deleted.resolve();
    await stopping;
    assert.deepEqual(codes, [0], "the stop exits 0");
    assert.equal((await check.query("select 1 from rooms where id = $1", [roomId])).rowCount, 0, "the room is deleted");
  } finally {
    socket.ws.terminate();
  }
});

/** A port that was free a moment ago, for a server in a process of its own. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a deploy's stop of the real server with a DM and a player on exits 0 within 5 s and saves the room at its last op (LP44-OPS-1)", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "development",
      DATABASE_URL: config.DATABASE_URL,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
      ASSET_DIR: join(assetDir, "server"),
      TRUST_CF_CONNECTING_IP: "1",
      ROOMS_PER_DAY: "1000000",
      ROOMS_PER_IP_PER_DAY: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // Ended in the finally, so a failed assertion never keeps the test file running.
  const ends: Array<{ terminate?(): void; destroy?(): void }> = [];
  try {
    for (const deadline = Date.now() + 20_000; !/listening/i.test(output); await sleep(50)) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the server did not start:\n${output}`);
    }

    // A device keeps its own address and cookie, as a browser does.
    const device = () => {
      const ip = randomIp();
      ips.push(ip);
      let cookie = "";
      const headers = (): Record<string, string> => ({ origin, "sec-fetch-site": "same-origin", "cf-connecting-ip": ip, "user-agent": userAgent, ...(cookie ? { cookie } : {}) });
      return {
        headers,
        async call(method: string, path: string, body?: unknown): Promise<Response> {
          const res = await fetch(`${origin}${path}`, {
            method,
            headers: { ...headers(), ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          });
          const session = res.headers.getSetCookie().find((c) => c.startsWith("rvtt="));
          if (session) cookie = session.split(";")[0] ?? "";
          return res;
        },
      };
    };
    const dm = device();
    const player = device();
    const created = await dm.call("POST", "/api/rooms", { name: "Stop", playerPassword: "owlbear-druid-wand", dmName: "Dungeon Master" });
    assert.equal(created.status, 201, await created.clone().text());
    const { roomId } = (await created.json()) as { roomId: string };
    rooms.push(roomId);
    const asked = await player.call("POST", `/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
    assert.equal(asked.status, 200, await asked.clone().text());
    const { ticket } = (await asked.json()) as { ticket: string };
    assert.equal((await player.call("POST", `/api/rooms/${roomId}/join/complete`, { ticket, name: "Pip", color: "#3e8ef7" })).status, 200);

    const wsUrl = `ws://127.0.0.1:${port}/ws?room=${roomId}`;
    const dmSocket = await Socket.open(wsUrl, dm.headers());
    ends.push(dmSocket.ws);
    await dmSocket.snapshot(randomBytes(8).toString("hex"));
    const playerSocket = await Socket.open(wsUrl, player.headers());
    ends.push(playerSocket.ws);
    await playerSocket.snapshot(randomBytes(8).toString("hex"));
    for (const text of ["The door creaks.", "Roll initiative.", "Pip goes first."]) {
      const ev = await dmSocket.apply({ t: "log.chat", text });
      assert.equal(ev.rejects?.length ?? 0, 0);
    }
    const seqOf = async (sql: string): Promise<number | null> => (await check.query<{ seq: number | null }>(sql, [roomId])).rows[0]?.seq ?? null;
    const lastSeq = await seqOf("select max(seq)::int as seq from room_ops where room_id = $1");
    assert.ok(lastSeq !== null && ((await seqOf("select seq::int from room_snapshots where room_id = $1")) ?? -1) < lastSeq, "the room's snapshot is behind its last op before the stop");

    // The player's phone is slow: it reads nothing until the server cuts it off, and it is part way through sending a token picture.
    (playerSocket.ws as unknown as { _socket: NetSocket })._socket.pause();
    const upload = createConnection(port, "127.0.0.1");
    ends.push(upload);
    upload.on("error", () => undefined);
    const uploadClosed = new Promise<void>((resolve) => upload.once("close", () => resolve()));
    await new Promise<void>((resolve) => upload.once("connect", () => resolve()));
    let uploadAnswer = "";
    upload.on("data", (chunk: Buffer) => (uploadAnswer += chunk.toString("latin1")));
    const head = [`PUT /api/rooms/${roomId}/assets?kind=token HTTP/1.1`, `host: 127.0.0.1:${port}`, "content-type: image/png", "content-length: 1048576"];
    for (const [name, value] of Object.entries(player.headers())) head.push(`${name}: ${value}`);
    upload.write(`${head.join("\r\n")}\r\n\r\n`);
    upload.write(Buffer.alloc(64 * 1024));
    await sleep(300);
    assert.equal(uploadAnswer, "", "the upload is still being read when the stop comes");

    // The DM's page tries again the moment its socket closes with 1012, then backs off from 250 ms as
    // client/state/socket.ts does, until the server stops listening. Meanwhile its fetches go on.
    const reconnects: string[] = [];
    const reconnecting = dmSocket.closed.then(async ({ code }) => {
      assert.equal(code, 1012);
      for (let attempt = 0; attempt < 8 && reconnects.at(-1) !== "ECONNREFUSED"; attempt++) {
        if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
        reconnects.push(
          await new Promise<string>((resolve) => {
            const ws = new WebSocket(wsUrl, { headers: dm.headers() });
            ws.once("open", () => {
              ws.terminate();
              resolve("open");
            });
            ws.once("error", (err: Error & { code?: string }) => resolve(err.code ?? err.message));
          }),
        );
      }
    });
    let fetching = true;
    const fetched: Array<number | "gone"> = [];
    const fetches = (async () => {
      while (fetching && fetched.at(-1) !== "gone") {
        try {
          const res = await dm.call("GET", `/api/rooms/${roomId}/me`);
          await res.arrayBuffer();
          fetched.push(res.status);
        } catch {
          fetched.push("gone");
        }
        await sleep(20);
      }
    })();
    await sleep(100);

    const started = Date.now();
    child.kill("SIGTERM");
    const code = await exited;
    const took = Date.now() - started;
    fetching = false;
    await Promise.all([reconnecting, fetches]);
    const lines = output.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as { msg?: string; sockets?: number; cutOff?: number }];
      } catch {
        return [];
      }
    });
    const steps = lines.map((line) => line.msg ?? "").filter((msg) => msg.startsWith("shut"));
    assert.equal(code, 0, `the stop's exit code, after ${took} ms: ${steps.join(", ")}`);
    assert.ok(took < 5_000, `the stop took ${took} ms`);
    assert.equal(await seqOf("select seq::int from room_snapshots where room_id = $1"), lastSeq, "the stop saved the room at its last op");
    assert.deepEqual(steps, [
      "shutting down",
      "shutdown: sockets closed",
      "shutdown: server closed",
      "shutdown: rooms closed",
      "shutdown: socket writes settled",
      "shutdown: pool closed",
      "shut down",
    ]);
    const sockets = lines.find((line) => line.msg === "shutdown: sockets closed");
    assert.deepEqual({ sockets: sockets?.sockets, cutOff: sockets?.cutOff }, { sockets: 2, cutOff: 1 }, "both sockets closed, the slow phone's cut off");
    // What the stop met: the DM's page tried again while the player's phone held up the close and was refused, and the upload was cut off.
    assert.ok(reconnects.includes("Unexpected server response: 503"), `the DM's page reconnected during the close: ${reconnects.join(", ")}`);
    assert.ok(!reconnects.includes("open"), "no socket opened during the stop");
    assert.ok(fetched.includes(200), `the DM's fetches before the stop: ${fetched.join(", ")}`);
    await uploadClosed;
    assert.equal(uploadAnswer, "", "the upload was cut off unanswered");
  } finally {
    for (const end of ends) {
      end.terminate?.();
      end.destroy?.();
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
});
