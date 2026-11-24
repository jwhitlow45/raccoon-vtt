import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LogEntry, Viewer } from "#shared/model.ts";
import { projectArchivedLog } from "#shared/project.ts";
import { mainFloorId } from "#shared/rules/floors.ts";
import { accessErrors, type AuthKit, HttpError, roomParam } from "../auth/http.ts";
import { ViewBusyError } from "../rooms/actor.ts";
import { ReceiptLines, receiptWait } from "../rooms/logHistory.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";
import type { RoomManager } from "../rooms/manager.ts";

/**
 * The receipt lookup (docs/design/design-v1-dice.md 1.2): what became of the
 * caller's own ops of one tag, for a device that lost an answer. Each part
 * the server holds a receipt for is committed, with the lines the op wrote
 * projected for the caller as the live log is, or refused, with the words.
 * A part the answer lacks is unknown to the device: never seen, past
 * retention, or another member's, which reads the same as none at all.
 *
 * It reads by key, the caller's member, the tag and its parts, never by
 * paging the log, so a hidden stretch of the log leaves no gap to count.
 * An op's lines no longer in memory come from the archive by the caller's
 * own streams and the op's seq once the room's metadata is complete, and by
 * the raw query before (ReceiptLines).
 *
 * The answer is the room as of the request's arrival (RoomActor.asOf): the
 * view after every batch through the last tick before it, which the room
 * gives once those batches have landed, and the receipt rows written before
 * that tick (persistence.ts readReceipts). So every row read belongs to a
 * batch the view holds, and a commit, a sweep or a tag's reuse landing
 * during the lookup never changes what it answers. Every part is projected
 * against that one view. The rows and the lines use bounded, cancellable
 * connections under the lookup's deadline, and none is held while the
 * room gives its view. Behind the room's grant, and limited per member and
 * room before anything is read.
 */
const TAG = z.string().min(1).max(64);

/** How long a whole lookup may authorize, charge, read and wait for the room's view. */
const RECEIPT_DEADLINE_MS = 5_000;

export type ReceiptPart =
  | { part: number; state: "committed"; seq: number; lines: LogEntry[] }
  | { part: number; state: "refused"; code: string; message: string };

export type ReceiptRouteOptions = { lines?: ReceiptLines; deadlineMs?: number };

export async function registerReceiptRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: Pick<RoomManager, "acquire" | "arrivalTick">; options?: ReceiptRouteOptions }): Promise<void> {
  const archive = deps.options?.lines ?? new ReceiptLines({ pool: kit.pool });
  const deadlineMs = deps.options?.deadlineMs ?? RECEIPT_DEADLINE_MS;
  await app.register(async (r) => {
    r.setErrorHandler(accessErrors);
    r.get("/api/rooms/:id/receipts/:tag", async (req, reply) => {
      const arrivedAt = req.arrivedAt;
      const roomId = roomParam(req);
      const tag = TAG.safeParse((req.params as { tag?: unknown }).tag);
      if (!tag.success) throw new HttpError(400, "invalid_query");
      const gone = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) gone.abort(new Error("client went away"));
      };
      reply.raw.on("close", onClose);
      const signal = AbortSignal.any([gone.signal, AbortSignal.timeout(deadlineMs)]);
      // The same deadline, for PostgreSQL to stop each statement at by itself (guardedQueries).
      const stopAt = performance.now() + deadlineMs;
      try {
        // The request limiter already resolved this memo, including cookie-less requests.
        if (!(await receiptWait(kit.sessions.lookup(req), signal))) throw new HttpError(403, "no_access");
        const grant = await archive.withQueries(signal, async (q) => {
          const allowed = await kit.auth.grant(req, reply, roomId, q);
          if (!allowed) return new HttpError(403, "no_access");
          const retryAfter = await kit.limits.receiptLookups(roomId, allowed.memberId, q);
          if (retryAfter !== null) return new HttpError(429, "rate_limited", { retryAfter });
          await kit.limits.recordReceiptLookup(roomId, allowed.memberId, q);
          return allowed;
        }, stopAt);
        if (grant instanceof HttpError) throw grant;
        const actor = await receiptWait(deps.manager.acquire(roomId), signal);
        const viewer: Viewer = { memberId: grant.memberId, role: grant.role };
        const view = await receiptWait(actor.asOf(arrivedAt, { signal }), signal);
        const { rows, lines } = await archive.lookup(roomId, viewer, tag.data, signal, view, deps.manager.arrivalTick(arrivedAt), stopAt);
        const state = view.state;
        // The DM's lines read as on the players' scene, every floor of it (docs/design/design-v1-floors.md 8.3).
        const start = grant.role === "dm" ? state.meta.playerSceneId : null;
        const scene = start === null ? null : mainFloorId(state, start);
        const parts: ReceiptPart[] = [];
        for (const row of rows) {
          if (row.state === "refused" || row.seq === null) {
            parts.push({ part: row.part, state: "refused", code: row.code ?? "invalid", message: row.message ?? "" });
            continue;
          }
          parts.push({ part: row.part, state: "committed", seq: row.seq, lines: projectArchivedLog(state, lines.get(row.seq) ?? [], viewer, { sceneId: scene }) });
        }
        reply.header("cache-control", "no-store");
        return { parts };
      } catch (err) {
        if (err instanceof ScanBusyError || err instanceof ScanCancelledError || err instanceof ViewBusyError) throw new HttpError(503, "busy", { retryAfter: 1 });
        throw err;
      } finally {
        reply.raw.off("close", onClose);
      }
    });
  });
}
