import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.ts";
import { ipKey } from "./auth/ipKey.ts";
import { testConfig } from "./auth/testing.ts";
import { sha256 } from "./auth/tokens.ts";
import { applySchema } from "./db.ts";
import { randomIp, Socket, TestClient } from "./rooms/testing.ts";
import { closeServer } from "./shutdown.ts";

/**
 * A deploy's shutdown with sockets open (design 15.4, LP5-OPS-3): every
 * socket's session gets its last sight stamped, a slow client's included,
 * and nothing writes through the pool after it ends. The app here has a
 * pool of its own, which the shutdown ends, and a second pool checks the
 * rows and cleans up.
 */

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

function client(): TestClient {
  const ip = randomIp();
  ips.push(ip);
  return new TestClient(() => app, ip, userAgent, (roomId) => rooms.push(roomId));
}

async function connect(roomId: string, who: TestClient): Promise<Socket> {
  const address = app.server.address();
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
