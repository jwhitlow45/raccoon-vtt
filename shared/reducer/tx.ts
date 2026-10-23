import { collectionOf, compareLogIds, parseKey, readEntity, revOf, keys, type EntityKey } from "../keys.ts";
import { cutLine, DM_LINE_BASE, droppedLines, MAX_LOG, neverRead, PARTY_LINE_BASE, PARTY_SLOT, partyIndex, rosterRanks } from "../logRings.ts";
import { logsByAudience } from "../migrate.ts";
import type {
  Actor,
  Character,
  FogTile,
  LogEntry,
  LogEvent,
  RoomMeta,
  RoomState,
  Scene,
  Token,
  TokenKind,
  Viewer,
} from "../model.ts";
import { hashValue, lineReader, seenByNonOwners } from "../project.ts";
import type { ActorTarget, RefusalCode, RestoreEntry } from "../protocol.ts";
import { autoWallsOf } from "../rules/autoWalls.ts";
import { decodeTile } from "../rules/fog.ts";
import type { ActorEvent } from "../rules/hp.ts";
import { markFinished, markWritable } from "../writable.ts";

/**
 * The envelope the server stamps on every op: the only source of time and
 * derived ids (design 2). Replay adds `opVersion`, the version the op was
 * stored with, so an older op keeps a rule it was applied under where the
 * reducer's own output changed since (shared/migrate.ts). Live ops leave it
 * out and take today's rules.
 */
export type Env = {
  seq: number;
  at: string;
  opVersion?: number;
  /**
   * The op as it would apply with no trap step (docs/design-v1-traps.md
   * 6.7): what the server's limits measure, so a trap going off never
   * changes whether an op passes. Never stored and never replayed.
   */
  withoutTraps?: true;
};

export { DM_LINE_BASE, MAX_LOG } from "../logRings.ts";

export class Refuse extends Error {
  code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function gone(what: string): Refuse {
  return new Refuse("gone", `${what} is not here`);
}

export function invalid(message: string): Refuse {
  return new Refuse("invalid", message);
}

/** The refusal of an op that would write more log lines than a line's number can count (Tx.sharedIndex, Tx.dmIndex). */
export const TOO_MANY_LINES = "That step writes too many log lines at once.";

/** The largest number a log line takes within its op: six digits, as a line id's schema allows. */
const MAX_LINE_INDEX = 999_999;

export type ResolvedActor = {
  holder: "token" | "character";
  id: string;
  actor: Actor;
  /** The creature kind the HP rules care about. Characters are always PCs. */
  kind: TokenKind;
  token?: Token;
  character?: Character;
};

/**
 * One op's working set: a copy-on-write view of the state that records the
 * value every touched entity had before, bumps revs, flags the `global`
 * cases from design 7.2 step 8, and numbers log entries from the envelope.
 *
 * Handlers never mutate entity objects. They build new ones and `write` them,
 * so untouched entities keep their identity for the client's rendering.
 */
export class Tx {
  state: RoomState;
  readonly env: Env;
  readonly actor: Viewer;
  global = false;
  log: LogEntry[] = [];
  private readonly copied = new Set<keyof RoomState>();
  private readonly before = new Map<EntityKey, unknown>();
  private readonly order: EntityKey[] = [];
  /** Keys this op wrote only for bookkeeping (see bumpWalls), which its inverse leaves out. */
  private readonly bookkeeping = new Set<EntityKey>();
  private logIndex = 0;
  private dmLineIndex = 0;
  /**
   * The lines this op wrote whose readers wait for its end (settleLog), in
   * the order written: each line some player may read, numbered with the
   * shared lines for now, an event line with the DM's number it takes should
   * no player or only some read it then, and the players' trap lines, which
   * count with the shared lines.
   */
  private readonly unsettled: ({ line: LogEntry; dmIndex: number } | { trapSeen: LogEntry })[] = [];
  private settled = false;

  constructor(state: RoomState, actor: Viewer, env: Env) {
    this.state = { ...state };
    markWritable(this.state);
    this.actor = actor;
    this.env = env;
  }

