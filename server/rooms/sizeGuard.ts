import { chunkKey, holderTileKey, parseKey, readEntity, tileKey, type EntityKey } from "#shared/keys.ts";
import { lineAudience } from "#shared/logRings.ts";
import { CHUNK_CELLS, type LogEntry, type Trap } from "#shared/model.ts";
import { trapOwnBytes } from "#shared/reducer/traps.ts";
import { exploredReserve, exploringSceneId, LIMITS, NO_ROOM_TO_EXPLORE, serializedBytes, utf8Bytes, type LimitCheck } from "#shared/limits.ts";
import type { RoomState, Scene } from "#shared/model.ts";
import { tilesAcross } from "#shared/rules/fog.ts";
import { sightEntryMaxBytes } from "#shared/rules/vision.ts";
import { isWritable } from "#shared/writable.ts";

/**
 * The byte limits of design 10.5 (8 MiB of serialized state, 3 MiB per
 * projected scene) without serializing the room on every op.
 *
 * The guard keeps the last exact size plus the most the state can have grown
 * since, and only serializes again when that sum could pass the limit. Each
 * op's growth comes from what it actually wrote (`growthBound`), not from the
 * size of its frame: one small op can write far more than it carries, such
 * as a fog reset over a 200 by 200 scene or an undo that restores a deleted
 * scene. A room far under its limits is therefore measured only at
 * snapshots, while a room near them is measured exactly before every op that
 * could cross.
 *
 * Wave 4 adds two reserves (docs/design-v1-maps-vision.md 2.4), both for
 * what can grow without an op that could be refused. The party's explored
 * layer grows by `sys.explore`, which is never refused, so the room check
 * and the exploring scene's projected check add what that layer may still
 * take (`exploredReserve`), and an explore only spends it. Sight is derived
 * and never stored, so every projected check of a vision scene adds the
 * most its sight tiles can take instead of measuring them.
 *
 * Wave 5 (docs/design-v1-dm-tools.md 2.4) splits a DM's projected scene into
 * the room-level part every DM projection shares (the monsters, the journal,
 * the roll requests, the characters, the log) and each scene's own part.
 * Journal pages and roll requests are room level, so an op on them touches
 * no scene, yet it grows every scene's projection, a scene nobody is viewing
 * included. So every op is checked against the room-level part plus the
 * largest scene part: the check of every scene and every DM at once.
 *
 * - The room-level part is measured exactly on every op, which costs only
 *   the collections the op wrote: sizes are kept per collection and per
 *   entity object, which are replaced and never changed. It counts the
 *   log's shared lines, which every DM receives.
 * - Each scene's own part is measured once, from one pass over the stored
 *   entities grouped by scene, at the room's first check, and kept with its
 *   growth bound. An op that touches a scene adds its growth there as
 *   before, and a scene whose bound could cross is measured exactly, by a
 *   pass over that scene's entities, never a projection.
 *
 * A DM's projection of a scene is exactly the two parts with the JSON around
 * them (and an empty sight map, whose real tiles the sight reserve covers),
 * and the log's lines outside the measure, so the measure is the
 * projection's size less those.
 *
 * Traps (docs/design-v1-traps.md 6.7) are counted so that a springing
 * never moves a measure: a trap's own fields exactly and, in place of what
 * the reducer writes on it and around it, fixed reserves from the complete
 * serialized writes (trapReserve, Appendix B), and the room's occurrences
 * and both trap logs at their bounds once it has a trap. So the measure is
 * the same whether or not, and however often, a trap went off, and the
 * actor measures a springing op without its trap step's writes, which the
 * reserves already hold (server/rooms/actor.ts).
 *
 * Companion stat blocks ride in every DM projection too, but outside this
 * measure (docs/design-v1-companion-stat-blocks.md 3.4): the measure counts
 * their field as empty, and the room's caps hold them to 3 MiB on their own
 * (shared/limits.ts). So a map, a monster or a journal page never grows
 * into the blocks' room, and a DM's snapshot is at most 3 MiB plus theirs.
 *
 * So do the log's lines that only some viewers or none read
 * (shared/logRings.ts): DM lines, party lines' copies and whispers. Each
 * ring bounds them on its own, by count and by bytes, about 2.8 MiB together
 * (shared/limits.ts), and the measure leaves them out. A hidden area's
 * reminder, another player's aura or a whisper between others then never
 * changes whether a player's op passes.
 */

