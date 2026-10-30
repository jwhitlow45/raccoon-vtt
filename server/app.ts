import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import pg from "pg";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { registerCleanup, type CleanupOptions } from "./assets/cleanup.ts";
import { AssetError } from "./assets/errors.ts";
import { uploadedAssetIds } from "./assets/store.ts";
import type { PasswordHasher } from "./auth/passwords.ts";
import { setupAuth } from "./auth/plugin.ts";
import type { Config } from "./config.ts";
import { registerAdminRoutes } from "./http/admin.ts";
import { registerAssetRoutes, type AssetRouteOptions } from "./http/assets.ts";
import { registerDisplayRoutes } from "./http/display.ts";
import { registerDmRoutes } from "./http/dm.ts";
import { registerExportRoutes, type ExportOptions } from "./http/export.ts";
import { registerJoinRoutes } from "./http/join.ts";
import { registerLogRoutes, type LogRouteOptions } from "./http/log.ts";
import { watchPoolErrors } from "./db.ts";
import { DEFAULT_SCAN_BUDGET, LogScanBudget } from "./rooms/logScanBudget.ts";
import { registerReceiptRoutes } from "./http/receipts.ts";
import { registerMemberRoutes } from "./http/members.ts";
import { registerRoomRoutes } from "./http/rooms.ts";
import { registerSecurity } from "./http/security.ts";
import { registerStatic } from "./http/static.ts";
import { registerXCardRoutes } from "./http/xcard.ts";
import { registerPlayerViewRoutes } from "./http/playerView.ts";
import { registerDdbImportRoutes, type DdbImportOptions } from "./http/ddbImport.ts";
import { TooBusyError } from "./rooms/errors.ts";
import { RoomNotFoundError, type RoomGateway } from "./rooms/gateway.ts";
import { RoomManager, type ManagerOptions } from "./rooms/manager.ts";
import { registerWebSocket, type WsOptions } from "./rooms/ws.ts";

export type AppDeps = {
  config: Config;
  pool: pg.Pool;
  /** The gateway the HTTP routes use. Defaults to the room manager's actor-backed one. */
  gateway?: RoomGateway;
  /** Tests pass their own to control the argon2 queue. */
  hasher?: PasswordHasher;
  /** Room engine limits and timings, for tests. */
  rooms?: Partial<ManagerOptions>;
  ws?: WsOptions;
  export?: ExportOptions;
  /** When image cleanup's daily job first runs (docs/design-v1-dm-tools.md 3.19). */
  cleanup?: CleanupOptions;
  /** The D&D Beyond import's limits and way out, for tests (docs/design-v1-pc-stats.md 6.3). */
  ddb?: Partial<DdbImportOptions>;
  /** The asset service's options, for tests: a starter catalog of their own (docs/design-v1-starter-art.md 5). */
  assets?: AssetRouteOptions;
  /** The log archive reader's admission and batches, for tests. */
  log?: Omit<LogRouteOptions, "pool">;
};

/**
 * The log archive's scans take their connections from a pool of their own,
 * one connection per lease of the scan budget (server/rooms/logScanBudget.ts),
 * so no archive reader can take a connection a room needs to commit. Taking a
 * connection and every query on one are bounded, so a stalled connection
 * cannot hold a scan's turn or lease past its request's deadline.
 */
const LOG_SCAN_CHECKOUT_MS = 500;
const LOG_SCAN_QUERY_MS = 15_000;

/**
 * Builds the HTTP and WebSocket server without listening, so integration
 * tests can drive it with `app.inject` and a real WebSocket client.
 *
 * Each area registers its routes from its own module (server/http/*,
 * server/rooms/*). Add the registration here, one line per module, after
 * setupAuth: the rate limiter only covers routes registered after it.
 */