  /**
   * The op is done: its state and the collections it copied take no more
   * writes, so the rules' caches may keep answers about them (writable.ts).
   */
  finish(): void {
    this.settleLog();
    markFinished(this.state);
    for (const name of this.copied) markFinished(this.state[name] as object);
  }

  read(key: EntityKey): unknown {
    return readEntity(this.state, key);
  }

  private collection<K extends keyof RoomState>(name: K): RoomState[K] {
    if (!this.copied.has(name)) {
      const current = this.state[name];
      this.state[name] = (Array.isArray(current) ? [...current] : { ...(current as object) }) as RoomState[K];
      markWritable(this.state[name] as object);
      this.copied.add(name);
    }
    return this.state[name];
  }

  write(key: EntityKey, value: unknown): void {
    this.bookkeeping.delete(key);
    this.put(key, value);
  }

  /**
   * Moves a scene's walls version forward, so the rules caches keyed on it
   * (walls, area coverage) drop what they hold. The version only ever goes
   * up: a cache keyed on a version it saw before would serve walls that are
   * gone.
   *
   * This is bookkeeping, not an edit, so it stays out of the op's inverse
   * unless the op also changed the scene for real. Otherwise every build op
   * would put the scene in its undo guard, and a second DM device painting
   * another corner of the map would block this one's undo (design 7.7).
   */
  bumpWalls(sceneId: string): void {
    const scene = this.scene(sceneId);
    this.writeBookkeeping(keys.scene(scene.id), { ...scene, wallsVersion: scene.wallsVersion + 1 });
  }

  /**
   * Writes something the op changes only as bookkeeping, which its inverse
   * leaves out unless the op also wrote the key for real: the walls
   * version, and the party's explored layer, which has no undo at all
   * (docs/design-v1-maps-vision.md 4.3.3).
   */
  writeBookkeeping(key: EntityKey, value: unknown): void {
    if (!this.before.has(key)) this.bookkeeping.add(key);
    this.put(key, value);
  }

  private put(key: EntityKey, value: unknown): void {
    const parsed = parseKey(key);
    if (!parsed) throw new Error(`unknown entity key ${key}`);
    const line = parsed.kind === "log" || parsed.kind === "trapLog" || parsed.kind === "trapSeen";
    const at = line ? lineAt(this.state[parsed.kind] ?? [], parsed.id, value === null) : -1;
    const prev = line ? (at >= 0 ? this.state[parsed.kind]![at]! : null) : readEntity(this.state, key);
    if (!this.before.has(key)) {
      this.before.set(key, prev);
      this.order.push(key);
    }
    let next = value;
    if (next !== null && parsed.kind !== "meta" && parsed.kind !== "encounterHistory" && !isLine(parsed.kind)) {
      next = { ...(next as object), rev: (revOf(prev) ?? 0) + 1 };
    }
    switch (parsed.kind) {
      case "meta":
        if (next === null) throw new Error("the room meta cannot be removed");
        this.state.meta = next as RoomMeta;
        break;
      case "encounter":
        this.state.encounter = (next as RoomState["encounter"]) ?? null;
        break;
      case "encounterHistory":
        this.state.encounterHistory = (next as RoomState["encounterHistory"]) ?? [];
        break;
      case "log":
      case "trapLog":
      case "trapSeen": {
        // A DM line counts past its op's shared lines (addLog), so a later shared line of the op goes before it, in id
        // order, as the client's copy keeps it (keys.ts withLine).
        const log = this.collection(parsed.kind);
        if (next === null) {
          if (at >= 0) log.splice(at, 1);
        } else if (at >= 0) {
          log[at] = next as LogEntry;
        } else {
          log.splice(lineSlot(log, parsed.id), 0, next as LogEntry);
        }
        break;
      }
      default: {
        const name = collectionOf(key);
        if (!name) throw new Error(`unknown entity key ${key}`);
        const map = this.collection(name) as Record<string, unknown>;
        const id = mapIdOf(parsed);
        if (next === null) delete map[id];
        else map[id] = next;
      }
    }
    if (isGlobalChange(parsed.kind, prev, next)) this.global = true;
  }

