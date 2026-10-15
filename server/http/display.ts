import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AssetError } from "../assets/errors.ts";
import { KINDS, isVariant } from "../assets/kinds.ts";
import { sendVariant } from "../assets/serve.ts";
import { getAsset, variantPath } from "../assets/store.ts";
import {
  CODE_MINUTES,
  MAX_DISPLAYS,
  MAX_LIVE_CODES,
  newDisplayCode,
  newDisplayMemberId,
  parseDisplayCode,
} from "../auth/displaySessions.ts";
import { checkDisplayGrant, putGrant } from "../auth/grants.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, parseBody, requireGrant, roomParam } from "../auth/http.ts";
import { parseRoomId } from "../auth/roomId.ts";
import { DISPLAY_SESSION_DAYS } from "../auth/sessions.ts";
import { sha256 } from "../auth/tokens.ts";
import { withTx } from "../auth/tx.ts";
import { TooBusyError } from "../rooms/errors.ts";
import { CLOSE_GRANT_REVOKED, RoomNotFoundError } from "../rooms/gateway.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { errorHandler } from "./assets.ts";

/**
 * Table displays (docs/design-v1-dm-tools.md 3.1): a TV that shows the
 * players' view to the table, as a viewer that is no member.
 *
 * A display holds a grant of its own role on a session of its own purpose,
 * whose token travels in a second cookie. Each route here names the session
 * it takes:
 *
 * - minting a code takes the ordinary DM rule, a room session from the room
 *   cookie with a DM grant,
 * - redeeming takes any caller, with any cookie or none, and makes the
 *   display session (or keeps a live one) and sets the display cookie,
 * - `display/me`, Leave and the display image route take only a display
 *   session, from the display cookie.
 *
 * Every other route reads only the room cookie, and a display session is no
 * session there (server/auth/sessions.ts), so a display token copied into
 * the room cookie can do nothing else.
 */