function roomFull(limit: number): LimitCheck {
  return { ok: false, code: "quota", message: `the room is full: it is at its ${Math.floor(limit / 1024 / 1024)} MiB size limit` };
}

function sceneFull(limit: number): LimitCheck {
  return { ok: false, code: "quota", message: `this scene is at its ${Math.floor(limit / 1024 / 1024)} MiB size limit` };
}

/** The last exact size, and how much the state may have grown since. */
type Measure = { bytes: number; growth: number };

export class SizeGuard {
  readonly stateLimit: number;
  readonly sceneLimit: number;
  #state: Measure | null = null;
  /** Each scene's own part (sceneOwnBytes), measured at the first check. */
  #scenes: Map<string, Measure> | null = null;

  constructor(opts: { stateLimit?: number; sceneLimit?: number } = {}) {
    this.stateLimit = opts.stateLimit ?? LIMITS.stateBytes;
    this.sceneLimit = opts.sceneLimit ?? LIMITS.projectedSceneBytes;
  }

  /** An exact measurement from outside, such as the snapshot just written. */
  stateMeasured(bytes: number): void {
    this.#state = { bytes, growth: 0 };
  }

  /**
   * Checks the state an op would produce, given at most how many bytes the
   * op added. On refusal nothing is recorded, because that state is
   * discarded. On success the growth is counted against the bounds of the
   * room and of each scene the op touched.
   *
   * `before` is the state the op applied to. An op that changes which scene
   * can explore (moving players, turning vision or fog on for the player
   * scene, an undo of either) is checked with the new scene's reserve, and
   * when only that reserve does not fit, the refusal says so in the words
   * the DM can act on (NO_ROOM_TO_EXPLORE).
   *
   * A scene already over its limit, as a room from before whispers counted
   * may be, refuses only an op that grows its whole measure, the room-level
   * part and its reserves included, compared exactly with `before`: a
   * shortened name or a deleted token on it passes, as does every edit
   * elsewhere. Without `before`, any op on the scene counts as growing it.
   */
  check(next: RoomState, sceneIds: readonly string[], growth: number, before?: RoomState): LimitCheck {
    const updates: Array<() => void> = [];
    const exploring = exploringSceneId(next);
    const newlyExploring = exploring !== null && before !== undefined && exploringSceneId(before) !== exploring;
    const reserve = exploredReserve(next);
    const state = this.#state;
    if (!state || state.bytes + state.growth + growth + reserve > this.stateLimit) {
      const bytes = measuredStateBytes(next);
      if (bytes + reserve > this.stateLimit) {
        return newlyExploring && bytes <= this.stateLimit ? { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE } : roomFull(this.stateLimit);
      }
      updates.push(() => this.stateMeasured(bytes));
    } else {
      updates.push(() => {
        state.growth += growth;
      });
    }
    const room = roomLevelBytes(next);
    const scenes = this.#sceneMeasures(before ?? next);
    const touched = new Set(sceneIds);
    for (const sceneId of scenes.keys()) if (!next.scenes[sceneId]) updates.push(() => scenes.delete(sceneId));
    for (const scene of Object.values(next.scenes)) {
      const sight = sightReserve(scene);
      const explored = scene.id === exploring ? reserve : 0;
      const measure = scenes.get(scene.id);
      const added = touched.has(scene.id) ? growth : 0;
      if (measure && SHELL_BYTES + room + measure.bytes + measure.growth + added + sight + explored <= this.sceneLimit) {
        if (added > 0) updates.push(() => (measure.growth += added));
        continue;
      }
      const own = sceneOwnBytes(next, scene.id);
      const need = SHELL_BYTES + room + own + sight + explored;
      if (need > this.sceneLimit && (before === undefined ? touched.has(scene.id) || (newlyExploring && scene.id === exploring) : need > neededBefore(before, scene.id))) {
        const exploringHere = newlyExploring && scene.id === exploring && SHELL_BYTES + room + own + sight <= this.sceneLimit;
        return exploringHere ? { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE } : sceneFull(this.sceneLimit);
      }
      updates.push(() => scenes.set(scene.id, { bytes: own, growth: 0 }));
    }
    for (const update of updates) update();
    return { ok: true };
  }

