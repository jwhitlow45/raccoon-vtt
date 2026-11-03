import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JoinMode } from "#shared/protocol.ts";
import type { AdmitWho } from "../auth/admit.ts";
import { checkGrant } from "../auth/grants.ts";
import {
  accessErrors,
  type AuthKit,
  Color,
  enforce,
  HttpError,
  Name,
  parseBody,
  Password,
  requireSession,
  roomParam,
  Token,
} from "../auth/http.ts";
import { continuable, newMember } from "../auth/roomRecords.ts";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.ts";
import { withTx } from "../auth/tx.ts";

/**
 * Joining as a player, in two steps so the roster is never shown before the
 * password (design section 10.2):
 *
 * 1. `join` checks the password and returns a join ticket, the player
 *    roster and the DMs' current colors.
 * 2. `join/complete` spends the ticket to continue as a listed player or to
 *    become a new one. A new player's member is added first and its grant
 *    written second (server/auth/admit.ts), so a failure in between leaves
 *    an unused member, never a grant without one.
 *
 * Once a room has seen many wrong passwords in an hour, step 1 also needs a
 * solved Turnstile check (design 10.3). Without TURNSTILE_SECRET there is no
 * check, and step 1 behaves as it always did.
 */

const JoinBody = z.object({ password: Password, turnstileToken: z.string().max(2048).optional() });
const CompleteBody = z.union([
  z.object({ ticket: Token, memberId: z.string().min(1).max(64) }),
  z.object({ ticket: Token, name: Name, color: Color }),
]);

