import { compareLogIds } from "./keys.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { isWritable } from "./writable.ts";

/**
 * The room log's rings (design 7.3, Log). The log the room holds in memory
 * is one list in id order, and each line has one audience, fixed when it
 * is written by who could read it then (shared/project.ts lineReaders):
 *
 * - A shared line may reach every player, each by what they see when they
 *   read it. The shared lines keep their newest MAX_LOG.
 * - A DM line reaches no player: no player could read it when it was
 *   written, and none who could later, such as one lent its creature, ever
 *   gets it. The DM lines keep their newest `dmLogLines`, each cut to
 *   `dmLogLineBytes` when written (cutDmLine). So the size guard can leave
 *   every one of them out of its measure (server/rooms/sizeGuard.ts), and
 *   such a line never changes whether an op passes.
 * - A party line reaches only some players: those who could read it then,
 *   each of whom holds a copy of their own (`to`, its reader first), so one
 *   player's lines never push out another's. Each player's copies keep
 *   their newest `partyLinesKept`, fewer as the room grows. The first
 *   reader's copy (`to` of one) stands for the line in the DM's log, and
 *   once its reader leaves the roster such copies keep their newest
 *   `partyLinesKept` together.
 * - A whisper reaches only its sender and its recipients. Each member's
 *   whispers keep their newest `whispersKept`, fewer in a room of more than
 *   8 members, and a whisper stays while it is among the newest of a
 *   current member it reaches.
 *
 * Each audience keeps its own newest lines and drops only its own oldest,
 * so a line one viewer never receives never pushes out a line they hold. A
 * viewer's live log holds only their own newest (liveStart), so lines
 * between others never change which of theirs it holds. The roster is
 * public, so a bound that moves with it tells no one anything.
 *
 * One ring may reach back further than another, and the archive's pages
 * start before a live log's oldest line, so a ring reaching back past the
 * rest would leave a gap no page fills. So once the shared lines hold their
 * MAX_LOG, a line older than the oldest of them goes, and a viewer whose own
 * ring is full gets a live log that starts at its oldest line. Both read
 * only lines that viewer gets.
 *
 * Trap lines keep rings of their own outside the log (Tx.addTrapLine).
 *
 * Which ring a line is in, and every bound here, decide which lines a logged
 * op keeps and drops, so changing one changes how ops replay: it needs a new
 * op version (shared/migrate.ts).
 */

/** Shared log lines kept in memory. Older ones live in the room_log table. */
export const MAX_LOG = 200;

/** The most lines the log holds with every ring full: what a room's state, an import's included, may hold. */
export const MAX_LOG_LINES = MAX_LOG + LIMITS.dmLogLines + LIMITS.whispersPerRoom + LIMITS.partyLinesPerRoom + LIMITS.partyLinesKept;

/**
 * The whispers each member keeps in a room of `members` members: their
 * newest `whispersKept`, or fewer once the room is large enough that every
 * member's would pass `whispersPerRoom` together.
 */
export function whispersKept(members: number): number {
  return Math.min(LIMITS.whispersKept, Math.floor(LIMITS.whispersPerRoom / Math.max(1, members)));
}

/** The party lines each member keeps in a room of `members` members, as whispersKept does with `partyLinesPerRoom`. */
export function partyLinesKept(members: number): number {
  return Math.min(LIMITS.partyLinesKept, Math.floor(LIMITS.partyLinesPerRoom / Math.max(1, members)));
}

type Roster = Readonly<Record<string, unknown>>;

/**
 * Where the DM's lines start counting within an op (Tx.addLog,
 * Tx.addTrapLine): past any count the shared log reaches in one op, and
 * inside the six digits a line id may have, so an occurrence's due still
 * parses. A line only the DM sees then never moves the id of a later line a
 * player gets, and the DM's merged log never meets two lines with one id.
 */
export const DM_LINE_BASE = 900_000;

/**
 * Where party lines start counting within an op (Tx.addLog): each reader's
 * copies take a run of PARTY_SLOT of their own, by the reader's place on
 * the roster, so the ids a player gets in one op count on without a gap
 * whatever lines the op wrote for others. The roster's most members fill
 * the runs up to DM_LINE_BASE.
 */
