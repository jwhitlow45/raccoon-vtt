import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { AskSessions } from "./askSessions.ts";
import type { SessionContext } from "./types.ts";
import { isToken, randomToken, sha256 } from "./tokens.ts";
import { inTx, type Queryable } from "./tx.ts";

/**
 * Device sessions (design section 10.2). A session is an opaque token in a
 * cookie. The database keeps only its hash, so a leaked table cannot be
 * replayed as cookies.
 *
 * The expiry slides: 180 days after last use. Writing that on every request
 * would turn every read into a write, so the row and the cookie's Max-Age are
 * refreshed at most once a day, and `last_seen_at` (shown in the DM devices
 * list) at most every 10 minutes.
 */
export const SESSION_DAYS = 180;
export const SESSION_MAX_AGE_S = SESSION_DAYS * 24 * 60 * 60;

/**
 * A table display's session (docs/design/design-v1-dm-tools.md 3.1) ends 30 days
 * after its last socket closed, since a TV sits in a shared place. While a
 * socket is open the grant recheck renews it (server/auth/displaySessions.ts).
 */
export const DISPLAY_SESSION_DAYS = 30;

/**
 * What a session is for. A `'room'` session is a browser's session in rooms.
 * A `'display'` session belongs to a table display and travels in a cookie
 * of its own. The server decides by this, never by the cookie a token came
 * in, so a display token copied into the room cookie is no session at all
 * to any ordinary route, and a room token in the display cookie opens no
 * display.
 */
export type SessionPurpose = "room" | "display";

export type CookieSettings = { name: string; secure: boolean };

/**
 * Production uses the `__Host-` prefix, which browsers accept only with
 * Secure, Path=/ and no Domain, so no subdomain or plain-http page can plant
 * or overwrite the cookie. Development over http://localhost cannot set a
 * Secure cookie, so it uses a plain name instead.
 */
export function cookieSettings(config: Pick<Config, "production">): CookieSettings {
  return config.production ? { name: "__Host-rvtt", secure: true } : { name: "rvtt", secure: false };
}

/** The display session's cookie: a second name with the room cookie's attributes, so one browser can hold both. */
export function displayCookieSettings(config: Pick<Config, "production">): CookieSettings {
  return config.production ? { name: "__Host-rvtt-display", secure: true } : { name: "rvtt-display", secure: false };
}

/** Refuses to boot a production server with development cookie settings. */
export function assertCookieSettings(config: Pick<Config, "production" | "publicOrigin">, cookie: CookieSettings): void {
  if (!config.production) return;
  if ((cookie.name !== "__Host-rvtt" && cookie.name !== "__Host-rvtt-display") || !cookie.secure) {
    throw new Error("Refusing to start in production with the development session cookie.");
  }
  // A Secure cookie is never sent over plain http, so every login would
  // silently fail.
  if (!config.publicOrigin.startsWith("https://")) {
    throw new Error("Refusing to start in production with a PUBLIC_ORIGIN that is not https.");
  }
}

export type SessionRow = {
  id: string;
  token: string;
  /** The row's expiry is more than a day old, so slide it and re-send the cookie. */
  slide: boolean;
  /** `last_seen_at` is more than 10 minutes old. */
  touch: boolean;
  /**
   * The row has no user agent: a session promoted from an ask token by a
   * DM's let-in, whose request was the DM's. The session's own next
   * request fills it in.
   */
  noUserAgent: boolean;
  /** create() adopted the device's ask token, or found it promoted a moment ago, rather than minting. */
  adopted?: true;
};

const USER_AGENT_MAX = 256;

/** How long a cookie value that named no session is answered from memory. */
const UNKNOWN_TTL_MS = 60_000;
const UNKNOWN_MAX = 10_000;
/** Promotion stamps kept, so a lookup in flight across a promotion's commit never caches its miss. */
const PROMOTED_MAX = 10_000;

