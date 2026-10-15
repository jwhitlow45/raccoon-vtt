import { ApiError } from "../../lib/api.ts";
import { parseRoomId } from "../../lib/roomId.ts";
import { formatBytes } from "../settings/backup.ts";
import type { AdminRoom, BackupRun } from "./api.ts";

/** How the admin page words its numbers, dates and refusals. Plain functions, so they are tested without a page. */

export { formatBytes };

export type RoomSort = "active" | "size";

/** Most recent activity first, or largest first. Ties go by name, then ID, so the order never jumps. */
export function sortRooms(rooms: readonly AdminRoom[], by: RoomSort): AdminRoom[] {
  return [...rooms].sort((a, b) => {
    const primary = by === "size" ? b.bytes - a.bytes : Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
    return primary || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then the date. */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute") + " ago";
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour") + " ago";
  if (ms < 30 * DAY) return plural(Math.floor(ms / DAY), "day") + " ago";
  return `on ${day(iso)}`;
}

/** A date with the time, in the viewer's own zone: "Oct 14, 2026, 4:00 AM". */
export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

const OUTCOMES: Record<BackupRun["outcome"], string> = {
  running: "Running",
  good: "Good",
  partial: "Partial",
  failed: "Failed",
  gone: "Gone",
};

const WHY: Partial<Record<BackupRun["outcome"], string>> = {
  partial: "The images did not all fit or copy, so the backup before it is still the one to restore.",
  gone: "Its files are no longer on the backups volume.",
};

/** A backup run in two lines: what became of it and when, then what it wrote or why it stopped. */
export function backupLines(run: BackupRun): { title: string; detail: string | null } {
  const title =
    run.outcome === "running" ? `Running, started ${when(run.startedAt)}.` : `${OUTCOMES[run.outcome]}, ${when(run.finishedAt ?? run.startedAt)}.`;
  const wrote = [
    run.dumpBytes !== null ? `${formatBytes(run.dumpBytes)} dump` : null,
    run.imagesCopied !== null ? `${plural(run.imagesCopied, "image")} copied` : null,
  ].filter((p) => p !== null);
  const detail = [WHY[run.outcome] ?? (run.outcome === "failed" ? run.error : null), wrote.length > 0 ? `${wrote.join(", ")}.` : null]
    .filter((p): p is string => Boolean(p))
    .join(" ");
  return { title, detail: detail || null };
}

/** Whether the typed text names this room, with or without the dash, in any case. */
export function confirmsRoom(typed: string, roomId: string): boolean {
  return parseRoomId(typed.trim()) === roomId;
}

/** A refused login in plain words. */
export function loginErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "bad_password":
      return "That is not the admin password.";
    case "rate_limited": {
      const minutes = Math.max(1, Math.ceil((err.retryAfterMs ?? MINUTE) / MINUTE));
      return `Too many wrong passwords. Try again in ${plural(minutes, "minute")}.`;
    }
    case "turnstile_failed":
      return "The human check did not pass. Try it again.";
    case "turnstile_unavailable":
      return "The human check could not be reached. Try again in a moment.";
    case "busy":
      return "The server is busy. Try again in a moment.";
    default:
      return err.message;
  }
}