export const PARTY_LINE_BASE = 800_000;
export const PARTY_SLOT = (DM_LINE_BASE - PARTY_LINE_BASE) / LIMITS.membersPerRoom;

/** A reader's line number `count` within an op, by their place `rank` on the roster (rosterRanks). */
export function partyIndex(rank: number, count: number): number {
  return PARTY_LINE_BASE + rank * PARTY_SLOT + count;
}

/** Each member's place on the roster, in id order: which run of an op's party lines is theirs. */
export function rosterRanks(members: Roster): Map<string, number> {
  return new Map(Object.keys(members).sort().map((id, i) => [id, i]));
}

export type LineAudience = "shared" | "dm" | "party" | "whisper";

/**
 * Who a log line is for (see above). A line written from op version 19 on
 * says so itself: a party line by its `to`, a DM line by its number from
 * DM_LINE_BASE. A line from before then has neither, and keeps the class its
 * kind gives it: a DM line when no player's projection carries it whatever
 * the room holds (neverRead), else shared. The class decides which lines a
 * logged op keeps and drops, so changing it needs a new op version.
 */
export function lineAudience(entry: Pick<LogEntry, "id" | "kind" | "data" | "to">): LineAudience {
  if (entry.kind === "whisper") return "whisper";
  if (entry.to !== undefined) return "party";
  if (dmNumbered(entry.id) || (entry.data !== undefined && neverRead(entry.data))) return "dm";
  return "shared";
}

/**
 * Whether no player's projection carries a log event, whatever the room
 * holds when they read it (shared/project.ts eventReach): a teleport, a save
 * that ends an effect, a player's new companion or deleted character, a
 * reminder, effect or concentration line marked `hidden`, a DM's mark of a
 * roll with pass or fail hidden (hiddenMark), and trap lines, which live in
 * logs of their own.
 */
export function neverRead(data: LogEvent): boolean {
  switch (data.type) {
    case "teleport":
    case "saveEnds":
    case "companion":
    case "characterDeleted":
    case "trap":
    case "trapSeen":
    case "trapNotice":
      return true;
    case "area":
    case "effect":
    case "concentration":
      return data.hidden === true;
    case "roll":
      return hiddenMark(data);
    default:
      return false;
  }
}

type RollLine = Extract<LogEvent, { type: "roll" }>;

/**
 * Whether a roll line is a DM's mark with pass or fail hidden: it adds
 * nothing its creature's players may read, and its line alone would tell
 * them the DM judged it (LP5-ROLLS-4). A line written since wave 7 carries
 * its tag and says itself whether a mark wrote it
 * (docs/design-v1-roll-request.md 7.5). An older one is read by its values
 * (isMarkLine).
 */
export function hiddenMark(data: RollLine): boolean {
  return !data.resultShown && (data.tag === undefined ? isMarkLine(data) : data.mark === true);
}

/**
 * Whether a roll line holds a result no player's answer could carry, so
 * that a DM's bare mark wrote it: a result with no total and no save failed
 * without rolling (a mark on a creature still waiting), a pass on a save
 * failed without rolling, a result beside a total on a request with no DC
 * (a player's total there carries none), or a result other than the DC's
 * own verdict on the total (an overrule). A player sends only a total, or
 * a fail without rolling on a save (permissions.ts rollAnswerCheck), and
 * the reducer sets a result only from the DC. The stored line is the same
 * whoever wrote it, so this reads its values alone: a mark that says what
 * the answer already says, such as a mark back to the DC's verdict after an
 * overrule, cannot be told from the answer and still reaches the player as
 * the same words again.
 */
export function isMarkLine(data: RollLine): boolean {
  if (data.result === undefined) return false;
  if (data.total === undefined) return !data.noRoll || data.result === "pass";
  if (data.dc === undefined) return true;
  return data.result !== (data.total >= data.dc ? "pass" : "fail");
}

function lineIndex(id: string): number {
  return Number(id.slice(id.indexOf(":") + 1));
}

/** Whether a line was numbered with the DM's lines of its op, from DM_LINE_BASE. */
export function dmNumbered(id: string): boolean {
  return lineIndex(id) >= DM_LINE_BASE;
}