  /**
   * Counts growth that is never checked: an explore, which only spends the
   * explored reserve the checks already held (section 2.4), so the room's
   * and the scene's bounds stay upper bounds without refusing it.
   */
  grew(growth: number, sceneIds: readonly string[]): void {
    if (this.#state) this.#state.growth += growth;
    for (const sceneId of sceneIds) {
      const measure = this.#scenes?.get(sceneId);
      if (measure) measure.growth += growth;
    }
  }

  /** Each scene's own part, from one pass over the state the guard first sees. */
  #sceneMeasures(state: RoomState): Map<string, Measure> {
    if (!this.#scenes) {
      this.#scenes = new Map();
      for (const [sceneId, bytes] of allScenesOwnBytes(state)) this.#scenes.set(sceneId, { bytes, growth: 0 });
    }
    return this.#scenes;
  }
}

/**
 * The scenes an op wrote into, from the entity keys the reducer touched:
 * those a written chunk, fog tile, explored tile or draft is keyed under, a
 * written scene itself, and those any written entity stood on before or
 * stands on after. Read from what the op did rather than from its type, so
 * an op that writes into a scene without naming it (conditions on inline
 * actors, a group edit, a member's removal) is never left out of that
 * scene's bound.
 */
export function touchedScenes(before: RoomState, after: RoomState, touched: readonly EntityKey[]): string[] {
  const out = new Set<string>();
  for (const key of touched) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    switch (parsed.kind) {
      case "chunk":
      case "fog":
      case "explored":
      case "fogDraft":
        out.add(parsed.sceneId);
        continue;
      case "scene":
        out.add(parsed.id);
        continue;
      default:
        for (const value of [readEntity(before, key), readEntity(after, key)]) {
          const sceneId = sceneOf(value);
          if (typeof sceneId === "string") out.add(sceneId);
        }
    }
  }
  return [...out];
}

/**
 * A scene's whole measure in the state an op started from, reserves
 * included, so an op on a scene already over its limit is refused only when
 * it adds to it. A scene the op made has none. Only asked of a scene over
 * its limit, which a room reaches rarely.
 */
function neededBefore(before: RoomState, sceneId: string): number {
  const scene = before.scenes[sceneId];
  if (!scene) return 0;
  const explored = exploringSceneId(before) === sceneId ? exploredReserve(before) : 0;
  return SHELL_BYTES + roomLevelBytes(before) + sceneOwnBytes(before, sceneId) + sightReserve(scene) + explored;
}

/** The most a vision scene's sight tiles can add to its projection, from its own key (section 4.3.4). */
function sightReserve(scene: Scene): number {
  if (scene.vision?.on !== true) return 0;
  return tilesAcross(scene.bounds.w) * tilesAcross(scene.bounds.h) * sightEntryMaxBytes(scene.id);
}

/*
 * A DM's projection (shared/project.ts projectState) as JSON:
 * `{"meta":…,"members":{…},…,"sight":{}}`. Its room-level collections are
 * the state's own, every one of them, the log as the measures count it
 * (measuredLog). Its scene-level collections hold only the viewed scene's
 * entities.
 */
const ROOM_LEVEL = [
  "meta",
  "members",
  "scenes",
  "characters",
  "encounter",
  "encounterHistory",
  "handouts",
  "log",
  "monsters",
  "srdImages",
  "savedEncounters",
  "journal",
  "rolls",
  "handoutDocs",
  "casts",
  "trapLog",
  "trapSeen",
] as const satisfies readonly (keyof RoomState)[];

const SCENE_LEVEL = [
  "buildChunks",
  "labels",
  "fogTiles",
  "fogDrafts",
  "tokens",
  "templates",
  "drawings",
  "stamps",
  "lights",
  "exploredTiles",
  "pins",
  "traps",
] as const satisfies readonly (keyof RoomState)[];

type SceneLevel = (typeof SCENE_LEVEL)[number];

/** Room-level collections every DM projection holds that the measure counts as empty, with caps of their own. */
const OUTSIDE = ["companionBlocks"] as const satisfies readonly (keyof RoomState)[];

