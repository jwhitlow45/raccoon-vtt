import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkGrant, formerDms, putGrant, revokeGrants } from "../auth/grants.ts";
import {
  accessRoutes,
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
import { newMember } from "../auth/roomRecords.ts";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.ts";
import { withTx } from "../auth/tx.ts";
import { RoomFullError, type RosterEntry } from "../rooms/gateway.ts";

/**
 * Joining as a player, in two steps so the roster is never shown before the
 * password (design section 10.2):
 *
 * 1. `join` checks the password and returns a join ticket, the player
 *    roster and the DMs' current colors.
 * 2. `join/complete` spends the ticket to continue as a listed player or to
 *    become a new one, and writes the player grant.
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

export function registerJoinRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  return accessRoutes(app, (r) => {
    r.post("/api/rooms/:id/join", async (req, reply) => {
      const roomId = roomParam(req);
      const { password, turnstileToken } = parseBody(JoinBody, req.body);
      const { rows } = await kit.pool.query<{ player_pw_hash: string; player_epoch: number }>(
        "select player_pw_hash, player_epoch from rooms where id = $1",
        [roomId],
      );
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");

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
      const [players, dmColors] = await Promise.all([continuable(kit, roomId), currentDmColors(kit, roomId)]);
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

      // A DM device that joined as a player would lose its DM grant without
      // the DM cleanup. It can sign out as a DM device first.
      const current = await checkGrant(kit.pool, kit.gateway, sessionId, roomId);
      if (current?.role === "dm") throw new HttpError(409, "already_dm");

      let memberId: string;
      let created: ReturnType<typeof newMember> | undefined;
      if ("memberId" in body) {
        // Only player members that were never a DM can be continued. A
        // member that is no longer in the room was most likely removed by
        // the DM while this device's roster was open: the join page says so
        // and offers joining as someone new, with the ticket still unused.
        const roster = await continuable(kit, roomId);
        if (!roster.some((m) => m.id === body.memberId)) {
          if (!(await kit.gateway.getMember(roomId, body.memberId))) throw new HttpError(409, "member_removed");
          throw new HttpError(403, "not_a_player");
        }
        memberId = body.memberId;
      } else {
        created = newMember(body.name, body.color, "player");
        memberId = created.id;
      }

      const ticket = kit.tickets.take(body.ticket);
      if (!ticket) throw new HttpError(403, "bad_ticket");

      // The epoch is checked under the room row lock, in the transaction that
      // writes the grant, so a password change cannot slip in between.
      await withTx(kit.pool, async (tx) => {
        const { rows } = await tx.query<{ player_epoch: number }>(
          "select player_epoch from rooms where id = $1 for update",
          [roomId],
        );
        const room = rows[0];
        if (!room) throw new HttpError(404, "room_not_found");
        if (room.player_epoch !== ticket.playerEpoch) throw new HttpError(403, "stale_ticket");
        // Again under the room lock, which a DM claim also takes, so a
        // member that became a DM a moment ago cannot slip through.
        if (!created && (await formerDms(tx, roomId)).has(memberId)) throw new HttpError(403, "not_a_player");
        await putGrant(tx, { sessionId, roomId, memberId, role: "player", epoch: room.player_epoch });
      });

      if (created) {
        // The member is added after the grant commits, so a grant that lost a
        // race never leaves an orphan in the roster. The caller cannot
        // connect before this response, so nothing sees the gap.
        try {
          await kit.gateway.addMember(roomId, created);
        } catch (err) {
          await revokeGrants(kit, roomId, { by: "session", sessionId, role: "player" });
          if (err instanceof RoomFullError) kit.tickets.restore(body.ticket, ticket);
          throw err;
        }
      }
      // The same shape as GET /api/rooms/:id/me, because the join page
      // hands this answer straight to the room as the caller's member.
      const member = (await kit.gateway.getMember(roomId, memberId)) ?? created ?? null;
      if (!member) {
        // The DM removed this member while the grant was being written. A
        // grant must never outlive its member, so this one is given up. The
        // ticket goes back, as with a full room: the password was right, so
        // the device may still join as someone new without typing it again.
        await revokeGrants(kit, roomId, { by: "session", sessionId, role: "player" });
        kit.tickets.restore(body.ticket, ticket);
        throw new HttpError(409, "member_removed");
      }
      return { roomId, memberId, role: "player", member };
    });
  });
}

/** The players a joining device may continue as: player members that were never a DM, in join order. */
async function continuable(kit: AuthKit, roomId: string): Promise<RosterEntry[]> {
  const roster = (await kit.gateway.playerRoster(roomId)) ?? [];
  const dms = await formerDms(kit.pool, roomId);
  return roster.filter((m) => !dms.has(m.id));
}

/**
 * The colors the room's DMs use now, one per DM in join order, so the join
 * page can mark them as taken (docs/design-v1-visual.md 4.4). A DM can
 * change color, so the page cannot assume the yellow they start with.
 * Colors only: who the DMs are stays out of a step a player reaches with
 * the password alone.
 */
async function currentDmColors(kit: AuthKit, roomId: string): Promise<string[]> {
  const dms = (await kit.gateway.dmRoster(roomId)) ?? [];
  return dms.map((m) => m.color);
}
