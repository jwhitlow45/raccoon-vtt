import type pg from "pg";
import { CLOSE_GRANT_REVOKED, type RoomGateway } from "../rooms/gateway.ts";
import type { DisplayGrantContext, GrantContext } from "./types.ts";
import { withTx, type Queryable } from "./tx.ts";

/**
 * Grants: the only source of authority in a room (design section 10.2).
 *
 * A grant is valid only at its room's current epoch for its role: a player
 * grant at `player_epoch`, a DM grant at `dm_epoch`. Bumping an epoch
 * (password change, DM link replacement) therefore voids every older grant
 * at once, and each stale row is deleted the next time it is checked.
 */
export type Role = "dm" | "player";

/**
 * Every role a grant row can hold. A table display's grant (docs/design-v1-dm-tools.md
 * 3.1) is valid at `player_epoch`, as a player's is, and is never a member's:
 * its member id is `display:<12 random characters>`, which no member has.
 */
export type GrantRole = Role | "display";

type GrantJoinRow = { member_id: string; role: Role; epoch: number; player_epoch: number; dm_epoch: number };

/**
 * The session's current grant in a room, or null. A stale grant is deleted
 * and that session's sockets in the room are closed with 4001.
 *
 * Only DM and player grants count here. A display grant lives on a display
 * session, which no ordinary route accepts, and is read only through
 * checkDisplayGrant.
 *
 * Exported for the WebSocket endpoint, which rechecks grants without a
 * request in hand.
 */
export async function checkGrant(
  pool: pg.Pool,
  gateway: RoomGateway,
  sessionId: string,
  roomId: string,
): Promise<GrantContext | null> {
  const { rows } = await pool.query<GrantJoinRow>(
    `select g.member_id, g.role, g.epoch, r.player_epoch, r.dm_epoch
     from grants g join rooms r on r.id = g.room_id
     where g.session_id = $1 and g.room_id = $2 and g.role in ('dm', 'player')`,
    [sessionId, roomId],
  );
  const row = rows[0];
  if (!row) return null;
  const current = row.role === "dm" ? row.dm_epoch : row.player_epoch;
  if (row.epoch !== current) {
    // Match the epoch too, so a fresh grant written since the read survives.
    await pool.query("delete from grants where session_id = $1 and room_id = $2 and role = $3 and epoch = $4", [
      sessionId,
      roomId,
      row.role,
      row.epoch,
    ]);
    gateway.closeSockets(roomId, { sessionIds: [sessionId] }, CLOSE_GRANT_REVOKED);
    return null;
  }
  return { sessionId, roomId, memberId: row.member_id, role: row.role };
}

/**
 * A table display's grant in a room, or null (docs/design-v1-dm-tools.md
 * 3.1). The session must be a live display session: the socket recheck asks
 * this every 60 s, and a display whose session expired or was deleted
 * closes with 4001 then, as one whose grant is gone does. A grant from an
 * older `player_epoch` (the player password changed) is deleted, and its
 * sockets close with 4001.
 */
export async function checkDisplayGrant(
  pool: Queryable,
  gateway: RoomGateway,
  sessionId: string,
  roomId: string,
): Promise<DisplayGrantContext | null> {
  const { rows } = await pool.query<{ member_id: string; epoch: number; player_epoch: number; live: boolean }>(
    `select g.member_id, g.epoch, r.player_epoch, s.expires_at > now() as live
     from grants g join rooms r on r.id = g.room_id join sessions s on s.id = g.session_id
     where g.session_id = $1 and g.room_id = $2 and g.role = 'display' and s.purpose = 'display'`,
    [sessionId, roomId],
  );
  const row = rows[0];
  if (!row || !row.live) return null;
  if (row.epoch !== row.player_epoch) {
    await pool.query("delete from grants where session_id = $1 and room_id = $2 and role = 'display' and epoch = $3", [
      sessionId,
      roomId,
      row.epoch,
    ]);
    gateway.closeSockets(roomId, { sessionIds: [sessionId] }, CLOSE_GRANT_REVOKED);
    return null;
  }
  return { sessionId, roomId, memberId: row.member_id, role: "display" };
}

/**
 * Writes the session's grant in a room, replacing whatever it held there. A
 * DM grant also marks its member as one that was a DM, for good: see
 * `markDmMembers`.
 */
export async function putGrant(
  q: Queryable,
  grant: { sessionId: string; roomId: string; memberId: string; role: GrantRole; epoch: number },
): Promise<void> {
  await q.query(
    `insert into grants (session_id, room_id, member_id, role, epoch) values ($1, $2, $3, $4, $5)
     on conflict (session_id, room_id) do update
       set member_id = excluded.member_id, role = excluded.role, epoch = excluded.epoch, created_at = now()`,
    [grant.sessionId, grant.roomId, grant.memberId, grant.role, grant.epoch],
  );
  if (grant.role === "dm") await markDmMembers(q, grant.roomId, [grant.memberId]);
}

/**
 * Records members as having been a DM in this room. "Continue as" refuses
 * them for good (design 10.2): a DM member that goes back to being a player
 * keeps the whispers it sent and received as DM, and the player password
 * must not be a way into them. The mark lives here rather than on the
 * member, because only the server ever needs it.
 */
export async function markDmMembers(q: Queryable, roomId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  await q.query(
    "insert into room_dm_members (room_id, member_id) select $1, unnest($2::text[]) on conflict do nothing",
    [roomId, memberIds],
  );
}

/** Members that have ever been a DM in this room. */
export async function formerDms(q: Queryable, roomId: string): Promise<Set<string>> {
  const { rows } = await q.query<{ member_id: string }>("select member_id from room_dm_members where room_id = $1", [roomId]);
  return new Set(rows.map((r) => r.member_id));
}

