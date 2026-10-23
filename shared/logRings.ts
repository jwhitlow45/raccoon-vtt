import { compareLogIds } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import type { LogEntry, Viewer } from "./model.ts";
import { isWritable } from "./writable.ts";

/**
 * The room log's rings (design 7.3, Log). The log the room holds in memory
 * is one list in id order, and each line has one audience, fixed when it
 * is written: a whisper reaches only its sender and its recipients, a DM
 * line reaches no player at all, and a shared line reaches each viewer by
 * what they may see when they read it. Each audience keeps its own newest
 * lines and drops only its own oldest, so a line one viewer never receives
 * never pushes out a line they hold:
 *
 * - The shared lines keep their newest MAX_LOG.
 * - The DM lines keep their newest `dmLogLines`, and one whose JSON is over
 *   `dmLogLineBytes` is left to the archive. So the size guard can leave
 *   every one of them out of its measure (server/rooms/sizeGuard.ts), and a
 *   hidden line never changes whether an op passes.
 * - Each member's whispers keep their newest `whispersKept`, and a whisper
 *   stays while it is among the newest of anyone it reaches. A viewer's
 *   live log holds only their own newest (liveStart), so whispers between
 *   others never change which of theirs it holds.
 *
 * One ring may reach back further than another, and the archive's pages
 * start before a live log's oldest line, so a ring reaching back past the
 * rest would leave a gap no page fills. So once the shared lines hold their
 * MAX_LOG, a DM line or whisper older than the oldest of them goes, and a
 * viewer whose own DM lines or whispers are full gets a live log that
 * starts at the oldest of those. Both read only lines that viewer gets.
 *
 * Trap lines keep rings of their own outside the log (Tx.addTrapLine).
 */

/** Shared log lines kept in memory. Older ones live in the room_log table. */
export const MAX_LOG = 200;

/** The most lines the log holds with every ring full: what a room's state, an import's included, may hold. */
export const MAX_LOG_LINES = MAX_LOG + LIMITS.dmLogLines + LIMITS.whispersKept * LIMITS.membersPerRoom;

/**
 * Where the DM's lines start counting within an op (Tx.addLog,
 * Tx.addTrapLine): past any count the shared log reaches in one op, and
 * inside the six digits a line id may have, so an occurrence's due still
 * parses. A line only the DM sees then never moves the id of a later line a
 * player gets, and the DM's merged log never meets two lines with one id.
 */
export const DM_LINE_BASE = 900_000;

export type LineAudience = "shared" | "dm" | "whisper";

/**
 * Who a log line is for. A DM line is one no player's projection carries,
 * whatever the room holds when they read it (shared/project.ts): a
 * teleport, a save that ends an effect, a player's new companion or
 * deleted character, and a reminder, effect or concentration line marked
 * `hidden`. A line about a creature without its `seen` mark is shared: the
 * creature's owners when it is read get it, and they can change.
 */
export function lineAudience(entry: Pick<LogEntry, "kind" | "data">): LineAudience {
  if (entry.kind === "whisper") return "whisper";
  const data = entry.data;
  if (!data) return "shared";
  switch (data.type) {
    case "teleport":
    case "saveEnds":
    case "companion":
    case "characterDeleted":
      return "dm";
    case "area":
    case "effect":
    case "concentration":
      return data.hidden ? "dm" : "shared";
    default:
      return "shared";
  }
}

/** Whether a line was numbered with the DM's lines of its op, from DM_LINE_BASE. */
export function dmNumbered(id: string): boolean {
  return Number(id.slice(id.indexOf(":") + 1)) >= DM_LINE_BASE;
}

/** Everyone a whisper reaches: its sender and its recipients, each once. */
export function whisperParties(entry: Pick<LogEntry, "from" | "to">): string[] {
  const out = new Set<string>();
  if (entry.from !== undefined) out.add(entry.from);
  for (const id of entry.to ?? []) out.add(id);
  return [...out];
}

/**
 * The lines the log drops once `added` is in it (the log in id order, with
 * `added` already there): the oldest of `added`'s own audience past its
 * bound, and once the shared lines are full, every line older than the
 * oldest of them. A room from before the rings may hold more of an audience
 * than its bound, and its first new line of that audience brings it down.
 */