  remove(key: EntityKey): void {
    this.write(key, null);
  }

  /**
   * Appends a log entry with an id derived from the envelope, so a replay
   * never inserts it twice. The log keeps each audience's lines apart
   * (shared/logRings.ts), each fixed by who reads the line in the room as
   * the op leaves it (settleLog). Until then the op reads its lines in the
   * order it wrote them, a line no player could ever read (neverRead) the
   * DM's at once, and the rest counted with the shared lines. Ops stored
   * before op version 19 kept one ring for every line, numbered in order,
   * and replay so.
   */
  addLog(entry: Omit<LogEntry, "id" | "at">): LogEntry {
    if (!logsByAudience(this.env.opVersion)) {
      const full = this.appendLine(entry, this.sharedIndex());
      const log = this.collection("log");
      for (const old of log.slice(0, Math.max(0, log.length - MAX_LOG))) this.write(keys.log(old.id), null);
      return full;
    }
    const event = entry.kind === "event" && entry.data !== undefined;
    if (event && neverRead(entry.data!)) return this.appendLine(entry, this.dmIndex(), cutLine);
    const line = this.appendLine(entry, this.sharedIndex());
    this.unsettled.push({ line, dmIndex: event ? this.dmIndex() : -1 });
    return line;
  }

  /**
   * Fixes the audience of every line the op wrote by the real projection of
   * the room as the op leaves it (lineReach), so a line counts for exactly
   * the players who read it when it arrives:
   *
   * - A line every player may read counts on from 0 in the op, with the
   *   players' trap lines, and with the readers of each part not all of them
   *   could read (LineParts).
   * - A line no player could read counts on from DM_LINE_BASE, as the DM's
   *   trap lines do, so it never moves the id of a line a player gets, and
   *   is cut to its ring's bound (cutLine). Each event line took its number
   *   there when written, so the DM's lines keep the op's order.
   * - A line only some players could read is such a DM line, and each
   *   reader gets a copy of their own: the line as they read it, naming the
   *   DM line it copies, cut as DM lines are, in that reader's own run from
   *   PARTY_LINE_BASE, so the ids each player gets in one op count on
   *   without a gap whatever the op wrote for others. A reader whose run of
   *   PARTY_SLOT is full in this op gets no more copies, a cap only an op
   *   ending thousands of effects on creatures they alone see comes near,
   *   and each other reader's copies and the DM line stay as they are.
   *
   * Each ring then drops only its own oldest, once, so a line never pushes
   * out one a viewer holds who could not read it.
   */
  private settleLog(): void {
    if (this.settled || !logsByAudience(this.env.opVersion)) return;
    this.settled = true;
    const reachOf = lineReader(this.state);
    const reaches = this.unsettled.map((u) => ("line" in u && u.line.kind === "event" ? reachOf(u.line) : null));
    if (reaches.some((r) => r !== null && (r.audience !== "shared" || r.parts !== undefined))) {
      // Only an op whose trap step wrote a players' line meets their log, which a room from before traps lacks.
      const held = new Set<LogEntry>(this.unsettled.some((u) => "trapSeen" in u) ? this.collection("trapSeen") : []);
      const writes: LogWrite[] = [];
      for (const u of this.unsettled) {
        if ("line" in u) writes.push([u.line.id, null]);
        else if (held.has(u.trapSeen)) this.write(keys.trapSeen(u.trapSeen.id), null);
      }
      const write = (entry: Omit<LogEntry, "id" | "at">, index: number, fit?: (line: LogEntry) => LogEntry): LogEntry => {
        const line = this.lineOf(entry, index, fit);
        writes.push([line.id, line]);
        return line;
      };
      const ranks = rosterRanks(this.state.members);
      const copies = new Map<string, number>();
      const settled = new Map<LogEntry, LogEntry[]>();
      let index = 0;
      this.unsettled.forEach((u, i) => {
        if (!("line" in u)) {
          // A trap line its ring dropped in this same op stays dropped.
          if (held.has(u.trapSeen)) this.write(keys.trapSeen(`${this.env.seq}:${index}`), { ...u.trapSeen, id: `${this.env.seq}:${index}` });
          index++;
          return;
        }
        const { id: _id, at: _at, ...entry } = u.line;
        const reach = reaches[i] ?? { audience: "shared" };
        if (reach.audience === "shared") {
          settled.set(u.line, [write(reach.parts ? { ...entry, parts: reach.parts } : entry, index++)]);
          return;
        }
        const dmLine = write(entry, u.dmIndex, cutLine);
        const lines = [dmLine];
        if (reach.audience === "party") {
          for (const [reader, view] of reach.views) {
            const count = copies.get(reader) ?? 0;
            if (count >= PARTY_SLOT) continue;
            copies.set(reader, count + 1);
            lines.push(write({ kind: entry.kind, to: [reader], data: view, copyOf: dmLine.id }, partyIndex(ranks.get(reader)!, count), cutLine));
          }
        }
        settled.set(u.line, lines);
      });
      this.writeLog(writes);
      this.log = this.log.flatMap((e) => settled.get(e) ?? [e]);
      // A number a line held only until now was never in the room, so the op never touched it.
      const inLog = new Set(this.state.log.map((e) => e.id));
      const unused = new Set<EntityKey>();
      for (const u of this.unsettled) {
        const key = "line" in u ? keys.log(u.line.id) : keys.trapSeen(u.trapSeen.id);
        const gone = "line" in u ? !inLog.has(u.line.id) : readEntity(this.state, key) === null;
        if (this.before.get(key) === null && gone) unused.add(key);
      }
      for (const key of unused) this.before.delete(key);
      if (unused.size > 0) {
        let kept = 0;
        for (const key of this.order) if (!unused.has(key)) this.order[kept++] = key;
        this.order.length = kept;
      }
    }
    this.writeLog(droppedLines(this.collection("log"), this.state.members).map((id) => [id, null]));
  }

