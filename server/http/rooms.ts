import { statfs } from "node:fs/promises";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { playerLink } from "#shared/playerLink.ts";
import type { Config } from "../config.ts";
import { deleteUnreferencedFiles, roomFileKeys } from "../assets/store.ts";
import { putGrant, revokeGrants } from "../auth/grants.ts";
import {
  accessRoutes,
  type AuthKit,
  DM_COLOR,
  enforce,
  HttpError,
  Name,
  parseBody,
  Password,
  requireGrant,
  roomParam,
} from "../auth/http.ts";
import { passwordProblem } from "../auth/passwords.ts";
import { readPlayerPassword, storePlayerPassword } from "../auth/playerSecret.ts";
import { dmLink } from "../auth/roomId.ts";
import { createRoomRecord } from "../auth/roomRecords.ts";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.ts";

/**
 * Rooms: create, look up, delete, change the player password, show the
 * player link, and "who am I" (design sections 10.1, 10.2 and 10.8).
 */

const CreateBody = z.object({
  name: Name,
  playerPassword: Password,
  dmName: Name,
  turnstileToken: z.string().max(2048).optional(),
});
const PasswordBody = z.object({ password: Password });
const DeleteBody = z.object({ name: z.string().max(200) });

/** New rooms are refused when the volume has less than this free (design section 10.1). */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

export async function diskHasRoom(config: Pick<Config, "ASSET_DIR">): Promise<boolean> {
  // In development the asset folder may not exist until the first upload, so
  // measure the volume the server runs from instead.
  const stats = await statfs(config.ASSET_DIR).catch(() => statfs("."));
  return stats.bavail * stats.bsize >= MIN_FREE_BYTES;
}

/**
 * A room's deletion, the one path both a DM's delete and the admin page's
 * take (docs/design-v1-dm-tools.md 3.18): the gateway unloads the room and
 * closes its sockets with 4009, the row's cascade removes its data, and its
 * files go to the trash when no other room names them. Image files are
 * shared between rooms that uploaded the same bytes, so the room's file
 * keys are collected first and only those no other room refers to once its
 * rows are gone are moved (design section 11.1). False when there was no
 * such room.
 */
export async function deleteRoomAndFiles(app: FastifyInstance, roomId: string, log: FastifyBaseLogger): Promise<boolean> {
  const fileKeys = await roomFileKeys(app.pool, roomId);
  const deleted = await app.gateway.deleteRoom(roomId);
  if (app.hasDecorator("assets")) {
    await deleteUnreferencedFiles(app.pool, app.assets.assetDir, fileKeys).catch((err: unknown) => {
      log.warn({ err, roomId }, "room deleted, but its unreferenced image files were not all removed");
    });
  }
  return deleted;
}