const RedeemBody = z.object({ code: z.string().min(1).max(40) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The redemption, as DM invites do it: one statement that spends a code only
 * when it is unused, unexpired and minted at the room's current
 * `player_epoch`, so a code from before a password change opens nothing.
 */
const REDEEM = `update display_codes set used_at = now()
  where token_hash = $1 and used_at is null and expires_at > now()
    and player_epoch = (select player_epoch from rooms where id = room_id)
  returning room_id`;

/** The room of a code that can still be redeemed: unused, unexpired, and minted at the room's current `player_epoch`. */
const LIVE_CODE_ROOM = `select c.room_id from display_codes c join rooms r on r.id = c.room_id
  where c.token_hash = $1 and c.used_at is null and c.expires_at > now() and c.player_epoch = r.player_epoch`;

/** A uuid no session has, so the count below excludes nothing when the caller holds no display session. */
const NO_SESSION = "00000000-0000-0000-0000-000000000000";

export async function registerDisplayRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager }): Promise<void> {
  await accessRoutes(app, (r) => {
    r.post("/api/rooms/:id/display/code", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const code = newDisplayCode();
      // Counted and written under the room row lock, so two DM devices
      // minting at once cannot both take the last place.
      const expiresAt = await withTx(kit.pool, async (tx) => {
        const { rows } = await tx.query<{ player_epoch: number }>("select player_epoch from rooms where id = $1 for update", [roomId]);
        const room = rows[0];
        if (!room) throw new HttpError(404, "room_not_found");
        // The DM grant is checked again here and its row locked to the end of
        // the transaction. A code is a DM device's power handed to a TV, and
        // revoking the device deletes its unused codes (grants.ts
        // revokeGrants), but a revocation that landed after the check above
        // would miss a code inserted after it. With the lock, a revocation
        // either commits first, and the grant is gone here, or waits for this
        // commit and then deletes the new code with the device's others.
        const held = await tx.query(
          `select 1 from grants g join rooms r on r.id = g.room_id
           where g.session_id = $1 and g.room_id = $2 and g.role = 'dm' and g.epoch = r.dm_epoch
           for update of g`,
          [grant.sessionId, roomId],
        );
        if (held.rowCount !== 1) throw new HttpError(403, "no_access");
        const live = await tx.query<{ n: number }>(
          `select count(*)::int as n from display_codes
           where room_id = $1 and used_at is null and expires_at > now() and player_epoch = $2`,
          [roomId, room.player_epoch],
        );
        if ((live.rows[0]?.n ?? 0) >= MAX_LIVE_CODES) throw new HttpError(429, "too_many_codes");
        const inserted = await tx.query<{ expires_at: Date }>(
          `insert into display_codes (token_hash, room_id, created_by_session, player_epoch, expires_at)
           values ($1, $2, $3, $4, now() + make_interval(mins => $5)) returning expires_at`,
          [sha256(code), roomId, grant.sessionId, room.player_epoch, CODE_MINUTES],
        );
        return inserted.rows[0]!.expires_at;
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ code, link: `/display#code=${code}`, expiresAt: expiresAt.toISOString() });
    });

    r.post("/api/display/redeem", async (req, reply) => {
      const body = parseBody(RedeemBody, req.body);
      const ip = kit.ip(req);
      enforce(await kit.limits.displayCodeFailures(ip));
      const refused = async (): Promise<HttpError> => {
        await kit.limits.recordDisplayCodeFailure(ip);
        return new HttpError(403, "bad_code");
      };
      const code = parseDisplayCode(body.code);
      if (!code) throw await refused();
      const hash = sha256(code);
      // The code's room first, so a full room is refused before the code is
      // spent. Only a live code finds it: a spent, expired or old-epoch code
      // is a wrong code like any other, and its holder never learns whether
      // the room is full.
      const found = await kit.pool.query<{ room_id: string }>(LIVE_CODE_ROOM, [hash]);
      const roomId = found.rows[0]?.room_id;
      if (!roomId) throw await refused();
      const current = await kit.displaySessions.lookup(req);

      /** Rooms this TV showed until now: a display shows one room, so pairing it with another signs it out of them. */
      let left: string[] = [];
      const session = await withTx(kit.pool, async (tx) => {
        const { rows } = await tx.query<{ player_epoch: number }>("select player_epoch from rooms where id = $1 for update", [roomId]);
        const room = rows[0];
        if (!room) return null;
        // Again under the room lock, which every redemption and a password
        // change take, so a code spent or voided a moment ago is still a
        // wrong code rather than a full room.
        const live = await tx.query(LIVE_CODE_ROOM, [hash]);
        if (live.rowCount !== 1) return null;
        // A TV paired again keeps its place, so its own grant is not counted.
        const displays = await tx.query<{ n: number }>(
          `select count(*)::int as n from grants g join sessions s on s.id = g.session_id
           where g.room_id = $1 and g.role = 'display' and g.epoch = $2 and s.expires_at > now() and s.id <> $3::uuid`,
          [roomId, room.player_epoch, current?.id ?? NO_SESSION],
        );
        if ((displays.rows[0]?.n ?? 0) >= MAX_DISPLAYS) throw new HttpError(409, "displays_full");
        const spent = await tx.query(REDEEM, [hash]);
        if (spent.rowCount !== 1) return null;
        let row = current;
        if (row) {
          // A fresh pairing starts the 30 days again.
          await tx.query("update sessions set expires_at = now() + make_interval(days => $2) where id = $1", [row.id, DISPLAY_SESSION_DAYS]);
          const gone = await tx.query<{ room_id: string }>(
            "delete from grants where session_id = $1 and role = 'display' and room_id <> $2 returning room_id",
            [row.id, roomId],
          );
          left = gone.rows.map((r) => r.room_id);
        } else {
          row = await kit.displaySessions.create(tx, req);
        }
        const held = await tx.query<{ member_id: string }>(
          "select member_id from grants where session_id = $1 and room_id = $2 and role = 'display'",
          [row.id, roomId],
        );
        const memberId = held.rows[0]?.member_id ?? newDisplayMemberId();
        await putGrant(tx, { sessionId: row.id, roomId, memberId, role: "display", epoch: room.player_epoch });
        return row;
      });
      if (!session) throw await refused();
      kit.displaySessions.setCookie(reply, session.token);
      // The DM devices list shows displays, and the DM panel counts them.
      kit.gateway.accessChanged(roomId);
      for (const other of left) {
        kit.gateway.closeSockets(other, { sessionIds: [session.id] }, CLOSE_GRANT_REVOKED);
        kit.gateway.accessChanged(other);
      }
      return { roomId };
    });

    r.get("/api/rooms/:id/display/me", async (req, reply) => {
      const roomId = roomParam(req);
      const session = await kit.displaySessions.lookup(req);
      if (!session) throw new HttpError(401, "no_session");
      const grant = await checkDisplayGrant(kit.pool, kit.gateway, session.id, roomId);
      if (!grant) throw new HttpError(403, "no_access");
      const { rows } = await kit.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId]);
      // The cookie outlives a page that stays open for months only if it is sent again now and then.
      kit.displaySessions.setCookie(reply, session.token);
      reply.header("cache-control", "no-store");
      return { roomId, roomName: rows[0]?.name ?? "", role: "display", memberId: grant.memberId };
    });

    // Leave signs the display out for good: its grants and its session go, and the cookie is cleared.
    r.delete("/api/display/session", async (req, reply) => {
      const session = await kit.displaySessions.lookup(req);
      if (session) {
        const { rows } = await kit.pool.query<{ room_id: string }>(
          `with gone as (delete from grants where session_id = $1 returning room_id),
             ended as (delete from sessions where id = $1 and purpose = 'display')
           select room_id from gone`,
          [session.id],
        );
        for (const { room_id: roomId } of rows) {
          kit.gateway.closeSockets(roomId, { sessionIds: [session.id] }, CLOSE_GRANT_REVOKED);
          kit.gateway.accessChanged(roomId);
        }
      }
      kit.displaySessions.clearCookie(reply);
      return reply.code(204).send();
    });
  });

  /**
   * The display's images. The canvas reads images from the asset route,
   * which authenticates with the room cookie, so a TV holding only a display
   * cookie reads them here instead: exactly the assets of its own projected
   * visible set (the map showing, the tokens it can see, the stamps' library
   * images, handouts shown to everyone), never by the uploader rule, since a
   * display uploads nothing. Every refusal is the asset route's same 404.
   */
  await app.register(async (scope) => {
    scope.setErrorHandler(errorHandler);
    scope.get<{ Params: { id: string; assetId: string; variant: string } }>(
      "/api/rooms/:id/display/assets/:assetId/:variant",
      async (req, reply) => {
        const roomId = parseRoomId(req.params.id);
        const { assetId, variant } = req.params;
        if (!roomId || !UUID.test(assetId) || !isVariant(variant)) throw new AssetError(404, "not_found");
        const grant = await app.auth.displayGrant(req, roomId);
        if (!grant) throw new AssetError(404, "not_found");
        const row = await getAsset(app.pool, assetId);
        if (!row || row.room_id !== roomId || !KINDS[row.kind].playersRead) throw new AssetError(404, "not_found");
        let visible: Set<string>;
        try {
          visible = (await deps.manager.acquire(roomId)).visibleAssets(grant.memberId);
        } catch (err) {
          if (err instanceof TooBusyError) throw new AssetError(503, "busy", { retryAfter: 30 });
          if (err instanceof RoomNotFoundError) throw new AssetError(404, "not_found");
          throw err;
        }
        if (!visible.has(row.id) || !row.variants.includes(variant)) throw new AssetError(404, "not_found");
        return sendVariant(reply, variantPath(app.assets.assetDir, row.sha256.toString("hex"), row.kind, variant, row.pipeline));
      },
    );
  });
}