  /**
   * Writes lines of the room log as `write` would one at a time, in their
   * order, in one pass over the log, so an op that writes or drops
   * thousands of lines, such as a turn that ends every effect in a large
   * room, takes time in proportion to them rather than to their square.
   */
  private writeLog(writes: readonly LogWrite[]): void {
    if (writes.length === 0) return;
    const log = this.collection("log");
    const last = new Map<string, LogEntry | null>();
    for (const [id, line] of writes) {
      const key = keys.log(id);
      this.bookkeeping.delete(key);
      if (!this.before.has(key)) {
        this.before.set(key, lineIn(log, id));
        this.order.push(key);
      }
      last.set(id, line);
    }
    const added = [...last.values()].filter((line): line is LogEntry => line !== null).sort((a, b) => compareLogIds(a.id, b.id));
    const next: LogEntry[] = [];
    let i = 0;
    for (const e of log) {
      if (last.has(e.id)) continue;
      while (i < added.length && compareLogIds(added[i]!.id, e.id) < 0) next.push(added[i++]!);
      next.push(e);
    }
    while (i < added.length) next.push(added[i++]!);
    markWritable(next);
    this.state.log = next;
  }

  /**
   * The number of the op's next line counted with the shared lines, which
   * stay below PARTY_LINE_BASE, where the copies' runs start. An op that
   * would write more is refused: the most an op writes in play is about
   * one a removed effect, some 80,000 in the largest room (logRings.ts).
   * Ops stored before op version 19 numbered every line this way, and
   * replay as they were.
   */
  private sharedIndex(): number {
    if (this.logIndex >= PARTY_LINE_BASE && logsByAudience(this.env.opVersion)) throw invalid(TOO_MANY_LINES);
    return this.logIndex++;
  }

  /** The number of the op's next DM line, from DM_LINE_BASE, refused past the six digits a line's number may have. */
  private dmIndex(): number {
    if (DM_LINE_BASE + this.dmLineIndex > MAX_LINE_INDEX) throw invalid(TOO_MANY_LINES);
    return DM_LINE_BASE + this.dmLineIndex++;
  }

