import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { LogEntry, Viewer } from "#shared/model.ts";
import { projectArchivedLog } from "#shared/project.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import { heldOpLines, ReceiptLines } from "../rooms/logHistory.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { readReceipts } from "../rooms/persistence.ts";

/**
 * The receipt lookup (docs/design-v1-dice.md 1.2): what became of the
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
 * the raw query before (ReceiptLines). Every part is projected against one
 * committed state, captured once, so a commit during the lookup never mixes
 * two. Behind the room's grant, and limited per member and room before
 * anything is read.
 */
const TAG = z.string().min(1).max(64);

/** How long a whole lookup may read the archive. */
const RECEIPT_DEADLINE_MS = 5_000;

export type ReceiptPart =
  | { part: number; state: "committed"; seq: number; lines: LogEntry[] }
  | { part: number; state: "refused"; code: string; message: string };

export type ReceiptRouteOptions = { lines?: ReceiptLines; deadlineMs?: number };

export function registerReceiptRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager; options?: ReceiptRouteOptions }): Promise<void> {
  const archive = deps.options?.lines ?? new ReceiptLines({ pool: kit.pool });
  const deadlineMs = deps.options?.deadlineMs ?? RECEIPT_DEADLINE_MS;
  return accessRoutes(app, (r) => {
    r.get("/api/rooms/:id/receipts/:tag", async (req, reply) => {
      const roomId = roomParam(req);
      const tag = TAG.safeParse((req.params as { tag?: unknown }).tag);
      if (!tag.success) throw new HttpError(400, "invalid_query");
      const grant = await requireGrant(kit, req, reply, roomId);
      enforce(await kit.limits.receiptLookups(roomId, grant.memberId));
      await kit.limits.recordReceiptLookup(roomId, grant.memberId);
      const actor = await deps.manager.acquire(roomId);
      const viewer: Viewer = { memberId: grant.memberId, role: grant.role };
      const { state } = actor.committed;
      const scene = grant.role === "dm" ? state.meta.playerSceneId : null;
      const rows = await readReceipts(kit.pool, roomId, grant.memberId, tag.data);
      const held = new Map<number, LogEntry[] | null>();
      for (const row of rows) if (row.state === "committed" && row.seq !== null) held.set(row.seq, heldOpLines(state, viewer, row.seq));
      const missing = [...held].flatMap(([seq, lines]) => (lines === null ? [seq] : []));
      const read = missing.length === 0 ? new Map<number, LogEntry[]>() : await readArchive(reply, roomId, missing, viewer);
      const parts: ReceiptPart[] = [];
      for (const row of rows) {
        if (row.state === "refused" || row.seq === null) {
          parts.push({ part: row.part, state: "refused", code: row.code ?? "invalid", message: row.message ?? "" });
          continue;
        }
        const entries = held.get(row.seq) ?? read.get(row.seq) ?? [];
        parts.push({ part: row.part, state: "committed", seq: row.seq, lines: projectArchivedLog(state, entries, viewer, { sceneId: scene }) });
      }
      reply.header("cache-control", "no-store");
      return { parts };
    });
  });

  /** The archive's lines for `seqs`, cancelled when the client goes or the deadline passes, which fails the lookup as busy. */
  async function readArchive(reply: FastifyReply, roomId: string, seqs: number[], viewer: Viewer): Promise<Map<number, LogEntry[]>> {
    const gone = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) gone.abort(new Error("client went away"));
    };
    reply.raw.on("close", onClose);
    try {
      return await archive.read(roomId, seqs, viewer, AbortSignal.any([gone.signal, AbortSignal.timeout(deadlineMs)]));
    } catch (err) {
      if (err instanceof ScanBusyError || err instanceof ScanCancelledError) throw new HttpError(503, "busy", { retryAfter: 1 });
      throw err;
    } finally {
      reply.raw.off("close", onClose);
    }
  }
}
