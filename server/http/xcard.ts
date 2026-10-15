import type { FastifyInstance } from "fastify";
import { checkGrant } from "../auth/grants.ts";
import { accessRoutes, type AuthKit, HttpError, roomParam } from "../auth/http.ts";
import type { RoomManager } from "../rooms/manager.ts";

/**
 * The X-card (docs/design-v1-dm-tools.md 3.11): John Stavropoulos's safety
 * tool, a tap that asks the table to edit out what just happened, with
 * nobody knowing who tapped it.
 *
 * Ops are stored with the member who sent them, and an ephemeral event
 * carries `from` and reaches one scene, so the card has a route and a
 * message of its own. Nothing about a tap is stored: no op, no log line, no
 * rate row, and no session timestamp. The usual `session()` path writes the
 * session's `last_seen_at` and slides its cookie, which would leave a time
 * tied to the sender, so this route reads the session with `lookup` and the
 * grant alone, and sends no cookie. Fastify writes no request line for it.
 * Its limits live in memory.
 *
 * Cloudflare's own logs, and this process's memory while it handles the
 * tap, still see who sent it (section 7). The table does not.
 */

/** Taps within this long of the card one room showed merge into that card. */
const MERGE_MS = 10_000;
const TAPS_PER_HOUR = 6;
const HOUR_MS = 3_600_000;
/** Past this many rooms or sessions held, stale entries are dropped on the next tap. */
const PRUNE_AT = 1_000;

export class XCardLimits {
  #now: () => number;
  #shown = new Map<string, number>();
  #taps = new Map<string, number[]>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts a tap against the session's hour. False once it has sent six. */
  tap(sessionId: string): boolean {
    const now = this.#now();
    if (this.#taps.size > PRUNE_AT) {
      for (const [id, times] of this.#taps) if (times.every((at) => now - at >= HOUR_MS)) this.#taps.delete(id);
    }
    const recent = (this.#taps.get(sessionId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= TAPS_PER_HOUR) {
      this.#taps.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    this.#taps.set(sessionId, recent);
    return true;
  }

  /** Whether this tap shows a card, or merges into the one the room showed in the last 10 s. */
  show(roomId: string): boolean {
    const now = this.#now();
    if (this.#shown.size > PRUNE_AT) {
      for (const [id, at] of this.#shown) if (now - at >= MERGE_MS) this.#shown.delete(id);
    }
    const last = this.#shown.get(roomId);
    if (last !== undefined && now - last < MERGE_MS) return false;
    this.#shown.set(roomId, now);
    return true;
  }
}

export function registerXCardRoutes(
  app: FastifyInstance,
  kit: AuthKit,
  deps: { manager: Pick<RoomManager, "get">; limits?: XCardLimits },
): Promise<void> {
  const limits = deps.limits ?? new XCardLimits();
  return accessRoutes(app, (r) => {
    r.post("/api/rooms/:id/xcard", { logLevel: "silent" }, async (req, reply) => {
      const roomId = roomParam(req);
      // `lookup` reads the room cookie's session and writes nothing. A table display's session is no session here.
      const session = await kit.sessions.lookup(req);
      if (!session) throw new HttpError(401, "no_session");
      if (!(await checkGrant(kit.pool, kit.gateway, session.id, roomId))) throw new HttpError(403, "no_access");
      if (!limits.tap(session.id)) return reply.code(429).send();
      // A merged tap is a success: the card is already showing everywhere.
      // A room nobody has loaded has nobody to show it to.
      if (limits.show(roomId)) deps.manager.get(roomId)?.xcard(new Date().toISOString());
      return reply.code(204).send();
    });
  });
}