/** `"name":` before a collection. */
function fieldBytes(name: string): number {
  return utf8Bytes(JSON.stringify(name)) + 1;
}

/**
 * The braces, the commas between the top-level fields, the empty sight map
 * and the collections counted as empty: what is around the two parts. A
 * field per collection, plus `sight`.
 */
const SHELL_BYTES = 2 + (ROOM_LEVEL.length + SCENE_LEVEL.length + OUTSIDE.length + 1 - 1) + fieldBytes("sight") + 2 + OUTSIDE.reduce((sum, name) => sum + fieldBytes(name) + 2, 0);

/*
 * Sizes kept per entity object and per collection object, which are
 * replaced and never changed once their op finished (shared/writable.ts),
 * so an op re-measures only what it wrote.
 */
const valueSizes = new WeakMap<object, number>();
const collectionSizes = new WeakMap<object, number>();

function valueBytes(value: unknown): number {
  if (value === null || typeof value !== "object") return serializedBytes(value);
  let bytes = valueSizes.get(value);
  if (bytes === undefined) {
    bytes = serializedBytes(value);
    if (!isWritable(value)) valueSizes.set(value, bytes);
  }
  return bytes;
}

/** A collection as JSON, a record or an array, from its entries' sizes. */
function collectionBytes(collection: unknown): number {
  if (collection === null || typeof collection !== "object") return valueBytes(collection);
  let bytes = collectionSizes.get(collection);
  if (bytes !== undefined) return bytes;
  if (Array.isArray(collection)) {
    bytes = 2 + Math.max(0, collection.length - 1);
    for (const item of collection) bytes += valueBytes(item);
  } else {
    const entries = Object.entries(collection);
    bytes = 2 + Math.max(0, entries.length - 1);
    for (const [key, value] of entries) bytes += fieldBytes(key) + valueBytes(value);
  }
  if (!isWritable(collection)) collectionSizes.set(collection, bytes);
  return bytes;
}

/**
 * The room-level part of every DM's projected scene, with its field names:
 * the state's own room-level collections, the log as the measures count it.
 * A singleton the op did not write and a collection it did not copy are the
 * same objects as before, so they cost a lookup.
 */
export function roomLevelBytes(state: RoomState): number {
  let bytes = 0;
  const trapped = hasTraps(state);
  for (const name of ROOM_LEVEL) {
    if ((name === "trapLog" || name === "trapSeen") && trapped) bytes += fieldBytes(name) + (name === "trapLog" ? TRAP_LOG_RESERVE : TRAP_SEEN_RESERVE + DUE_RESERVE);
    else if (name === "log") bytes += fieldBytes(name) + collectionBytes(measuredLog(state.log));
    else bytes += fieldBytes(name) + (name === "meta" || name === "encounter" ? valueBytes(state[name]) : collectionBytes(state[name] ?? (name === "trapLog" || name === "trapSeen" ? [] : {})));
  }
  return bytes;
}

const measuredLogs = new WeakMap<readonly LogEntry[], readonly LogEntry[]>();

/**
 * The log as the measures count it: its shared lines alone. The lines only
 * some viewers or none read, DM lines, party lines' copies and whispers,
 * ride outside the measures under bounds of their own (shared/logRings.ts),
 * so a line a player cannot read never decides whether their op passes.
 * The very list when it holds no other.
 */
export function measuredLog(log: readonly LogEntry[]): readonly LogEntry[] {
  const cached = measuredLogs.get(log);
  if (cached) return cached;
  const kept = log.some((e) => lineAudience(e) !== "shared") ? log.filter((e) => lineAudience(e) === "shared") : log;
  if (!isWritable(log)) measuredLogs.set(log, kept);
  return kept;
}

// ---------------------------------------------------------------------------
// The traps' reserves (docs/design-v1-traps.md 6.7, Appendix B)

/** Per trap, the small fields the reducer writes and `noticedBy` (160), and its actions' and stop's slack (100). */
export const TRAP_RESERVE = 160 + 100;
/** Per scene with a pit trap, the tokens a pit can move: 500 tokens at 8 bytes. */
export const PIT_TOKENS_RESERVE = 4 * 1024;
/** Per room once it has a trap: 10 occurrences, and both trap logs at their bounds. */
export const DUE_RESERVE = 42 * 1024;
export const TRAP_LOG_RESERVE = 45 * 1024;
export const TRAP_SEEN_RESERVE = 30 * 1024;