export async function buildApp({ config, pool, gateway, hasher, rooms, ws, export: exportOptions, cleanup, ddb, assets, log }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.production ? "info" : "debug" },
    // cloudflared keeps idle origin connections for 90 s. A shorter Node
    // keep-alive makes it reuse sockets Node already closed, which shows up
    // as sporadic 502s on uploads (design section 10.7).
    keepAliveTimeout: 95_000,
    bodyLimit: 64 * 1024,
  });
  app.server.headersTimeout = 96_000;
  app.decorate("config", config);
  app.decorate("pool", pool);

  // Every scope's own handler answers the refusals it expects and passes the
  // rest up to here. An unexpected failure is logged in full and answered
  // with a bare code: Fastify's default would send the error's own message
  // and code, such as a database address, to anyone who can trigger it.
  // Client errors from Fastify itself (a malformed body, a wrong content
  // type) keep their default answers.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) throw err;
    req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: "internal" satisfies ApiErrorCode });
  });

  // Headers and CSRF before anything else, so they cover every route.
  registerSecurity(app, config);

  const manager = new RoomManager({
    pool,
    log: app.log,
    options: {
      ...rooms,
      actor: {
        quotaBytes: config.ROOM_QUOTA_MB * 1024 * 1024,
        // The archive shares the asset volume's floor. The asset service is registered below, before any room loads.
        archiveGuard: () => app.assets.archiveDiskOk(),
        ...rooms?.actor,
      },
    },
  });
  app.decorate("rooms", manager);
  // Shutdown steps 3 and 4 (design 15.4): the socket layer's preClose has already sent 1012.
  app.addHook("onClose", async () => manager.close());

  // Status only, never a room id (design 10.7).
  app.get("/healthz", async () => ({ status: manager.degraded() ? "degraded" : "ok" }));

  const roomGateway = gateway ?? manager.gateway;
  app.decorate("gateway", roomGateway);
  const kit = await setupAuth(app, { config, pool, gateway: roomGateway, hasher });

  await registerRoomRoutes(app, kit);
  await registerJoinRoutes(app, kit);
  await registerDmRoutes(app, kit);
  await registerMemberRoutes(app, kit);
  await registerAssetRoutes(app, assets);
  // A player's visible assets come from the room's projection (design 11.2), plus their own uploads.
  app.assets.setVisibleAssets(async (roomId, memberId) => {
    const ids = await uploadedAssetIds(pool, roomId, memberId);
    try {
      const actor = await manager.acquire(roomId);
      for (const id of actor.visibleAssets(memberId)) ids.add(id);
    } catch (err) {
      if (err instanceof TooBusyError) throw new AssetError(503, "busy", { retryAfter: 30 });
      if (!(err instanceof RoomNotFoundError)) throw err;
    }
    return ids;
  });
  // After the asset routes: the display image route reads `app.assets`.
  await registerDisplayRoutes(app, kit, { manager });
  await registerCleanup(app, cleanup);
  await registerAdminRoutes(app, kit);
  await registerWebSocket(app, { manager, config, options: ws });
  await registerExportRoutes(app, kit, { manager, options: exportOptions });
  const budget = log?.budget;
  const leases = budget instanceof LogScanBudget ? budget.options.leases : { ...DEFAULT_SCAN_BUDGET.leases, ...budget?.leases };
  const scanPool = new pg.Pool({ ...pool.options, max: leases.page + leases.export, connectionTimeoutMillis: LOG_SCAN_CHECKOUT_MS, query_timeout: LOG_SCAN_QUERY_MS });
  // A connection that drops while a scan holds it errors on the client, which must never go unheard.
  watchPoolErrors(scanPool, (err, where) => app.log.warn({ err, where }, "log scan connection failed"));
  app.addHook("onClose", async () => scanPool.end());
  await registerLogRoutes(app, kit, { manager, options: { ...log, pool: scanPool } });
  await registerReceiptRoutes(app, kit, { manager });
  await registerXCardRoutes(app, kit, { manager });
  await registerPlayerViewRoutes(app, kit, { manager });
  // On the strict egress port, whose squid list names D&D Beyond's character service alone (docs/design-v1-pc-stats.md 6.3).
  await registerDdbImportRoutes(app, { dispatcher: app.assets.egress.strict, ...ddb });

  // The built SPA, when there is one. In development Vite serves it instead.
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  if (existsSync(dist)) await registerStatic(app, dist);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    pool: pg.Pool;
    rooms: RoomManager;
  }
}