  /** Writes a log line numbered `index` in this op, as `fit` makes it, and keeps it for the archive. */
  private appendLine(entry: Omit<LogEntry, "id" | "at">, index: number, fit?: (line: LogEntry) => LogEntry): LogEntry {
    const full = this.lineOf(entry, index, fit);
    this.write(keys.log(full.id), full);
    this.log.push(full);
    return full;
  }

  /** A log line numbered `index` in this op, as `fit` makes it. */
  private lineOf(entry: Omit<LogEntry, "id" | "at">, index: number, fit: (line: LogEntry) => LogEntry = (line) => line): LogEntry {
    return fit({ id: `${this.env.seq}:${index}`, at: this.env.at, ...entry });
  }

  addEvent(data: LogEvent): LogEntry {
    return this.addLog({ kind: "event", data });
  }

  /**
   * Appends a line to one of the trap logs (docs/design-v1-traps.md 6.3),
   * numbered from the envelope, so lines of every log sort together and a
   * replay never writes one twice. The players' lines share the shared
   * log's count, since every player gets both. The DM's lines count on
   * their own from DM_LINE_BASE, with the room log's DM lines, so a line
   * only the DM sees never moves the id of a later line a player gets, and
   * the DM's merged log never meets two lines with one id. Each log keeps
   * only its own newest `keep`, so a line one audience cannot see never
   * pushes out one it could. Trap lines never reach the stored log. A
   * players' line may take a new number when the op is done, with the
   * shared lines it counts among (settleLog), so only the DM's are named
   * elsewhere, as an occurrence names its line.
   */
  addTrapLine(ring: "trapLog" | "trapSeen", data: LogEvent, keep: number): LogEntry {
    const index = ring === "trapLog" ? this.dmIndex() : this.sharedIndex();
    const line: LogEntry = { id: `${this.env.seq}:${index}`, at: this.env.at, kind: "event", data };
    const key = ring === "trapLog" ? keys.trapLog : keys.trapSeen;
    this.write(key(line.id), line);
    if (ring === "trapSeen") this.unsettled.push({ trapSeen: line });
    const lines = this.collection(ring);
    for (const old of lines.slice(0, Math.max(0, lines.length - keep))) this.write(key(old.id), null);
    return line;
  }

  /**
   * Stamps rule events with the actor that produced them and logs each one.
   * An event about a token also records whether players who do not own it
   * could see it now, after this op's own changes (design 7.3).
   */
  addActorEvents(resolved: ResolvedActor, events: ActorEvent[]): void {
    const token = resolved.holder === "token" ? this.state.tokens[resolved.id] : undefined;
    const target = token ? { tokenId: resolved.id, ...(seenByNonOwners(this.state, token, this.env) ? { seen: true as const } : {}) } : { characterId: resolved.id };
    for (const event of events) this.addEvent({ ...event, ...target } as LogEvent);
  }

  touched(): EntityKey[] {
    return [...this.order];
  }

  /**
   * The absolute restore that undoes this op: every touched entity's prior
   * value, guarded by what the op left there (design 7.7), so an undo never
   * lands on top of a later change by someone else. A removed entity must
   * still be absent. Any other is guarded by the hash of its value without
   * its bookkeeping fields (guardHash), not by its rev: a restore writes a
   * new rev, so a rev guard would refuse the next undo of the same entity
   * even though nobody else touched it. Log entries are left out, because
   * the log is a record of what happened, undo included.
   */
  inverse(): RestoreEntry[] | null {
    const entries: RestoreEntry[] = [];
    for (const key of this.order) {
      if (key.startsWith("log:") || key.startsWith("trapLog:") || key.startsWith("trapSeen:") || this.bookkeeping.has(key)) continue;
      const after = readEntity(this.state, key);
      const entry: RestoreEntry = { key, value: this.before.get(key) ?? null };
      if (after === null) entry.expectRev = null;
      else entry.expectHash = guardHash(key, after);
      entries.push(entry);
    }
    return entries.length === 0 ? null : entries;
  }

  // Lookups that refuse with `gone` when the entity is missing.

  scene(id: string): Scene {
    const scene = this.state.scenes[id];
    if (!scene) throw gone("scene");
    return scene;
  }

