import type { LogEntry, Member } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { memberName } from "./format.ts";

/**
 * What the Log says while it is closed (features section 16): a count of
 * messages from others on its button, and a toast for a whisper to you,
 * which someone expects an answer to. Events (moves, turns, damage) count
 * for neither: the map and the strip already show them.
 */

export function latestLogId(log: readonly LogEntry[]): string | null {
  return log[log.length - 1]?.id ?? null;
}

const after = (entry: LogEntry, id: string | null) => id === null || compareLogIds(entry.id, id) > 0;

/** Chat and whispers from someone else newer than the last entry seen. */
export function unreadCount(log: readonly LogEntry[], seenId: string | null, me: string): number {
  let n = 0;
  for (const e of log) if (e.kind !== "event" && e.from !== me && after(e, seenId)) n++;
  return n;
}

/** Whispers to `me` from someone else, newer than `afterId`, oldest first. */
export function newWhispersTo(log: readonly LogEntry[], afterId: string | null, me: string): LogEntry[] {
  return log.filter((e) => e.kind === "whisper" && e.from !== me && (e.to ?? []).includes(me) && after(e, afterId));
}

const PREVIEW_CHARS = 80;

export function whisperToastText(entry: LogEntry, members: Readonly<Record<string, Member | undefined>>): string {
  const text = (entry.text ?? "").replace(/\s+/g, " ").trim();
  const short = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text;
  return `${memberName({ members }, entry.from)} whispers: ${short}`;
}

/** The badge text: a count, capped so it stays one small pill. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
