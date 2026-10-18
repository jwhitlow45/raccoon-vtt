import { unlink } from "node:fs/promises";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { STARTER_KEY, STARTER_KINDS } from "#shared/starter.ts";
import { MAX_FETCH_BYTES, fetchPublicImage, type Fetched } from "../assets/fetchPublic.ts";
import { withInUse } from "../assets/cleanup.ts";
import { AssetError, isAssetError } from "../assets/errors.ts";
import { creditForImport } from "../assets/openverse.ts";
import { ASSET_KINDS, KINDS, isVariant } from "../assets/kinds.ts";
import type { Reservation } from "../assets/quota.ts";
import { sendVariant } from "../assets/serve.ts";
import { isCachedThumbnail } from "../assets/serpapi.ts";
import { AssetService, type AssetServiceOptions, type VisibleAssetsFn } from "../assets/service.ts";
import { getAsset, listRoomAssets, variantPath } from "../assets/store.ts";
import { receiveToFile, tempFile } from "../assets/upload.ts";
import type { GrantContext } from "../auth/types.ts";
import { clientIp } from "../auth/clientIp.ts";
import { ipKey } from "../auth/ipKey.ts";
import { registerSearchRoutes } from "./search.ts";
import { isThumbnailUrl } from "#shared/searchThumbnails.ts";

/**
 * Asset routes (design sections 10.8, 11.1 and 11.2):
 *
 * - `PUT /api/rooms/:id/assets?kind=` upload a raw image body
 * - `GET /api/rooms/:id/assets` list what the caller may see
 * - `POST /api/rooms/:id/assets/import` import an image from a URL
 * - `POST /api/rooms/:id/assets/starter` copy a starter work into the room
 * - `GET /api/assets/:assetId/:variant` read one image
 *
 * plus image search, registered from search.ts. `app.assets` is the service
 * behind them, decorated so room import and room deletion can reuse its
 * slots, queue, quota and file helpers.
 *
 * CSRF (Sec-Fetch-Site or Origin) is checked by the app-wide hook from
 * server/auth, not here.
 */
export type AssetRouteOptions = Partial<Omit<AssetServiceOptions, "pool" | "config">> & {
  visibleAssets?: VisibleAssetsFn;
};

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UploadQuery = z.object({
  kind: z.enum(ASSET_KINDS),
  // The original file name, only for the map grid hint (a name like
  // `crypt_30x20.jpg`). The body carries no name of its own.
  name: z.string().max(255).optional(),
});

const ImportBody = z.object({
  url: z.string().min(1).max(4096),
  fallback: z.string().min(1).max(4096).optional(),
  kind: z.enum(ASSET_KINDS),
});

// Strict, so a client that sends a credit or a file learns at once that neither is ever read.
const StarterBody = z.strictObject({
  work: z.string().regex(STARTER_KEY),
  kind: z.enum(STARTER_KINDS),
});

