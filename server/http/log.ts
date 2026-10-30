import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Viewer } from "#shared/model.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import { sha256 } from "../auth/tokens.ts";
import type { GrantContext } from "../auth/types.ts";
import { admissionHolds, canonicalId, captureView, compareIds, LogHistory, viewNames, type ExportRange, type HistoryAdmission, type LogHistoryOptions } from "../rooms/logHistory.ts";
import { LogScanBudget, ScanBusyError, ScanCancelledError, type ScanBudgetOptions, type ScanPool } from "../rooms/logScanBudget.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { ExportFormatter, exportFileName, validTimeZone } from "./logExport.ts";

/**
 * The log archive's routes (design 10.8, docs/design-v1-dm-tools.md 3.10):
 * Show older and newer pages, the session listing and the session export,
 * every one read through the history reader (server/rooms/logHistory.ts),
 * projected for the caller exactly as the live log is (design 7.3), so a
 * whisper or an event about a hidden creature never comes back through the
 * archive, and what each answers depends on the lines the caller may read
 * alone.
 *
 * Players read with the player scene. A DM may name the scene it is
 * viewing, which the DM's projection does not narrow by: a DM's pages and
 * files hold every scene's lines.
 *
 * A DM may also ask a page `as` a player of the roster, for View as a
 * player (docs/design-v1-per-player-vision.md 7.4): the page is that
 * player's, less every whisper the DM is not party to, as the preview's
 * socket gets its log, and it names the player it was answered as (`as`),
 * which the preview checks (D-261026-10). `as` from a player, or naming
 * anyone but a player of the roster, is refused.
 */

const EntryId = z.string().regex(/^\d{1,18}:\d{1,6}$/);

/*
 * A page is `limit` lines before an id, or after one, the newest when
 * neither is given. Its cursors are its own oldest and newest lines, never
 * a row the caller may not see, and a page that came back short says that
 * direction ended (logHistory.ts page). So a full page always offers the
 * next, which may come back empty.
 */
const Query = z
  .object({
    before: EntryId.optional(),
    after: EntryId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    sceneId: z.string().min(1).max(64).optional(),
    as: z.string().min(1).max(64).optional(),
  })
  .refine((q) => q.before === undefined || q.after === undefined);

const SessionsQuery = z.object({
  before: EntryId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

const Instant = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)));
/**
 * A session is exported by its first and last ids, both or neither (for
 * everything). The older `from` and `to` times still filter for clients
 * that send them, but never together with ids.
 */
const ExportQuery = z
  .object({
    fromId: EntryId.optional(),
    toId: EntryId.optional(),
    from: Instant.optional(),
    to: Instant.optional(),
    tz: z.string().max(64).default("UTC"),
  })
  .refine((q) => (q.fromId === undefined) === (q.toId === undefined))
  .refine((q) => q.fromId === undefined || (q.from === undefined && q.to === undefined));

/** How long a whole request may scan. */
const PAGE_DEADLINE_MS = 5_000;
const EXPORT_DEADLINE_MS = 30_000;

export type LogRouteOptions = {
  /** The pool scans take their cursors' connections from. Defaults to the app's own pool. */
  pool?: Pick<pg.Pool, "connect">;
  /** The budget's limits, or for tests a budget to watch. */
  budget?: Partial<ScanBudgetOptions> | LogScanBudget;
  history?: Omit<LogHistoryOptions, "pool">;
  /** Whole-request deadlines, for tests. */
  deadlines?: { pageMs?: number; exportMs?: number };
};