export async function registerJoinRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  await app.register(async (r) => {
    r.setErrorHandler(accessErrors);
    r.post("/api/rooms/:id/join", async (req, reply) => {
      const roomId = roomParam(req);
      const { password, turnstileToken } = parseBody(JoinBody, req.body);
      const { rows } = await kit.pool.query<{ player_pw_hash: string; player_epoch: number; join_mode: JoinMode }>(
        "select player_pw_hash, player_epoch, join_mode from rooms where id = $1",
        [roomId],
      );
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");
      // Only by asking: the password lets nobody new in, so it is refused
      // before the limits and the hash, and counts for nothing.
      if (room.join_mode === "ask_only") throw new HttpError(403, "asks_only");

      const ip = kit.ip(req);
      enforce(await kit.limits.failures(roomId, ip));
      enforce(await kit.limits.successes(ip, roomId));
      // Before the hash, so a guess that fails the challenge never takes a
      // place in the argon2 queue. The per-IP limits above still apply to
      // everyone, challenged or not.
      if (turnstileEnabled(kit.config) && (await kit.limits.joinChallenged(roomId))) {
        if (!turnstileToken) throw new HttpError(403, "turnstile_required");
        const turnstile = await verifyTurnstile(kit.config, turnstileToken, kit.clientIp(req));
        if (turnstile === "failed") throw new HttpError(403, "turnstile_failed");
        if (turnstile === "unavailable") throw new HttpError(503, "turnstile_unavailable");
      }
      if (!(await kit.hasher.verify(room.player_pw_hash, password))) {
        await kit.limits.recordPasswordFailure(roomId, ip);
        throw new HttpError(403, "bad_password");
      }

      // A session is created only on success, so failed guesses cannot mint
      // sessions and earn the larger per-session request allowance.
      const session = await withTx(kit.pool, async (tx) => {
        const ensured = await kit.sessions.ensure(tx, req);
        await kit.limits.recordSuccess(tx, ip, roomId);
        return ensured;
      });
      if (session.created) kit.sessions.setCookie(reply, session.row.token);

      // The epoch read before the hash: if the password changed meanwhile,
      // this ticket is already dead, which is the safe answer.
      const ticket = kit.tickets.mint(roomId, session.row.id, room.player_epoch);
      const [players, dmColors] = await Promise.all([continuable(kit, roomId, kit.admissions.inFlight(roomId)), currentDmColors(kit, roomId)]);
      return { ticket, players, dmColors };
    });

    r.post("/api/rooms/:id/join/complete", async (req, reply) => {
      const roomId = roomParam(req);
      const body = parseBody(CompleteBody, req.body);
      const { sessionId } = await requireSession(kit, req, reply);

      // A ticket from another room or another device is refused without
      // being used up, so it cannot be burned by someone who saw it.
      const peeked = kit.tickets.peek(body.ticket);
      if (!peeked || peeked.roomId !== roomId || peeked.sessionId !== sessionId) {
        throw new HttpError(403, "bad_ticket");
      }
      // An earlier try with this ticket is still settling. The page asks
      // GET /me, and tries again in a moment if the device is not in yet.
      if (peeked.reserved) throw new HttpError(503, "busy", { retryAfter: 1 });

      // A DM device that joined as a player would lose its DM grant without
      // the DM cleanup. It can sign out as a DM device first.
      const current = await checkGrant(kit.pool, kit.gateway, sessionId, roomId);
      if (current?.role === "dm") throw new HttpError(409, "already_dm");
      // Another tab of this device finished first.
      if (current && (await kit.gateway.getMember(roomId, current.memberId))) throw new HttpError(409, "already_in");

      let who: AdmitWho;
      if ("memberId" in body) {
        // Only player members that were never a DM can be continued. A
        // member that is no longer in the room was most likely removed by
        // the DM while this device's roster was open: the join page says so
        // and offers joining as someone new, with the ticket still unused.
        const roster = await continuable(kit, roomId, kit.admissions.inFlight(roomId));
        if (!roster.some((m) => m.id === body.memberId)) {
          if (!(await kit.gateway.getMember(roomId, body.memberId))) throw new HttpError(409, "member_removed");
          throw new HttpError(403, "not_a_player");
        }
        who = { kind: "member", memberId: body.memberId };
      } else {
        who = { kind: "new", member: newMember(body.name, body.color, "player") };
      }

      const ticket = kit.tickets.reserve(body.ticket);
      if (ticket === "reserved") throw new HttpError(503, "busy", { retryAfter: 1 });
      if (!ticket) throw new HttpError(403, "bad_ticket");

      // A new player's member is written before its grant (server/auth/admit.ts).
      // The ticket stays reserved until the attempt settles: spent once the
      // grant commits, back for another try once it is known to have failed.
      const answer = await kit.admissions.admit({
        roomId,
        sessionId,
        who,
        // The epoch is checked under the room row lock, in the transaction
        // that writes the grant, so a password change cannot slip in between.
        async locked(_tx, room) {
          // A ticket minted before the switch to Only by asking, or by a
          // check that was in flight during it, is refused here.
          if (room.join_mode === "ask_only") throw new HttpError(403, "asks_only");
          if (room.player_epoch !== ticket.playerEpoch) throw new HttpError(403, "stale_ticket");
        },
        settled(outcome) {
          if (outcome.kind === "in") kit.tickets.spend(body.ticket);
          else kit.tickets.release(body.ticket);
        },
      });
      // Still settling, or settled without a way to tell whether the grant
      // landed: GET /me says whether the device is in.
      if (answer.kind === "pending" || answer.kind === "unknown") throw new HttpError(503, "busy", { retryAfter: 2 });
      if (answer.kind === "refused") throw answer.error;
      // The same shape as GET /api/rooms/:id/me, because the join page
      // hands this answer straight to the room as the caller's member.
      return { roomId, memberId: answer.memberId, role: "player", member: answer.member };
    });
  });
}

/**
 * The colors the room's DMs use now, one per DM in join order, so the join
 * page can mark them as taken (docs/design/design-v1-visual.md 4.4). A DM can
 * change color, so the page cannot assume the yellow they start with.
 * Colors only: who the DMs are stays out of a step a player reaches with
 * the password alone.
 */
async function currentDmColors(kit: AuthKit, roomId: string): Promise<string[]> {
  const dms = (await kit.gateway.dmRoster(roomId)) ?? [];
  return dms.map((m) => m.color);
}