  token(id: string): Token {
    const token = this.state.tokens[id];
    if (!token) throw gone("token");
    return token;
  }

  character(id: string): Character {
    const character = this.state.characters[id];
    if (!character) throw gone("character");
    return character;
  }

  resolveActor(target: ActorTarget): ResolvedActor {
    if ("tokenId" in target) {
      const token = this.token(target.tokenId);
      if ("ref" in token.actor) {
        const character = this.character(token.actor.ref);
        return { holder: "character", id: character.id, actor: character.actor, kind: "pc", token, character };
      }
      return { holder: "token", id: token.id, actor: token.actor.inline, kind: token.kind, token };
    }
    const character = this.character(target.characterId);
    return { holder: "character", id: character.id, actor: character.actor, kind: "pc", character };
  }

  /** Like resolveActor, but undefined for a dangling reference instead of a refusal, for side effects on rows. */
  tryResolveActor(target: ActorTarget): ResolvedActor | undefined {
    try {
      return this.resolveActor(target);
    } catch (err) {
      if (err instanceof Refuse) return undefined;
      throw err;
    }
  }

  /** Writes a changed actor back to whatever holds it. */
  putActor(resolved: ResolvedActor, actor: Actor): void {
    if (resolved.holder === "character") {
      const character = this.character(resolved.id);
      this.write(keys.character(character.id), { ...character, actor });
    } else {
      const token = this.token(resolved.id);
      this.write(keys.token(token.id), { ...token, actor: { inline: actor } });
    }
  }

