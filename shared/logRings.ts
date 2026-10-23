import { compareLogIds } from "./keys.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { isWritable } from "./writable.ts";

/**
 * The room log's rings (design 7.3, Log). The log the room holds in memory
 * is one list in id order, and each line has one audience, fixed when its
 * op is done by who reads it in the room the op leaves (shared/project.ts
 * lineReach, Tx.settleLog):
 *
 * - A shared line may reach every player, each by what they see when they
 *   read it, less the parts they were not among the readers of then
 *   (LineParts). The shared lines keep their newest MAX_LOG.
 * - A DM line reaches no player: no player could read it when it was
 *   written, and none who could later, such as one lent its creature, ever
 *   gets it. The DM lines keep their newest `dmLogLines`.
 * - A party line reaches only some players: those who could read it then.
 *   The line itself is a DM line, and each reader holds a copy of their own
 *   (`to`, the reader alone), the line as they read it then, so one
 *   player's lines never push out another's and no copy holds anything its
 *   reader could not read. A copy whose reader leaves the roster goes.
 * - A whisper reaches only its sender and its recipients, and stays while
 *   it is among the newest of a current member it reaches.
 *
 * Each member's whispers and each player's copies keep their newest,
 * bounded by count and by bytes (memberRing), each a share of the room's
 * by the roster's size. A DM line and a copy are cut to `apartLineBytes`
 * when written (cutLine), and the longest whisper fits it. An import's
 * lines outside the measures are cut the same way. None of these
 * lines is in the room's measures (server/rooms/sizeGuard.ts), so none
 * decides whether an op passes, and their bounds keep them to about 2 MiB.
 *
 * Each audience keeps its own newest lines and drops only its own oldest,
 * so a line one viewer never receives never pushes out a line they hold. A
 * viewer's live log holds only their own newest (liveStart), so lines
 * between others never change which of theirs it holds, and a ring's bytes
 * count only what its own viewer reads. The roster is public, so a bound
 * that moves with it tells no one anything.
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
export const MAX_LOG_LINES = MAX_LOG + LIMITS.dmLogLines + LIMITS.whispersPerRoom + LIMITS.partyLinesPerRoom;

/** A member's ring of whispers or of party lines' copies: their newest `lines`, at most `bytes` of them together. */
export type MemberRing = { lines: number; bytes: number };

/**
 * Each member's ring in a room of `members` members: their newest
 * `whispersKept` whispers, or `partyLinesKept` copies, or fewer once the
 * room is large enough that every member's would pass the room's count or
 * bytes together, so a room keeps at most that much however many join.
 */
