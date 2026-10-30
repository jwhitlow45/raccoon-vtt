import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog } from "#shared/project.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import { ReceiptLines } from "../rooms/logHistory.ts";
import { ScanBusyError, ScanCancelledError } from "../rooms/logScanBudget.ts";
import type { RoomManager } from "../rooms/manager.ts";
import type { ReceiptRow } from "../rooms/persistence.ts";

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
 * committed state, captured once, after the receipt rows are read and once
 * it holds each of their ops, so a commit during the lookup never mixes two
 * states and never meets a state older than its op. The rows and the lines
 * are read on one bounded, cancellable connection under the lookup's
 * deadline. Behind the room's grant, and limited per member and room before
 * anything is read.
 */
const TAG = z.string().min(1).max(64);

/** How long a whole lookup may read its rows and the archive, and wait for the room's state. */
const RECEIPT_DEADLINE_MS = 5_000;

export type ReceiptPart =
  | { part: number; state: "committed"; seq: number; lines: LogEntry[] }
  | { part: number; state: "refused"; code: string; message: string };

export type ReceiptRouteOptions = { lines?: ReceiptLines; deadlineMs?: number };

/** How often a lookup looks again for the room's state to reach a receipt's seq. */
const CAUGHT_UP_POLL_MS = 10;

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
      const gone = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) gone.abort(new Error("client went away"));
      };
      reply.raw.on("close", onClose);
      const signal = AbortSignal.any([gone.signal, AbortSignal.timeout(deadlineMs)]);
      let found: Awaited<ReturnType<ReceiptLines["lookup"]>>;
      try {
        // The state is taken after the rows are read, once it holds every committed receipt's op (stateThrough).
        found = await archive.lookup(roomId, viewer, tag.data, signal, (rows) => stateThrough(actor, newestCommitted(rows), signal));
      } catch (err) {
        if (err instanceof ScanBusyError || err instanceof ScanCancelledError) throw new HttpError(503, "busy", { retryAfter: 1 });
        throw err;
      } finally {
        reply.raw.off("close", onClose);
      }
      const { rows, state, lines } = found;
      const scene = grant.role === "dm" ? state.meta.playerSceneId : null;
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
    });
  });
}

function newestCommitted(rows: readonly ReceiptRow[]): number {
  let seq = 0;
  for (const row of rows) if (row.state === "committed" && row.seq !== null && row.seq > seq) seq = row.seq;
  return seq;
}

/**
 * The room's committed state once it has reached `seq`. A receipt is
 * written in its batch's transaction, a moment before the room takes that
 * batch as its committed state, so a row read in that moment is newer than
 * the state. Projecting its op's lines against a state without the op could
 * drop lines the caller may read, so the lookup waits for the state, and a
 * cancel or the deadline ends the wait as ScanCancelledError (busy).
 */
export async function stateThrough(actor: { readonly committed: { state: RoomState; seq: number } }, seq: number, signal: AbortSignal): Promise<RoomState> {
  for (;;) {
    const committed = actor.committed;
    if (committed.seq >= seq) return committed.state;
    if (signal.aborted) throw new ScanCancelledError(signal.reason);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ScanCancelledError(signal.reason));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, CAUGHT_UP_POLL_MS);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
