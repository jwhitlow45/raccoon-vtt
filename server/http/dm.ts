import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { deviceLabel } from "../auth/device.ts";
import { checkGrant, putGrant, revokeGrants } from "../auth/grants.ts";
import {
  accessRoutes,
  type AuthKit,
  Color,
  DM_COLOR,
  enforce,
  HttpError,
  Name,
  parseBody,
  requireGrant,
  roomParam,
  Token,
} from "../auth/http.ts";
import { dmLink, inviteLink } from "../auth/roomId.ts";
import { newMember, replaceDmKey } from "../auth/roomRecords.ts";
import { randomToken, sha256, tokenMatches } from "../auth/tokens.ts";
import { withTx } from "../auth/tx.ts";

/**
 * DM access (design section 10.2): claiming DM with the key, device invites,
 * the DM devices list, removing a co-DM, and replacing the DM link.
 */

const MemberParam = z.string().min(1).max(64);
/**
 * Who a device with no member in the room becomes: one of the room's
 * current DM members (`memberId`, "This is me"), or a new DM member (`name`).
 * With neither, the answer is the list to choose from.
 */
const Who = { name: Name.optional(), color: Color.optional(), memberId: MemberParam.optional() };
const ClaimBody = z.object({ key: Token, ...Who });
const RedeemBody = z.object({ token: Token, ...Who });
const SessionParam = z.uuid();

const INVITE_MINUTES = 10;
/** Unused invites a room may hold at once, so a DM device cannot fill the table. */
const MAX_OPEN_INVITES = 20;

/**
 * The redemption statement from the design, verbatim in effect: an invite
 * from another room, a used one, an expired one, or one minted before a link
 * replacement matches nothing.
 */
const REDEEM = `update dm_invites set used_at = now()
  where token_hash = $1 and room_id = $2 and used_at is null and expires_at > now()
    and dm_epoch = (select dm_epoch from rooms where id = $2)
  returning room_id`;

const INVITE_VALID = `select 1 from dm_invites
  where token_hash = $1 and room_id = $2 and used_at is null and expires_at > now()
    and dm_epoch = (select dm_epoch from rooms where id = $2)`;

type LockedRoom = { dm_epoch: number; dm_key_hash: Buffer };

/**
 * What a DM claim and an invite redemption share once the secret checks
 * out: rotate the session (or create one), make the caller's member a DM
 * member, and write a DM grant at the current `dm_epoch`.
 *
 * `consume` re-checks the secret inside the transaction, under the room row
 * lock, so a link replaced or an invite spent a moment ago is refused.
 */
async function becomeDm(
  kit: AuthKit,
  req: FastifyRequest,
  reply: FastifyReply,
  roomId: string,
  who: { name?: string | undefined; color?: string | undefined; memberId?: string | undefined },
  consume: (tx: pg.PoolClient, room: LockedRoom) => Promise<void>,
): Promise<{ roomId: string; memberId: string; role: "dm" }> {
  const ip = kit.ip(req);
  const current = await kit.sessions.lookup(req);
  const existing = current ? await checkGrant(kit.pool, kit.gateway, current.id, roomId) : null;

  // A device that is already in the room keeps its member: a player becomes
  // a DM member, and only this session's grant changes. That member's other
  // devices keep their player grants.
  //
  // A device with no member here is one DM's second phone or laptop far
  // more often than a new co-DM, so it may continue as a current DM member,
  // which keeps one person one member: one undo history, one set of
  // whispers. The DM key or invite already gives full DM rights. Picking a
  // DM member also opens that member's whispers, which the owner accepted:
  // whoever holds the DM key is trusted as the DM (design 10.2). A player
  // member can never be picked, which would put a player's whispers behind
  // the DM key.
  let memberId: string;
  let created: ReturnType<typeof newMember> | undefined;
  if (existing) {
    memberId = existing.memberId;
  } else if (who.memberId) {
    const member = await kit.gateway.getMember(roomId, who.memberId);
    if (!member) throw new HttpError(409, "member_removed");
    if (member.kind !== "dm") throw new HttpError(403, "not_a_dm");
    memberId = member.id;
  } else if (who.name) {
    created = newMember(who.name, who.color ?? DM_COLOR, "dm");
    memberId = created.id;
  } else {
    // Answered before the transaction, so asking never spends an invite.
    const dmMembers = (await kit.gateway.dmRoster(roomId)) ?? [];
    throw new HttpError(409, "choose_member", { extra: { roomId, dmMembers } });
  }

  const session = await withTx(kit.pool, async (tx) => {
    const { rows } = await tx.query<LockedRoom>("select dm_epoch, dm_key_hash from rooms where id = $1 for update", [
      roomId,
    ]);
    const room = rows[0];
    if (!room) throw new HttpError(404, "room_not_found");
    await consume(tx, room);
    const row = current ? await kit.sessions.rotate(tx, req, current.id) : await kit.sessions.create(tx, req);
    await putGrant(tx, { sessionId: row.id, roomId, memberId, role: "dm", epoch: room.dm_epoch });
    await kit.limits.recordSuccess(tx, ip, roomId);
    return row;
  });
  // The old token died with the commit, so the new cookie goes out whatever
  // happens next.
  kit.sessions.setCookie(reply, session.token);

  if (created) {
    try {
      await kit.gateway.addMember(roomId, created);
    } catch (err) {
      // Even this rollback of a grant written a moment ago goes through the
      // one cleanup every DM grant removal uses.
      await revokeGrants(kit, roomId, { by: "session", sessionId: session.id, role: "dm" });
      throw err;
    }
  } else {
    await kit.gateway.setMemberKind(roomId, memberId, "dm");
    if (!(await kit.gateway.getMember(roomId, memberId))) {
      // The DM removed this device's member while it claimed. A grant must
      // never outlive its member: the device signs in again as a new one.
      await revokeGrants(kit, roomId, { by: "session", sessionId: session.id, role: "dm" });
      throw new HttpError(409, "member_removed");
    }
  }
  // A new DM device, and maybe an invite used: the DM devices list and an
  // invite card waiting for its device change on every DM's screen. Its
  // member may already be online on another device, so presence alone does
  // not say so.
  kit.gateway.accessChanged(roomId);
  return { roomId, memberId, role: "dm" };
}