export async function registerAssetRoutes(app: FastifyInstance, opts: AssetRouteOptions = {}): Promise<void> {
  const service = new AssetService({ ...opts, pool: app.pool, config: app.config });
  await service.init();
  app.decorate("assets", service);
  app.addHook("onClose", async () => service.close());
  const trustCf = app.config.TRUST_CF_CONNECTING_IP === "1";

  /** The caller's grant for the room in the path, or a refusal. */
  async function requireGrant(req: FastifyRequest, reply: FastifyReply, roomId: string): Promise<GrantContext> {
    if (!ROOM_ID.test(roomId)) throw new AssetError(404, "not_found");
    const grant = await app.auth.grant(req, reply, roomId);
    if (!grant) throw new AssetError(403, "forbidden");
    return grant;
  }

  async function writableRoom(roomId: string) {
    const room = await service.roomInfo(roomId);
    if (!room) throw new AssetError(404, "not_found");
    if (room.readOnly) throw new AssetError(409, "read_only");
    return room;
  }

  // The upload route gets a scope of its own with every body parser
  // removed except a pass-through for image/*, so the handler reads the
  // raw stream itself, after it holds a slot, and Fastify never buffers it.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(/^image\/[a-z0-9.+-]+$/i, (_req, _payload, done) => done(null));
    scope.setErrorHandler(errorHandler);

    scope.put<{ Params: { id: string }; Querystring: Record<string, string> }>(
      "/api/rooms/:id/assets",
      async (req, reply) => {
        let bodyRead = false;
        let releaseSlot: (() => void) | undefined;
        let reservation: Reservation | undefined;
        let path: string | undefined;
        try {
          const roomId = req.params.id;
          const query = UploadQuery.safeParse(req.query);
          if (!query.success) throw new AssetError(400, "bad_request");
          const { kind, name } = query.data;
          // SVG is image/* too, but it is a document that can run script.
          // The magic-byte check would refuse it later anyway. This refuses
          // it before a byte is read.
          if (/^image\/svg/i.test(req.headers["content-type"] ?? "")) throw new AssetError(415, "unsupported_type");

          const grant = await requireGrant(req, reply, roomId);
          if (KINDS[kind].dmOnly && grant.role !== "dm") throw new AssetError(403, "forbidden");
          const declared = contentLength(req);
          const cap = KINDS[kind].maxUploadBytes;
          if (declared !== undefined && declared > cap) throw new AssetError(413, "too_large");

          const room = await writableRoom(roomId);
          await service.assertFreeDisk();
          const ip = ipKey(clientIp(req, trustCf));
          const checks = service.hourlyChecks(grant.sessionId, ip, roomId, kind);
          service.assertHourly(checks);
          releaseSlot = service.slots.acquire({ kind: "upload", roomId, ip, sessionId: grant.sessionId, pinned: room.pinned });
          service.hourly.record(checks);

          reservation = await service.quota.reserve(roomId, declared ?? cap);
          path = tempFile(service.tmpDir, "intake");
          const received = await receiveToFile(req.raw, path, service.bodyLimits(kind));
          bodyRead = true;
          const result = await service.ingest({
            roomId,
            uploaderIds: [grant.memberId],
            kind,
            tempPath: path,
            sha256: received.sha256,
            reservation,
            nameHint: name,
          });
          return reply.code(200).send(result);
        } catch (err) {
          // Whatever refused the upload, an unread body is never drained:
          // the answer closes the connection instead.
          if (!bodyRead) reply.header("connection", "close");
          throw err;
        } finally {
          reservation?.release();
          releaseSlot?.();
          if (path) await unlink(path).catch(() => undefined);
        }
      },
    );
  });

  await app.register(async (scope) => {
    scope.setErrorHandler(errorHandler);

    scope.get<{ Params: { id: string } }>("/api/rooms/:id/assets", async (req, reply) => {
      const roomId = req.params.id;
      const grant = await requireGrant(req, reply, roomId);
      if (grant.role === "dm") {
        const assets = await listRoomAssets(app.pool, roomId);
        // The library marks what the room's state does not use (docs/design-v1-dm-tools.md 3.19).
        return { assets: app.hasDecorator("rooms") ? await withInUse(app.pool, app.rooms, roomId, assets) : assets };
      }
      const assets = (await listRoomAssets(app.pool, roomId, await service.visibleAssets(roomId, grant.memberId))).filter((a) => KINDS[a.kind].playersRead);
      return { assets };
    });

    scope.get<{ Params: { assetId: string; variant: string } }>("/api/assets/:assetId/:variant", async (req, reply) => {
      const { assetId, variant } = req.params;
      // Every refusal below is the same 404, so an asset id from another
      // room, or one the caller may not see, is indistinguishable from one
      // that never existed.
      if (!UUID.test(assetId) || !isVariant(variant)) throw new AssetError(404, "not_found");
      const row = await getAsset(app.pool, assetId);
      if (!row) throw new AssetError(404, "not_found");
      const grant = await app.auth.grant(req, reply, row.room_id);
      if (!grant) throw new AssetError(404, "not_found");
      if (grant.role !== "dm") {
        if (!KINDS[row.kind].playersRead) throw new AssetError(404, "not_found");
        const visible = await service.visibleAssets(row.room_id, grant.memberId);
        if (!visible.has(row.id)) throw new AssetError(404, "not_found");
      }
      // The variant must be one this row has before any path is built.
      if (!row.variants.includes(variant)) throw new AssetError(404, "not_found");
      return sendVariant(reply, variantPath(service.assetDir, row.sha256.toString("hex"), row.kind, variant, row.pipeline));
    });

    scope.post<{ Params: { id: string } }>("/api/rooms/:id/assets/import", async (req, reply) => {
      const roomId = req.params.id;
      const grant = await requireGrant(req, reply, roomId);
      const body = ImportBody.safeParse(req.body);
      if (!body.success) throw new AssetError(400, "bad_request");
      const { url, fallback, kind } = body.data;
      if (KINDS[kind].dmOnly && grant.role !== "dm") throw new AssetError(403, "forbidden");
      // The fallback must be a thumbnail a search handed to this server, so a
      // client cannot use it to fetch anything else.
      if (fallback !== undefined && !(isThumbnailUrl(fallback) && (await isCachedThumbnail(app.pool, fallback)))) {
        throw new AssetError(400, "bad_fallback");
      }

      await writableRoom(roomId);
      await service.assertFreeDisk();
      const ip = ipKey(clientIp(req, trustCf));
      // A URL import spends the shared budget whatever kind it asks for, so the thumbnails' larger one never pays for outbound fetches.
      const checks = service.hourlyChecks(grant.sessionId, ip, roomId);
      service.assertHourly(checks);
      const releaseFetch = service.outbound.tryAcquire();
      if (!releaseFetch) throw new AssetError(503, "busy", { retryAfter: 2 });
      service.hourly.record(checks);

      let reservation: Reservation | undefined;
      const paths: string[] = [];
      try {
        reservation = await service.quota.reserve(roomId, MAX_FETCH_BYTES);
        let fetched: Fetched;
        let fetchedFrom: { original: string } | { thumbnail: string };
        let path = tempFile(service.tmpDir, "fetch");
        paths.push(path);
        try {
          fetched = await fetchPublicImage(url, { dispatcher: service.egress.public, path });
          fetchedFrom = { original: new URL(url).href };
        } catch (err) {
          if (fallback === undefined) throw err;
          path = tempFile(service.tmpDir, "fetch");
          paths.push(path);
          // serpapi.com is reachable only through the strict port. Google's
          // thumbnail hosts are ordinary public hosts.
          const host = new URL(fallback).hostname;
          const dispatcher = host === "serpapi.com" ? service.egress.strict : service.egress.public;
          fetched = await fetchPublicImage(fallback, { dispatcher, path, allowedHost: host });
          fetchedFrom = { thumbnail: fallback };
        }
        releaseFetch();
        // An image from an Openverse result keeps that result's credit, read
        // from the server's own cache by what was fetched. A credit in the
        // request body is never read (docs/design-v1-dm-tools.md 3.13).
        const credit = await creditForImport(app.pool, fetchedFrom, path);
        const result = await service.ingest({
          roomId,
          uploaderIds: [grant.memberId],
          kind,
          tempPath: path,
          sha256: fetched.sha256,
          reservation,
          nameHint: lastPathSegment(fetched.finalUrl),
          credit,
        });
        return reply.code(200).send(credit ? { ...result, credit } : result);
      } finally {
        releaseFetch();
        reservation?.release();
        await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
      }
    });

    /*
     * A starter pick (docs/design-v1-starter-art.md 5) is an upload whose
     * bytes come from the server's own build: the same role rule, room
     * checks, hourly budgets and intake slot as an upload of its kind, and
     * the work looked up in the shipped catalog, which names the file and
     * the credit. It takes no quota reservation, since the row never counts
     * toward the room's storage.
     */
    scope.post<{ Params: { id: string } }>("/api/rooms/:id/assets/starter", async (req, reply) => {
      const roomId = req.params.id;
      const grant = await requireGrant(req, reply, roomId);
      const body = StarterBody.safeParse(req.body);
      if (!body.success) throw new AssetError(400, "bad_request");
      const { work, kind } = body.data;
      const found = service.starter.works.get(work);
      if (!found) throw new AssetError(404, "not_found");
      // A stamp-only work has no asset kind among its uses, so it lands here too.
      if (!(found.work.uses as readonly string[]).includes(kind)) throw new AssetError(400, "bad_request");
      if (KINDS[kind].dmOnly && grant.role !== "dm") throw new AssetError(403, "forbidden");

      const room = await writableRoom(roomId);
      await service.assertFreeDisk();
      const ip = ipKey(clientIp(req, trustCf));
      const checks = service.hourlyChecks(grant.sessionId, ip, roomId, kind);
      service.assertHourly(checks);
      const releaseSlot = service.slots.acquire({ kind: "upload", roomId, ip, sessionId: grant.sessionId, pinned: room.pinned });
      try {
        service.hourly.record(checks);
        const result = await service.ingestStarter({ roomId, uploaderIds: [grant.memberId], found, kind });
        return reply.code(200).send(result);
      } finally {
        releaseSlot();
      }
    });

    await registerSearchRoutes(scope, { requireGrant });
  });
}

function contentLength(req: FastifyRequest): number | undefined {
  const raw = req.headers["content-length"];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function lastPathSegment(url: URL): string | undefined {
  const segment = url.pathname.split("/").pop();
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment).slice(0, 255);
  } catch {
    return segment.slice(0, 255);
  }
}

/**
 * Asset refusals become `{error: code}` with their status and headers.
 * Fastify's own client errors (415 for a wrong body type, 400 for bad JSON)
 * keep their status. Anything else is logged and answered as a bare 500.
 */
export function errorHandler(err: FastifyError | AssetError, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (isAssetError(err)) {
    if (err.retryAfter !== undefined) reply.header("retry-after", String(err.retryAfter));
    if (err.closeConnection) reply.header("connection", "close");
    return reply.code(err.status).send({ error: err.code });
  }
  const status = (err as FastifyError).statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const code: ApiErrorCode = status === 415 ? "unsupported_type" : status === 413 ? "too_large" : "bad_request";
    return reply.code(status).send({ error: code });
  }
  req.log.error({ err }, "asset route failed");
  return reply.code(500).send({ error: "internal" satisfies ApiErrorCode });
}

declare module "fastify" {
  interface FastifyInstance {
    assets: AssetService;
  }
}
