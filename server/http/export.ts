import { unlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { WindowLimiter } from "../assets/limits.ts";
import { receiveToFile, tempFile } from "../assets/upload.ts";
import { formerDmsOfLiveRoom, putGrant } from "../auth/grants.ts";
import { accessRoutes, type AuthKit, DM_COLOR, enforce, HttpError, Name, parseBody, Password, requireGrant, roomParam } from "../auth/http.ts";
import { passwordProblem } from "../auth/passwords.ts";
import { storePlayerPassword } from "../auth/playerSecret.ts";
import { dmLink, formatRoomId } from "../auth/roomId.ts";
import { verifyTurnstile } from "../auth/turnstile.ts";
import { buildExportZip, exportableState, roomExport, roomManifest } from "../rooms/exportRoom.ts";
import { importRoom, IMPORT_LIMITS } from "../rooms/importRoom.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { diskHasRoom } from "./rooms.ts";

/**
 * Room export and import (design 16.4 and 10.3).
 *
 * Export copies the committed state on the actor queue and streams the zip
 * outside it, so the room keeps playing. Slots bound what streams at once
 * (1 per room, 1 per IP, 2 server-wide) and hourly counts bound how often
 * (4 per room and per IP). A reader averaging under 64 KiB/s over 30 s, or
 * one still reading after 30 minutes, is cut off so it cannot hold a slot.
 *
 * Import is a room creation with a zip body. The form travels in the
 * `X-Import-Form` header as base64url JSON, because the body is the zip and
 * the password must not sit in a URL that gets logged.
 */
const ImportForm = z.object({
  name: Name.optional(),
  playerPassword: Password,
  dmName: Name,
  turnstileToken: z.string().max(2048).optional(),
});

export type ExportOptions = {
  perRoom?: number;
  perIp?: number;
  total?: number;
  perHour?: number;
  minBytesPer30s?: number;
  maxMs?: number;
  checkEveryMs?: number;
};

export function registerExportRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager; options?: ExportOptions }): Promise<void> {
  const o = deps.options ?? {};
  const inFlight = { total: 0, byRoom: new Map<string, number>(), byIp: new Map<string, number>() };
  const perRoom = o.perRoom ?? 1;
  const perIp = o.perIp ?? 1;
  const total = o.total ?? 2;
  const hourly = new WindowLimiter(3_600_000);
  const perHour = o.perHour ?? 4;
  const minBytesPer30s = o.minBytesPer30s ?? 64 * 1024 * 30;
  const maxMs = o.maxMs ?? 30 * 60_000;
  const checkEveryMs = o.checkEveryMs ?? 30_000;

  return accessRoutes(app, (r) => {
    r.get("/api/rooms/:id/export", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const ip = kit.ip(req);
      const checks = [
        { key: `r:${roomId}`, limit: perHour },
        { key: `ip:${ip}`, limit: perHour },
      ];
      const wait = hourly.retryAfter(checks);
      if (wait > 0) throw new HttpError(429, "rate_limited", { retryAfter: wait });
      if (inFlight.total >= total || (inFlight.byRoom.get(roomId) ?? 0) >= perRoom || (inFlight.byIp.get(ip) ?? 0) >= perIp) {
        throw new HttpError(503, "busy", { retryAfter: 10 });
      }
      // Fastify answers HEAD with this handler too. A HEAD stops after the
      // checks, so the page can learn why an export would be refused before
      // handing the download to the browser, which shows a refused download
      // only in its own download list. It takes no slot and is not counted.
      if (req.method === "HEAD") return reply.code(200).header("cache-control", "no-store").send();
      inFlight.total++;
      bump(inFlight.byRoom, roomId, 1);
      bump(inFlight.byIp, ip, 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        inFlight.total--;
        bump(inFlight.byRoom, roomId, -1);
        bump(inFlight.byIp, ip, -1);
      };
      try {
        const actor = await deps.manager.acquire(roomId);
        // The state is immutable, so the copy on the queue is a reference and the manifest query is the only wait.
        const copied = await actor.read((state, seq) => ({ state: exportableState(state, { memberId: grant.memberId, role: "dm" }), seq }));
        // Read after the copy: a member marked later got its DM grant after
        // the copy too, so the copied log holds nothing it had as DM.
        const dmMemberIds = await formerDmsOfLiveRoom(kit.pool, roomId);
        if (!dmMemberIds) throw new HttpError(404, "room_not_found");
        const { manifest, rows } = await roomManifest(kit.pool, roomId);
        hourly.record(checks);
        const out = new PassThrough();
        const zip = buildExportZip(app.assets.assetDir, { room: roomExport(roomId, copied.seq, copied.state, dmMemberIds), manifest, rows });
        // yazl reports a file it cannot stat or read on the ZipFile itself,
        // not on its output stream. A room deleted mid-export unlinks its
        // files under the reader, and an unheard error there would end the
        // whole process. Listening before this tick ends is in time, because
        // yazl's first stat answers on a later one.
        zip.on("error", (err: Error) => {
          req.log.warn({ err, roomId }, "export failed reading an image");
          zip.outputStream.unpipe(out);
          out.destroy(err);
        });
        let bytes = 0;
        let sinceCheck = 0;
        const started = Date.now();
        const watchdog = setInterval(() => {
          const tooSlow = sinceCheck < minBytesPer30s;
          const tooLong = Date.now() - started > maxMs;
          sinceCheck = 0;
          if (tooSlow || tooLong) {
            req.log.warn({ roomId, bytes, tooSlow, tooLong }, "export aborted");
            out.destroy(new Error(tooLong ? "export ran too long" : "export reader too slow"));
          }
        }, checkEveryMs);
        const finish = (): void => {
          clearInterval(watchdog);
          release();
        };
        out.on("close", finish);
        out.on("error", finish);
        zip.outputStream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          sinceCheck += chunk.length;
        });
        zip.outputStream.on("error", (err: Error) => out.destroy(err));
        zip.outputStream.pipe(out);
        return reply
          .type("application/zip")
          .header("content-disposition", `attachment; filename="raccoon-room-${formatRoomId(roomId)}.zip"`)
          .header("cache-control", "no-store")
          .send(out);
      } catch (err) {
        release();
        throw err;
      }
    });
  }).then(() =>
    app.register(async (scope) => {
      // The body is the zip itself, read as a stream after the checks, never buffered by Fastify.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("application/zip", (_req, _payload, done) => done(null));
      scope.setErrorHandler<Error>((err, _req, reply) => {
        if (err instanceof HttpError) {
          if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
          return reply.code(err.status).send({ error: err.code, ...err.extra });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 415) return reply.code(415).send({ error: "unsupported_type" satisfies ApiErrorCode });
        throw err;
      });

      scope.post("/api/rooms/import", async (req, reply) => {
        const form = parseForm(req);
        const problem = passwordProblem(form.playerPassword);
        if (problem) throw new HttpError(400, "weak_password", { extra: { reason: problem } });
        const ip = kit.ip(req);
        enforce(await kit.limits.creation(ip));
        if (!(await diskHasRoom(kit.config))) throw new HttpError(507, "disk_full");
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > IMPORT_LIMITS.bodyBytes) throw new HttpError(413, "too_large");
        const session = await kit.sessions.lookup(req);
        let releaseSlot: (() => void) | undefined;
        try {
          releaseSlot = app.assets.slots.tryAcquire({ kind: "roomImport", ip, sessionId: session?.id ?? "", pinned: false }) ?? undefined;
          if (!releaseSlot) throw new HttpError(503, "busy", { retryAfter: 10 });
        } catch (err) {
          reply.header("connection", "close");
          throw err;
        }
        const path = tempFile(app.assets.tmpDir, "intake");
        let newCookie: string | undefined;
        try {
          // After the slot: a Turnstile token works once, and the client
          // resends the same request after a busy answer, so the token must
          // not be spent on an attempt that was always going to wait.
          const turnstile = await verifyTurnstile(kit.config, form.turnstileToken, kit.clientIp(req));
          if (turnstile !== "ok") {
            // The body is still unread, and draining up to 95 MB of it for a refusal is wasted work.
            reply.header("connection", "close");
            throw turnstile === "failed" ? new HttpError(403, "turnstile_failed") : new HttpError(503, "turnstile_unavailable");
          }
          await receiveToFile(req.raw, path, { maxBytes: IMPORT_LIMITS.bodyBytes, deadlineMs: 600_000, minBytesPerSec: 32 * 1024, graceMs: 10_000 }).catch(
            (err: { status?: number; code?: ApiErrorCode }) => {
              throw new HttpError(err.status ?? 400, err.code ?? "upload_failed");
            },
          );
          const playerPwHash = await kit.hasher.hash(form.playerPassword);
          const room = await importRoom(
            { pool: kit.pool, assets: app.assets, gateway: kit.gateway, log: req.log },
            path,
            { name: form.name, playerPwHash, dmName: form.dmName, dmColor: DM_COLOR, createdIp: ip },
            {
              beforeImages: async (tx) => {
                await kit.limits.lockCreation(tx);
                enforce(await kit.limits.creation(ip, tx));
                await kit.limits.recordCreation(tx, ip);
              },
              afterImages: async (tx, created) => {
                const { row, created: isNew } = await kit.sessions.ensure(tx, req);
                if (isNew) newCookie = row.token;
                await putGrant(tx, { sessionId: row.id, roomId: created.roomId, memberId: created.dmMember.id, role: "dm", epoch: 1 });
                await storePlayerPassword(tx, kit.config.roomSecretKey, created.roomId, form.playerPassword);
              },
            },
          );
          if (newCookie) kit.sessions.setCookie(reply, newCookie);
          return reply.code(201).send({ roomId: room.roomId, dmLink: dmLink(room.roomId, room.dmKey) });
        } finally {
          releaseSlot();
          await unlink(path).catch(() => undefined);
        }
      });
    }),
  );
}

function parseForm(req: FastifyRequest): z.infer<typeof ImportForm> {
  const header = req.headers["x-import-form"];
  if (typeof header !== "string" || header.length > 8_192) throw new HttpError(400, "invalid_form");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_form");
  }
  return parseBody(ImportForm, json);
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
