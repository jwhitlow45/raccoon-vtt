import { describeEvent, memberName, whisperHeading, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";

/**
 * The session log export (docs/design-v1-dm-tools.md 3.10): sessions found
 * among the lines a viewer may read, and the Markdown file of one session
 * or of everything. The log keeps no sessions, and the group plays one
 * evening at a time, so a session is a run of lines, in id order, with no
 * gap over 4 hours between one line's time and the next's.
 *
 * Everything here works on entries already projected for the viewer, so a
 * session's bounds, its line count and the file hold only what that
 * viewer's Log panel shows. Each line reads as the panel reads it, through
 * shared/logText.ts. Both work a line at a time, so the server can find
 * sessions and write a file over an archive of any length without holding
 * it (server/rooms/logHistory.ts).
 */

export const SESSION_GAP_MS = 4 * 3_600_000;

/**
 * One session: its first and last lines' ids, which select it for export,
 * and their times, which only label it. A clock that stepped back keeps a
 * line in its session, so `to` can be earlier than `from`.
 */
export type LogSession = { firstId: string; lastId: string; from: string; to: string; lines: number };

/** Groups entries, oldest first, into sessions, handing each to `done` once it ends. */
export class SessionFold {
  #gapMs: number;
  #done: (session: LogSession) => void;
  #current: (LogSession & { toMs: number }) | null = null;

  constructor(done: (session: LogSession) => void, gapMs = SESSION_GAP_MS) {
    this.#done = done;
    this.#gapMs = gapMs;
  }

  add(entry: LogEntry): void {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return;
    const current = this.#current;
    if (current && at - current.toMs <= this.#gapMs) {
      current.lastId = entry.id;
      current.to = entry.at;
      current.toMs = at;
      current.lines++;
      return;
    }
    this.end();
    this.#current = { firstId: entry.id, lastId: entry.id, from: entry.at, to: entry.at, toMs: at, lines: 1 };
  }

  /** Ends the open session, if there is one. */
  end(): void {
    const current = this.#current;
    if (!current) return;
    this.#current = null;
    this.#done({ firstId: current.firstId, lastId: current.lastId, from: current.from, to: current.to, lines: current.lines });
  }
}

/** Sessions, newest first. `entries` are oldest first. */
export function sessionsOf(entries: readonly LogEntry[], gapMs = SESSION_GAP_MS): LogSession[] {
  const out: LogSession[] = [];
  const fold = new SessionFold((s) => out.push(s), gapMs);
  for (const entry of entries) fold.add(entry);
  fold.end();
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

export type ExportInput = { roomName: string; names: LogNames; me: string; tz: string; dm?: boolean };

/**
 * The file, written in pieces: a title with the room's name and the dates
 * it covers, then one line per entry, oldest first. When the lines span more
 * than one day in the viewer's zone, each day gets a heading of its own.
 * The title needs the first and last entries, so the server finds those
 * first and then streams the lines through `lines`.
 */
export class ExportFormatter {
  #c: Clock;
  #input: ExportInput;
  #severalDays: boolean;
  #title: string;
  #day = "";

  constructor(input: ExportInput, ends: { first: Pick<LogEntry, "at">; last: Pick<LogEntry, "at"> } | null) {
    this.#c = clock(input.tz);
    this.#input = input;
    const title = escapeName(input.roomName);
    if (!ends) {
      this.#title = `# ${title}: log\n\nNo lines.\n`;
      this.#severalDays = false;
      return;
    }
    const firstDate = plain(this.#c.date.format(new Date(ends.first.at)));
    const lastDate = plain(this.#c.date.format(new Date(ends.last.at)));
    this.#title = `# ${title}: log of ${firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`}\n\n`;
    this.#severalDays = firstDate !== lastDate;
  }

  head(): string {
    return this.#title;
  }

  /** The text of the next entries, oldest first, with a day's heading wherever a new day starts. */
  lines(entries: readonly LogEntry[]): string {
    let out = "";
    for (const entry of entries) {
      const at = new Date(entry.at);
      if (this.#severalDays) {
        const today = plain(this.#c.day.format(at));
        if (today !== this.#day) {
          if (this.#day !== "") out += "\n";
          out += `## ${today}\n\n`;
          this.#day = today;
        }
      }
      const line = exportLine(entry, this.#input.names, this.#input.me, plain(this.#c.time.format(at)), this.#input.dm === true);
      if (line !== null) out += `${line}\n`;
    }
    return out;
  }
}

/** The whole file at once, for entries in hand. */
export function renderLogExport(input: ExportInput & { entries: readonly LogEntry[] }): string {
  const first = input.entries[0];
  const last = input.entries[input.entries.length - 1];
  const format = new ExportFormatter(input, first && last ? { first, last } : null);
  return first ? format.head() + format.lines(input.entries) : format.head();
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
