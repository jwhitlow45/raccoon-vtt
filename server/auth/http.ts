import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { textSchemas } from "#shared/protocol.ts";
import type { Config } from "../config.ts";
import { RoomFullError, RoomNotFoundError, type RoomGateway } from "../rooms/gateway.ts";
import type { Role } from "./grants.ts";
import { BusyError, type PasswordHasher } from "./passwords.ts";
import type { SlowLimits, Verdict } from "./ratelimit.ts";
import { parseRoomId } from "./roomId.ts";
import type { SessionStore } from "./sessions.ts";
import type { JoinTickets } from "./tickets.ts";
import type { AuthService, GrantContext, SessionContext } from "./types.ts";

/**
 * What the access routes (server/http/rooms.ts, join.ts, dm.ts, members.ts)
 * share: the services, typed errors, and the checks every route repeats.
 */
export type AuthKit = {
  config: Config;
  pool: pg.Pool;
  gateway: RoomGateway;
  auth: AuthService;
  sessions: SessionStore;
  /** Table displays' sessions, on their own cookie (docs/design-v1-dm-tools.md 3.1). */
  displaySessions: SessionStore;
  hasher: PasswordHasher;
  limits: SlowLimits;
  tickets: JoinTickets;
  /** The caller's address as limits count it: clientIp(), then ipKey(). */
  ip(req: FastifyRequest): string;
  /** The caller's own address, from clientIp(), for Turnstile. */
  clientIp(req: FastifyRequest): string;
};

/** An expected refusal, sent as `{error: code, ...extra}` with its status. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfter: number | undefined;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: ApiErrorCode, opts: { retryAfter?: number; extra?: Record<string, unknown> } = {}) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryAfter = opts.retryAfter;
    this.extra = opts.extra;
  }
}

/** Throws 429 with Retry-After when a slow limit refuses. */
export function enforce(verdict: Verdict): void {
  if (verdict !== null) throw new HttpError(429, "rate_limited", { retryAfter: verdict });
}

/**
 * Registers routes in their own encapsulated scope, with an error handler
 * that turns the typed errors above into responses. Anything else goes on to
 * the app's default handler unchanged, so the other areas' routes keep
 * Fastify's usual errors.
 */
export async function accessRoutes(app: FastifyInstance, routes: (scope: FastifyInstance) => void): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler<Error>((err, _req, reply) => {
      if (err instanceof HttpError) {
        if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
        return reply.code(err.status).send({ error: err.code, ...err.extra });
      }
      if (err instanceof BusyError) return reply.code(429).header("retry-after", "2").send({ error: "busy" satisfies ApiErrorCode });
      if (err instanceof RoomFullError) return reply.code(409).send({ error: "room_full" satisfies ApiErrorCode });
      if (err instanceof RoomNotFoundError) return reply.code(404).send({ error: "room_not_found" satisfies ApiErrorCode });
      throw err;
    });
    routes(scope);
  });
}

/** The canonical room ID from the `:id` path parameter. */
export function roomParam(req: FastifyRequest): string {
  const id = parseRoomId((req.params as { id?: unknown }).id);
  if (!id) throw new HttpError(404, "room_not_found");
  return id;
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, "invalid_body", { extra: { field: first?.path.join(".") ?? "" } });
  }
  return parsed.data;
}

export async function requireSession(kit: AuthKit, req: FastifyRequest, reply: FastifyReply): Promise<SessionContext> {
  const session = await kit.auth.session(req, reply);
  if (!session) throw new HttpError(401, "no_session");
  return session;
}

export async function requireGrant(
  kit: AuthKit,
  req: FastifyRequest,
  reply: FastifyReply,
  roomId: string,
  role?: Role,
): Promise<GrantContext> {
  const grant = await kit.auth.grant(req, reply, roomId);
  if (!grant) throw new HttpError(403, "no_access");
  if (role && grant.role !== role) throw new HttpError(403, "dm_only");
  return grant;
}

// Shared field schemas. A name is trimmed, then held to the protocol's own
// name rule: a member name becomes a sys.memberJoin op and a room name
// becomes stored state, and replay and import check both with that rule. A
// looser rule here once let a name in that the room could not replay.
export const Name = z.string().trim().pipe(textSchemas.name);
export const Color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((c) => c.toLowerCase());
/** Any player password field. The policy itself is checked separately, only where one is set. */
export const Password = z.string().min(1).max(256);
export const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The DM's member color when none is chosen: the crest yellow, the client theme's accent and first member color. */
export const DM_COLOR = "#f7df00";