/** Whether a line was numbered past its op's shared lines: a party line or a DM line. */
export function countedApart(id: string): boolean {
  return lineIndex(id) >= PARTY_LINE_BASE;
}

/**
 * A DM line cut to `dmLogLineBytes`, as trap lines are cut when written
 * (shared/reducer/traps.ts), so it keeps its place in the live log with no
 * hole: text no event line uses first, then what only a take-back needs (an
 * HP line's `revert`), a rolled answer's dice and what it changed, and a
 * dice line's rolls from the end. The longest line an op writes, a dice
 * line of 20 rolls at about 4.5 KB, fits whole, so in play only a
 * take-back's record of many effects is cut, and that change can no longer
 * be taken back. What is left is bounded by the protocol, far inside.
 */
export function cutDmLine(line: LogEntry): LogEntry {
  const fits = (e: LogEntry) => serializedBytes(e) <= LIMITS.dmLogLineBytes;
  if (fits(line)) return line;
  let out = line;
  if (out.kind === "event" && (out.text !== undefined || out.from !== undefined)) {
    const { text: _text, from: _from, ...rest } = out;
    out = rest;
  }
  const data = out.data;
  if (fits(out) || !data) return out;
  if (data.type === "hp" && data.revert) {
    const { revert: _revert, ...rest } = data;
    out = { ...out, data: rest };
  } else if (data.type === "roll") {
    const { dice: _dice, changed: _changed, ...rest } = data;
    out = { ...out, data: rest };
  } else if (data.type === "dice") {
    let rolls = data.rolls;
    while (rolls.length > 0 && !fits({ ...out, data: { ...data, rolls } })) rolls = rolls.slice(0, -1);
    out = { ...out, data: { ...data, rolls } };
  }
  return out;
}

/** Everyone a whisper reaches: its sender and its recipients, each once. */
export function whisperParties(entry: Pick<LogEntry, "from" | "to">): string[] {
  const out = new Set<string>();
  if (entry.from !== undefined) out.add(entry.from);
  for (const id of entry.to ?? []) out.add(id);
  return [...out];
}

/**
 * The lines the log drops (the log in id order, `members` the room's
 * roster): each ring's oldest past its bound, and once the shared lines are
 * full, every line older than the oldest of them. A line written or a
 * member come or gone moves only the bounds it names, so a room whose rings
 * already hold their bounds drops only from the ring that grew. A room from
 * before the rings may hold more of an audience than its bound, and its
 * first new line brings each down.
 */
export function droppedLines(log: readonly LogEntry[], members: Roster): string[] {
  const drop = new Set<string>([...whispersOutside(log, members), ...partyOutside(log, members)]);
  for (const [audience, bound] of [["shared", MAX_LOG], ["dm", LIMITS.dmLogLines]] as const) {
    let over = -bound;
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

/**
 * The whispers among no current member's newest: for each member it reaches,
 * at least `whispersKept` newer ones reach them too. A member no longer on
 * the roster keeps none, so a whisper only they and those gone were party to
 * goes, and the rest stay by the members left.
 */
function whispersOutside(log: readonly LogEntry[], members: Roster): string[] {
  const keep = whispersKept(Object.keys(members).length);
  const held = new Map<string, number>();
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.kind !== "whisper") continue;
    let kept = false;
    for (const id of whisperParties(e)) {
      if (!Object.hasOwn(members, id)) continue;
      const n = held.get(id) ?? 0;
      held.set(id, n + 1);
      if (n < keep) kept = true;
    }
    if (!kept) out.push(e.id);
  }
  return out;
}

/**
 * The party lines outside their ring: a copy past its reader's newest
 * `partyLinesKept`, and once its reader leaves the roster, a copy no one
 * holds any more, except the first reader's copies, the DM's, which keep
 * their newest `partyLinesKept` together.
 */
function partyOutside(log: readonly LogEntry[], members: Roster): string[] {
  const keep = partyLinesKept(Object.keys(members).length);
  const held = new Map<string, number>();
  let gone = 0;
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (lineAudience(e) !== "party") continue;
    const reader = e.to![0];
    if (reader !== undefined && Object.hasOwn(members, reader)) {
      const n = held.get(reader) ?? 0;
      held.set(reader, n + 1);
      if (n >= keep) out.push(e.id);
    } else if (e.to!.length !== 1 || gone++ >= LIMITS.partyLinesKept) out.push(e.id);
  }
  return out;
}

