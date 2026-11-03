import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { JOIN_MODES, type JoinMode } from "#shared/protocol.ts";
import type { AdmitOutcome, AdmitWho } from "../auth/admit.ts";
import type { AskToken } from "../auth/askSessions.ts";
import { checkGrant } from "../auth/grants.ts";
import { accessErrors, type AuthKit, Color, HttpError, Name, parseBody, requireGrant, roomParam, Token } from "../auth/http.ts";
import { ADMISSION_DEADLINE_MS, isEnding, type JoinRequest, type Refusal } from "../auth/joinRequests.ts";
import { ASK_CHALLENGE_PER_ROOM_HOUR, type AskCounts } from "../auth/ratelimit.ts";
import { continuable, newMember } from "../auth/roomRecords.ts";
import { isToken } from "../auth/tokens.ts";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.ts";
import { withTx } from "../auth/tx.ts";

/**
 * Join requests (docs/design/design-v1-join-requests.md 5.2): a newcomer
 * without the password asks, waits, and a DM device lets them in or turns
 * them away. The mode switch lives here too.
 *
 * A requester learns only its own request's state: no roster, colors in
 * use, presence, count of others waiting or who answered. The ask, `mine`,
 * wait and cancel routes find the device by its room session, else its ask
 * token, and every check of the request's id, room and device comes before
 * a held wait is touched.
 */

const AskBody = z.object({ name: Name, color: Color, turnstileToken: z.string().max(2048).optional() });
const MemberParam = z.string().min(1).max(64);
const LetInBody = z.object({
  as: z.discriminatedUnion("kind", [z.object({ kind: z.literal("new") }), z.object({ kind: z.literal("member"), memberId: MemberParam })]),
});
const TurnAwayBody = z.object({ ids: z.array(Token).min(1).max(50) });
const ModeBody = z.object({ mode: z.enum(JOIN_MODES) });

/** The admission transaction's checkout. Its statements time out at 2 s too. */
const ASK_CHECKOUT_MS = 2_000;

/**
 * The mode switch, one statement under the row lock, reading the current
 * mode in the same statement. Hashes move only when the room enters or
 * leaves Only by asking, so a repeated, retried or concurrent identical
 * switch never copies the sentinel over the real hash. `ask-only` is no PHC
 * string, so every build's password check reads it as wrong.
 */
const SWITCH_MODE = `with prev as (select join_mode, player_pw_hash_held from rooms where id = $1 for update)
update rooms r set
  join_mode = $2::text,
  player_pw_hash = case when prev.join_mode <> 'ask_only' and $2::text = 'ask_only' then 'ask-only'
                        when prev.join_mode = 'ask_only' and $2::text <> 'ask_only' then prev.player_pw_hash_held
                        else r.player_pw_hash end,
  player_pw_hash_held = case when prev.join_mode <> 'ask_only' and $2::text = 'ask_only' then r.player_pw_hash
                             when prev.join_mode = 'ask_only' and $2::text <> 'ask_only' then null
                             else r.player_pw_hash_held end
from prev
where r.id = $1 and prev.join_mode <> $2::text
  and not (prev.join_mode = 'ask_only' and $2::text <> 'ask_only' and prev.player_pw_hash_held is null)
returning prev.join_mode`;

/** The asking device: its room session, else its ask token. One id either way. */
type Device = { kind: "session" | "token"; id: string };

/** The let-in's request has no session or ask token left to grant onto: it ends as gone. */
class RequesterGone extends HttpError {
  constructor() {
    super(404, "request_gone");
  }
}
/** The let-in found the room With the password under its lock: it ends as closed. */
class AsksClosed extends HttpError {
  constructor() {
    super(404, "request_gone");
  }
}

