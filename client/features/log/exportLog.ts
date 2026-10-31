import { LIMITS } from "#shared/limits.ts";
import { FileCutShortError, type LogRange, type LogSession } from "../../lib/api.ts";

/**
 * The session log export's words (docs/design-v1-dm-tools.md 3.10): each
 * session as the sheet lists it, and what a failed export says. Plain
 * functions with the locale and time zone passed in, so they run under
 * node --test. ExportLog.tsx draws the sheet.
 */

function lines(n: number, locale: string | undefined): string {
  return `${n.toLocaleString(locale)} ${n === 1 ? "line" : "lines"}`;
}

/**
 * "Tuesday, October 14, 7:02 PM to 10:48 PM, 412 lines", in the device's
 * own time, as the Log panel shows times. A session past midnight names
 * its second day, and one from another year names the year.
 */
export function sessionLabel(session: LogSession, opts: { locale?: string; timeZone?: string; now?: Date } = {}): string {
  const { locale, timeZone } = opts;
  const from = new Date(session.from);
  const to = new Date(session.to);
  const now = opts.now ?? new Date();
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const dayOptions: Intl.DateTimeFormatOptions = { timeZone, weekday: "long", month: "long", day: "numeric", ...(year(from) !== year(now) ? { year: "numeric" } : {}) };
  const day = (d: Date) => d.toLocaleDateString(locale, dayOptions);
  const time = (d: Date) => d.toLocaleTimeString(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const start = `${day(from)}, ${time(from)}`;
  const count = lines(session.lines, locale);
  const sameDay = day(to) === day(from);
  // A session inside one minute reads as that minute alone, not "7:02 PM to 7:02 PM".
  if (sameDay && time(to) === time(from)) return `${start}, ${count}`;
  const end = sameDay ? time(to) : `${day(to)}, ${time(to)}`;
  return `${start} to ${end}, ${count}`;
}

/**
 * A session's key and its export: its first and last lines' ids. Its times
 * only label it, since two sessions can share them when a clock ran back.
 */
export function sessionKey(session: LogSession): string {
  return `${session.firstId}|${session.lastId}`;
}

export function sessionRange(session: LogSession): LogRange {
  return { fromId: session.firstId, toId: session.lastId };
}

/** The sessions held with an older page of them after, each once, newest first. */
export function withOlderSessions(held: readonly LogSession[], page: readonly LogSession[]): LogSession[] {
  const keys = new Set(held.map(sessionKey));
  return [...held, ...page.filter((s) => !keys.has(sessionKey(s)))];
}

export type MoreSessions = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };
export type SessionList =
  | { kind: "loading" }
  | { kind: "ready"; sessions: LogSession[]; lines: number; next: string | null; more: MoreSessions }
  | { kind: "error"; message: string };

/**
 * The sheet's list once an Older sessions answer for the page before
 * `before` lands: `answer` is the page, or the failure's words. An answer
 * for a list that has moved on since it was asked changes nothing.
 */
export function withOlderAnswer(list: SessionList, before: string, answer: { sessions: LogSession[]; lines: number; nextSessionsBefore: string | null } | { failed: string }): SessionList {
  if (list.kind !== "ready" || list.next !== before) return list;
  if ("failed" in answer) return { ...list, more: { kind: "error", message: answer.failed } };
  return { kind: "ready", sessions: withOlderSessions(list.sessions, answer.sessions), lines: answer.lines, next: answer.nextSessionsBefore ?? null, more: { kind: "idle" } };
}

/**
 * The sheet's open flag for the answers it waits on: set at every setup,
 * and cleared with `close` at cleanup. Development's StrictMode runs
 * setup, cleanup and setup again, and an open flag cleared only at cleanup
 * would drop every later answer.
 */
export function whileOpen(open: { current: boolean }, close: () => void): () => void {
  open.current = true;
  return () => {
    open.current = false;
    close();
  };
}

/** "Everything, 2,104 lines": `total` counts every line of the log this viewer may read, on every page of sessions. */
export function everythingLabel(total: number, locale?: string): string {
  return `Everything, ${lines(total, locale)}`;
}

/** What a refused or failed request says, in the sheet. */
export function exportErrorText(err: unknown): string {
  if (err instanceof FileCutShortError) return "The log could not be exported. The file stopped before its end. Try again.";
  const e = err as { status?: number; code?: string; retryAfterMs?: number | null; message?: string } | null;
  if (e?.status === 429 && e.code === "busy") return "Someone in this room is exporting the log right now. Try again in a moment.";
  if (e?.status === 429) {
    const minutes = e.retryAfterMs ? Math.max(1, Math.ceil(e.retryAfterMs / 60_000)) : null;
    const when = minutes === null ? "later" : minutes === 1 ? "in a minute" : `in ${minutes} minutes`;
    return `Too many log exports this hour. Try again ${when}.`;
  }
  if (e?.code === "network" || e?.status === 0) return "Could not reach the server. Check your connection and try again.";
  return e?.message ? `The log could not be exported. ${e.message}` : "The log could not be exported. Try again.";
}

/** Why the sheet asks once and keeps its list: every page of sessions, every export and every download counts against one hourly limit. */
export const EXPORT_LIMIT_NOTE = `Opening this list, Older sessions, and each export or download count toward ${LIMITS.logExportsPerHour} an hour.`;

/** A file past the size the page reads (MAX_LOG_FILE_BYTES): the browser's own download saves it instead. */
export const LARGE_FILE_NOTE = "This file is large. Use Download to save it. Download uses another export request.";

/** The device's IANA time zone, which the file's times follow, or UTC where the browser cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
