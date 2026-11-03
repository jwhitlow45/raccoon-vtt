import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { RoomGateway } from "../rooms/gateway.ts";
import { Admissions, type AdmissionsOptions } from "./admit.ts";
import { AskSessions } from "./askSessions.ts";
import { clientIp } from "./clientIp.ts";
import { checkDisplayGrant, checkGrant } from "./grants.ts";
import { ipKey } from "./ipKey.ts";
import type { AuthKit } from "./http.ts";
import { JoinRequests, SWEEP_MS, type JoinRequestOptions } from "./joinRequests.ts";
import { PasswordHasher } from "./passwords.ts";
import { registerRequestLimits, SlowLimits } from "./ratelimit.ts";
import { parseRoomId } from "./roomId.ts";
import { assertCookieSettings, cookieSettings, displayCookieSettings, SessionStore } from "./sessions.ts";
import { JoinTickets } from "./tickets.ts";
import type { AuthService } from "./types.ts";

const HOUR_MS = 3_600_000;

/** Timings of the join paths, for tests. `sweepMs` runs the join sweep and its follow-ups that often. */
export type AccessOptions = { admissions?: AdmissionsOptions; joinRequests?: JoinRequestOptions; sweepMs?: number };

/**
 * Sets up authentication on the app: the cookie parser, the per-request rate
 * limiter, `app.auth`, and the hourly cleanup of expired rows.
 *
 * Call it before registering any route, because the rate limiter only
 * covers routes added after it.
 */
export async function setupAuth(
  app: FastifyInstance,
  deps: { config: Config; pool: pg.Pool; gateway: RoomGateway; hasher?: PasswordHasher | undefined; access?: AccessOptions | undefined },
): Promise<AuthKit> {
  const { config, pool, gateway } = deps;
  const cookie = cookieSettings(config);
  assertCookieSettings(config, cookie);
  const displayCookie = displayCookieSettings(config);
  assertCookieSettings(config, displayCookie);

  await app.register(fastifyCookie);
  const sessions = new SessionStore(pool, cookie);
  // Ask tokens share the room cookie, and every path that makes a room
  // session adopts one (docs/design/design-v1-join-requests.md 5.1).
  const askSessions = new AskSessions(pool, sessions);
  sessions.adoptAskTokens(askSessions);
  // Table displays (docs/design/design-v1-dm-tools.md 3.1): a second store on a
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
  // statement) and ask tokens, spent invites and display codes, hourly
  // (design section 16.3). Unref'd so the timer never keeps a test process
  // alive.
  const timer = setInterval(() => {
    void Promise.all([
      limits.prune(),
      sessions.cleanup(),
      askSessions.cleanup(),
      pool.query("delete from dm_invites where expires_at < now()"),
      pool.query("delete from display_codes where expires_at < now()"),
    ]).catch((err: unknown) => app.log.warn({ err }, "auth cleanup failed"));
  }, HOUR_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  // Join requests (docs/design/design-v1-join-requests.md 5.1): in memory,
  // signalled to the DM sockets, swept every 15 s with the follow-ups of
  // joins whose outcome or member removal is still owed.
  const lifeS = config.JOIN_REQUEST_LIFE_S;
  const joinRequests = new JoinRequests({ ...(lifeS !== undefined && !config.production ? { lifeMs: lifeS * 1000 } : {}), ...deps.access?.joinRequests });
  joinRequests.onChange((roomId) => gateway.joinRequestsChanged(roomId));
  app.decorate("joinRequests", joinRequests);
  const admissions = new Admissions({ pool, gateway, log: app.log, options: deps.access?.admissions, changed: (roomId) => joinRequests.changed(roomId) });
  const sweep = setInterval(() => {
    joinRequests.sweep();
    void admissions.followUp().catch((err: unknown) => app.log.warn({ err }, "join follow-up failed"));
    void joinRequests.retryHolds(
      (hold) => limits.recordTurnAway(hold.roomId, hold.sessionId, hold.ipKey, hold.at, () => joinRequests.now()),
      (err, hold) => app.log.warn({ err, roomId: hold.roomId }, "join request hold not saved yet"),
    );
  }, deps.access?.sweepMs ?? SWEEP_MS);
  sweep.unref();
  // Before the server waits out its open requests: a held wait answers at
  // once, so closing never sits out a 25 s hold (as the socket layer's
  // preClose does for sockets).
  app.addHook("preClose", async () => joinRequests.close());
  app.addHook("onClose", async () => clearInterval(sweep));

  return {
    config,
    pool,
    gateway,
    auth,
    sessions,
    displaySessions,
    askSessions,
    hasher: deps.hasher ?? new PasswordHasher(),
    limits,
    tickets: new JoinTickets(),
    admissions,
    joinRequests,
    ip: (req) => ipKey(clientIp(req, trust)),
    clientIp: (req) => clientIp(req, trust),
  };
}
