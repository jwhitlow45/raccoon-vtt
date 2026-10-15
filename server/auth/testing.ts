import { randomBytes } from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { buildApp } from "../app.ts";
import { loadConfig, type Config } from "../config.ts";
import { applySchema } from "../db.ts";
import { DirectGateway } from "../rooms/gateway.ts";
import { ipKey } from "./ipKey.ts";
import type { PasswordHasher } from "./passwords.ts";

/**
 * Integration test kit: an app on the shared development Postgres, clients
 * that keep their own cookie and IP, and cleanup of everything a test run
 * wrote. Other agents' tests use the same database at the same time, so every
 * row here is keyed by a random room ID, a random documentation-range IP, or
 * this run's user agent, and only those rows are deleted afterwards.
 */
export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    // Generous by default, so the shared site-wide count from other runs
    // never fails an unrelated test. The limit tests set their own.
    ROOMS_PER_DAY: "1000000",
    ROOMS_PER_IP_PER_DAY: "1000",
    ...env,
  });
}

/** A random address in 2001:db8::/32, the IPv6 documentation range. */
export function randomIp(): string {
  const h = () => randomBytes(2).toString("hex");
  return `2001:db8:${h()}:${h()}::${h()}`;
}

export type TestApp = {
  app: FastifyInstance;
  pool: pg.Pool;
  gateway: DirectGateway;
  config: Config;
  /** A new device: its own cookie jar and, unless given, its own IP. */
  client(ip?: string): TestClient;
  /** Remembers a room so close() deletes it. */
  track(roomId: string): void;
  close(): Promise<void>;
};

export async function startTestApp(
  opts: { env?: Record<string, string>; hasher?: PasswordHasher } = {},
): Promise<TestApp> {
  const config = testConfig(opts.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  await applySchema(pool);
  const { rows } = await pool.query<{ now: Date }>("select now()");
  const startedAt = rows[0]?.now ?? new Date();
  const gateway = new DirectGateway(pool);
  const app = await buildApp({ config, pool, gateway, hasher: opts.hasher });
  await app.ready();

  const userAgent = `raccoon-itest/${randomBytes(6).toString("hex")}`;
  const rooms = new Set<string>();
  const ips = new Set<string>();

  return {
    app,
    pool,
    gateway,
    config,
    client(ip = randomIp()) {
      ips.add(ip);
      return new TestClient(app, ip, userAgent, (roomId) => rooms.add(roomId));
    },
    track: (roomId) => rooms.add(roomId),
    async close() {
      await app.close();
      const roomIds = [...rooms];
      const fragments = [...roomIds, ...[...ips].map(ipKey)];
      await pool.query("delete from rooms where id = any($1::text[])", [roomIds]);
      await pool.query("delete from sessions where user_agent = $1", [userAgent]);
      if (fragments.length > 0) {
        await pool.query(
          "delete from rate_events where exists (select 1 from unnest($1::text[]) f where position(f in key) > 0)",
          [fragments],
        );
      }
      // The site-wide creation count has no per-run key. Dropping this run's
      // share keeps a developer's own `pnpm dev` from hitting the daily cap.
      await pool.query("delete from rate_events where key = 'create:site' and at >= $1", [startedAt]);
      await pool.end();
    },
  };
}

type Body = Record<string, unknown>;

export class TestClient {
  readonly ip: string;
  token: string | undefined;
  #app: FastifyInstance;
  #userAgent: string;
  #track: (roomId: string) => void;

  constructor(app: FastifyInstance, ip: string, userAgent: string, track: (roomId: string) => void) {
    this.#app = app;
    this.ip = ip;
    this.#userAgent = userAgent;
    this.#track = track;
  }

  async request(
    method: NonNullable<InjectOptions["method"]>,
    url: string,
    body?: Body,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const res = await this.#app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        "user-agent": this.#userAgent,
        "sec-fetch-site": "same-origin",
        ...(this.token ? { cookie: `rvtt=${this.token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
    const cookie = res.cookies.find((c) => c.name === "rvtt");
    if (cookie) this.token = cookie.value;
    return res;
  }

  get(url: string): Promise<LightMyRequestResponse> {
    return this.request("GET", url);
  }

  post(url: string, body?: Body): Promise<LightMyRequestResponse> {
    return this.request("POST", url, body);
  }

  delete(url: string, body?: Body): Promise<LightMyRequestResponse> {
    return this.request("DELETE", url, body);
  }

  /** Creates a room as this device, which becomes its DM. */
  async createRoom(
    name = "Test room",
    password = "owlbear-druid-wand",
  ): Promise<{ roomId: string; dmLink: string; dmKey: string }> {
    const res = await this.post("/api/rooms", { name, playerPassword: password, dmName: "Dungeon Master" });
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
    const body = res.json<{ roomId: string; dmLink: string }>();
    this.#track(body.roomId);
    const dmKey = body.dmLink.split("#dm=")[1] ?? "";
    return { ...body, dmKey };
  }

  /** Both join steps, as a new player. */
  async join(roomId: string, name = "Player", password = "owlbear-druid-wand", color = "#3e8ef7"): Promise<string> {
    const first = await this.post(`/api/rooms/${roomId}/join`, { password });
    if (first.statusCode !== 200) throw new Error(`join failed: ${first.statusCode} ${first.body}`);
    const { ticket } = first.json<{ ticket: string }>();
    const done = await this.post(`/api/rooms/${roomId}/join/complete`, { ticket, name, color });
    if (done.statusCode !== 200) throw new Error(`join/complete failed: ${done.statusCode} ${done.body}`);
    return done.json<{ memberId: string }>().memberId;
  }

  async me(roomId: string): Promise<{ status: number; role?: string; memberId?: string }> {
    const res = await this.get(`/api/rooms/${roomId}/me`);
    if (res.statusCode !== 200) return { status: res.statusCode };
    return { status: 200, ...res.json<{ role: string; memberId: string }>() };
  }
}
