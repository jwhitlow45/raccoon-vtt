import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { SESSION_DAYS, type SessionStore } from "./sessions.ts";
import { isToken, randomToken, sha256 } from "./tokens.ts";
import { afterCommit, type Queryable } from "./tx.ts";

/**
 * Ask tokens (docs/design/design-v1-join-requests.md 5.1, D-261102-108): the
 * identity of a device with no room session that asked a DM to let it in.
 *
 * A token is minted only once an ask is admitted, travels in the room
 * cookie the app already uses, and lives an hour from the device's latest
 * ask, in `ask_sessions`, never in `sessions`. So it is no session to the
 * request limiter on any route, and an older build that knows nothing of
 * this table reads it as an unknown cookie. Whatever first makes the device
 * a session (a DM's let-in, a password join, a DM claim, a new room)
 * promotes the token into `sessions` with the same id and token hash under
 * a lock on its row, so every request the device has waiting, in any room,
 * keeps following one identity. Nothing is ever demoted.
 *
 * Only the ask, `mine`, wait and cancel routes and SessionStore.create read
 * this table. It keeps no negative cache.
 */
export const ASK_TOKEN_MS = 60 * 60_000;

export type AskToken = { id: string; token: string };

/** What a cookie's hash names, read in one statement over one snapshot. */
export type CookieIdentity = { sessionId: string | null; askId: string | null };

export class AskSessions {
  #pool: Pick<pg.Pool, "query">;
  #sessions: SessionStore;
  #memo = new WeakMap<FastifyRequest, Promise<AskToken | null>>();

  constructor(pool: Pick<pg.Pool, "query">, sessions: SessionStore) {
    this.#pool = pool;
    this.#sessions = sessions;
  }

  /** The live ask token the request's room cookie names, once per request. */
  lookup(req: FastifyRequest): Promise<AskToken | null> {
    let found = this.#memo.get(req);
    if (!found) {
      found = this.#find(req.cookies[this.#sessions.cookie.name]);
      this.#memo.set(req, found);
    }
    return found;
  }

  /** A new token, written in the caller's transaction. The caller sets the cookie only once its admission succeeds. */
  async mint(tx: Queryable): Promise<AskToken> {
    const token = randomToken();
    const id = randomUUID();
    await tx.query("insert into ask_sessions (id, token_hash, expires_at) values ($1, $2, now() + make_interval(secs => $3))", [
      id,
      sha256(token),
      ASK_TOKEN_MS / 1000,
    ]);
    return { id, token };
  }

  /**
   * Moves a token's expiry to an hour from now. It touches only a row still
   * in `ask_sessions`, so a token promoted meanwhile keeps its session's
   * 180 days. False when there was no such row.
   */
  async renew(tx: Queryable, id: string): Promise<boolean> {
    const result = await tx.query("update ask_sessions set expires_at = now() + make_interval(secs => $2) where id = $1", [id, ASK_TOKEN_MS / 1000]);
    return result.rowCount === 1;
  }

  /**
   * Whether a cookie's hash names a room session or a live ask token, in
   * one statement over one snapshot. A promotion inserts the session and
   * deletes the ask row in one transaction, so this never finds neither for
   * a live token. The `purpose` test is #find's, so a display token placed
   * in the room cookie never counts as a room session. It bypasses every
   * cache, since a promotion may have committed since the request's own
   * lookup missed.
   */
  async identify(q: Queryable, token: string): Promise<CookieIdentity> {
    const { rows } = await q.query<{ session_id: string | null; ask_id: string | null }>(
      `select (select id from sessions where token_hash = $1 and expires_at > now() and purpose = 'room') as session_id,
              (select id from ask_sessions where token_hash = $1 and expires_at > now()) as ask_id`,
      [sha256(token)],
    );
    return { sessionId: rows[0]?.session_id ?? null, askId: rows[0]?.ask_id ?? null };
  }

  /**
   * Makes ask token `id` a room session with the same id and token hash and
   * the normal 180 days, and deletes the ask row, under a lock on it, in
   * the caller's transaction. A let-in passes the requester's id and no user
   * agent, since its request is the DM's. `"session"`: the token was
   * promoted already (by another room's let-in, say), so the session with
   * this id is the one to use. `"gone"`: neither is left.
   *
   * Once the transaction commits, or may have, the token's hash leaves the
   * session store's unknown-token cache. `hash` lets a caller whose commit
   * answer was lost clear it again as it reads the outcome back.
   */
  async promote(tx: Queryable, id: string, userAgent: string | null = null): Promise<{ state: "promoted" | "session" | "gone"; hash?: Buffer }> {
    const { rows } = await tx.query<{ token_hash: Buffer }>("select token_hash from ask_sessions where id = $1 and expires_at > now() for update", [id]);
    const row = rows[0];
    if (row) {
      await tx.query(
        `insert into sessions (id, token_hash, user_agent, expires_at, purpose)
         values ($1, $2, $3, now() + make_interval(days => $4), 'room')`,
        [id, row.token_hash, userAgent, SESSION_DAYS],
      );
      await tx.query("delete from ask_sessions where id = $1", [id]);
      const hash = row.token_hash;
      afterCommit(tx, () => this.#sessions.promoted(hash));
      return { state: "promoted", hash };
    }
    const session = await tx.query("select 1 from sessions where id = $1 and purpose = 'room' and expires_at > now()", [id]);
    return { state: session.rowCount === 1 ? "session" : "gone" };
  }

  /** Whether the id is still a live room session or ask token: a let-in's cheap check before it adds a member. */
  async live(q: Queryable, id: string): Promise<boolean> {
    const { rows } = await q.query<{ live: boolean }>(
      `select exists (select 1 from sessions where id = $1 and purpose = 'room' and expires_at > now())
           or exists (select 1 from ask_sessions where id = $1 and expires_at > now()) as live`,
      [id],
    );
    return rows[0]?.live === true;
  }

  /** The hourly cleanup's part. */
  async cleanup(): Promise<number> {
    const result = await this.#pool.query("delete from ask_sessions where expires_at < now()");
    return result.rowCount ?? 0;
  }

  async #find(token: string | undefined): Promise<AskToken | null> {
    if (!isToken(token)) return null;
    const { rows } = await this.#pool.query<{ id: string }>("select id from ask_sessions where token_hash = $1 and expires_at > now()", [sha256(token)]);
    const row = rows[0];
    return row ? { id: row.id, token } : null;
  }
}
