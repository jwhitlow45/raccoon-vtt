import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The contract between authentication and everything that needs to know who
 * is calling. server/auth implements it and decorates the app with it as
 * `app.auth`. Routes in other areas (assets, search, export, the WebSocket)
 * depend only on this interface, so they can be built and tested with a fake.
 *
 * Authority comes from the grant, never from the member record (design
 * section 10.2): `role` here is the role of this session in this room, at the
 * room's current epoch.
 */
export type SessionContext = { sessionId: string };

export type GrantContext = {
  sessionId: string;
  roomId: string;
  memberId: string;
  role: "dm" | "player";
};

/**
 * A table display's grant (docs/design-v1-dm-tools.md 3.1). It comes only
 * from a display session in the display cookie, and its member id is
 * `display:<12 random characters>`, which no member has. Its socket keeps
 * the role `'player'`, so it receives what a player who owns nothing does.
 */
export type DisplayGrantContext = {
  sessionId: string;
  roomId: string;
  memberId: string;
  role: "display";
};

export interface AuthService {
  /**
   * The room session from the room cookie, or null. Slides the cookie's
   * Max-Age at most once a day. A display session is never one, whatever
   * cookie it arrives in.
   */
  session(req: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null>;
  /** The caller's grant for this room at the current epoch, or null. Stale grants are deleted. */
  grant(req: FastifyRequest, reply: FastifyReply, roomId: string): Promise<GrantContext | null>;
  /**
   * The display session's grant for this room, from the display cookie only,
   * or null. The session is never slid: only its sockets renew it. A grant
   * from an older player epoch is deleted.
   */
  displayGrant(req: FastifyRequest, roomId: string): Promise<DisplayGrantContext | null>;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthService;
  }
}
