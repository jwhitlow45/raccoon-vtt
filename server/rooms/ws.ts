import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { clientMessageSchema, type ClientMessage } from "#shared/protocol.ts";
import { clientIp } from "../auth/clientIp.ts";
import { renewClosedDisplay } from "../auth/displaySessions.ts";
import { ipKey } from "../auth/ipKey.ts";
import { parseRoomId } from "../auth/roomId.ts";
import type { GrantContext } from "../auth/types.ts";
import type { Config } from "../config.ts";
import type { RoomActor } from "./actor.ts";
import { SlidingWindow, SocketRegistry, SustainedViolation, type Clock, type SocketCaps } from "./budgets.ts";
import { CLOSE, Connection } from "./connection.ts";
import { TooBusyError } from "./errors.ts";
import { RoomNotFoundError } from "./gateway.ts";
import type { RoomManager } from "./manager.ts";

/**
 * The WebSocket endpoint, `/ws?room=` (design sections 7.1, 7.2, 7.5, 7.6
 * and 10.4).
 *
 * Before the upgrade completes: an exact Origin match, the session cookie, a
 * current-epoch grant for the room, and the socket caps. After it: the
 * socket is bound to that grant, the room loads (or the socket closes with
 * 4011), and every frame passes the budget before it is parsed.
 *
 * `/ws?room=&as=display` is a table display's socket (docs/design-v1-dm-tools.md
 * 3.1): it takes only a display session from the display cookie, and its
 * connection keeps the role `'player'` with the `display` flag. Every other
 * socket reads only the room cookie, where a display session is none.
 *
 * Message listeners are attached synchronously in the handler, because a
 * frame that arrives before a listener exists is lost: @fastify/websocket
 * hands over a socket that is already open. Frames that arrive while the
 * room is still loading are kept, in order, and handled once it is.
 */
export type WsOptions = {
  caps?: Partial<SocketCaps>;
  /** Protocol-level ping interval (design 7.5): 30 s. */
  pingMs?: number;
  /** A socket whose send buffer stays above this for `bufferedHoldMs` is closed (design 10.4): 7 MiB for 10 s. */
  bufferedLimit?: number;
  bufferedHoldMs?: number;
  /** `scene` rate: 1 per 2 s per socket and 4 per 10 s per session. */
  scenePerSocketMs?: number;
  scenePerSessionWindowMs?: number;
  scenePerSession?: number;
  /** Frames kept while the room loads. */
  pendingFrames?: number;
  /** How long a socket may take to answer the shutdown's close before it is cut off: 2 s. */
  closeGraceMs?: number;
  /** The clock each socket's frame, op and ephemeral budgets read. It exists for tests, so a burst can be judged with no refill between its frames. */
  now?: Clock;
};

export const MAX_FRAME_BYTES = 64 * 1024;
/**
 * The send buffer a socket may hold for `bufferedHoldMs` before it is
 * closed: 1 MiB over the largest DM snapshot, 6 MiB with companion stat
 * blocks (docs/design-v1-companion-stat-blocks.md 3.4), so one snapshot
 * alone never closes a slow socket.
 */
export const DEFAULT_BUFFERED_LIMIT = 7 * 1024 * 1024;

/** The grant a socket is bound to. A table display's has the role `'player'` and `display` set. */
type SocketGrant = Omit<GrantContext, "role"> & { role: GrantContext["role"]; display: boolean };

declare module "fastify" {
  interface FastifyRequest {
    wsGrant: SocketGrant | null;
    wsIp: string | null;
  }
}