export function droppedLines(log: readonly LogEntry[], added: Pick<LogEntry, "kind" | "data">): string[] {
  const audience = lineAudience(added);
  const drop = new Set<string>(audience === "whisper" ? whispersOutside(log) : []);
  if (audience !== "whisper") {
    let over = -(audience === "dm" ? LIMITS.dmLogLines : MAX_LOG);
    for (const e of log) if (lineAudience(e) === audience) over++;
    for (const e of log) {
      if (over <= 0) break;
      if (lineAudience(e) !== audience) continue;
      drop.add(e.id);
      over--;
    }
  }
  let shared = 0;
  for (const e of log) if (!drop.has(e.id) && lineAudience(e) === "shared") shared++;
  if (shared >= MAX_LOG) {
    for (const e of log) {
      if (drop.has(e.id)) continue;
      if (lineAudience(e) === "shared") break;
      drop.add(e.id);
    }
  }
  return [...drop];
}

/** The whispers among no one's newest: for each it reaches, at least `whispersKept` newer ones reach them too. */
function whispersOutside(log: readonly LogEntry[]): string[] {
  const held = new Map<string, number>();
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.kind !== "whisper") continue;
    let kept = false;
    for (const id of whisperParties(e)) {
      const n = held.get(id) ?? 0;
      held.set(id, n + 1);
      if (n < LIMITS.whispersKept) kept = true;
    }
    if (!kept) out.push(e.id);
  }
  return out;
}

const starts = new WeakMap<readonly LogEntry[], Map<string, string | null>>();

/**
 * The oldest line of a viewer's live log, or null for all of it: the
 * oldest of a full ring of their own, their own whispers or, for a DM, the
 * DM lines, whichever is newer. It reads only lines the viewer gets, so
 * what their live log holds depends on nothing they never receive. A line
 * before it reaches them through the archive's pages, as any line older
 * than the live log does.
 */
export function liveStart(log: readonly LogEntry[], viewer: Viewer): string | null {
  const key = `${viewer.role}|${viewer.memberId}`;
  const cached = starts.get(log)?.get(key);
  if (cached !== undefined) return cached;
  let start: string | null = null;
  let dm = 0;
  let whispers = 0;
  // Newest first, so the first ring to fill is the newer start.
  for (let i = log.length - 1; i >= 0 && start === null; i--) {
    const e = log[i]!;
    const audience = lineAudience(e);
    if (audience === "dm" && viewer.role === "dm" && ++dm === LIMITS.dmLogLines) start = e.id;
    else if (audience === "whisper" && whisperParties(e).includes(viewer.memberId) && ++whispers === LIMITS.whispersKept) start = e.id;
  }
  if (!isWritable(log)) {
    let byViewer = starts.get(log);
    if (!byViewer) starts.set(log, (byViewer = new Map()));
    byViewer.set(key, start);
  }
  return start;
}

/** Whether a line is in a viewer's live log by where it starts (liveStart). Each line's own rules still apply. */
export function inLiveLog(log: readonly LogEntry[], viewer: Viewer, id: string): boolean {
  const start = liveStart(log, viewer);
  return start === null || compareLogIds(id, start) >= 0;
}

/**
 * The lines whose place in some viewer's live log a change of the log may
 * have moved, by moving where that log starts: every line of either log
 * between the start before and the start after (fan-out, design 7.3). A
 * line the change wrote or dropped is touched anyway.
 */
export function linesPastStart(before: readonly LogEntry[], after: readonly LogEntry[], viewers: Iterable<Viewer>): string[] {
  if (before === after) return [];
  const out = new Set<string>();
  const done = new Set<string>();
  for (const viewer of viewers) {
    const key = `${viewer.role}|${viewer.memberId}`;
    if (done.has(key)) continue;
    done.add(key);
    const a = liveStart(before, viewer);
    const b = liveStart(after, viewer);
    if (a === b) continue;
    const [lo, hi] = a === null ? [null, b!] : b === null ? [null, a] : compareLogIds(a, b) < 0 ? [a, b] : [b, a];
    for (const log of [before, after]) {
      for (const e of log) {
        if (compareLogIds(e.id, hi) >= 0) break;
        if (lo === null || compareLogIds(e.id, lo) >= 0) out.add(e.id);
      }
    }
  }
  return [...out];
}