  /**
   * Every actor in the room, by id, for scans such as re-anchoring durations.
   * Map order would differ after a jsonb round trip, and the log ids a scan
   * produces must come out the same on replay.
   */
  actors(): ResolvedActor[] {
    const out: ResolvedActor[] = [];
    for (const character of Object.values(this.state.characters)) {
      out.push({ holder: "character", id: character.id, actor: character.actor, kind: "pc", character });
    }
    for (const token of Object.values(this.state.tokens)) {
      if ("inline" in token.actor) out.push({ holder: "token", id: token.id, actor: token.actor.inline, kind: token.kind, token });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/**
 * What an undo guard compares: the entity's value without the fields that
 * only count changes. A rev moves on every write, a restore's included, and
 * a scene's walls version moves on every build op anywhere on the scene.
 * Neither means someone changed what the undo would put back. Nor does a
 * scene's thumbnail, which a DM device uploads in the background whenever
 * it likes (docs/design-v1-maps-vision.md 3.3), so a thumbnail that lands
 * between a rename and its undo never makes the undo refuse.
 *
 * The meta and the encounter history have none of these fields, so their
 * hash is the plain value hash older stored restores were guarded with, and
 * those still replay exactly as they applied. A scene from before
 * thumbnails has none, so leaving it out changes no stored scene guard.
 */
export function guardHash(key: EntityKey, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return hashValue(value);
  const scene = parseKey(key)?.kind === "scene";
  if (!("rev" in value) && !(scene && ("wallsVersion" in value || "thumb" in value))) return hashValue(value);
  const { rev: _rev, ...rest } = value as Record<string, unknown>;
  if (scene) {
    delete rest.wallsVersion;
    delete rest.thumb;
  }
  return hashValue(rest);
}

/** The kinds that are lines of a log: kept in order, with no rev, and never put back by an undo. */
function isLine(kind: string): boolean {
  return kind === "log" || kind === "trapLog" || kind === "trapSeen";
}

/** A line written to the room log, or null for one removed (Tx.writeLog). */
type LogWrite = readonly [id: string, line: LogEntry | null];

/**
 * Where the line `id` is, or would go, in a log: the first place whose line
 * does not sort before it. Each log is kept in id order, since an op writes
 * only lines of its own seq, the newest, and a line is never put back.
 */
function lineSlot(log: readonly LogEntry[], id: string): number {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareLogIds(log[mid]!.id, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The line `id` of a log, or null. */
function lineIn(log: readonly LogEntry[], id: string): LogEntry | null {
  const line = log[lineSlot(log, id)];
  return line?.id === id ? line : null;
}

/**
 * Where the line `id` is in a log, or -1. A load and an import put each log
 * in id order (logsInIdOrder), so a line is found by its id. A line to be
 * removed is looked for in the whole log should that fail, so a log out of
 * order still loses the lines a trim drops, and no trim can loop.
 */
function lineAt(log: readonly LogEntry[], id: string, removing: boolean): number {
  const at = lineSlot(log, id);
  if (log[at]?.id === id) return at;
  return removing ? log.findIndex((e) => e.id === id) : -1;
}

/** Whether a tile's new bits lack any bit it had. An unreadable tile counts as clearing, which only re-projects more. */
function clearsBits(before: FogTile, after: FogTile): boolean {
  if (before.bits === after.bits) return false;
  const a = decodeTile(before.bits);
  const b = decodeTile(after.bits);
  if (!a || !b) return true;
  for (let i = 0; i < a.length; i++) if ((a[i]! & ~b[i]!) !== 0) return true;
  return false;
}

function mapIdOf(parsed: NonNullable<ReturnType<typeof parseKey>>): string {
  switch (parsed.kind) {
    case "chunk":
      return `${parsed.sceneId}:${parsed.cx},${parsed.cy}`;
    case "fog":
    case "explored":
    case "sight":
      return `${parsed.sceneId}:${parsed.tx},${parsed.ty}`;
    case "fogDraft":
      return parsed.sceneId;
    case "encounter":
    case "encounterHistory":
    case "meta":
      throw new Error("singleton");
    default:
      return parsed.id;
  }
}

/**
 * The client replays ops on projected state (design 7.4), where a player's
 * view of a token they do not own has no `ownerIds`. The flag only matters
 * on the server, so a missing list compares as empty instead of throwing.
 */
function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

/**
 * Design 7.2 step 8: settings, members, scene membership, `fogEnabled`,
 * automatic walls, fog tiles and ownership changes invalidate every
 * projection in scope, so the fan-out re-projects everything instead of
 * only the touched keys. So does a blackout turned on or off: it takes the
 * whole table out of players' projections and puts it back (design 13.3).
 *
 * Wave 4 (docs/design-v1-maps-vision.md 4.3.3 and 4.3.5): turning vision on
 * or off, or changing its light, changes the rule for every creature on the
 * scene, so it is global like `fogEnabled`. Exploring only adds to the
 * explored layer and is not: the actor finds what it reveals. Clearing
 * explored bits, by a hide or a reset, can withhold anything there again,
 * so it is.
 */
function isGlobalChange(kind: string, prev: unknown, next: unknown): boolean {
  switch (kind) {
    case "member":
    case "fog":
      return true;
    case "explored":
      return prev !== null && (next === null || clearsBits(prev as FogTile, next as FogTile));
    case "meta": {
      const a = prev as RoomMeta | null;
      const b = next as RoomMeta;
      return (
        a === null ||
        a.playerSceneId !== b.playerSceneId ||
        a.view.blackout !== b.view.blackout ||
        JSON.stringify(a.settings) !== JSON.stringify(b.settings)
      );
    }
    case "scene": {
      // A change of automatic walls changes the walls of every chunk, and so
      // which hidden secret doors players see as walls (section 2.1).
      const a = prev as Scene | null;
      const b = next as Scene | null;
      return (
        a === null ||
        b === null ||
        a.fogEnabled !== b.fogEnabled ||
        autoWallsOf(a) !== autoWallsOf(b) ||
        (a.vision?.on ?? false) !== (b.vision?.on ?? false) ||
        a.vision?.light !== b.vision?.light
      );
    }
    case "token": {
      const a = prev as Token | null;
      const b = next as Token | null;
      if (a === null || b === null) return false;
      return a.sceneId !== b.sceneId || !sameIds(a.ownerIds, b.ownerIds);
    }
    case "character": {
      const a = prev as Character | null;
      const b = next as Character | null;
      if (a === null || b === null) return false;
      return !sameIds(a.ownerIds, b.ownerIds);
    }
    default:
      return false;
  }
}