export function registerRoomRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  return accessRoutes(app, (r) => {
    // The create form needs the Turnstile site key, which is public by design.
    r.get("/api/config", async () => ({
      turnstileSiteKey: turnstileEnabled(kit.config) ? (kit.config.TURNSTILE_SITE_KEY ?? null) : null,
      // Openverse needs no key, so image search is always there
      // (docs/design-v1-dm-tools.md 3.13). Kept for the picker, which reads it.
      searchEnabled: true,
    }));

    r.post("/api/rooms", async (req, reply) => {
      const body = parseBody(CreateBody, req.body);
      const problem = passwordProblem(body.playerPassword);
      if (problem) throw new HttpError(400, "weak_password", { extra: { reason: problem } });

      const ip = kit.ip(req);
      // Cheap refusals first, before Turnstile's round trip and the hash.
      enforce(await kit.limits.creation(ip));
      if (!(await diskHasRoom(kit.config))) throw new HttpError(507, "disk_full");
      const turnstile = await verifyTurnstile(kit.config, body.turnstileToken, kit.clientIp(req));
      if (turnstile === "failed") throw new HttpError(403, "turnstile_failed");
      if (turnstile === "unavailable") throw new HttpError(503, "turnstile_unavailable");

      const playerPwHash = await kit.hasher.hash(body.playerPassword);
      let newCookie: string | undefined;
      const room = await createRoomRecord(
        kit,
        { name: body.name, playerPwHash, dmName: body.dmName, dmColor: DM_COLOR, createdIp: ip },
        async (tx, created) => {
          // The real check: serialized, so the last slot goes to one request.
          await kit.limits.lockCreation(tx);
          enforce(await kit.limits.creation(ip, tx));
          await kit.limits.recordCreation(tx, ip);
          const { row, created: isNew } = await kit.sessions.ensure(tx, req);
          if (isNew) newCookie = row.token;
          await putGrant(tx, {
            sessionId: row.id,
            roomId: created.roomId,
            memberId: created.dmMember.id,
            role: "dm",
            epoch: 1,
          });
          await storePlayerPassword(tx, kit.config.roomSecretKey, created.roomId, body.playerPassword);
        },
      );
      if (newCookie) kit.sessions.setCookie(reply, newCookie);
      return reply.code(201).send({ roomId: room.roomId, dmLink: dmLink(room.roomId, room.dmKey) });
    });

    r.get("/api/rooms/:id", async (req) => {
      const roomId = roomParam(req);
      const { rows } = await kit.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId]);
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");
      return { roomId, name: room.name };
    });

    // The room's name comes along for the Home page's list of this device's
    // rooms, which checks each room here.
    r.get("/api/rooms/:id/me", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId);
      const member = await kit.gateway.getMember(roomId, grant.memberId);
      const { rows } = await kit.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId]);
      return { roomId, roomName: rows[0]?.name ?? "", role: grant.role, memberId: grant.memberId, member };
    });

    /**
     * The player link, for a DM to show or copy at any time (design 10.2,
     * decided in section 17). The only way a stored player password
     * ever leaves the server. `playerLink` is null for a room whose password
     * predates the stored copy, or when the copy no longer opens because
     * ROOM_SECRET_KEY changed. Either way, changing the password once
     * stores a fresh one.
     */
    r.get("/api/rooms/:id/player-link", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const stored = await readPlayerPassword(kit.pool, kit.config.roomSecretKey, roomId);
      if (!stored) throw new HttpError(404, "room_not_found");
      if (stored.stored && stored.password === null) {
        // Never the value itself: only that it did not open.
        req.log.warn({ roomId }, "the stored player password does not open with ROOM_SECRET_KEY");
      }
      reply.header("cache-control", "no-store");
      return { playerLink: stored.password === null ? null : playerLink(roomId, stored.password) };
    });

    /**
     * Bumping `player_epoch` voids every player grant, every table display
     * and its codes, and every outstanding join ticket at once. The grants
     * are also deleted here, rather than at their next check, so their
     * sockets close now. DM grants are untouched.
     */
    r.post("/api/rooms/:id/password", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const { password } = parseBody(PasswordBody, req.body);
      const problem = passwordProblem(password);
      if (problem) throw new HttpError(400, "weak_password", { extra: { reason: problem } });
      const hash = await kit.hasher.hash(password);
      await revokeGrants(kit, roomId, { by: "role", role: ["player", "display"] }, async (tx) => {
        await tx.query("update rooms set player_pw_hash = $2, player_epoch = player_epoch + 1 where id = $1", [
          roomId,
          hash,
        ]);
        await storePlayerPassword(tx, kit.config.roomSecretKey, roomId, password);
      });
      kit.tickets.dropRoom(roomId);
      // Other DM devices show or copy the player link, which just stopped working.
      kit.gateway.accessChanged(roomId);
      return reply.code(204).send();
    });

    r.delete("/api/rooms/:id", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const { name } = parseBody(DeleteBody, req.body);
      const { rows } = await kit.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId]);
      const room = rows[0];
      if (!room) throw new HttpError(404, "room_not_found");
      // Typed by hand to confirm, so surrounding spaces from a phone keyboard
      // should not make it fail.
      if (name.trim() !== room.name.trim()) throw new HttpError(400, "name_mismatch");
      await deleteRoomAndFiles(app, roomId, req.log);
      return reply.code(204).send();
    });
  });
}