function hasTraps(state: RoomState): boolean {
  for (const _ in state.traps ?? {}) return true;
  return false;
}

/** A trap as the measures count it: its own fields exactly, and its reserve in place of what the reducer writes on it. */
export function trapMeasure(trap: Trap): number {
  let bytes = trapSizes.get(trap);
  if (bytes === undefined) {
    bytes = trapOwnBytes(trap) + TRAP_RESERVE;
    trapSizes.set(trap, bytes);
  }
  return bytes;
}

const trapSizes = new WeakMap<Trap, number>();

/** The chunks a pit trap's squares touch, each counted once. */
function pitChunks(trap: Trap): Set<string> {
  const out = new Set<string>();
  if (!trap.rig?.pit || !("cells" in trap.zone)) return out;
  for (const r of trap.zone.cells) {
    for (let cy = Math.floor(r.y / CHUNK_CELLS); cy * CHUNK_CELLS < r.y + r.h; cy++) {
      for (let cx = Math.floor(r.x / CHUNK_CELLS); cx * CHUNK_CELLS < r.x + r.w; cx++) out.add(`${cx},${cy}`);
    }
  }
  return out;
}

/**
 * A scene's pit reserve: for every chunk a pit trap's squares touch, a
 * whole new chunk as `buildHeight` fills it, map key and envelope included,
 * `2K + 780` bytes with K the scene id's serialized length, whether or not
 * the chunk exists yet, and 4 KiB for the tokens a pit can move once the
 * scene has a pit trap. A chunk two pits touch counts for each.
 */
export function pitReserve(state: RoomState, sceneId: string): number {
  let chunks = 0;
  let pits = 0;
  for (const trap of Object.values(state.traps ?? {})) {
    if (trap.sceneId !== sceneId || !trap.rig?.pit) continue;
    pits++;
    chunks += pitChunks(trap).size;
  }
  if (pits === 0) return 0;
  const k = utf8Bytes(JSON.stringify(sceneId));
  return chunks * (2 * k + 780) + PIT_TOKENS_RESERVE;
}

/** Every reserve and trap measure the room's own bytes count: the traps, the pits, and the room's occurrences and logs. */
function trapsMeasure(state: RoomState): number {
  const traps = Object.entries(state.traps ?? {});
  let bytes = Math.max(0, traps.length - 1);
  const scenes = new Set<string>();
  for (const [key, trap] of traps) {
    bytes += fieldBytes(key) + trapMeasure(trap);
    scenes.add(trap.sceneId);
  }
  for (const sceneId of scenes) bytes += pitReserve(state, sceneId);
  if (traps.length > 0) return bytes + DUE_RESERVE + TRAP_LOG_RESERVE + TRAP_SEEN_RESERVE;
  // A room whose traps were all deleted keeps their lines, which no springing can add to any more.
  return bytes + collectionBytes(state.trapLog ?? []) - 2 + collectionBytes(state.trapSeen ?? []) - 2;
}

/**
 * The room's own bytes as the guard counts them: everything exactly, the
 * traps by their measures and reserves. The log's lines only some viewers
 * or none read and the record of a turn's reminders (RoomState.reminded)
 * ride outside, under bounds of their own, so no player's op ever passes
 * or fails by what they cannot read.
 */
export function measuredStateBytes(state: RoomState): number {
  return serializedBytes({ ...state, log: measuredLog(state.log), traps: {}, trapLog: [], trapSeen: [], reminded: undefined }) + trapsMeasure(state);
}

/**
 * The measure of a state already serialized to `bytes`, such as a snapshot
 * just written, without serializing it again: its traps and their logs
 * swapped for their measures, and the lines and the record outside them
 * taken out.
 */