export function registerLogRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager; options?: LogRouteOptions }): Promise<void> {
  const given = deps.options?.budget;
  const budget = given instanceof LogScanBudget ? given : new LogScanBudget(given);
  const pageMs = deps.options?.deadlines?.pageMs ?? PAGE_DEADLINE_MS;
  const exportMs = deps.options?.deadlines?.exportMs ?? EXPORT_DEADLINE_MS;
  const history = new LogHistory({ pool: deps.options?.pool ?? kit.pool, ...deps.options?.history });
  deps.manager.onDelete((roomId) => budget.cancelRoom(roomId));
  app.addHook("preClose", async () => budget.close());
  /** Rooms with an export being written: one at a time per room. */
  const exporting = new Set<string>();

  /**
   * Every listing and every export is charged against one limit per member
   * and room, cached or not (ratelimit.ts logExport), before anything is
   * read, so the answers and the limit left never depend on hidden ops.
   */
  async function grantAndCheck(req: FastifyRequest, reply: FastifyReply, roomId: string): Promise<GrantContext> {
    const grant = await requireGrant(kit, req, reply, roomId);
    enforce(await kit.limits.logExport(roomId, grant.memberId, kit.ip(req)));
    return grant;
  }

  /** Who the request was admitted as, with its cookie token's hash, fixed now for every later check. */
  async function admission(req: FastifyRequest, grant: GrantContext): Promise<HistoryAdmission> {
    const session = await kit.sessions.lookup(req);
    if (!session || session.id !== grant.sessionId) throw new HttpError(403, "no_access");
    return { sessionId: grant.sessionId, tokenHash: sha256(session.token), roomId: grant.roomId, memberId: grant.memberId, role: grant.role };
  }

  async function stillAdmitted(a: HistoryAdmission): Promise<void> {
    if (!(await admissionHolds(kit.pool, a))) throw new HttpError(403, "no_access");
  }

  /**
   * The request's scan: cancelled when the client goes or its deadline
   * passes. Admission and deadline failures are failures, answered busy,
   * never a short answer.
   */
  function openScan(reply: FastifyReply, pool: ScanPool, roomId: string, memberId: string, deadlineMs: number) {
    const gone = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) gone.abort(new Error("client went away"));
    };
    reply.raw.on("close", onClose);
    const signal = AbortSignal.any([gone.signal, AbortSignal.timeout(deadlineMs)]);
    const scan = budget.open({ pool, roomId, memberId, signal });
    return {
      scan,
      close: () => {
        reply.raw.off("close", onClose);
        scan.close();
      },
    };
  }

  function scanFailure(err: unknown): unknown {
    if (err instanceof ScanBusyError) return new HttpError(429, "busy", { retryAfter: err.retryAfter });
    if (err instanceof ScanCancelledError) return new HttpError(503, "busy", { retryAfter: 1 });
    return err;
  }

  return accessRoutes(app, (r) => {
    r.get("/api/rooms/:id/log/sessions", async (req, reply) => {
      const roomId = roomParam(req);
      reply.header("cache-control", "no-store");
      const query = SessionsQuery.safeParse(req.query);
      if (!query.success) throw new HttpError(400, "invalid_query");
      const before = query.data.before === undefined ? undefined : canonicalId(query.data.before)!;
      const grant = await grantAndCheck(req, reply, roomId);
      await kit.limits.recordLogExport(roomId, grant.memberId, kit.ip(req));
      const admitted = await admission(req, grant);
      const actor = await deps.manager.acquire(roomId);
      const view = captureView(actor.committed, roomId, { memberId: grant.memberId, role: grant.role });
      const { scan, close } = openScan(reply, "page", roomId, grant.memberId, pageMs);
      try {
        const page = await history.sessions(view, { before, limit: query.data.limit }, scan).catch((err: unknown) => {
          throw scanFailure(err);
        });
        await stillAdmitted(admitted);
        return page;
      } finally {
        close();
      }
    });

    r.get("/api/rooms/:id/log/export", async (req, reply) => {
      const roomId = roomParam(req);
      reply.header("cache-control", "no-store");
      const query = ExportQuery.safeParse(req.query);
      if (!query.success || !validTimeZone(query.data.tz)) throw new HttpError(400, "invalid_query");
      const { fromId, toId, from, to, tz } = query.data;
      const range: ExportRange = {};
      if (fromId !== undefined && toId !== undefined) {
        range.fromId = canonicalId(fromId)!;
        range.toId = canonicalId(toId)!;
        if (compareIds(range.fromId, range.toId) > 0) throw new HttpError(400, "invalid_query");
      }
      if (from !== undefined) range.fromMs = Date.parse(from);
      if (to !== undefined) range.toMs = Date.parse(to);
      const grant = await grantAndCheck(req, reply, roomId);
      if (exporting.has(roomId)) throw new HttpError(429, "busy", { retryAfter: 2 });
      exporting.add(roomId);
      let streaming = false;
      let opened: ReturnType<typeof openScan> | null = null;
      try {
        await kit.limits.recordLogExport(roomId, grant.memberId, kit.ip(req));
        const admitted = await admission(req, grant);
        const actor = await deps.manager.acquire(roomId);
        const view = captureView(actor.committed, roomId, { memberId: grant.memberId, role: grant.role });
        opened = openScan(reply, "export", roomId, grant.memberId, exportMs);
        const { scan, close } = opened;
        // The first pass finds the title's dates and the file's name, so the headers go out right before the lines.
        const ends = await history.bounds(view, range, scan).catch((err: unknown) => {
          throw scanFailure(err);
        });
        await stillAdmitted(admitted);
        const format = new ExportFormatter({ roomName: view.state.meta.name, names: viewNames(view), me: grant.memberId, tz, dm: grant.role === "dm" }, ends);
        // A session is named for the evening it started, everything for its newest line.
        const session = range.fromId !== undefined || range.fromMs !== undefined;
        const name = exportFileName(view.state.meta.name, session ? ends?.first.at : ends?.last.at, tz);
        /*
         * Once the headers are out, any failure (a query, the scan's
         * admission or deadline, or the caller's admission ending) destroys
         * the response without its last chunk, so the download fails rather
         * than saving a file cut short as if it were whole.
         */
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          close();
          exporting.delete(roomId);
        };
        async function* body(): AsyncGenerator<string> {
          try {
            yield format.head();
            if (!ends) return;
            for await (const batch of history.exportBatches(view, range, scan)) {
              await stillAdmitted(admitted);
              const text = format.lines(batch);
              if (text !== "") yield text;
            }
          } finally {
            end();
          }
        }
        if (scan.signal.aborted) throw new HttpError(503, "busy", { retryAfter: 1 });
        const stream = Readable.from(body(), { objectMode: false });
        // A stream destroyed before it was read never runs the body, and one destroyed mid-batch stops its query here.
        stream.on("close", () => {
          scan.cancel(new Error("export stream closed"));
          end();
        });
        // A cancelled scan (deadline, room deletion, shutdown) ends the stream itself: a reader that stopped reading
        // leaves the body waiting at its last chunk, where nothing else would release the scan's lease.
        scan.signal.addEventListener("abort", () => stream.destroy(new Error("export cancelled")), { once: true });
        streaming = true;
        return reply
          .header("content-type", "text/markdown; charset=utf-8")
          .header("content-disposition", `attachment; filename="${name}"`)
          .send(stream);
      } finally {
        if (!streaming) {
          opened?.close();
          exporting.delete(roomId);
        }
      }
    });

    r.get("/api/rooms/:id/log", async (req, reply) => {
      const roomId = roomParam(req);
      reply.header("cache-control", "no-store");
      const grant = await requireGrant(kit, req, reply, roomId);
      const query = Query.safeParse(req.query);
      if (!query.success) throw new HttpError(400, "invalid_query");
      const { limit, sceneId, as } = query.data;
      const before = query.data.before === undefined ? undefined : canonicalId(query.data.before)!;
      const after = query.data.after === undefined ? undefined : canonicalId(query.data.after)!;
      if (as !== undefined && grant.role !== "dm") throw new HttpError(403, "no_access");
      // One fixed charge per page, before anything is read, so what is left never depends on what a scan met.
      const wait = budget.chargePage(roomId, grant.memberId);
      if (wait !== null) throw new HttpError(429, "rate_limited", { retryAfter: wait });
      const done = budget.beginPage(roomId, grant.memberId);
      if (!done) throw new HttpError(429, "busy", { retryAfter: 1 });
      let opened: ReturnType<typeof openScan> | null = null;
      try {
        const admitted = await admission(req, grant);
        const actor = await deps.manager.acquire(roomId);
        const committed = actor.committed;
        if (as !== undefined && committed.state.members[as]?.kind !== "player") throw new HttpError(403, "no_access");
        const scene = grant.role === "dm" && as === undefined ? (sceneId ?? committed.state.meta.playerSceneId) : null;
        const viewer: Viewer = as === undefined ? { memberId: grant.memberId, role: grant.role } : { memberId: as, role: "player" };
        const view = captureView(committed, roomId, viewer, { sceneId: scene, previewBy: as === undefined ? null : grant.memberId });
        opened = openScan(reply, "page", roomId, grant.memberId, pageMs);
        const page = await history.page(view, { before, after, limit }, opened.scan).catch((err: unknown) => {
          throw scanFailure(err);
        });
        await stillAdmitted(admitted);
        return { ...page, ...(as !== undefined ? { as } : {}) };
      } finally {
        opened?.close();
        done();
      }
    });
  });
}