/**
 * The former-DM marks for a backup, or null when the room is gone.
 *
 * Deleting a room cascades its marks away, so an empty answer alone cannot
 * tell "no former DMs" from "deleted since the state was copied". An export
 * that took the empty set would let an import trust it and make a demoted DM
 * continuable. One statement reads the room row and its marks together.
 */
export async function formerDmsOfLiveRoom(q: Queryable, roomId: string): Promise<Set<string> | null> {
  const { rows } = await q.query<{ member_id: string | null }>(
    "select m.member_id from rooms r left join room_dm_members m on m.room_id = r.id where r.id = $1",
    [roomId],
  );
  if (rows.length === 0) return null;
  return new Set(rows.flatMap((r) => (r.member_id === null ? [] : [r.member_id])));
}

/** Which grants in one room to revoke. A list of roles takes any of them. */
type Roles = GrantRole | readonly GrantRole[];
export type GrantSelector =
  | { by: "session"; sessionId: string; role?: Roles }
  | { by: "member"; memberId: string; role?: Roles }
  | { by: "role"; role: Roles; exceptSessionId?: string };

export type RevokeResult = {
  removed: Array<{ sessionId: string; memberId: string; role: GrantRole }>;
  /** Members whose `kind` went back to 'player' because no DM grant is left. */
  demoted: string[];
};

/**
 * The one way grants are removed: kick, DM device revoke, remove DM, DM link
 * replacement and password change all come here (design section 10.2).
 *
 * In one transaction it deletes the selected grants and every unused invite
 * their sessions minted in this room, because an invite is a DM's power
 * handed to a future device and must not outlive the DM grant behind it.
 * Then, once committed, it closes those sessions' sockets with 4001 and sets
 * `kind` back to 'player' for any member left with no DM grant.
 *
 * `before` runs first in the same transaction, for the epoch bumps that must
 * commit together with the deletion.
 */
export async function revokeGrants(
  deps: { pool: pg.Pool; gateway: RoomGateway },
  roomId: string,
  selector: GrantSelector,
  before?: (tx: pg.PoolClient) => Promise<void>,
): Promise<RevokeResult> {
  const result = await withTx(deps.pool, async (tx) => {
    if (before) await before(tx);
    const { rows } = await tx.query<{ session_id: string; member_id: string; role: GrantRole }>(
      ...deleteStatement(roomId, selector),
    );
    const removed = rows.map((r) => ({ sessionId: r.session_id, memberId: r.member_id, role: r.role }));
    const sessionIds = [...new Set(removed.map((r) => r.sessionId))];
    if (sessionIds.length > 0) {
      await tx.query(
        "delete from dm_invites where room_id = $1 and used_at is null and created_by_session = any($2::uuid[])",
        [roomId, sessionIds],
      );
      // A display code is a DM device's power handed to a TV, so it goes with the DM grant behind it, as an invite does.
      await tx.query(
        "delete from display_codes where room_id = $1 and used_at is null and created_by_session = any($2::uuid[])",
        [roomId, sessionIds],
      );
    }
    const candidates = new Set(removed.filter((r) => r.role === "dm").map((r) => r.memberId));
    if (selector.by === "member") candidates.add(selector.memberId);
    let demoted: string[] = [];
    if (candidates.size > 0) {
      const still = await tx.query<{ member_id: string }>(
        "select distinct member_id from grants where room_id = $1 and role = 'dm' and member_id = any($2::text[])",
        [roomId, [...candidates]],
      );
      const stillDm = new Set(still.rows.map((r) => r.member_id));
      demoted = [...candidates].filter((m) => !stillDm.has(m));
    }
    return { removed, sessionIds, demoted };
  });

  // Sockets first: losing the label update is cosmetic, an open socket is not.
  if (result.sessionIds.length > 0) {
    deps.gateway.closeSockets(roomId, { sessionIds: result.sessionIds }, CLOSE_GRANT_REVOKED);
  }
  // A DM device or a table display gone changes the DM devices list, which
  // other DMs' panels show without polling. Presence alone misses one whose
  // member is still online on another device.
  if (result.removed.some((r) => r.role === "dm" || r.role === "display")) deps.gateway.accessChanged(roomId);
  for (const memberId of result.demoted) await deps.gateway.setMemberKind(roomId, memberId, "player");
  return { removed: result.removed, demoted: result.demoted };
}

function rolesOf(role: Roles): GrantRole[] {
  return typeof role === "string" ? [role] : [...role];
}

function deleteStatement(roomId: string, s: GrantSelector): [string, unknown[]] {
  const returning = "returning session_id, member_id, role";
  switch (s.by) {
    case "session":
      return s.role
        ? [`delete from grants where room_id = $1 and session_id = $2 and role = any($3::text[]) ${returning}`, [roomId, s.sessionId, rolesOf(s.role)]]
        : [`delete from grants where room_id = $1 and session_id = $2 ${returning}`, [roomId, s.sessionId]];
    case "member":
      return s.role
        ? [`delete from grants where room_id = $1 and member_id = $2 and role = any($3::text[]) ${returning}`, [roomId, s.memberId, rolesOf(s.role)]]
        : [`delete from grants where room_id = $1 and member_id = $2 ${returning}`, [roomId, s.memberId]];
    case "role":
      return s.exceptSessionId
        ? [
            `delete from grants where room_id = $1 and role = any($2::text[]) and session_id <> $3 ${returning}`,
            [roomId, rolesOf(s.role), s.exceptSessionId],
          ]
        : [`delete from grants where room_id = $1 and role = any($2::text[]) ${returning}`, [roomId, rolesOf(s.role)]];
  }
}