export function measuredFromStored(bytes: number, state: RoomState): number {
  const traps = state.traps ?? {};
  const log = state.trapLog ?? [];
  const seen = state.trapSeen ?? [];
  const roomLog = measuredLog(state.log);
  // The record's field, `,"reminded":{…}`, is its object's bytes less the braces, and the comma before it.
  const reminded = state.reminded === undefined ? 0 : serializedBytes({ reminded: state.reminded }) - 1;
  const outside = reminded + (roomLog === state.log ? 0 : collectionBytes(state.log) - collectionBytes(roomLog));
  if (Object.keys(traps).length === 0 && log.length === 0 && seen.length === 0) return bytes - outside;
  return bytes - outside - (collectionBytes(traps) - 2) - (collectionBytes(log) - 2) - (collectionBytes(seen) - 2) + trapsMeasure(state);
}

/** The scene an entity of a scene-level collection belongs to. */
function sceneOfEntry(name: SceneLevel, key: string, value: unknown): string | undefined {
  if (name === "fogDrafts") return key;
  const sceneId = (value as { sceneId?: unknown } | null)?.sceneId;
  return typeof sceneId === "string" ? sceneId : undefined;
}

/** One scene's own part of a DM's projection: its scene-level collections, filtered to it, with their field names, and its pit reserve. */
export function sceneOwnBytes(state: RoomState, sceneId: string): number {
  let bytes = pitReserve(state, sceneId);
  for (const name of SCENE_LEVEL) {
    let count = 0;
    let inside = 0;
    for (const [key, value] of Object.entries(state[name] ?? {})) {
      if (sceneOfEntry(name, key, value) !== sceneId) continue;
      count++;
      inside += fieldBytes(key) + entryBytes(name, value);
    }
    bytes += fieldBytes(name) + 2 + inside + Math.max(0, count - 1);
  }
  return bytes;
}

/** An entity as a scene's part counts it: a trap by its measure, anything else exactly. */
function entryBytes(name: SceneLevel, value: unknown): number {
  return name === "traps" ? trapMeasure(value as Trap) : valueBytes(value);
}

/** Every scene's own part, in one pass over the state's scene-level entities. */
function allScenesOwnBytes(state: RoomState): Map<string, number> {
  const counts = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  for (const id of Object.keys(state.scenes)) {
    counts.set(id, SCENE_LEVEL.map(() => 0));
    sizes.set(id, SCENE_LEVEL.map(() => 0));
  }
  SCENE_LEVEL.forEach((name, i) => {
    for (const [key, value] of Object.entries(state[name] ?? {})) {
      const sceneId = sceneOfEntry(name, key, value);
      const count = sceneId === undefined ? undefined : counts.get(sceneId);
      if (!count) continue;
      count[i]! += 1;
      sizes.get(sceneId!)![i]! += fieldBytes(key) + entryBytes(name, value);
    }
  });
  const out = new Map<string, number>();
  for (const id of Object.keys(state.scenes)) {
    const count = counts.get(id)!;
    const size = sizes.get(id)!;
    let bytes = pitReserve(state, id);
    SCENE_LEVEL.forEach((name, i) => (bytes += fieldBytes(name) + 2 + size[i]! + Math.max(0, count[i]! - 1)));
    out.set(id, bytes);
  }
  return out;
}

/**
 * Every scene of a room that arrives whole, as a room import stores it, by
 * the projected-scene check every op runs (design 10.5,
 * docs/design-v1-maps-vision.md 2.4): the room-level part, the scene's own
 * part, the most its sight tiles can take and, on the player scene, all its
 * explored layer may still take. A room the import accepts then takes the
 * moves and edits its own checks would refuse at once otherwise. The import
 * makes its player scene the one that explores, as moving players there
 * would, so a scene whose explored reserve alone does not fit gets the words
 * the DM can act on (NO_ROOM_TO_EXPLORE). The room's own bytes are the
 * import's to check.
 */
export function checkWholeScenes(state: RoomState, sceneLimit: number = LIMITS.projectedSceneBytes): LimitCheck {
  const exploring = exploringSceneId(state);
  const explored = exploredReserve(state);
  const room = roomLevelBytes(state);
  for (const [sceneId, own] of allScenesOwnBytes(state)) {
    const scene = state.scenes[sceneId]!;
    const need = SHELL_BYTES + room + own + sightReserve(scene);
    if (need + (sceneId === exploring ? explored : 0) <= sceneLimit) continue;
    return sceneId === exploring && need <= sceneLimit ? { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE } : sceneFull(sceneLimit);
  }
  return { ok: true };
}

