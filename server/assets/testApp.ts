import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import pg from "pg";
import type { GrantContext, AuthService, SessionContext } from "../auth/types.ts";
import { loadConfig, type Config } from "../config.ts";
import { applySchema } from "../db.ts";
import { registerAssetRoutes, type AssetRouteOptions } from "../http/assets.ts";

/**
 * Shared setup for the asset integration tests: the dev Postgres, rooms
 * with unique ids, and an app with a fake `app.auth`. The real auth service
 * is built elsewhere. These tests depend only on its contract.
 */

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";

export async function testPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  await applySchema(pool);
  return pool;
}

export function testConfig(assetDir: string, over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    ASSET_DIR: assetDir,
    TRUST_CF_CONNECTING_IP: "1",
    ...over,
  });
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomRoomId(): string {
  return Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join("");
}

export async function makeRoom(pool: pg.Pool, opts: { pinned?: boolean; ageHours?: number; readOnly?: boolean } = {}): Promise<string> {
  const id = randomRoomId();
  await pool.query(
    `insert into rooms (id, name, player_pw_hash, dm_key_hash, pinned, read_only, created_at)
     values ($1, 'asset test', 'x', '\\x00', $2, $3, now() - make_interval(hours => $4))`,
    [id, opts.pinned ?? false, opts.readOnly ?? false, opts.ageHours ?? 48],
  );
  return id;
}

export async function dropRooms(pool: pg.Pool, roomIds: readonly string[]): Promise<void> {
  await pool.query(`delete from rooms where id = any($1)`, [[...roomIds]]);
}

/**
 * Grants keyed by the `x-test-session` header and the room. Each test
 * member is one session.
 */
export class FakeAuth implements AuthService {
  grants = new Map<string, GrantContext>();

  allow(roomId: string, role: "dm" | "player", memberId = `m-${randomUUID().slice(0, 8)}`): GrantContext & { headers: Record<string, string> } {
    const sessionId = randomUUID();
    const grant: GrantContext = { sessionId, roomId, memberId, role };
    this.grants.set(`${sessionId}|${roomId}`, grant);
    return { ...grant, headers: { "x-test-session": sessionId } };
  }

  async session(req: FastifyRequest): Promise<SessionContext | null> {
    const id = req.headers["x-test-session"];
    return typeof id === "string" ? { sessionId: id } : null;
  }

  async grant(req: FastifyRequest, _reply: unknown, roomId: string): Promise<GrantContext | null> {
    const id = req.headers["x-test-session"];
    return typeof id === "string" ? (this.grants.get(`${id}|${roomId}`) ?? null) : null;
  }

  /** The asset routes never take a table display's session. */
  async displayGrant(): Promise<null> {
    return null;
  }
}

/** Tests never reach the real Openverse: one that searches passes its own fake. */
async function noOpenverse(): Promise<never> {
  throw new Error("a test reached for Openverse without a fake");
}

export async function buildAssetApp(opts: {
  pool: pg.Pool;
  config: Config;
  auth: AuthService;
  options?: AssetRouteOptions;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", opts.config);
  app.decorate("pool", opts.pool);
  app.decorate("auth", opts.auth);
  await registerAssetRoutes(app, { minFreeBytes: 0, openverse: { http: noOpenverse }, ...opts.options });
  await app.ready();
  return app;
}
