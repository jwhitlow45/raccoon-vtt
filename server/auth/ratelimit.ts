import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Config } from "../config.ts";
import { clientIp } from "./clientIp.ts";
import { ipKey } from "./ipKey.ts";
import type { SessionStore } from "./sessions.ts";
import type { Queryable } from "./tx.ts";

/**
 * Rate limits (design section 10.3), in two layers.
 *
 * Fast limits on every request live in memory in @fastify/rate-limit. A
 * table shares one IP, so a request with a valid session is counted per
 * session (600 a minute, and image reads 3,000 a minute on a key of their
 * own), and only a request without one per IP (120 a minute). The key comes
 * from a real session lookup, not the raw cookie, so an invented cookie
 * value is counted against its IP like no cookie at all.
 *
 * Slow limits (room creation, password and DM key failures, successful joins)
 * are counted in `rate_events`, so a restart does not reset a lockout, and
 * they are keyed per IP and per room, so minting new sessions resets nothing.
 * The count of failed password joins per room is kept the same way, but it
 * never refuses anything itself: it only decides when a join needs Turnstile.
 */
const SESSION_PER_MINUTE = 600;
const IP_PER_MINUTE = 120;
const IMAGE_READS_PER_MINUTE = 3_000;

/**
 * The path a request was routed to. The router decodes percent-escapes
 * before it matches, so `/%61pi/config` reaches `/api/config` while its raw
 * URL does not start with `/api/`. Classifying by the raw URL would let any
 * API route skip the limiter. A request that matched no route falls back to
 * its raw URL: only the SPA fallback or a 404 answers it.
 */
function routedPath(req: FastifyRequest): string {
  return req.routeOptions.url ?? req.url;
}