/** Redeems an invite for a room already known to hold it. */
async function redeem(
  kit: AuthKit,
  req: FastifyRequest,
  reply: FastifyReply,
  roomId: string,
  body: z.infer<typeof RedeemBody>,
): Promise<{ roomId: string; memberId: string; role: "dm" }> {
  const hash = sha256(body.token);
  enforce(await kit.limits.successes(kit.ip(req), roomId));
  // Checked before anything else, so a dead invite reads as dead rather than
  // asking for a name it will never use.
  const valid = await kit.pool.query(INVITE_VALID, [hash, roomId]);
  if (valid.rowCount !== 1) throw new HttpError(403, "bad_invite");
  return becomeDm(kit, req, reply, roomId, body, async (tx) => {
    const spent = await tx.query(REDEEM, [hash, roomId]);
    if (spent.rowCount !== 1) throw new HttpError(403, "bad_invite");
  });
}

export function registerDmRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  return accessRoutes(app, (r) => {
    r.post("/api/rooms/:id/dm", async (req, reply) => {
      const roomId = roomParam(req);
      const body = parseBody(ClaimBody, req.body);
      const { rows } = await kit.pool.query<{ dm_key_hash: Buffer }>("select dm_key_hash from rooms where id = $1", [
        roomId,
      ]);
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");

      const ip = kit.ip(req);
      enforce(await kit.limits.failures(roomId, ip));
      enforce(await kit.limits.successes(ip, roomId));
      if (!tokenMatches(body.key, room.dm_key_hash)) {
        await kit.limits.recordFailure(roomId, ip);
        throw new HttpError(403, "bad_key");
      }
      return becomeDm(kit, req, reply, roomId, body, async (_tx, locked) => {
        if (!tokenMatches(body.key, locked.dm_key_hash)) throw new HttpError(403, "bad_key");
      });
    });

    r.post("/api/rooms/:id/dm/invite", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const open = await kit.pool.query<{ n: number }>(
        "select count(*)::int as n from dm_invites where room_id = $1 and used_at is null and expires_at > now()",
        [roomId],
      );
      if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_INVITES) throw new HttpError(429, "too_many_invites");
      const token = randomToken();
      const { rows } = await kit.pool.query<{ expires_at: Date }>(
        `insert into dm_invites (token_hash, room_id, created_by_session, dm_epoch, expires_at)
         select $1, id, $3, dm_epoch, now() + make_interval(mins => $4) from rooms where id = $2
         returning expires_at`,
        [sha256(token), roomId, grant.sessionId, INVITE_MINUTES],
      );
      const invite = rows[0];
      if (!invite) throw new HttpError(404, "room_not_found");
      return reply
        .code(201)
        .send({ token, link: inviteLink(roomId, token), expiresAt: invite.expires_at.toISOString() });
    });

    r.post("/api/rooms/:id/dm/redeem", async (req, reply) => {
      const roomId = roomParam(req);
      const body = parseBody(RedeemBody, req.body);
      return redeem(kit, req, reply, roomId, body);
    });

    // A bare token, typed without its link, names no room. The invite's
    // primary key finds it, then the same redemption runs.
    r.post("/api/dm/redeem", async (req, reply) => {
      const body = parseBody(RedeemBody, req.body);
      const { rows } = await kit.pool.query<{ room_id: string }>("select room_id from dm_invites where token_hash = $1", [
        sha256(body.token),
      ]);
      const invite = rows[0];
      if (!invite) throw new HttpError(403, "bad_invite");
      return redeem(kit, req, reply, invite.room_id, body);
    });

    // Table displays are listed too (docs/design-v1-dm-tools.md 3.1), marked
    // `display`, so a DM can see a TV and sign it out like any DM device.
    r.get("/api/rooms/:id/dm/devices", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const { rows } = await kit.pool.query<{
        session_id: string;
        member_id: string;
        role: "dm" | "display";
        user_agent: string | null;
        last_seen_at: Date;
      }>(
        `select g.session_id, g.member_id, g.role, s.user_agent, s.last_seen_at
         from grants g
         join rooms r on r.id = g.room_id
         join sessions s on s.id = g.session_id
         where g.room_id = $1
           and ((g.role = 'dm' and g.epoch = r.dm_epoch)
             or (g.role = 'display' and g.epoch = r.player_epoch and s.expires_at > now()))
         order by s.last_seen_at desc`,
        [roomId],
      );
      const open = kit.gateway.openSessions(roomId);
      // This device's own recent invites, so its invite card can tell when one was used.
      const invites = await kit.pool.query<{ expires_at: Date; used_at: Date | null }>(
        `select expires_at, used_at from dm_invites
         where room_id = $1 and created_by_session = $2 and expires_at > now() - interval '1 hour'
         order by expires_at`,
        [roomId, grant.sessionId],
      );
      return {
        devices: rows.map((row) => ({
          sessionId: row.session_id,
          memberId: row.member_id,
          device: deviceLabel(row.user_agent),
          lastSeenAt: row.last_seen_at.toISOString(),
          online: open.has(row.session_id),
          current: row.session_id === grant.sessionId,
          ...(row.role === "display" ? { display: true } : {}),
        })),
        invites: invites.rows.map((row) => ({ expiresAt: row.expires_at.toISOString(), used: row.used_at !== null })),
      };
    });

    r.delete("/api/rooms/:id/dm/devices/:sessionId", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const target = SessionParam.safeParse((req.params as { sessionId?: unknown }).sessionId);
      if (!target.success) throw new HttpError(404, "not_found");
      const { removed } = await revokeGrants(kit, roomId, { by: "session", sessionId: target.data, role: ["dm", "display"] });
      if (removed.length === 0) throw new HttpError(404, "not_found");
      return reply.code(204).send();
    });

    r.delete("/api/rooms/:id/dm/members/:memberId", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const target = MemberParam.safeParse((req.params as { memberId?: unknown }).memberId);
      if (!target.success) throw new HttpError(404, "member_not_found");
      // Stepping down would lock a sole DM out of every device at once. A DM
      // who means it can revoke this device from the devices list instead.
      if (target.data === grant.memberId) throw new HttpError(400, "cannot_remove_self");
      if (!(await kit.gateway.getMember(roomId, target.data))) throw new HttpError(404, "member_not_found");
      await revokeGrants(kit, roomId, { by: "member", memberId: target.data, role: "dm" });
      return reply.code(204).send();
    });

    /**
     * After a leak: a new key and the next `dm_epoch`, which also voids every
     * invite. Every DM grant except this device's is deleted, and every
     * other DM member goes back to 'player'.
     */
    r.post("/api/rooms/:id/dm/replace-link", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      let key = "";
      await revokeGrants(kit, roomId, { by: "role", role: "dm", exceptSessionId: grant.sessionId }, async (tx) => {
        // Re-check under the room lock: a concurrent replacement from another
        // DM device may have removed this one's grant since the check above.
        const { rows } = await tx.query<{ ok: boolean }>(
          `select g.epoch = r.dm_epoch as ok from rooms r
           join grants g on g.room_id = r.id and g.session_id = $2 and g.role = 'dm'
           where r.id = $1 for update of r`,
          [roomId, grant.sessionId],
        );
        if (!rows[0]?.ok) throw new HttpError(403, "no_access");
        const replaced = await replaceDmKey(tx, roomId);
        key = replaced.key;
        await tx.query("update grants set epoch = $3 where session_id = $1 and room_id = $2", [
          grant.sessionId,
          roomId,
          replaced.epoch,
        ]);
      });
      return { dmLink: dmLink(roomId, key) };
    });
  });
}
