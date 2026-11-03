import { randomBytes } from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { buildApp } from "../app.ts";
import { loadConfig, type Config } from "../config.ts";
import { applySchema } from "../db.ts";
import type { Member } from "#shared/model.ts";
import { DirectGateway, MAX_MEMBERS, RoomFullError, rosterOf, type RoomGateway, type RosterEntry, type SocketFilter } from "../rooms/gateway.ts";
import { ipKey } from "./ipKey.ts";
import { sha256 } from "./tokens.ts";
import type { PasswordHasher } from "./passwords.ts";
import type { AccessOptions } from "./plugin.ts";

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
  opts: { env?: Record<string, string>; hasher?: PasswordHasher; access?: AccessOptions } = {},
): Promise<TestApp> {
  const config = testConfig(opts.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  await applySchema(pool);
  const { rows } = await pool.query<{ now: Date }>("select now()");
  const startedAt = rows[0]?.now ?? new Date();
  const gateway = new DirectGateway(pool);
  const app = await buildApp({ config, pool, gateway, hasher: opts.hasher, access: opts.access });
  await app.ready();

  const userAgent = `raccoon-itest/${randomBytes(6).toString("hex")}`;
  const rooms = new Set<string>();
  const ips = new Set<string>();
  // A session promoted from an ask token has no user agent until its next
  // request, so cookies are cleaned up by their hashes too.
  const tokens = new Set<string>();

  return {
    app,
    pool,
    gateway,
    config,
    client(ip = randomIp()) {
      ips.add(ip);
      return new TestClient(app, ip, userAgent, (roomId) => rooms.add(roomId), (token) => tokens.add(token));
    },
    track: (roomId) => rooms.add(roomId),
    async close() {
      await app.close();
      const roomIds = [...rooms];
      const fragments = [...roomIds, ...[...ips].map(ipKey)];
      await pool.query("delete from rooms where id = any($1::text[])", [roomIds]);
      await pool.query("delete from sessions where user_agent = $1", [userAgent]);
      const hashes = [...tokens].map((token) => sha256(token));
      await pool.query("delete from sessions where token_hash = any($1::bytea[])", [hashes]);
      await pool.query("delete from ask_sessions where token_hash = any($1::bytea[])", [hashes]);
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
  #seen: (token: string) => void;

  constructor(app: FastifyInstance, ip: string, userAgent: string, track: (roomId: string) => void, seen: (token: string) => void = () => undefined) {
    this.#app = app;
    this.ip = ip;
    this.#userAgent = userAgent;
    this.#track = track;
    this.#seen = seen;
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
    if (cookie) {
      this.token = cookie.value;
      this.#seen(cookie.value);
    }
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

// Fakes for the join paths' unit and property tests
// (docs/design/design-v1-join-requests.md 10): an in-memory stand-in for the
// few tables admission touches, and a room gateway whose member calls can
// be held, failed or slowed.

type GrantRow = { session_id: string; room_id: string; member_id: string; role: string; epoch: number };
type FakeTables = {
  rooms: Map<string, { player_epoch: number; dm_epoch: number; join_mode: string }>;
  grants: Map<string, GrantRow>;
  dmMembers: Set<string>;
};

function copyTables(t: FakeTables): FakeTables {
  return {
    rooms: new Map([...t.rooms].map(([k, v]) => [k, { ...v }])),
    grants: new Map([...t.grants].map(([k, v]) => [k, { ...v }])),
    dmMembers: new Set(t.dmMembers),
  };
}

/**
 * A COMMIT applies only what its transaction changed from the copy it
 * started on, as Postgres does, so a transaction that began before another
 * one committed never undoes that one's rows.
 */
function applyChanges(into: FakeTables, base: FakeTables, tx: FakeTables): void {
  for (const name of ["rooms", "grants"] as const) {
    const target = into[name] as Map<string, unknown>;
    const was = base[name] as Map<string, unknown>;
    const now = tx[name] as Map<string, unknown>;
    for (const k of was.keys()) if (!now.has(k)) target.delete(k);
    for (const [k, v] of now) if (JSON.stringify(was.get(k)) !== JSON.stringify(v)) target.set(k, v);
  }
  for (const k of base.dmMembers) if (!tx.dmMembers.has(k)) into.dmMembers.delete(k);
  for (const k of tx.dmMembers) into.dmMembers.add(k);
}

/** A room row locked with `for update`: the only lock these statements take, held to the transaction's end. */
const ROOM_LOCK = /^select .* from rooms where id = \$1 for update$/;

/**
 * The tables a join attempt reads and writes, in memory, answering only the
 * statements admission and revokeGrants send. A transaction works on a copy
 * that replaces the tables at COMMIT. The one lock is the room row's, as
 * Postgres holds it: a second transaction waits for it, then reads what the
 * first committed, as a read-committed statement does after a lock wait.
 */
export class FakeAccessDb {
  tables: FakeTables = { rooms: new Map(), grants: new Map(), dmMembers: new Set() };
  /** Runs before every statement. Throw to fail it, or await to hold it. */
  before: (sql: string) => Promise<void> | void = () => undefined;
  /** The next COMMIT's answer is lost: "applied" commits first, "dropped" does not. */
  loseCommit: "applied" | "dropped" | null = null;
  /** Runs before a connection is handed out. */
  connecting: () => Promise<void> | void = () => undefined;
  statements: string[] = [];

  addRoom(roomId: string, epochs: { player_epoch?: number; dm_epoch?: number; join_mode?: string } = {}): void {
    this.tables.rooms.set(roomId, { player_epoch: epochs.player_epoch ?? 1, dm_epoch: epochs.dm_epoch ?? 1, join_mode: epochs.join_mode ?? "password" });
  }

  grant(sessionId: string, roomId: string): GrantRow | undefined {
    return this.tables.grants.get(`${sessionId}|${roomId}`);
  }

  #roomLocks = new Map<string, Promise<void>>();

  async #lockRoom(roomId: string): Promise<() => void> {
    const before = this.#roomLocks.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = before.then(() => mine);
    this.#roomLocks.set(roomId, tail);
    await before;
    return () => {
      release();
      if (this.#roomLocks.get(roomId) === tail) this.#roomLocks.delete(roomId);
    };
  }

  get pool(): pg.Pool {
    const db = this;
    return {
      async connect() {
        await db.connecting();
        let tx: FakeTables | null = null;
        let base: FakeTables | null = null;
        let wrote = false;
        const locks: Array<() => void> = [];
        const unlock = () => {
          for (const release of locks.splice(0)) release();
        };
        return {
          async query(text: string, values: unknown[] = []) {
            const sql = text.replace(/\s+/g, " ").trim();
            db.statements.push(sql);
            await db.before(sql);
            if (sql === "begin") {
              tx = copyTables(db.tables);
              base = copyTables(tx);
              wrote = false;
              return result([]);
            }
            if (sql === "commit") {
              const lose = db.loseCommit;
              db.loseCommit = null;
              try {
                if (lose !== "dropped" && tx && base) applyChanges(db.tables, base, tx);
                if (lose) throw new Error("connection lost during commit");
                tx = null;
                return result([]);
              } finally {
                unlock();
              }
            }
            if (sql === "rollback") {
              tx = null;
              unlock();
              return result([]);
            }
            if (tx && ROOM_LOCK.test(sql)) {
              locks.push(await db.#lockRoom(String(values[0])));
              // What another transaction committed while this one waited.
              if (!wrote) {
                tx = copyTables(db.tables);
                base = copyTables(tx);
              }
            }
            if (!sql.startsWith("select") && !sql.startsWith("set local")) wrote = true;
            return db.run(sql, values, tx ?? db.tables);
          },
          release() {
            unlock();
          },
        };
      },
      query(text: string, values: unknown[] = []) {
        return db.run(text.replace(/\s+/g, " ").trim(), values, db.tables);
      },
    } as unknown as pg.Pool;
  }

  run(sql: string, v: unknown[], t: FakeTables): Promise<pg.QueryResult> {
    const s = (i: number) => String(v[i]);
    if (sql.startsWith("set local")) return Promise.resolve(result([]));
    if (sql.startsWith("select player_epoch, dm_epoch") || sql.startsWith("select join_mode, player_epoch, dm_epoch")) {
      const room = t.rooms.get(s(0));
      return Promise.resolve(result(room ? [{ ...room }] : []));
    }
    if (sql.startsWith("select dm_epoch from rooms")) {
      const room = t.rooms.get(s(0));
      return Promise.resolve(result(room ? [{ dm_epoch: room.dm_epoch }] : []));
    }
    if (sql === "select 1 from rooms where id = $1 for update") {
      return Promise.resolve(result(t.rooms.has(s(0)) ? [{ "?column?": 1 }] : []));
    }
    if (sql.startsWith("select role, member_id, epoch from grants where session_id = $1 and room_id = $2")) {
      const g = t.grants.get(`${s(0)}|${s(1)}`);
      const rows = g && (!sql.includes("role in") || g.role === "dm" || g.role === "player") ? [{ role: g.role, member_id: g.member_id, epoch: g.epoch }] : [];
      return Promise.resolve(result(rows));
    }
    if (sql.startsWith("select member_id from room_dm_members")) {
      return Promise.resolve(result([...t.dmMembers].filter((k) => k.startsWith(`${s(0)}|`)).map((k) => ({ member_id: k.slice(s(0).length + 1) }))));
    }
    if (sql.startsWith("insert into grants")) {
      t.grants.set(`${s(0)}|${s(1)}`, { session_id: s(0), room_id: s(1), member_id: s(2), role: s(3), epoch: Number(v[4]) });
      return Promise.resolve(result([]));
    }
    if (sql.startsWith("insert into room_dm_members")) {
      for (const m of v[1] as string[]) t.dmMembers.add(`${s(0)}|${m}`);
      return Promise.resolve(result([]));
    }
    if (sql.startsWith("delete from grants")) {
      const removed: GrantRow[] = [];
      for (const [k, g] of t.grants) {
        if (g.room_id !== s(0)) continue;
        let hit = false;
        if (sql.includes("and session_id = $2 and member_id = $3")) hit = g.session_id === s(1) && g.member_id === s(2) && g.role === s(3) && g.epoch === Number(v[4]);
        else if (sql.includes("and member_id = $2")) hit = g.member_id === s(1) && (!sql.includes("role = any") || (v[2] as string[]).includes(g.role));
        else if (sql.includes("and session_id = $2")) hit = g.session_id === s(1) && (!sql.includes("role = any") || (v[2] as string[]).includes(g.role));
        if (hit) {
          removed.push(g);
          t.grants.delete(k);
        }
      }
      return Promise.resolve(result(removed.map((g) => ({ session_id: g.session_id, member_id: g.member_id, role: g.role }))));
    }
    if (sql.startsWith("delete from dm_invites") || sql.startsWith("delete from display_codes")) return Promise.resolve(result([]));
    if (sql.startsWith("select distinct member_id from grants")) {
      const ids = new Set(v[1] as string[]);
      return Promise.resolve(result([...t.grants.values()].filter((g) => g.room_id === s(0) && g.role === "dm" && ids.has(g.member_id)).map((g) => ({ member_id: g.member_id }))));
    }
    return Promise.reject(new Error(`FakeAccessDb does not know: ${sql}`));
  }
}

function result(rows: Record<string, unknown>[]): pg.QueryResult {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as pg.QueryResult;
}

/**
 * A room gateway over an in-memory roster. `addMember`, `removeMember` and
 * `setMemberKind` go through `hold`, so a test can delay, fail or count
 * each call.
 */
export class FakeRoomGateway implements RoomGateway {
  members = new Map<string, Map<string, Member>>();
  hold: (call: "add" | "remove" | "kind", roomId: string, memberId: string) => Promise<void> | void = () => undefined;
  calls: string[] = [];
  closed: Array<{ roomId: string; filter: SocketFilter; code: number }> = [];
  signals: string[] = [];

  room(roomId: string): Map<string, Member> {
    let m = this.members.get(roomId);
    if (!m) this.members.set(roomId, (m = new Map()));
    return m;
  }

  async createRoom(): Promise<void> {}
  async addMember(roomId: string, member: Member): Promise<void> {
    this.calls.push(`add ${member.id}`);
    await this.hold("add", roomId, member.id);
    const room = this.room(roomId);
    if (!room.has(member.id) && room.size >= MAX_MEMBERS) throw new RoomFullError();
    room.set(member.id, member);
  }
  async setMemberKind(roomId: string, memberId: string, kind: Member["kind"]): Promise<void> {
    await this.hold("kind", roomId, memberId);
    const m = this.room(roomId).get(memberId);
    if (m) this.room(roomId).set(memberId, { ...m, kind });
  }
  async removeMember(roomId: string, memberId: string): Promise<void> {
    this.calls.push(`remove ${memberId}`);
    await this.hold("remove", roomId, memberId);
    this.room(roomId).delete(memberId);
  }
  closeSockets(roomId: string, filter: SocketFilter, code: number): void {
    this.closed.push({ roomId, filter, code });
  }
  accessChanged(): void {}
  joinRequestsChanged(roomId: string): void {
    this.signals.push(roomId);
  }
  openSessions(): ReadonlySet<string> {
    return new Set();
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    return this.members.delete(roomId);
  }
  async playerRoster(roomId: string): Promise<RosterEntry[] | null> {
    return rosterOf(Object.fromEntries(this.room(roomId)), "player");
  }
  async dmRoster(roomId: string): Promise<RosterEntry[] | null> {
    return rosterOf(Object.fromEntries(this.room(roomId)), "dm");
  }
  async getMember(roomId: string, memberId: string): Promise<Member | null> {
    return this.room(roomId).get(memberId) ?? null;
  }
}

/**
 * Makes the pool's next transaction whose statements match `writes` commit
 * and then lose the COMMIT's answer, as a connection that drops just after
 * Postgres applied it. `meanwhile` runs between the two. Both the promise and
 * the callback form of connect() keep working, since pool.query itself
 * takes the callback form. Returns the undo.
 */
export function loseNextCommit(pool: pg.Pool, writes: (sql: string) => boolean, meanwhile: () => Promise<void> = async () => undefined): () => void {
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let armed = true;
  const patched = (cb?: (err: Error | undefined, client?: pg.PoolClient, done?: () => void) => void) => {
    const wrapped = connect().then((client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      let wrote = false;
      (client as { query: unknown }).query = (...args: unknown[]) => {
        const text = args[0];
        if (typeof text === "string" && writes(text)) wrote = true;
        if (armed && wrote && text === "commit") {
          armed = false;
          return (async () => {
            await query("commit");
            await meanwhile();
            throw new Error("connection lost during commit");
          })();
        }
        return query(...args);
      };
      return client;
    });
    if (cb) {
      wrapped.then((client) => cb(undefined, client, () => client.release()), (err: Error) => cb(err));
      return undefined;
    }
    return wrapped;
  };
  (pool as { connect: unknown }).connect = patched;
  return () => ((pool as { connect: unknown }).connect = connect);
}