/** Static files: every GET outside the API and the socket. */
function isStatic(req: FastifyRequest): boolean {
  const path = routedPath(req);
  return (req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/") && !path.startsWith("/ws");
}

/** Image reads, which the asset routes authorize themselves after the limiter. A table display reads through its own route. */
function isAssetRead(req: FastifyRequest): boolean {
  if (req.method !== "GET") return false;
  const path = routedPath(req);
  return path.startsWith("/api/assets/") || path === DISPLAY_ASSET_ROUTE;
}

/** The display image route (docs/design-v1-dm-tools.md 3.1), as Fastify reports the route it matched. */
const DISPLAY_ASSET_ROUTE = "/api/rooms/:id/display/assets/:assetId/:variant";

/** Routes and sockets a table display uses with its own cookie. */
function isDisplayRequest(req: FastifyRequest): boolean {
  const path = routedPath(req);
  if (path === "/ws") return (req.query as { as?: unknown } | undefined)?.as === "display";
  return path.startsWith("/api/display/") || path.startsWith("/api/rooms/:id/display/");
}

/**
 * Registers the per-request limiter. It hooks routes as they are added, so it
 * must be registered before any route it should cover.
 */
export async function registerRequestLimits(
  app: FastifyInstance,
  deps: { sessions: SessionStore; displaySessions: SessionStore; config: Config },
): Promise<void> {
  const trust = deps.config.TRUST_CF_CONNECTING_IP === "1";
  await app.register(rateLimit, {
    global: true,
    timeWindow: 60_000,
    max: (_req, key) => (key.startsWith("a:") ? IMAGE_READS_PER_MINUTE : key.startsWith("s:") ? SESSION_PER_MINUTE : IP_PER_MINUTE),
    keyGenerator: async (req) => {
      if (isStatic(req)) return "static";
      // A table display holds no room session, and the whole table shares
      // its address, so its own requests count against its display session.
      // Only its own routes look at that cookie, so it buys nothing elsewhere.
      const session = (await deps.sessions.lookup(req)) ?? (isDisplayRequest(req) ? await deps.displaySessions.lookup(req) : null);
      if (!session) return `ip:${ipKey(clientIp(req, trust))}`;
      // A map scene fetches dozens of token images at once, so a signed-in
      // device's image reads get an allowance of their own, far above the
      // 600. It is still a limit: the grant is checked only inside the
      // route, so an unlimited read would let any session send the
      // database unlimited lookups of made-up asset ids.
      return isAssetRead(req) ? `a:${session.id}` : `s:${session.id}`;
    },
    allowList: (_req, key) => key === "static",
  });
}

/** Seconds to wait before retrying, or null when allowed. */
export type Verdict = number | null;

const HOUR = 3600;
const DAY = 24 * HOUR;
const FAILURES_PER_IP = 20;
const FAILURE_WINDOW = 10 * 60;
const LOCKOUT = 15 * 60;
/**
 * The session log (docs/design-v1-dm-tools.md 3.10): every listing and every
 * export, per member and room, with a loose cap per address against a
 * flood, sized for a table of phones behind one home connection.
 */
const LOG_EXPORTS_PER_MEMBER_HOUR = 10;
const LOG_EXPORTS_PER_IP_HOUR = 60;
const SUCCESSES_PER_IP_HOUR = 30;
const SUCCESSES_PER_ROOM_HOUR = 60;
/**
 * Failed password joins on one room, from every address together, in a
 * sliding hour, at which joining that room needs a Turnstile check (design
 * 10.3). A table of five or six people mistyping a three-word passphrase on
 * phone keyboards makes a handful of failures, so a group arriving for a
 * session should never meet the check. A guesser with many /64s is held to
 * about 20 free guesses an hour per room (the count is read before the hash
 * and written after it, so a burst already in flight can add a few tens),
 * and every guess past that costs a solved challenge before it reaches the
 * argon2 queue.
 */
const JOIN_CHALLENGE_FAILURES_PER_HOUR = 20;

type WindowState = { n: number; oldestExpiresIn: number; sinceNewest: number };

export class SlowLimits {
  #pool: pg.Pool;
  #config: Pick<Config, "ROOMS_PER_IP_PER_DAY" | "ROOMS_PER_DAY">;

  constructor(pool: pg.Pool, config: Pick<Config, "ROOMS_PER_IP_PER_DAY" | "ROOMS_PER_DAY">) {
    this.#pool = pool;
    this.#config = config;
  }

  /**
   * Room creation: per IP and site-wide, per day (design section 10.1). The
   * route checks once cheaply before hashing, then again inside its
   * transaction under `lockCreation`, so two racing requests cannot both
   * take the last slot.
   */
  async creation(ip: string, q: Queryable = this.#pool): Promise<Verdict> {
    const perIp = await this.#window(`create:ip:${ip}`, DAY, q);
    if (perIp.n >= this.#config.ROOMS_PER_IP_PER_DAY) return wait(perIp.oldestExpiresIn);
    const site = await this.#window("create:site", DAY, q);
    if (site.n >= this.#config.ROOMS_PER_DAY) return wait(site.oldestExpiresIn);
    return null;
  }

  /** Serializes creations for the rest of the transaction. Room import uses it too. */
  async lockCreation(tx: Queryable): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtext('raccoon:room-create'))");
  }

  async recordCreation(tx: Queryable, ip: string): Promise<void> {
    await this.#record(tx, [`create:ip:${ip}`, "create:site"]);
  }

  /**
   * Password and DM key failures for one IP on one room. The IP is the
   * limits' form from ipKey, so an IPv6 /64 counts as one address.
   *
   * The first 20 failures in 10 minutes cost nothing. Past that, each retry
   * must wait 2^(n - 20) seconds after the latest failure, where n counts
   * the last 15 minutes, up to the full 15-minute lockout. Counting the
   * longer window keeps a burst of 30 or more locked for the whole 15
   * minutes rather than releasing it when the 10-minute window empties.
   *
   * There is no lockout per room across all IPs. Room IDs are not secret,
   * so a few addresses guessing wrong would lock every new device out of a
   * room, the right password and the DM link included. One /64 gets about
   * 60 to 70 guesses an hour, but someone holding many /64s (a /48 has
   * 65,536) would be bounded only by the argon2 queue, about 700,000
   * guesses an hour at 2 hashes of 9 ms. That finds a generated three-word
   * passphrase (1,595 words, about 4.06e9 phrases) in months, not
   * centuries, and keeps joins busy meanwhile. The project accepted that
   * (design 17), then chose a challenge over a lockout: see joinChallenged().
   */
  async failures(roomId: string, ip: string): Promise<Verdict> {
    return this.#growingDelay(`fail:${roomId}:${ip}`);
  }

  /**
   * Wrong table display codes from one address (docs/design-v1-dm-tools.md
   * 3.1), in a bucket of their own with the joins' growing delays. A code
   * names no room until it matches, and a TV's typos must never use up the
   * join budget of the players at the same home address.
   */
  async displayCodeFailures(ip: string): Promise<Verdict> {
    return this.#growingDelay(`dfail:${ip}`);
  }

  async recordDisplayCodeFailure(ip: string): Promise<void> {
    await this.#record(this.#pool, [`dfail:${ip}`]);
  }

  /**
   * The session log's listing and export (docs/design-v1-dm-tools.md 3.10),
   * checked before anything is read. Every request is charged, a cached
   * answer as much as a fresh one: the cache key moves with the room's seq,
   * which hidden ops move too, so charging only misses would let a player
   * count the DM's hidden activity by when they ran out.
   */
  async logExport(roomId: string, memberId: string, ip: string): Promise<Verdict> {
    const member = await this.#window(`logx:${roomId}:${memberId}`, HOUR);
    if (member.n >= LOG_EXPORTS_PER_MEMBER_HOUR) return wait(member.oldestExpiresIn);
    const address = await this.#window(`logx:ip:${ip}`, HOUR);
    if (address.n >= LOG_EXPORTS_PER_IP_HOUR) return wait(address.oldestExpiresIn);
    return null;
  }

  async recordLogExport(roomId: string, memberId: string, ip: string): Promise<void> {
    await this.#record(this.#pool, [`logx:${roomId}:${memberId}`, `logx:ip:${ip}`]);
  }

  /**
   * The first 20 failures in 10 minutes cost nothing. Past that, each retry
   * waits 2^(n - 20) seconds after the latest failure, where n counts the
   * last 15 minutes, up to the full 15-minute lockout.
   */
  async #growingDelay(key: string): Promise<Verdict> {
    const recent = await this.#window(key, FAILURE_WINDOW);
    const longer = await this.#window(key, LOCKOUT);
    if (recent.n >= FAILURES_PER_IP || longer.n >= FAILURES_PER_IP + 10) {
      const delay = Math.min(LOCKOUT, 2 ** (longer.n - FAILURES_PER_IP));
      if (longer.sinceNewest < delay) return wait(delay - longer.sinceNewest);
    }
    return null;
  }

  /** A wrong DM key. A wrong player password goes to recordPasswordFailure instead. */
  async recordFailure(roomId: string, ip: string): Promise<void> {
    await this.#record(this.#pool, [`fail:${roomId}:${ip}`]);
  }

  /** A wrong player password: counted for its address, and for the room's challenge. */
  async recordPasswordFailure(roomId: string, ip: string): Promise<void> {
    await this.#record(this.#pool, [`fail:${roomId}:${ip}`, `fail:room:${roomId}`]);
  }

  /**
   * Whether a password join on this room must carry a solved Turnstile
   * check: 20 or more wrong player passwords from all addresses together in
   * the last hour (design 10.3). It is never a lockout. Anyone who passes
   * the check still gets the password checked, so the group can always join,
   * and a device that already holds a grant never sends the password at
   * all. The check lifts an hour after the failures stop.
   *
   * Only player passwords count. A DM key is 256 random bits, so a wrong one
   * is a stale link, not a guess worth slowing down.
   */
  async joinChallenged(roomId: string): Promise<boolean> {
    const room = await this.#window(`fail:room:${roomId}`, HOUR);
    return room.n >= JOIN_CHALLENGE_FAILURES_PER_HOUR;
  }

  /** Successful joins, DM claims and invite redemptions, per IP and per room, per hour. */
  async successes(ip: string, roomId: string): Promise<Verdict> {
    const perIp = await this.#window(`ok:ip:${ip}`, HOUR);
    if (perIp.n >= SUCCESSES_PER_IP_HOUR) return wait(perIp.oldestExpiresIn);
    const room = await this.#window(`ok:room:${roomId}`, HOUR);
    if (room.n >= SUCCESSES_PER_ROOM_HOUR) return wait(room.oldestExpiresIn);
    return null;
  }

  async recordSuccess(q: Queryable, ip: string, roomId: string): Promise<void> {
    await this.#record(q, [`ok:ip:${ip}`, `ok:room:${roomId}`]);
  }

  /** Every window above is at most a day long, so older rows count for nothing. */
  async prune(): Promise<number> {
    const result = await this.#pool.query("delete from rate_events where at < now() - interval '1 day'");
    return result.rowCount ?? 0;
  }

  async #window(key: string, seconds: number, q: Queryable = this.#pool): Promise<WindowState> {
    // Ages are computed by Postgres against its own clock, the same clock
    // that stamped the rows, so app and database clock skew cannot matter.
    const { rows } = await q.query<{ n: number; oldest_expires_in: number | null; since_newest: number | null }>(
      `select count(*)::int as n,
         extract(epoch from min(at) + make_interval(secs => $2) - now())::float8 as oldest_expires_in,
         extract(epoch from now() - max(at))::float8 as since_newest
       from rate_events where key = $1 and at > now() - make_interval(secs => $2)`,
      [key, seconds],
    );
    const row = rows[0];
    return {
      n: row?.n ?? 0,
      oldestExpiresIn: row?.oldest_expires_in ?? 0,
      sinceNewest: row?.since_newest ?? Number.POSITIVE_INFINITY,
    };
  }

  async #record(q: Queryable, keys: string[]): Promise<void> {
    await q.query("insert into rate_events (key, at) select unnest($1::text[]), now()", [keys]);
  }
}

function wait(seconds: number): number {
  return Math.max(1, Math.ceil(seconds));
}