export async function registerWebSocket(app: FastifyInstance, deps: { manager: RoomManager; config: Config; options?: WsOptions }): Promise<void> {
  const { manager, config } = deps;
  const opts = deps.options ?? {};
  const registry = new SocketRegistry(opts.caps);
  const sceneSocket = new SlidingWindow(opts.scenePerSocketMs ?? 2_000, 1);
  const sceneSession = new SlidingWindow(opts.scenePerSessionWindowMs ?? 10_000, opts.scenePerSession ?? 4);
  const pingMs = opts.pingMs ?? 30_000;
  const bufferedLimit = opts.bufferedLimit ?? DEFAULT_BUFFERED_LIMIT;
  const bufferedHoldMs = opts.bufferedHoldMs ?? 10_000;
  const pendingFrames = opts.pendingFrames ?? 64;
  const trustCf = config.TRUST_CF_CONNECTING_IP === "1";
  /** Open table display sockets per session, so the last one to close can renew its session. */
  const displaySockets = new Map<string, number>();

  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: { threshold: 1024 } },
    errorHandler(error, socket, request) {
      request.log.warn({ err: error }, "websocket error");
      socket.terminate();
    },
    // Shutdown step 2 (design 15.4): every socket closes with 1012 before the
    // actors finish their commits. A client slow to answer is cut off after a
    // moment. Otherwise the server's close waits out ws's 30 s close timeout,
    // past the deploy's own limit, and the socket's last-seen stamp would
    // start after the pool had ended (server/shutdown.ts).
    preClose(done) {
      const open = [...this.websocketServer.clients];
      for (const client of open) client.close(CLOSE.restarting, "restarting");
      this.websocketServer.close();
      void socketsClosed(open, opts.closeGraceMs ?? 2_000).then(() => done());
    },
  });
  app.decorateRequest("wsGrant", null);
  app.decorateRequest("wsIp", null);

  app.get(
    "/ws",
    {
      websocket: true,
      preHandler: async (req, reply) => {
        if (req.headers.origin !== config.publicOrigin) return reply.code(403).send({ error: "cross_origin" satisfies ApiErrorCode });
        const query = req.query as { room?: unknown; as?: unknown };
        const roomId = parseRoomId(query.room);
        if (!roomId) return reply.code(404).send({ error: "room_not_found" satisfies ApiErrorCode });
        let grant: SocketGrant | null = null;
        if (query.as === "display") {
          const display = await app.auth.displayGrant(req, roomId);
          if (display) grant = { sessionId: display.sessionId, roomId, memberId: display.memberId, role: "player", display: true };
        } else {
          const room = await app.auth.grant(req, reply, roomId);
          if (room) grant = { ...room, display: false };
        }
        if (!grant) return reply.code(403).send({ error: "no_access" satisfies ApiErrorCode });
        const ip = ipKey(clientIp(req, trustCf));
        if (!registry.canOpen(grant.sessionId, roomId, ip)) return reply.code(429).send({ error: "too_many_sockets" satisfies ApiErrorCode });
        req.wsGrant = grant;
        req.wsIp = ip;
        return undefined;
      },
    },
    (socket, req) => {
      const grant = req.wsGrant;
      const ip = req.wsIp ?? "unknown";
      if (!grant) {
        socket.close(CLOSE.authFailure, "no grant");
        return;
      }
      const conn = new Connection(socket, grant, ip, { now: opts.now });
      const release = registry.open(grant.sessionId, grant.roomId, ip);
      if (conn.display) displaySockets.set(conn.sessionId, (displaySockets.get(conn.sessionId) ?? 0) + 1);
      let actor: RoomActor | null = null;
      const pending: Array<{ data: RawData; isBinary: boolean }> = [];
      let inbound: Promise<void> = Promise.resolve();
      const stalled = new SustainedViolation(bufferedHoldMs);

      /** Keeps the socket's messages in order while each one does its own reads before joining the room queue. */
      const chain = (work: () => Promise<void> | void): void => {
        inbound = inbound.then(work).catch((err: unknown) => {
          req.log.warn({ err, roomId: grant.roomId }, "websocket message failed");
          conn.close(1011, "internal error");
        });
      };

      const handle = (data: RawData, isBinary: boolean): void => {
        const room = actor;
        if (!room || conn.closed) return;
        if (isBinary) {
          conn.close(CLOSE.authFailure, "binary frame");
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(rawToString(data));
        } catch {
          conn.close(CLOSE.authFailure, "not json");
          return;
        }
        const parsed = clientMessageSchema.safeParse(json);
        if (!parsed.success) {
          // An oversized or malformed ephemeral event is dropped like an over-budget frame. Anything else is a broken client.
          // A table display sends none at all, so one from it closes it as a valid one would (dispatch below).
          if (!conn.display && json !== null && typeof json === "object" && (json as { t?: unknown }).t === "eph") return;
          conn.close(CLOSE.authFailure, "invalid message");
          return;
        }
        dispatch(room, parsed.data);
      };

      const dispatch = (room: RoomActor, msg: ClientMessage): void => {
        // A table display sends nothing but `hello` and `ping`. Only a hostile client would.
        if (conn.display && msg.t !== "hello" && msg.t !== "ping") {
          conn.close(CLOSE.authFailure, "a table display sends nothing");
          return;
        }
        switch (msg.t) {
          case "ping":
            conn.send({ t: "pong", k: msg.k });
            return;
          case "hello":
            if (!conn.helloAllowed || conn.helloPending) {
              conn.close(CLOSE.authFailure, "unexpected hello");
              return;
            }
            conn.helloAllowed = false;
            conn.helloPending = true;
            chain(() => room.hello(conn, msg));
            return;
          case "op":
            if (conn.helloCount === 0) {
              conn.close(CLOSE.authFailure, "op before hello");
              return;
            }
            chain(() => room.op(conn, msg.n, msg.op, msg.g));
            return;
          case "eph":
            room.ephemeral(conn, msg);
            return;
          case "scene":
            if (conn.role !== "dm") {
              conn.close(CLOSE.authFailure, "scene is for the DM");
              return;
            }
            if (conn.helloCount === 0 || conn.helloPending || !sceneSocket.tryAdd(`c:${conn.id}`) || !sceneSession.tryAdd(`s:${conn.sessionId}`)) {
              conn.send({ t: "retry", code: "busy" });
              return;
            }
            room.scene(conn);
            return;
        }
      };

      socket.on("message", (data: RawData, isBinary: boolean) => {
        try {
          if (conn.closed) return;
          const verdict = conn.frames.accept(rawLength(data));
          if (verdict === "abuse") {
            conn.close(CLOSE.abuse, "frame budget");
            return;
          }
          if (verdict === "drop") return;
          if (!actor) {
            if (pending.length < pendingFrames) pending.push({ data, isBinary });
            return;
          }
          handle(data, isBinary);
        } catch (err) {
          req.log.warn({ err, roomId: grant.roomId }, "websocket frame failed");
          conn.close(1011, "internal error");
        }
      });
      socket.on("close", () => {
        try {
          release();
          // Connection ids never repeat, so this key would otherwise wait for a sweep.
          sceneSocket.forget(`c:${conn.id}`);
          conn.closed = true;
          conn.clearTimers();
          actor?.detach(conn);
          actor = null;
          if (conn.display) displayClosed(conn);
        } catch (err) {
          req.log.warn({ err, roomId: grant.roomId }, "websocket close failed");
        }
      });
      socket.on("pong", () => {
        conn.alive = true;
      });
      socket.on("error", () => undefined);

      conn.every(pingMs, () => {
        if (!conn.alive) {
          conn.terminate();
          return;
        }
        conn.alive = false;
        try {
          socket.ping();
        } catch {
          conn.terminate();
        }
      });
      conn.every(1_000, () => {
        if (socket.bufferedAmount > bufferedLimit) {
          if (stalled.over()) conn.close(CLOSE.stalled, "send buffer full");
        } else {
          stalled.reset();
        }
      });

      /**
       * A display's session ends 30 days after its last socket closed
       * (docs/design-v1-dm-tools.md 3.1). A socket the server closed with
       * 4001 renews nothing, so a sign out, a password change or an expired
       * session is never undone by the close that follows it.
       */
      const displayClosed = (closing: Connection): void => {
        const left = (displaySockets.get(closing.sessionId) ?? 1) - 1;
        if (left > 0) {
          displaySockets.set(closing.sessionId, left);
          return;
        }
        displaySockets.delete(closing.sessionId);
        if (closing.closedWith === CLOSE.grantRevoked) return;
        manager.closeWrites.run(
          () => renewClosedDisplay(app.pool, closing.sessionId),
          (err) => req.log.warn({ err }, "display session renewal failed"),
        );
      };

      void (async () => {
        try {
          for (let attempt = 0; attempt < 2 && !actor; attempt++) {
            const room = await manager.acquire(grant.roomId);
            if (conn.closed) return;
            if (room.attach(conn)) actor = room;
          }
          if (!actor) {
            conn.close(CLOSE.tooBusy, "room unavailable");
            return;
          }
          for (const frame of pending.splice(0)) handle(frame.data, frame.isBinary);
        } catch (err) {
          if (err instanceof TooBusyError) conn.close(CLOSE.tooBusy, "too busy");
          else if (err instanceof RoomNotFoundError) conn.close(CLOSE.roomClosed, "room not found");
          else {
            req.log.error({ err, roomId: grant.roomId }, "room load failed");
            conn.close(1011, "internal error");
          }
        }
      })();
    },
  );
}

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data.byteLength;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * Resolves once every socket has closed, cutting off those still open after
 * `graceMs`. The socket layer's own close listener was added first, so a
 * socket's close writes have started by the time it counts as closed here.
 */
async function socketsClosed(sockets: WebSocket[], graceMs: number): Promise<void> {
  if (sockets.length === 0) return;
  const closed = Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()))));
  if (await within(closed, graceMs)) return;
  for (const socket of sockets) socket.terminate();
  // A socket cut off reports its close a moment later.
  await within(closed, 1_000);
}

async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const done = await Promise.race([
    work.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return done;
}
