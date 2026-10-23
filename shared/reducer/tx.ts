import { collectionOf, compareLogIds, parseKey, readEntity, revOf, keys, type EntityKey } from "../keys.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { DM_LINE_BASE, droppedLines, lineAudience, MAX_LOG } from "../logRings.ts";
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
import { hashValue, seenByNonOwners } from "../project.ts";
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
    const prev = readEntity(this.state, key);
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
        const log = this.collection(parsed.kind);
        const index = log.findIndex((e) => e.id === parsed.id);
        if (next === null) {
          if (index >= 0) log.splice(index, 1);
        } else if (index >= 0) {
          log[index] = next as LogEntry;
        } else {
          // A DM line counts past its op's shared lines (addLog), so a later shared line of the op goes before it, in id
          // order, as the client's copy keeps it (keys.ts withLine).
          let at = log.length;
          while (at > 0 && sameSeq(log[at - 1]!.id, parsed.id) && compareLogIds(log[at - 1]!.id, parsed.id) > 0) at--;
          log.splice(at, 0, next as LogEntry);
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
   * (shared/logRings.ts): a DM line counts on from DM_LINE_BASE, as the
   * DM's trap lines do, so it never moves the id of a later line a player
   * gets, and each ring drops only its own oldest, so it never pushes out a
   * line a player holds. A DM line too long for its ring goes only to the
   * archive. Ops stored before op version 19 kept one ring for every line,
   * numbered in order, and replay so.
   */
  addLog(entry: Omit<LogEntry, "id" | "at">): LogEntry {
    const apart = logsByAudience(this.env.opVersion);
    const dm = apart && lineAudience(entry) === "dm";
    const index = dm ? DM_LINE_BASE + this.dmLineIndex++ : this.logIndex++;
    const full: LogEntry = { id: `${this.env.seq}:${index}`, at: this.env.at, ...entry };
    this.log.push(full);
    if (!apart) {
      this.write(keys.log(full.id), full);
      const log = this.collection("log");
      while (log.length > MAX_LOG) this.write(keys.log(log[0]!.id), null);
      return full;
    }
    if (dm && serializedBytes(full) > LIMITS.dmLogLineBytes) return full;
    this.write(keys.log(full.id), full);
    for (const id of droppedLines(this.collection("log"), full)) this.write(keys.log(id), null);
    return full;
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
   * pushes out one it could. Trap lines never reach the stored log.
   */
  addTrapLine(ring: "trapLog" | "trapSeen", data: LogEvent, keep: number): LogEntry {
    const index = ring === "trapLog" ? DM_LINE_BASE + this.dmLineIndex++ : this.logIndex++;
    const line: LogEntry = { id: `${this.env.seq}:${index}`, at: this.env.at, kind: "event", data };
    const key = ring === "trapLog" ? keys.trapLog : keys.trapSeen;
    this.write(key(line.id), line);
    const lines = this.collection(ring);
    while (lines.length > keep) this.write(key(lines[0]!.id), null);
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

function sameSeq(a: string, b: string): boolean {
  return a.slice(0, a.indexOf(":")) === b.slice(0, b.indexOf(":"));
}

/** The kinds that are lines of a log: kept in order, with no rev, and never put back by an undo. */
function isLine(kind: string): boolean {
  return kind === "log" || kind === "trapLog" || kind === "trapSeen";
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