export class SessionStore {
  readonly cookie: CookieSettings;
  readonly purpose: SessionPurpose;
  #days: number;
  #pool: Pick<pg.Pool, "query">;
  #now: () => number;
  // One lookup per request, shared by the rate limiter's key and every
  // `auth.session()` call the route makes.
  #memo = new WeakMap<FastifyRequest, Promise<SessionRow | null>>();
  /**
   * Hashes of cookie values that named no live session a moment ago, keyed
   * by the sha256 #find computes anyway. The rate limiter looks up every
   * token-shaped cookie before it can count the request, so a client
   * sending an invented one would otherwise cost a query on every request,
   * even once its IP is over the limit. Remembering the miss is safe
   * because a token turns valid later only through promotion from an ask
   * token (server/auth/askSessions.ts), which clears its hash here as it
   * commits and stamps it, and a lookup that started before the stamp does
   * not cache its miss.
   */
  #unknown = new Map<string, number>();
  #promoted = new Map<string, number>();
  #stamp = 0;
  #asks: AskSessions | null = null;

  constructor(pool: Pick<pg.Pool, "query">, cookie: CookieSettings, now: () => number = Date.now, purpose: SessionPurpose = "room") {
    this.#pool = pool;
    this.cookie = cookie;
    this.#now = now;
    this.purpose = purpose;
    this.#days = purpose === "display" ? DISPLAY_SESSION_DAYS : SESSION_DAYS;
  }

  /** Room sessions only: create() adopts the device's ask token from these, rather than minting a second identity. */
  adoptAskTokens(asks: AskSessions): void {
    if (this.purpose === "room") this.#asks = asks;
  }

  /**
   * An ask token's hash just became a session's, or may have. Idempotent,
   * and run by the promotion's after-commit callback and again by any
   * reconciliation, so every request authenticated after the commit reads
   * the database.
   */
  promoted(hash: Buffer): void {
    const key = hash.toString("hex");
    this.#unknown.delete(key);
    this.#promoted.delete(key);
    this.#promoted.set(key, ++this.#stamp);
    for (const old of this.#promoted.keys()) {
      if (this.#promoted.size <= PROMOTED_MAX) break;
      this.#promoted.delete(old);
    }
  }

  /** The session the request's cookie names, without side effects. */
  lookup(req: FastifyRequest, q: Queryable = this.#pool): Promise<SessionRow | null> {
    let found = this.#memo.get(req);
    if (!found) {
      found = this.#find(req.cookies[this.cookie.name], q);
      this.#memo.set(req, found);
    }
    return found;
  }

  /**
   * `AuthService.session`: the lookup, plus the sliding expiry. Only for room
   * sessions: a display session is renewed by its sockets alone, never by a
   * request.
   */
  async session(req: FastifyRequest, reply: FastifyReply, q: Queryable = this.#pool): Promise<SessionContext | null> {
    const row = await this.lookup(req, q);
    if (!row) return null;
    if (row.noUserAgent) {
      // Apart from the slide and touch writes, and only from the session's own request.
      row.noUserAgent = false;
      const ua = userAgent(req);
      if (ua !== null) await q.query("update sessions set user_agent = $2 where id = $1 and user_agent is null", [row.id, ua]);
    }
    if (row.slide || row.touch) {
      const slide = row.slide;
      // Clear the flags before the write, so concurrent calls in one request
      // do it once.
      row.slide = false;
      row.touch = false;
      await q.query(
        `update sessions set last_seen_at = now(),
           expires_at = case when $2 then now() + make_interval(days => $3) else expires_at end
         where id = $1`,
        [row.id, slide, SESSION_DAYS],
      );
      if (slide) this.setCookie(reply, row.token);
    }
    return { sessionId: row.id };
  }

  /**
   * Inserts a new session and remembers it for the rest of the request. The
   * caller sets the cookie once its transaction commits.
   *
   * A room session made inside a transaction adopts the device's ask token
   * first (docs/design/design-v1-join-requests.md 5.1): the same id and
   * token, so the cookie stays as it is and the device's waiting requests
   * keep following it. A display session never does.
   */
  async create(q: Queryable, req: FastifyRequest): Promise<SessionRow> {
    const adopted = this.#asks && inTx(q) ? await this.#adopt(q, this.#asks, req) : null;
    if (adopted) {
      this.#memo.set(req, Promise.resolve(adopted));
      return adopted;
    }
    const token = randomToken();
    const id = randomUUID();
    await q.query(
      `insert into sessions (id, token_hash, user_agent, expires_at, purpose)
       values ($1, $2, $3, now() + make_interval(days => $4), $5)`,
      [id, sha256(token), userAgent(req), this.#days, this.purpose],
    );
    const row: SessionRow = { id, token, slide: false, touch: false, noUserAgent: false };
    this.#memo.set(req, Promise.resolve(row));
    return row;
  }

  /**
   * The ask token in the room cookie, made a session. One read over both
   * tables finds where the cookie's hash lives now: already a session (a
   * let-in promoted it a moment ago, after this request's lookup missed),
   * a live ask token, which is promoted under its row lock, or neither.
   */
  async #adopt(tx: Queryable, asks: AskSessions, req: FastifyRequest): Promise<SessionRow | null> {
    const token = req.cookies[this.cookie.name];
    if (!isToken(token)) return null;
    const found = await asks.identify(tx, token);
    if (found.sessionId) return { id: found.sessionId, token, slide: false, touch: false, noUserAgent: false, adopted: true };
    if (!found.askId) return null;
    const promoted = await asks.promote(tx, found.askId, userAgent(req));
    if (promoted === "gone") return null;
    return { id: found.askId, token, slide: false, touch: false, noUserAgent: false, adopted: true };
  }

  /** The request's session, or a new one inserted with `q`. */
  async ensure(q: Queryable, req: FastifyRequest): Promise<{ row: SessionRow; created: boolean }> {
    const row = await this.lookup(req);
    return row ? { row, created: false } : { row: await this.create(q, req), created: true };
  }

  /**
   * Rotation replaces the token on the same row (design section 10.2). The
   * old token stops working the moment this commits, while every grant and
   * watermark keyed on the session id stays attached.
   */
  async rotate(q: Queryable, req: FastifyRequest, sessionId: string): Promise<SessionRow> {
    const token = randomToken();
    const result = await q.query(
      `update sessions set token_hash = $2, last_seen_at = now(), expires_at = now() + make_interval(days => $3)
       where id = $1`,
      [sessionId, sha256(token), SESSION_DAYS],
    );
    if (result.rowCount !== 1) throw new Error("session vanished during rotation");
    const row: SessionRow = { id: sessionId, token, slide: false, touch: false, noUserAgent: false };
    this.#memo.set(req, Promise.resolve(row));
    return row;
  }

  /**
   * The cookie lives as long as a room cookie, whatever the purpose. The
   * row's expiry is the real limit, and a display renewed by its socket for
   * longer than its first 30 days must not lose its cookie meanwhile.
   */
  setCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.cookie.name, token, {
      path: "/",
      httpOnly: true,
      secure: this.cookie.secure,
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE_S,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookie.name, { path: "/", httpOnly: true, secure: this.cookie.secure, sameSite: "strict" });
  }

