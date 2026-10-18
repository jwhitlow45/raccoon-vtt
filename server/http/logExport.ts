import { describeEvent, memberName, whisperHeading, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";

/**
 * The session log export (docs/design-v1-dm-tools.md 3.10): sessions found
 * among the lines a viewer may read, and the Markdown file of one session
 * or of everything. The log keeps no sessions, and the group plays one
 * evening at a time, so a session is a run of lines with no gap over 4
 * hours between two of them.
 *
 * Everything here works on entries already projected for the viewer, so a
 * session's bounds, its line count and the file hold only what that
 * viewer's Log panel shows. Each line reads as the panel reads it, through
 * shared/logText.ts.
 */

export const SESSION_GAP_MS = 4 * 3_600_000;

export type LogSession = { from: string; to: string; lines: number };

/** Sessions, newest first. `entries` are oldest first. */
export function sessionsOf(entries: readonly LogEntry[], gapMs = SESSION_GAP_MS): LogSession[] {
  const out: LogSession[] = [];
  let current: { from: string; to: string; toMs: number; lines: number } | null = null;
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    if (current && at - current.toMs <= gapMs) {
      current.to = entry.at;
      current.toMs = at;
      current.lines++;
      continue;
    }
    if (current) out.push({ from: current.from, to: current.to, lines: current.lines });
    current = { from: entry.at, to: entry.at, toMs: at, lines: 1 };
  }
  if (current) out.push({ from: current.from, to: current.to, lines: current.lines });
  return out.reverse();
}

/** Accepted when a formatter constructs with it: `UTC` works, though `Intl.supportedValuesOf('timeZone')` does not list it. */
export function validTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The entries in `[from, to]`, either bound open. */
export function entriesBetween(entries: readonly LogEntry[], from: string | undefined, to: string | undefined): LogEntry[] {
  const lo = from === undefined ? -Infinity : Date.parse(from);
  const hi = to === undefined ? Infinity : Date.parse(to);
  return entries.filter((e) => {
    const at = Date.parse(e.at);
    return at >= lo && at <= hi;
  });
}

type Clock = { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; day: Intl.DateTimeFormat; ymd: Intl.DateTimeFormat };

function clock(tz: string): Clock {
  return {
    time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
    date: new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }),
    day: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    ymd: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
  };
}

/** ICU puts a narrow no-break space before AM and PM. A plain one reads the same and survives every editor. */
function plain(text: string): string {
  return text.replace(/[  ]/g, " ");
}

/** Names go in bold, so the characters that would end or start Markdown formatting there are escaped. */
function escapeName(name: string): string {
  return name.replace(/([\\`*_[\]<>#])/g, "\\$1");
}

/** A message's own text, kept as typed, with its later lines under its bullet and no raw HTML. */
function messageText(text: string): string {
  return text.replaceAll("<", "&lt;").replace(/\r?\n/g, "\n  ");
}

/** One line of the file, as the Log panel reads it, with the time in the viewer's zone. */
export function exportLine(entry: LogEntry, names: LogNames, me: string, time: string, dm = false): string | null {
  if (entry.kind === "event") {
    if (!entry.data) return null;
    return `- ${time} ${messageText(describeEvent(entry.data, names, dm))}`;
  }
  const who = `**${escapeName(memberName(names, entry.from))}**`;
  const text = messageText(entry.text ?? "");
  if (entry.kind === "whisper") {
    const heading = whisperHeading(entry, names.members, me);
    return `- ${time} ${who} (${heading.charAt(0).toLowerCase()}${heading.slice(1)}): ${text}`;
  }
  return `- ${time} ${who}: ${text}`;
}

/**
 * The file: a title with the room's name and the dates it covers, then one
 * line per entry, oldest first. When the lines span more than one day in the
 * viewer's zone, each day gets a heading of its own.
 */
export function renderLogExport(input: { roomName: string; entries: readonly LogEntry[]; names: LogNames; me: string; tz: string; dm?: boolean }): string {
  const c = clock(input.tz);
  const first = input.entries[0];
  const last = input.entries[input.entries.length - 1];
  const title = escapeName(input.roomName);
  if (!first || !last) return `# ${title}: log\n\nNo lines.\n`;
  const firstDate = plain(c.date.format(new Date(first.at)));
  const lastDate = plain(c.date.format(new Date(last.at)));
  const out = [`# ${title}: log of ${firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`}`, ""];
  const severalDays = firstDate !== lastDate;
  let day = "";
  for (const entry of input.entries) {
    const at = new Date(entry.at);
    if (severalDays) {
      const today = plain(c.day.format(at));
      if (today !== day) {
        if (day !== "") out.push("");
        out.push(`## ${today}`, "");
        day = today;
      }
    }
    const line = exportLine(entry, input.names, input.me, plain(c.time.format(at)), input.dm === true);
    if (line !== null) out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/** "crypt-crawlers-log-2026-10-14.md", dated by the line `at` in the viewer's zone (today when there is none). */
export function exportFileName(roomName: string, at: string | undefined, tz: string): string {
  const slug =
    roomName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "room";
  const date = clock(tz).ymd.format(at === undefined ? new Date() : new Date(at));
  return `${slug}-log-${date}.md`;
}
