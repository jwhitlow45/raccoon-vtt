import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LogEntry, Viewer } from "#shared/model.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { readLogLines, readReceipts } from "../rooms/persistence.ts";

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
 * Behind the room's grant, and limited per member and room before anything
 * is read.
 */
const TAG = z.string().min(1).max(64);

export type ReceiptPart =
  | { part: number; state: "committed"; seq: number; lines: LogEntry[] }
  | { part: number; state: "refused"; code: string; message: string };

export function registerReceiptRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager }): Promise<void> {
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
      const scene = grant.role === "dm" ? actor.committed.state.meta.playerSceneId : null;
      const rows = await readReceipts(kit.pool, roomId, grant.memberId, tag.data);
      const parts: ReceiptPart[] = [];
      for (const row of rows) {
        if (row.state === "refused" || row.seq === null) {
          parts.push({ part: row.part, state: "refused", code: row.code ?? "invalid", message: row.message ?? "" });
          continue;
        }
        const entries = actor.committedLines(row.seq) ?? (await readLogLines(kit.pool, roomId, row.seq));
        parts.push({ part: row.part, state: "committed", seq: row.seq, lines: actor.projectLog(entries, viewer, scene) });
      }
      reply.header("cache-control", "no-store");
      return { parts };
    });
  });
}