  /** Deletes expired sessions. Their grants go with them (on delete cascade). */
  async cleanup(): Promise<number> {
    const result = await this.#pool.query("delete from sessions where expires_at < now()");
    return result.rowCount ?? 0;
  }

  async #find(token: string | undefined, q: Queryable): Promise<SessionRow | null> {
    if (!isToken(token)) return null;
    const hash = sha256(token);
    const key = hash.toString("hex");
    const now = this.#now();
    const until = this.#unknown.get(key);
    if (until !== undefined) {
      if (until > now) return null;
      this.#unknown.delete(key);
    }
    const started = this.#stamp;
    const { rows } = await q.query<{ id: string; slide: boolean; touch: boolean; no_ua: boolean }>(
      `select id,
         expires_at < now() + make_interval(days => $2) - interval '1 day' as slide,
         last_seen_at < now() - interval '10 minutes' as touch,
         user_agent is null as no_ua
       from sessions where token_hash = $1 and expires_at > now() and purpose = $3`,
      [hash, this.#days, this.purpose],
    );
    const row = rows[0];
    if (!row) {
      // A promotion stamped since this lookup began may have committed
      // after its query read the table, so its miss proves nothing.
      if ((this.#promoted.get(key) ?? 0) <= started) this.#rememberUnknown(key, now);
      return null;
    }
    return { id: row.id, token, slide: row.slide, touch: row.touch, noUserAgent: this.purpose === "room" && row.no_ua };
  }

  #rememberUnknown(key: string, now: number): void {
    // Oldest first, because a Map keeps insertion order.
    for (const [old, until] of this.#unknown) {
      if (this.#unknown.size < UNKNOWN_MAX && until > now) break;
      this.#unknown.delete(old);
    }
    this.#unknown.set(key, now + UNKNOWN_TTL_MS);
  }
}

function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua !== "" ? ua.slice(0, USER_AGENT_MAX) : null;
}