/**
 * At most how many bytes an op added to the serialized state: for every
 * entity it wrote, the new value's size less the old one's, counting only
 * the entities that grew, plus the key that names a new one. A DM's
 * projection of a scene holds those same values, so this also bounds how
 * much any projected scene grew. An entity that changed scene counts in
 * full, as a new one, because the scene it moved into gained all of it even
 * though the room barely changed. Entities that shrank or went away are not
 * subtracted, so the bound errs high and the next exact measurement settles
 * it.
 */
export function growthBound(before: RoomState, after: RoomState, touched: readonly EntityKey[]): number {
  let growth = 0;
  const trapped = hasTraps(after);
  // A room's first trap brings the room's reserves for occurrences and both trap logs (docs/design-v1-traps.md 6.7).
  if (trapped && !hasTraps(before)) growth += DUE_RESERVE + TRAP_LOG_RESERVE + TRAP_SEEN_RESERVE;
  for (const key of touched) {
    const next = readEntity(after, key);
    if (next === null || next === undefined) continue;
    const parsed = parseKey(key);
    // A trap's line is held by its log's reserve while the room has a trap.
    if ((parsed?.kind === "trapLog" || parsed?.kind === "trapSeen") && trapped) continue;
    // The log's lines only some viewers or none read ride outside the measures.
    if (parsed?.kind === "log" && lineAudience(next as LogEntry) !== "shared") continue;
    const prev = readEntity(before, key);
    const added = prev === null || prev === undefined || sceneOf(prev) !== sceneOf(next);
    const size = (value: unknown) => (parsed?.kind === "trap" ? trapMeasure(value as Trap) + pitGrowth(value as Trap) : serializedBytes(value));
    const delta = size(next) + (added ? entryKeyBytes(key) : -size(prev));
    if (delta > 0) growth += delta;
  }
  return growth;
}

/** The most a trap's pit adds to its scene's reserve: its chunks, and the moved tokens' reserve as if it were the scene's only pit. */
function pitGrowth(trap: Trap): number {
  if (!trap.rig?.pit) return 0;
  const k = utf8Bytes(JSON.stringify(trap.sceneId));
  return pitChunks(trap).size * (2 * k + 780) + PIT_TOKENS_RESERVE;
}

/**
 * What a new entry's key adds to the stored JSON: the key its collection
 * stores it under (an entity's id, or "<scene>:<x>,<y>" for chunks and fog
 * and explored tiles) as JSON writes it, quotes and escapes included, then
 * the colon and the comma after it. A scene ID may be 64 control
 * characters, each escaped to six bytes, so the entity key's own length
 * would undercount it, while the explored layer's reserve counts the
 * escaped key (shared/limits.ts): an explore must take off the guard's
 * bound exactly what it takes off the reserve. A log entry is an array
 * element and adds only its comma, and the singletons are always there.
 */
function entryKeyBytes(key: EntityKey): number {
  const parsed = parseKey(key);
  if (!parsed) return jsonKeyBytes(key);
  switch (parsed.kind) {
    case "meta":
    case "encounter":
    case "encounterHistory":
      return 0;
    case "log":
    case "trapLog":
    case "trapSeen":
      return 1;
    case "chunk":
      return jsonKeyBytes(chunkKey(parsed.sceneId, parsed.cx, parsed.cy));
    case "fog":
    case "explored":
    case "sight":
    case "sightAll":
    case "fogAll":
    case "exploredAny":
      return jsonKeyBytes(tileKey(parsed.sceneId, parsed.tx, parsed.ty));
    case "exploredBy":
      return jsonKeyBytes(holderTileKey(parsed.sceneId, parsed.memberId, parsed.tx, parsed.ty));
    case "fogDraft":
    case "holders":
      return jsonKeyBytes(parsed.sceneId);
    default:
      return jsonKeyBytes(parsed.id);
  }
}

function jsonKeyBytes(key: string): number {
  return utf8Bytes(JSON.stringify(key)) + 2;
}

function sceneOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "sceneId" in value ? value.sceneId : undefined;
}