type LogRoom = Pick<RoomState, "log" | "members">;

const starts = new WeakMap<readonly LogEntry[], WeakMap<Roster, Map<string, string | null>>>();

/**
 * The oldest line of a viewer's live log, or null for all of it: the
 * oldest of the newest full ring they hold. A player holds their own
 * whispers and party lines. A DM holds their own whispers, the DM lines and
 * every party line's first copy, so every member's party lines and those of
 * members gone. It reads only lines the viewer gets and the roster, which
 * every viewer holds, so what their live log holds depends on nothing they
 * never receive. A line before it reaches them through the archive's
 * pages, as any line older than the live log does.
 *
 * A member's bounds grow when one leaves, and lines dropped under the
 * smaller bound do not come back, so a ring may have dropped lines and
 * still be short of its bound. A ring counts as full here at the bound of a
 * roster as large as it may have been since the oldest shared line: this
 * one with every member the log says left added back. A line a ring dropped
 * after that line then always lies before where the live log starts.
 */
export function liveStart(room: LogRoom, viewer: Viewer): string | null {
  const { log, members } = room;
  const key = `${viewer.role}|${viewer.memberId}`;
  const cached = starts.get(log)?.get(members)?.get(key);
  if (cached !== undefined) return cached;
  let largest = Object.keys(members).length;
  for (const e of log) if (e.data?.type === "member" && e.data.action === "remove") largest++;
  const whisperBound = whispersKept(largest);
  const partyBound = partyLinesKept(largest);
  const dmViewer = viewer.role === "dm";
  let start: string | null = null;
  let dm = 0;
  let whispers = 0;
  let gone = 0;
  const party = new Map<string, number>();
  // Newest first, so the first ring to fill is the newer start.
  for (let i = log.length - 1; i >= 0 && start === null; i--) {
    const e = log[i]!;
    const audience = lineAudience(e);
    if (audience === "dm") {
      if (dmViewer && ++dm === LIMITS.dmLogLines) start = e.id;
    } else if (audience === "whisper") {
      if (whisperParties(e).includes(viewer.memberId) && ++whispers === whisperBound) start = e.id;
    } else if (audience === "party") {
      const reader = e.to![0];
      if (reader !== undefined && Object.hasOwn(members, reader)) {
        if (!dmViewer && reader !== viewer.memberId) continue;
        const n = (party.get(reader) ?? 0) + 1;
        party.set(reader, n);
        if (n === partyBound) start = e.id;
      } else if (dmViewer && e.to!.length === 1 && ++gone === LIMITS.partyLinesKept) start = e.id;
    }
  }
  if (!isWritable(log) && !isWritable(members)) {
    let byRoster = starts.get(log);
    if (!byRoster) starts.set(log, (byRoster = new WeakMap()));
    let byViewer = byRoster.get(members);
    if (!byViewer) byRoster.set(members, (byViewer = new Map()));
    byViewer.set(key, start);
  }
  return start;
}

/** Whether a line is in a viewer's live log by where it starts (liveStart). Each line's own rules still apply. */
export function inLiveLog(room: LogRoom, viewer: Viewer, id: string): boolean {
  const start = liveStart(room, viewer);
  return start === null || compareLogIds(id, start) >= 0;
}

/**
 * The lines whose place in some viewer's live log a change of the log or
 * the roster may have moved, by moving where that log starts: every line
 * of either log between the start before and the start after (fan-out,
 * design 7.3). A line the change wrote or dropped is touched anyway.
 */
export function linesPastStart(beforeRoom: LogRoom, afterRoom: LogRoom, viewers: Iterable<Viewer>): string[] {
  const before = beforeRoom.log;
  const after = afterRoom.log;
  if (before === after && beforeRoom.members === afterRoom.members) return [];
  const out = new Set<string>();
  const done = new Set<string>();
  for (const viewer of viewers) {
    const key = `${viewer.role}|${viewer.memberId}`;
    if (done.has(key)) continue;
    done.add(key);
    const a = liveStart(beforeRoom, viewer);
    const b = liveStart(afterRoom, viewer);
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
