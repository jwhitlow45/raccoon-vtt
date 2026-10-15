import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { LIMITS } from "#shared/limits.ts";
import type { Config } from "../config.ts";
import type { Verdict } from "./ratelimit.ts";
import type { CookieSettings } from "./sessions.ts";
import { isToken, randomToken, sha256 } from "./tokens.ts";

/**
 * The admin page's sessions (docs/design-v1-dm-tools.md 3.18).
 *
 * They are not room sessions and hold no grants: a cookie of their own
 * holds 32 random bytes, and the table keeps only their sha256, a fixed
 * 12-hour expiry, and a fingerprint of the ADMIN_PASSWORD_HASH they were
 * made under. Changing the hash in .env therefore ends every admin session
 * at the next request, with nothing to migrate.
 */

const SESSION_MS = LIMITS.adminSessionHours * 3600_000;

/** `__Host-` in production, as the room cookie, so no subdomain or plain-http page can plant one. */
export function adminCookieSettings(config: Pick<Config, "production">): CookieSettings {
  return config.production ? { name: "__Host-rvtt-admin", secure: true } : { name: "rvtt-admin", secure: false };
}

export function passwordFingerprint(passwordHash: string): Buffer {
  return sha256(passwordHash);
}

export class AdminSessions {
  readonly cookie: CookieSettings;
  #pool: pg.Pool;
  #fingerprint: Buffer;

  constructor(pool: pg.Pool, cookie: CookieSettings, passwordHash: string) {
    this.#pool = pool;
    this.cookie = cookie;
    this.#fingerprint = passwordFingerprint(passwordHash);
  }

  /** A new session, returning the cookie's token. Never extended: it ends 12 hours from now. */
  async create(): Promise<string> {
    const token = randomToken();
    await this.#pool.query(
      `insert into admin_sessions (token_hash, password_fingerprint, expires_at)
       values ($1, $2, now() + make_interval(secs => $3))`,
      [sha256(token), this.#fingerprint, SESSION_MS / 1000],
    );
    return token;
  }

  /** Whether the request's admin cookie names a live session made under the current password hash. */
  async valid(req: FastifyRequest): Promise<boolean> {
    const token = req.cookies[this.cookie.name];
    if (!isToken(token)) return false;
    const { rowCount } = await this.#pool.query(
      "select 1 from admin_sessions where token_hash = $1 and password_fingerprint = $2 and expires_at > now()",
      [sha256(token), this.#fingerprint],
    );
    return (rowCount ?? 0) > 0;
  }

  async end(req: FastifyRequest): Promise<void> {
    const token = req.cookies[this.cookie.name];
    if (isToken(token)) await this.#pool.query("delete from admin_sessions where token_hash = $1", [sha256(token)]);
  }

  /** Expired sessions, and those of a password hash no longer in use. */
  async prune(): Promise<number> {
    const result = await this.#pool.query("delete from admin_sessions where expires_at < now() or password_fingerprint <> $1", [this.#fingerprint]);
    return result.rowCount ?? 0;
  }

  setCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.cookie.name, token, {
      path: "/",
      httpOnly: true,
      secure: this.cookie.secure,
      sameSite: "strict",
      maxAge: SESSION_MS / 1000,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookie.name, { path: "/", httpOnly: true, secure: this.cookie.secure, sameSite: "strict" });
  }
}

const FAILURES_PER_ADDRESS = LIMITS.adminLoginFailuresPer15Min;
const SITE_FAILURES_PER_HOUR = LIMITS.adminLoginSiteFailuresPerHour;
const HOUR_S = 3600;

/**
 * Failed admin logins, kept in `rate_events` so a restart forgets nothing.
 *
 * Per address: 5 failures in 15 minutes close the login to that address
 * for a minute after the latest, and each failure after that doubles the
 * wait, up to an hour. Across the site: 50 failures in an hour close the
 * login for everyone until an hour after the latest. A stranger can so keep
 * the server owner off the page for an hour, never out of the CLI. Only the
 * server owner uses the page, so per address is right here, unlike the
 * limits a table shares.
 */
export class AdminLoginLimits {
  #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async check(ip: string): Promise<Verdict> {
    const site = await this.#window("admin:fail:site", HOUR_S);
    if (site.n >= SITE_FAILURES_PER_HOUR) return wait(HOUR_S - site.sinceNewest);
    const recent = await this.#window(`admin:fail:${ip}`, 15 * 60);
    const hour = await this.#window(`admin:fail:${ip}`, HOUR_S);
    if (recent.n >= FAILURES_PER_ADDRESS || hour.n >= 2 * FAILURES_PER_ADDRESS) {
      const delay = Math.min(HOUR_S, 60 * 2 ** Math.max(0, hour.n - FAILURES_PER_ADDRESS));
      if (hour.sinceNewest < delay) return wait(delay - hour.sinceNewest);
    }
    return null;
  }

  async recordFailure(ip: string): Promise<void> {
    await this.#pool.query("insert into rate_events (key, at) select unnest($1::text[]), now()", [[`admin:fail:${ip}`, "admin:fail:site"]]);
  }

  async #window(key: string, seconds: number): Promise<{ n: number; sinceNewest: number }> {
    // Ages come from Postgres's own clock, which stamped the rows.
    const { rows } = await this.#pool.query<{ n: number; since_newest: number | null }>(
      `select count(*)::int as n, extract(epoch from now() - max(at))::float8 as since_newest
       from rate_events where key = $1 and at > now() - make_interval(secs => $2)`,
      [key, seconds],
    );
    return { n: rows[0]?.n ?? 0, sinceNewest: rows[0]?.since_newest ?? Number.POSITIVE_INFINITY };
  }
}

function wait(seconds: number): number {
  return Math.max(1, Math.ceil(seconds));
}
