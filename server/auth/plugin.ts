import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { RoomGateway } from "../rooms/gateway.ts";
import { clientIp } from "./clientIp.ts";
import { checkDisplayGrant, checkGrant } from "./grants.ts";
import { ipKey } from "./ipKey.ts";
import type { AuthKit } from "./http.ts";
import { PasswordHasher } from "./passwords.ts";
import { registerRequestLimits, SlowLimits } from "./ratelimit.ts";
import { parseRoomId } from "./roomId.ts";
import { assertCookieSettings, cookieSettings, displayCookieSettings, SessionStore } from "./sessions.ts";
import { JoinTickets } from "./tickets.ts";
import type { AuthService } from "./types.ts";

const HOUR_MS = 3_600_000;

/**
 * Sets up authentication on the app: the cookie parser, the per-request rate
 * limiter, `app.auth`, and the hourly cleanup of expired rows.
 *
 * Call it before registering any route, because the rate limiter only
 * covers routes added after it.
 */
export async function setupAuth(
  app: FastifyInstance,
  deps: { config: Config; pool: pg.Pool; gateway: RoomGateway; hasher?: PasswordHasher },
): Promise<AuthKit> {
  const { config, pool, gateway } = deps;
  const cookie = cookieSettings(config);
  assertCookieSettings(config, cookie);
  const displayCookie = displayCookieSettings(config);
  assertCookieSettings(config, displayCookie);

  await app.register(fastifyCookie);
  const sessions = new SessionStore(pool, cookie);
  // Table displays (docs/design-v1-dm-tools.md 3.1): a second store on a
  // second cookie, which only the display routes and the `as=display`
  // socket read.
  const displaySessions = new SessionStore(pool, displayCookie, Date.now, "display");
  await registerRequestLimits(app, { sessions, displaySessions, config });

  const auth: AuthService = {
    session: (req, reply) => sessions.session(req, reply),
    async grant(req, reply, roomId, q = pool) {
      const id = parseRoomId(roomId);
      if (!id) return null;
      const session = await sessions.session(req, reply, q);
      return session ? checkGrant(q, gateway, session.sessionId, id) : null;
    },
    async displayGrant(req, roomId) {
      const id = parseRoomId(roomId);
      if (!id) return null;
      const session = await displaySessions.lookup(req);
      return session ? checkDisplayGrant(pool, gateway, session.id, id) : null;
    },
  };
  app.decorate("auth", auth);

  const limits = new SlowLimits(pool, config);
  const trust = config.TRUST_CF_CONNECTING_IP === "1";

  // Slow-limit rows, expired sessions (display sessions too, by the same
  // statement), spent invites and display codes, hourly (design section
  // 16.3). Unref'd so the timer never keeps a test process alive.
  const timer = setInterval(() => {
    void Promise.all([
      limits.prune(),
      sessions.cleanup(),
      pool.query("delete from dm_invites where expires_at < now()"),
      pool.query("delete from display_codes where expires_at < now()"),
    ]).catch((err: unknown) => app.log.warn({ err }, "auth cleanup failed"));
  }, HOUR_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  return {
    config,
    pool,
    gateway,
    auth,
    sessions,
    displaySessions,
    hasher: deps.hasher ?? new PasswordHasher(),
    limits,
    tickets: new JoinTickets(),
    ip: (req) => ipKey(clientIp(req, trust)),
    clientIp: (req) => clientIp(req, trust),
  };
}