export function memberRing(kind: "whisper" | "party", members: number): MemberRing {
  const n = Math.max(1, members);
  if (kind === "whisper") return { lines: Math.min(LIMITS.whispersKept, Math.floor(LIMITS.whispersPerRoom / n)), bytes: Math.floor(LIMITS.whisperBytesPerRoom / n) };
  return { lines: Math.min(LIMITS.partyLinesKept, Math.floor(LIMITS.partyLinesPerRoom / n)), bytes: Math.floor(LIMITS.partyLineBytesPerRoom / n) };
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
 *
 * It lies past any count the shared lines reach in one op. The op that
 * writes the most is a turn that ends every effect the room holds, a line
 * each, and a room's bytes hold about 80,000 effects at the most: 32 a
 * creature, which with its effects at their shortest takes about 3.4 KB.
 */
export const PARTY_LINE_BASE = 100_000;
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
 * says so itself: a party line's copy by its `to`, a DM line, a party
 * line's own included, by its number from DM_LINE_BASE. A line from before
 * then has neither, and keeps the class its kind gives it: a DM line when no
 * player's projection carries it whatever the room holds (neverRead), else
 * shared. The class decides which lines a logged op keeps and drops, so
 * changing it needs a new op version.
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
 * A line outside the measures cut to `apartLineBytes`, as trap lines are cut
 * when written (shared/reducer/traps.ts), so it keeps its place in the live
 * log with no hole. Only a shared line has part readers (LineParts), so
 * those go first, whatever the line's size. Then text no event line uses,
 * what only a take-back needs (an HP line's `revert`), a rolled answer's
 * dice and what it changed, and a dice line's rolls from the end. The
 * longest line an op writes, a dice line of 20 rolls at about 4.5 KB, fits
 * whole, as does the longest whisper, so in play only a take-back's record
 * of many effects is cut, and that change can no longer be taken back.
 *
 * A line an import brings may still not fit: the state schema bounds each
 * field, not the line. Such a line keeps only its place: its id, time and
 * kind, who it is from and for, and the DM line it copies, which the
 * schema bounds well inside it.
 */
export function cutLine(line: LogEntry): LogEntry {
  const fits = (e: LogEntry) => serializedBytes(e) <= LIMITS.apartLineBytes;
  let out = line;
  if (out.parts !== undefined) {
    const { parts: _parts, ...rest } = out;
    out = rest;
  }
  if (fits(out)) return out;
  if (out.kind === "event" && (out.text !== undefined || out.from !== undefined)) {
    const { text: _text, from: _from, ...rest } = out;
    out = rest;
  }
  const data = out.data;
  if (fits(out)) return out;
  if (data?.type === "hp" && data.revert) {
    const { revert: _revert, ...rest } = data;
    out = { ...out, data: rest };
  } else if (data?.type === "roll") {
    const { dice: _dice, changed: _changed, ...rest } = data;
    out = { ...out, data: rest };
  } else if (data?.type === "dice") {
    let rolls = data.rolls;
    while (rolls.length > 0 && !fits({ ...out, data: { ...data, rolls } })) rolls = rolls.slice(0, -1);
    out = { ...out, data: { ...data, rolls } };
  }
  if (fits(out)) return out;
  const { id, at, kind, from, to, copyOf } = out;
  return { id, at, kind, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(copyOf !== undefined ? { copyOf } : {}) };
}

/** Everyone a whisper reaches: its sender and its recipients, each once. */
export function whisperParties(entry: Pick<LogEntry, "from" | "to">): string[] {
  const out = new Set<string>();
  if (entry.from !== undefined) out.add(entry.from);
  for (const id of entry.to ?? []) out.add(id);
  return [...out];
}

const sizes = new WeakMap<LogEntry, number>();

/** A line's serialized bytes, kept for the life of the line object, which is replaced and never changed. */
function lineBytes(e: LogEntry): number {
  let bytes = sizes.get(e);
  if (bytes === undefined) sizes.set(e, (bytes = serializedBytes(e)));
  return bytes;
}

/** The members whose ring holds a line: a whisper's parties, a copy's reader, or none. */
function ringMembers(e: LogEntry): readonly string[] {
  if (e.kind === "whisper") return whisperParties(e);
  return lineAudience(e) === "party" ? e.to!.slice(0, 1) : [];
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
  const drop = new Set<string>(outsideMemberRings(log, members));
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

/** The log with every line its rings drop left out (droppedLines): what an import keeps in memory of the log it brings. */
export function ringed(log: readonly LogEntry[], members: Roster): LogEntry[] {
  const drop = new Set(droppedLines(log, members));
  return log.filter((e) => !drop.has(e.id));
}

/**
 * The whispers and copies outside every member ring: each ring holds its
 * member's newest lines while their count and bytes stay inside its bound
 * (memberRing), and no older one once one does not fit. A whisper stays
 * while any current member it reaches holds it. A member no longer on the
 * roster holds none, so a whisper only they and those gone were party to
 * goes, and so does a copy of theirs.
 */
function outsideMemberRings(log: readonly LogEntry[], members: Roster): string[] {
  const size = Object.keys(members).length;
  const bounds = { whisper: memberRing("whisper", size), party: memberRing("party", size) };
  const rings = new Map<string, { lines: number; bytes: number; full: boolean }>();
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    const held = ringMembers(e);
    if (held.length === 0) continue;
    const kind = e.kind === "whisper" ? "whisper" : "party";
    const bound = bounds[kind];
    const bytes = lineBytes(e);
    let kept = false;
    for (const id of held) {
      if (!Object.hasOwn(members, id)) continue;
      const key = `${kind}|${id}`;
      const ring = rings.get(key) ?? { lines: 0, bytes: 0, full: false };
      rings.set(key, ring);
      if (!ring.full && ring.lines < bound.lines && ring.bytes + bytes <= bound.bytes) {
        ring.lines++;
        ring.bytes += bytes;
        kept = true;
      } else ring.full = true;
    }
    if (!kept) out.push(e.id);
  }
  return out;
}

type LogRoom = Pick<RoomState, "log" | "members">;

const starts = new WeakMap<readonly LogEntry[], WeakMap<Roster, Map<string, string | null>>>();

/**
 * The oldest line of a viewer's live log, or null for all of it: the
 * oldest of the newest full ring they hold. A player holds their own
 * whispers and copies, and a DM their own whispers and the DM lines. It
 * reads only lines the viewer gets and the roster, which every viewer
 * holds, so what their live log holds depends on nothing they never
 * receive. A line before it reaches them through the archive's pages, as
 * any line older than the live log does.
 *
 * A member's bounds grow when one leaves, and lines dropped under the
 * smaller bound do not come back, so a ring may have dropped lines and
 * still be short of its bound. A ring counts as full here at the bound of a
 * roster as large as it may have been since the oldest shared line: this
 * one with every member the log says left added back, and never past the
 * most a roster holds. A ring of whispers or copies counts as full once its
 * bytes pass that bound less the longest line it may hold, since the line
 * it dropped last fit no more than that. A line a ring dropped after the
 * oldest shared line then always lies before where the live log starts.
 */
export function liveStart(room: LogRoom, viewer: Viewer): string | null {
  const { log, members } = room;
  const key = `${viewer.role}|${viewer.memberId}`;
  const cached = starts.get(log)?.get(members)?.get(key);
  if (cached !== undefined) return cached;
  let largest = Object.keys(members).length;
  for (const e of log) if (e.data?.type === "member" && e.data.action === "remove") largest++;
  largest = Math.min(largest, LIMITS.membersPerRoom);
  const dmViewer = viewer.role === "dm";
  const bounds = { whisper: memberRing("whisper", largest), party: memberRing("party", largest) };
  const rings = { whisper: { lines: 0, bytes: 0 }, party: { lines: 0, bytes: 0 } };
  let start: string | null = null;
  let dm = 0;
  // Newest first, so the first ring to fill is the newer start.
  for (let i = log.length - 1; i >= 0 && start === null; i--) {
    const e = log[i]!;
    const audience = lineAudience(e);
    if (audience === "dm") {
      if (dmViewer && ++dm === LIMITS.dmLogLines) start = e.id;
      continue;
    }
    const kind = audience === "whisper" ? "whisper" : audience === "party" ? "party" : null;
    if (kind === null || !ringMembers(e).includes(viewer.memberId)) continue;
    const ring = rings[kind];
    ring.lines++;
    ring.bytes += lineBytes(e);
    if (ring.lines === bounds[kind].lines || ring.bytes > bounds[kind].bytes - LIMITS.apartLineBytes) start = e.id;
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

/**
 * Whether the log in memory still holds every line of op `seq` the viewer
 * reads. Each ring drops its own oldest, so an op's lines leave memory a
 * ring at a time: they are all here while the op is newer than the log's
 * oldest line, which the shared lines' floor keeps, and than where the
 * viewer's live log starts (liveStart). Otherwise the archive has them.
 */
export function holdsOp(room: LogRoom, viewer: Viewer, seq: number): boolean {
  const oldest = room.log[0];
  const start = liveStart(room, viewer);
  return oldest !== undefined && seqOf(oldest.id) < seq && (start === null || seqOf(start) < seq);
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

/**
 * The log's lines one per event, for the reducer's reads of what happened.
 * A party line's copy is its reader's view of the DM line it names
 * (`copyOf`), so a copy is left out while the log holds that line. Where it
 * does not, the copies stand for it: on a player's own projection, which
 * the client replays ops on (design 7.4) and which holds no DM line and no
 * `copyOf`, and once the DM ring has dropped that one line, whatever other
 * lines of its op it still holds. A copy keeps only what its reader read, a
 * dice line's tag only for its roller, so the reads that count lines, such
 * as a cast's damage roll, meet one.
 *
 * In id order, so by op, and within an op each audience in the order it
 * was written. What was written before what across audiences in one op is
 * not kept, so a read goes by op (shared/reducer/areaTriggers.ts).
 */
export function eventLines(log: readonly LogEntry[]): LogEntry[] {
  const dmLines = new Set<string>();
  for (const e of log) if (dmNumbered(e.id)) dmLines.add(e.id);
  return log.filter((e) => e.copyOf === undefined || !dmLines.has(e.copyOf));
}

function seqOf(id: string): number {
  return Number(id.slice(0, id.indexOf(":")));
}