export async function registerJoinRequestRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  const store = kit.joinRequests;

  async function deviceOf(req: FastifyRequest): Promise<Device | null> {
    const session = await kit.sessions.lookup(req);
    if (session) return { kind: "session", id: session.id };
    const token = await kit.askSessions.lookup(req);
    return token ? { kind: "token", id: token.id } : null;
  }

  /** A grant here whose member exists: the device is in already. Grants live only on sessions. */
  async function isIn(roomId: string, sessionId: string): Promise<boolean> {
    const grant = await checkGrant(kit.pool, kit.gateway, sessionId, roomId);
    return grant !== null && (await kit.gateway.getMember(roomId, grant.memberId)) !== null;
  }

  function refused(refusal: Refusal): HttpError {
    switch (refusal.code) {
      case "asks_full":
        // No Retry-After: it would tell the asker when other people's places free up.
        return new HttpError(429, "asks_full");
      case "asked_recently":
        return new HttpError(429, "asked_recently", refusal.retryAfter === undefined ? {} : { retryAfter: refusal.retryAfter });
      case "busy":
        return new HttpError(503, "busy", { retryAfter: 2 });
      case "asks_off":
        return new HttpError(403, "asks_off");
      case "room_not_found":
        return new HttpError(404, "room_not_found");
      case "request_deciding":
      case "already_in":
        return new HttpError(409, refusal.code);
    }
  }

  function needsTurnstile(counts: AskCounts, device: Device | null): boolean {
    if (!turnstileEnabled(kit.config)) return false;
    if (counts.roomAsks >= ASK_CHALLENGE_PER_ROOM_HOUR) return true;
    if (counts.addressHeldAt === null) return false;
    // A table phone that had a real session before the turn-away is not the one being held.
    const older = device?.kind === "session" && counts.sessionCreatedAt !== null && counts.sessionCreatedAt < counts.addressHeldAt;
    return !older;
  }

  /** The shape of GET /me, read by the session id, never the request's memo: the cookie may have been an ask token when the request began. */
  async function meOf(roomId: string, sessionId: string) {
    const grant = await checkGrant(kit.pool, kit.gateway, sessionId, roomId);
    if (!grant) return null;
    const member = await kit.gateway.getMember(roomId, grant.memberId);
    if (!member) return null;
    const { rows } = await kit.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId]);
    return { roomId, roomName: rows[0]?.name ?? "", role: grant.role, memberId: grant.memberId, member };
  }

  function requestParam(req: FastifyRequest): string {
    const id = (req.params as { requestId?: unknown }).requestId;
    if (typeof id !== "string" || !isToken(id)) throw new HttpError(404, "request_gone");
    return id;
  }

  function seen(r: JoinRequest) {
    return { requestId: r.id, state: r.state === "deciding" ? "waiting" : r.state, name: r.name, color: r.color, expiresAt: new Date(store.expiresAt(r)).toISOString() };
  }

  await app.register(async (r) => {
    r.setErrorHandler(accessErrors);

    r.get("/api/rooms/:id/join-requests/mine", async (req, reply) => {
      const roomId = roomParam(req);
      const device = await deviceOf(req);
      const mine = device ? store.mine(roomId, device.id) : null;
      reply.header("cache-control", "no-store");
      // Most devices that open the join page hold no request, so that is a
      // plain empty answer, not an error the browser logs on every visit.
      if (!mine) return reply.code(204).send();
      return seen(mine);
    });

    r.post("/api/rooms/:id/join-requests", async (req, reply) => {
      const startedAt = store.now();
      const roomId = roomParam(req);
      const body = parseBody(AskBody, req.body);

      // (1) The generation before the mode, so a switch to With the
      // password or a delete that lands after this read moves it.
      const generation = store.generation(roomId);
      const { rows } = await kit.pool.query<{ join_mode: JoinMode }>("select join_mode from rooms where id = $1", [roomId]);
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");
      if (room.join_mode === "password") throw new HttpError(403, "asks_off");

      // (2) The device, without minting anything.
      let device = await deviceOf(req);
      if (device?.kind === "session" && (await isIn(roomId, device.id))) throw new HttpError(409, "already_in");
      if (device) {
        const refusal = store.deviceCheck(roomId, device.id);
        if (refusal) throw refused(refusal);
      }

      // (3) This address's own counts, and whether Turnstile is needed.
      const ip = kit.ip(req);
      const counts = await kit.limits.asks(kit.pool, roomId, ip, device?.id ?? null, device?.kind === "session" ? device.id : null);
      if (counts.deviceHeld !== null) throw new HttpError(429, "asked_recently", { retryAfter: counts.deviceHeld });
      if (counts.limited !== null) throw new HttpError(429, "rate_limited", { retryAfter: counts.limited });

      // (4) A place, synchronously, so racing asks cannot overfill the caps.
      const place = store.reserve(roomId, ip, startedAt, generation);
      if ("ok" in place) throw refused(place);
      let admitted: JoinRequest | null = null;
      try {
        // (5) Turnstile, outside every lock.
        let verified = false;
        if (needsTurnstile(counts, device)) {
          if (!body.turnstileToken) throw new HttpError(403, "turnstile_required");
          const turnstile = await verifyTurnstile(kit.config, body.turnstileToken, kit.clientIp(req));
          if (turnstile === "failed") throw new HttpError(403, "turnstile_failed");
          if (turnstile === "unavailable") throw new HttpError(503, "turnstile_unavailable");
          verified = true;
        }

        // (6) The address's lock, then the room's, always in that order.
        const unlock = await store.locks.acquire([`ip:${ip}`, `room:${roomId}`]);
        try {
          if (store.now() - startedAt > ADMISSION_DEADLINE_MS) throw new HttpError(503, "busy", { retryAfter: 2 });
          const known = device;
          const written = await withTx(
            kit.pool,
            async (tx) => {
              await tx.query("set local statement_timeout = '2s'");
              const again = await kit.limits.asks(tx, roomId, ip, known?.id ?? null, known?.kind === "session" ? known.id : null);
              if (again.deviceHeld !== null) throw new HttpError(429, "asked_recently", { retryAfter: again.deviceHeld });
              if (again.limited !== null) throw new HttpError(429, "rate_limited", { retryAfter: again.limited });
              // The challenge rechecked where admissions are serialized, so a
              // burst never slips its 21st ask past it.
              if (needsTurnstile(again, known) && !verified) throw new HttpError(403, "turnstile_required");
              let found = known;
              let minted: AskToken | null = null;
              if (!found) {
                // A let-in may have promoted this cookie's token since the
                // lookups missed. One statement over one snapshot sees a
                // promotion wholly before or wholly after, so a live token is
                // never taken for neither, and never replaced.
                const cookie = req.cookies[kit.sessions.cookie.name];
                if (isToken(cookie)) {
                  const identity = await kit.askSessions.identify(tx, cookie);
                  if (identity.sessionId) found = { kind: "session", id: identity.sessionId };
                  else if (identity.askId) found = { kind: "token", id: identity.askId };
                }
                if (!found) {
                  minted = await kit.askSessions.mint(tx);
                  found = { kind: "token", id: minted.id };
                }
              }
              // A token promoted meanwhile renews nothing: its session keeps its 180 days.
              if (found.kind === "token" && !minted) await kit.askSessions.renew(tx, found.id);
              await kit.limits.recordAsk(tx, roomId, ip);
              return { device: found, minted, roomAsks: again.roomAsks + 1 };
            },
            { checkoutMs: ASK_CHECKOUT_MS },
          );
          device = written.device;

          // (8) Final admission, synchronous in the store.
          const out = store.admit(place, { sessionId: device.id, name: body.name, color: body.color });
          if (!out.ok) throw refused(out);
          admitted = out.request;
          // Only now: a token made for an ask refused above is never handed out.
          if (written.minted) kit.sessions.setCookie(reply, written.minted.token);
          if (written.roomAsks === ASK_CHALLENGE_PER_ROOM_HOUR) req.log.info({ roomId }, "join requests challenged");
        } finally {
          unlock();
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        req.log.warn({ err, roomId }, "join request admission failed");
        throw new HttpError(503, "busy", { retryAfter: 2 });
      } finally {
        // (7) Every refusal or error gives the place back.
        if (!admitted) store.release(place);
      }
      req.log.info({ roomId, requestId: admitted.id }, "join request asked");
      return reply.code(201).send({ requestId: admitted.id, expiresAt: new Date(store.expiresAt(admitted)).toISOString() });
    });

    r.post("/api/rooms/:id/join-requests/:requestId/wait", async (req, reply) => {
      const roomId = roomParam(req);
      const requestId = requestParam(req);
      const device = await deviceOf(req);
      const held = device ? store.wait(roomId, requestId, device.id) : null;
      if (!device || !held) throw new HttpError(404, "request_gone");
      // A held wait reads nothing and holds no pooled connection. A page
      // that went away lets it go, as receipts.ts does.
      const onClose = () => {
        if (!reply.raw.writableFinished) held.release();
      };
      reply.raw.on("close", onClose);
      let state: Awaited<typeof held.answer>;
      try {
        state = await held.answer;
      } finally {
        reply.raw.off("close", onClose);
      }
      reply.header("cache-control", "no-store");
      if (state === "gone") throw new HttpError(404, "request_gone");
      if (state === "in") {
        const me = await meOf(roomId, device.id);
        // Let in, then kicked or removed before this answer: nothing to enter.
        if (!me) throw new HttpError(404, "request_gone");
        return { requestId, state, me };
      }
      return { requestId, state };
    });

    r.delete("/api/rooms/:id/join-requests/:requestId", async (req, reply) => {
      const roomId = roomParam(req);
      const requestId = requestParam(req);
      const device = await deviceOf(req);
      const result = device ? store.cancel(roomId, requestId, device.id) : "gone";
      if (result === "gone") throw new HttpError(404, "request_gone");
      // A grant may already be committing. The let-in decides, and the wait hears it.
      if (result === "deciding") throw new HttpError(409, "request_deciding");
      // Answered before Cancel landed: let in, turned away, expired or closed.
      // The page asks GET /me, so a device let in never reads the ask form.
      if (result === "ended") throw new HttpError(409, "request_answered");
      req.log.debug({ roomId, requestId }, "join request cancelled");
      return reply.code(204).send();
    });

    r.get("/api/rooms/:id/join-requests", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const { rows } = await kit.pool.query<{ join_mode: JoinMode }>("select join_mode from rooms where id = $1", [roomId]);
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");
      const [challenged, players] = await Promise.all([kit.limits.askChallenged(roomId), continuable(kit, roomId, kit.admissions.inFlight(roomId))]);
      reply.header("cache-control", "no-store");
      return {
        mode: room.join_mode,
        challenged,
        // Never the requester's address, device or token. A request being let in says so, and whether its let-in answered 202.
        requests: store.list(roomId).map((x) => ({
          id: x.id,
          name: x.name,
          color: x.color,
          askedAt: new Date(x.askedAt).toISOString(),
          ...(x.state === "deciding" ? { deciding: true } : {}),
          ...(x.pending ? { pending: true } : {}),
        })),
        players,
      };
    });

    r.post("/api/rooms/:id/join-requests/:requestId/let-in", async (req, reply) => {
      // Before the carry-on pick is checked: a kick of that member from here on refuses this let-in's grant.
      const begun = kit.admissions.begin();
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const requestId = requestParam(req);
      const { as } = parseBody(LetInBody, req.body);
      const taken = store.take(roomId, requestId);
      if (!taken.ok) throw new HttpError(taken.code === "request_gone" ? 404 : 409, taken.code);
      const request = taken.request;

      // Cheap checks before a member is added for nothing. Each settles the
      // request by the table in 5.1 before it answers.
      try {
        if (!(await kit.askSessions.live(kit.pool, request.sessionId))) throw new RequesterGone();
        if (await isIn(roomId, request.sessionId)) throw new HttpError(409, "already_in");
        if (as.kind === "member") {
          // Only player members that were never a DM, and none another join is adding.
          const roster = await continuable(kit, roomId, kit.admissions.inFlight(roomId));
          if (!roster.some((m) => m.id === as.memberId)) {
            if (!(await kit.gateway.getMember(roomId, as.memberId))) throw new HttpError(409, "member_removed");
            throw new HttpError(403, "not_a_player");
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        store.settle(request.id, settlementOf({ kind: "refused", error }));
        throw answerFor(error, store.get(request.id));
      }

      const who: AdmitWho = as.kind === "new" ? { kind: "new", member: newMember(request.name, request.color, "player") } : { kind: "member", memberId: as.memberId };
      let promotedHash: Buffer | undefined;
      const answer = await kit.admissions.admit({
        roomId,
        // The requester's id from the record, never anything from this
        // request, which is the DM's: the DM's own session is untouched.
        sessionId: request.sessionId,
        who,
        begun,
        async locked(tx, room) {
          if (room.join_mode === "password") throw new AsksClosed();
          const promoted = await kit.askSessions.promote(tx, request.sessionId);
          if (promoted.state === "gone") throw new RequesterGone();
          promotedHash = promoted.hash;
          // A let-in counts as a successful join for the room and the
          // requester's address, and gives that address one ask back, but
          // neither refuses it: the DM is the gate.
          await kit.limits.recordSuccess(tx, request.ipKey, roomId);
          await kit.limits.recordLetIn(tx, roomId, request.ipKey);
        },
        maybeCommitted() {
          if (promotedHash) kit.sessions.promoted(promotedHash);
        },
        settled(outcome) {
          store.settle(request.id, settlementOf(outcome));
          req.log.info(
            { roomId, requestId: request.id, outcome: outcome.kind, by: grant.memberId, as: who.kind === "new" ? "new" : "existing" },
            "join request answered",
          );
        },
      });
      if (answer.kind === "pending") {
        store.markPending(request.id);
        return reply.code(202).send({ memberId: answer.memberId, pending: true });
      }
      if (answer.kind === "in") return { memberId: answer.memberId };
      if (answer.kind === "unknown") throw new HttpError(404, "request_gone");
      throw answerFor(answer.error, store.get(request.id));
    });

    r.post("/api/rooms/:id/join-requests/turn-away", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const { ids } = parseBody(TurnAwayBody, req.body);
      for (const turned of store.turnAway(roomId, ids)) {
        // Mirrored in the database, so a restart forgets no hold.
        await kit.limits.recordTurnAway(roomId, turned.sessionId, turned.ipKey);
        req.log.info({ roomId, requestId: turned.id, outcome: "turned_away", by: grant.memberId }, "join request answered");
      }
      return reply.code(204).send();
    });

    r.post("/api/rooms/:id/join-mode", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const { mode } = parseBody(ModeBody, req.body);
      const switched = await kit.pool.query<{ join_mode: JoinMode }>(SWITCH_MODE, [roomId, mode]);
      if (switched.rowCount !== 1) {
        // No row back: no room, the mode already set, or no password to go back to.
        const { rows } = await kit.pool.query<{ join_mode: JoinMode; held: boolean }>(
          "select join_mode, player_pw_hash_held is not null as held from rooms where id = $1",
          [roomId],
        );
        const now = rows[0];
        if (!now) throw new HttpError(404, "room_not_found");
        if (now.join_mode === mode) return { mode };
        throw new HttpError(409, "no_password");
      }
      // After the commit: entering Only by asking voids every outstanding
      // ticket, as a password change does, and With the password ends every
      // request still waiting.
      if (mode === "ask_only") kit.tickets.dropRoom(roomId);
      if (mode === "password") store.closeRoom(roomId);
      kit.gateway.joinRequestsChanged(roomId);
      req.log.info({ roomId, mode, by: grant.memberId }, "join mode changed");
      return { mode };
    });
  });
}

/** How a let-in's outcome settles its request (5.1, the table). */
function settlementOf(outcome: AdmitOutcome): "in" | "gone" | "closed" | "failed" {
  if (outcome.kind === "in") return "in";
  if (outcome.kind === "unknown") return "gone";
  const err = outcome.error;
  if (err instanceof RequesterGone) return "gone";
  if (err instanceof AsksClosed) return "closed";
  if (err instanceof HttpError && (err.code === "already_in" || err.code === "room_not_found")) return "gone";
  return "failed";
}

/**
 * The DM's answer to a refused let-in, once the request is settled. One
 * that ended is no longer asking, unless the device is in already. One
 * back to waiting gets the refusal itself.
 */
function answerFor(err: Error, request: JoinRequest | undefined): Error {
  if (err instanceof HttpError && err.code === "already_in") return err;
  if (!request || isEnding(request.state)) return new HttpError(404, "request_gone");
  return err;
}
