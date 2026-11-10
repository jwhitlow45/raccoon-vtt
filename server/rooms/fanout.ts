import { chunkKey, doorChunk, keys, parseKey, partsKey, readEntity, type EntityKey } from "#shared/keys.ts";
import { linesPastStart } from "#shared/logRings.ts";
import type { Label, LogEntry, RoomState, SceneId, Stamp, Trap, Viewer } from "#shared/model.ts";
import { allKeys, changedSightKeys, dependents, diffProjection, hashValue, heldGroundMap, namedByMemory, perPlayerScene, playerChunkBatch, projectEntity, projectState, rankedStamp, sightHolders, stampCells, stampOrder, stampRanks, viewerSceneId, type HeldEntry, type ProjectedState } from "#shared/project.ts";
import { MAX_KEPT_REFUSALS, type Change, type RefusalCode } from "#shared/protocol.ts";
import type { OpAcknowledgment } from "#shared/undoContract.ts";
import { visionRules, type PartySight } from "#shared/ruleHooks.ts";
import { heldFloors } from "#shared/rules/floors.ts";
import { labelCells, TILE_CELLS } from "#shared/rules/fog.ts";
import type { CellRange } from "#shared/rules/footprint.ts";
import { zoneRanges } from "#shared/rules/traps.ts";
import type { ClientKey, Connection } from "./connection.ts";

/**
 * Fan-out after a commit (design 7.3): the batch's touched keys, their
 * dependents in the state before and after, or everything in scope when an
 * op set `global`, projected once per viewer class and compared with each
 * connection's held map. Only differences are sent, in one `ev` per
 * connection together with that client's acks and refusals.
 */
export type Reject = { n: number; code: RefusalCode; message: string };
/** An undo or redo that applied, and what it took back (design 7.7). */
export type Restored = { n: number; what: string };

/** An op that wrote a sync record without `at`, and the `at` the server wrote (docs/design/design-v1-resync.md 3.4). */
export type Stamped = { n: number; at: string };

export type CommittedBatch = {
  /** The number each frame of the batch carries, which the actor sets at the batch's close (counted.ts). */
  pub: number;
  before: RoomState;
  after: RoomState;
  touched: EntityKey[];
  global: boolean;
  acks: Map<ClientKey, number[]>;
  ackDetails?: Map<ClientKey, OpAcknowledgment[]>;
  rejects: Map<ClientKey, Reject[]>;
  restored: Map<ClientKey, Restored[]>;
  /** Each player client's ops in the batch whose trap step refuses their Undo move (docs/design/design-v1-traps.md 6.5). */
  trapped?: Map<ClientKey, number[]>;
  /** Each client's ops in the batch that wrote a sync record without `at`, with the `at` written. */
  stamped?: Map<ClientKey, Stamped[]>;
  /** Each player client's walks the real build stopped short of where their device let them go, each landed at its last clear spot (docs/design/design-v1-map-discovery.md 6). */
  blocked?: Map<ClientKey, number[]>;
};

function viewerClass(conn: Connection, state: RoomState): string {
  const scene = viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId });
  if (conn.previewBy !== null) return partsKey(["preview", conn.previewBy, conn.memberId]);
  return conn.role === "dm" ? partsKey(["dm", conn.memberId, scene]) : partsKey(["player", conn.memberId]);
}

/**
 * Whether a DM's view as a player leaves a line out
 * (docs/design/design-v1-per-player-vision.md 7.4, decision 13): a whisper the
 * DM is not party to, so the preview never shows whispers between
 * players. Its snapshot, its events and the log pages asked for it
 * (server/http/log.ts) all read this.
 */
export function previewOmits(line: Pick<LogEntry, "kind" | "from" | "to">, by: string): boolean {
  return line.kind === "whisper" && line.from !== by && !(line.to?.includes(by) ?? false);
}

/**
 * The keys whose projection the batch may have changed. On a vision scene
 * someone is looking at, sight can change without the op touching anything
 * there (a door, a light, a death), so the sight tiles that changed join
 * the touched keys, and with them what stands on those tiles
 * (docs/design/design-v1-maps-vision.md 4.3.5). Scenes nobody looks at need no
 * diff: a viewer arriving on one gets a snapshot.
 */
export function candidateKeys(batch: CommittedBatch, watched: Iterable<string> = [], viewers: Iterable<Viewer> = []): Set<EntityKey> {
  if (batch.global) return new Set([...allKeys(batch.before), ...allKeys(batch.after)]);
  const touched = [...batch.touched, ...changedSightKeys(batch.before, batch.after, watched)];
  // A viewer's live log starts where a ring of their own fills (shared/logRings.ts), which the roster bounds, so the lines it passed over come and go.
  const passed = linesPastStart(batch.before, batch.after, viewers).map((id) => keys.log(id));
  return new Set([...touched, ...dependents(batch.before, touched, batch.after), ...dependents(batch.after, touched, batch.before), ...passed]);
}

/** The floors the batch's viewers hold (heldFloors): a player's, none behind a blackout, and every floor of each DM's scene. */
function watchedScenes(held: Iterable<ReadonlySet<SceneId>>): Set<string> {
  const out = new Set<string>();
  for (const floors of held) for (const id of floors) out.add(id);
  return out;
}

/**
 * The floors a connection's projection covers in a state
 * (docs/design/design-v1-floors.md 8.1), memoized per finished state and
 * viewer by heldFloors itself.
 */
export function heldBy(state: RoomState, conn: Connection): ReadonlySet<SceneId> {
  return heldFloors(state, conn.viewer, { sceneId: conn.sceneId });
}

function sameFloors(a: ReadonlySet<SceneId>, b: ReadonlySet<SceneId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The floor a key of a scene's own collections lies on in `state`, or null
 * for a room-level key and for an entity the state no longer holds, whose
 * projection is per viewer and reads its own rule (docs/design/design-v1-floors.md
 * 8.1). A remembered label or stamp the live build lost is such a key.
 */
export function floorOfKey(state: RoomState, key: EntityKey): SceneId | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "scene":
    case "played":
    case "memoryShared":
    case "opened":
      return parsed.id;
    case "chunk":
    case "fog":
    case "explored":
    case "sight":
    case "sightAll":
    case "fogAll":
    case "exploredAny":
    case "exploredBy":
    case "holders":
    case "fogDraft":
    case "memory":
    case "memoryBy":
      return parsed.sceneId;
    case "token":
    case "template":
    case "drawing":
    case "label":
    case "stamp":
    case "light":
    case "pin":
    case "trap":
    case "floorLink": {
      const sceneId = (readEntity(state, key) as { sceneId?: unknown } | null)?.sceneId;
      return typeof sceneId === "string" ? sceneId : null;
    }
    default:
      return null;
  }
}

/*
 * Hashes of projected values, kept for the life of each value object.
 * Values are the state's own entities or built by projection, and are
 * never changed after, so an object is hashed once however many
 * connections and batches compare it: a sight tile of 1,368 characters
 * every player receives (docs/design/design-v1-maps-vision.md 4.3.5), or a chunk
 * that projection hands every player again as the same object.
 */
const hashes = new WeakMap<object, string>();

function hashOf(projected: unknown): string {
  if (typeof projected !== "object" || projected === null) return hashValue(projected);
  let h = hashes.get(projected);
  if (h === undefined) hashes.set(projected, (h = hashValue(projected)));
  return h;
}

/*
 * Projection classes (docs/design/design-v1-per-player-vision.md 6.9): the kinds
 * whose projection for a player reads no more than one of three things,
 * each projected once per batch for every player who shares that thing
 * rather than once per player. A change that re-projects the whole map,
 * such as a light level switch, then costs one projection per class
 * (docs/design/design-v1-maps-vision.md 4.3.6), and each value is hashed once.
 *
 * - The scene a player is on: the scene itself, the shared sight and fog
 *   (`sightAll`, `fogAll`), and the DM's kinds, which project to nothing
 *   for players.
 * - The sight they read: sight tiles, the same for every player who reads
 *   one raster, which viewers with the same sources share (6.1).
 * - The fog they read: fog tiles, the map's chunks, labels, stamps and found traps, per
 *   member for sight holders, whose own layer is in their fog, and once
 *   for every other player and table display, whose fog is the DM's layer
 *   and the party's.
 *
 * Everything else reads who the player is or what they own, and is
 * projected per member. On a whole-party scene each of the three is the
 * same for every player, as it always was. An end of stairs or a ladder
 * reads the fog as a found trap does, but names its far floor only to a
 * viewer who holds that floor (docs/design/design-v1-floors.md phase 2, 4),
 * so it is one of these.
 */
const SCENE_KINDS = new Set(["scene", "light", "explored", "fogDraft", "sightAll", "fogAll", "exploredAny", "exploredBy", "holders"]);
const FOG_KINDS = new Set(["fog", "label", "stamp", "trap"]);

/**
 * What a player reads on a per-player scene, by which both the fan-out and
 * the drag preview's judgment (ephemeral.ts judgedBy) put players who read
 * the same together (docs/design/design-v1-per-player-vision.md 6.9 and 7.5). One
 * rule for both, so they never drift apart (review PV3-OPUS-6).
 *
 * - The sight: with vision on, the sight object the player's projection
 *   reads, which viewers with the same sources share, named by its number
 *   in `sights`, and "none" with vision off.
 * - The fog: their own for a player who sees for themselves, whose layer is
 *   in it, and "shared" for every other player and table display.
 */
export function perPlayerClasses(state: RoomState, sceneId: string, memberId: string, sights: Map<PartySight, number>): { sight: string; fog: string } {
  const holder = sightHolders(state, sceneId).includes(memberId);
  let sight = "none";
  if (state.scenes[sceneId]?.vision?.on === true) {
    const view = visionRules.holderSight(state, sceneId, holder ? memberId : null);
    let n = sights.get(view);
    if (n === undefined) sights.set(view, (n = sights.size));
    sight = String(n);
  }
  return { sight, fog: holder ? partsKey(["holder", memberId]) : "shared" };
}

/*
 * The fog classes' projections of labels, stamps and found traps, kept
 * across batches by every input they read (6.9): the entity object, the
 * scene's `fogEnabled`, the class's fog tile objects under the entity's
 * cells in row order, and for a door-zone trap its door's chunk object,
 * which holds whether the door is a hidden secret one and where a free
 * door stands. Each is replaced and never changed, so an unchanged input
 * returns the same answer without testing a cell, and a changed one never
 * hits. The scene and blackout checks run before it. A label or stamp some
 * layer's memory names also reads that memory, the class's sight and the
 * remembered box (docs/design/design-v1-map-discovery.md decision 6), which the
 * path does not hold, so it is projected afresh (MD2-O-1, MD2-LK-2).
 */
type Memo = WeakMap<object, Memo | { value: unknown }>;
const memo: Memo = new WeakMap();
const ABSENT = {};
const FOG_ON = {};
const FOG_OFF = {};
/** Ends every path, so a shorter path never reads a longer one's node as its answer. */
const END = {};

function remembered(path: readonly object[], make: () => unknown): unknown {
  let node = memo;
  for (const part of path) {
    let next = node.get(part) as Memo | undefined;
    if (!next) node.set(part, (next = new WeakMap()));
    node = next;
  }
  const hit = node.get(END) as { value: unknown } | undefined;
  if (hit) return hit.value;
  const value = make();
  node.set(END, { value });
  return value;
}

/** One batch's projections, shared within each class. A DM's are projected per DM class (viewerClass). */
class Projector {
  readonly #state: RoomState;
  /** Each class's projected values, by key. */
  readonly #byClass = new Map<string, Map<EntityKey, unknown>>();
  /** A name for each sight object, which viewers with the same sources share. */
  readonly #sights = new Map<PartySight, number>();
  /** Each member's classes on each floor, worked out once a batch however many of the floor's keys ask. */
  readonly #classes = new Map<string, { sight: string; fog: string }>();

  constructor(state: RoomState) {
    this.#state = state;
  }

  /**
   * One connection's projection of the candidates. For a player, a table
   * display or a preview, a key on a floor outside `held` projects to null
   * before any class is asked (docs/design/design-v1-floors.md 8.1), since a
   * class shares one answer among players who may hold different floors.
   * The scene kinds' class is that of the whole held set, since a floor's
   * level is renumbered among the floors held, and the sight and fog
   * classes are each floor's own.
   */
  project(conn: Connection, candidates: readonly EntityKey[], held: ReadonlySet<SceneId>): Map<EntityKey, unknown> {
    const out = new Map<EntityKey, unknown>();
    const own = (key: EntityKey) => () => projectEntity(key, this.#state, conn.viewer, { sceneId: conn.sceneId });
    if (conn.role === "dm") {
      for (const key of candidates) out.set(key, own(key)());
      return out;
    }
    // Encoded arrays, since a scene id, which the DM names, may hold any separator (FANOUT-CLASS-KEYS).
    const scenes = partsKey(["scene", ...[...held].sort()]);
    for (const key of candidates) {
      const floor = floorOfKey(this.#state, key);
      if (floor !== null && !held.has(floor)) {
        out.set(key, null);
        continue;
      }
      const kind = key.slice(0, key.indexOf(":"));
      if (SCENE_KINDS.has(kind)) out.set(key, this.#shared(scenes, key, own(key)));
      // A key of a scene kind whose entity is gone, or any other kind, reads who the player is: per member.
      else if (floor === null) out.set(key, own(key)());
      else if (kind === "sight") out.set(key, this.#shared(this.#classesOf(conn, floor).sight, key, own(key)));
      // A chunk holds what its fog class holds (docs/design/design-v1-map-discovery.md 5.6), a holder's own sight and fog among them.
      else if (kind === "fog" || kind === "chunk") out.set(key, this.#shared(this.#fogClass(conn, floor, candidates), key, own(key)));
      else if (FOG_KINDS.has(kind)) {
        const cls = this.#fogClass(conn, floor, candidates);
        out.set(key, this.#shared(cls, key, () => this.#fogged(conn, cls, key)));
      } else out.set(key, own(key)());
    }
    if (conn.previewBy !== null) {
      for (const [key, value] of out) if (key.startsWith("log:") && value !== null && previewOmits(value as LogEntry, conn.previewBy)) out.set(key, null);
    }
    return out;
  }

  /** The floor's fog class for the connection, populated with the floor's changed chunks the first time it is asked. */
  #fogClass(conn: Connection, sceneId: SceneId, candidates: readonly EntityKey[]): string {
    const cls = this.#classesOf(conn, sceneId).fog;
    this.#prepareChunks(conn, sceneId, cls, candidates);
    return cls;
  }

  /** Populate the class once, cutting the union of its floor's changed chunks' neighborhoods together. */
  #prepareChunks(conn: Connection, sceneId: SceneId, cls: string, candidates: readonly EntityKey[]): void {
    if (this.#byClass.has(cls)) return;
    const values = new Map<EntityKey, unknown>();
    this.#byClass.set(cls, values);
    const scene = this.#state.scenes[sceneId];
    if (!scene || !heldGroundMap(scene)) return;
    const positions = candidates.flatMap((key) => {
      const parsed = parseKey(key);
      return parsed?.kind === "chunk" && parsed.sceneId === sceneId ? [parsed] : [];
    });
    for (const [at, chunk] of playerChunkBatch(this.#state, sceneId, positions, conn.memberId)) values.set(`chunk:${at}`, chunk);
  }

  #shared(cls: string, key: EntityKey, make: () => unknown): unknown {
    let values = this.#byClass.get(cls);
    if (!values) this.#byClass.set(cls, (values = new Map()));
    if (values.has(key)) return values.get(key);
    const value = make();
    values.set(key, value);
    return value;
  }

  /**
   * A floor's sight and fog classes for a player's socket, a table display's
   * or a preview's. Sight holders are the floor's players whose entry is on,
   * as projection reads them, and the sight object is the one their
   * projection reads. Each floor keeps its own holder list, so a holder's
   * classes are per floor (docs/design/design-v1-floors.md 8.1).
   */
  #classesOf(conn: Connection, sceneId: SceneId): { sight: string; fog: string } {
    const key = partsKey([conn.memberId, sceneId]);
    let classes = this.#classes.get(key);
    if (classes) return classes;
    const state = this.#state;
    const scene = state.scenes[sceneId];
    if (!scene || !perPlayerScene(scene)) classes = { sight: partsKey(["sight", sceneId, "party"]), fog: partsKey(["fog", sceneId, "party"]) };
    else {
      const { sight, fog } = perPlayerClasses(state, sceneId, conn.memberId, this.#sights);
      classes = { sight: partsKey(["sight", sceneId, sight]), fog: partsKey(["fog", sceneId, fog]) };
    }
    this.#classes.set(key, classes);
    return classes;
  }

  /** A label, stamp or found trap for its floor's fog class, through the memo. The held-floor gate ran before it. */
  #fogged(conn: Connection, cls: string, key: EntityKey): unknown {
    const state = this.#state;
    const opts = { sceneId: conn.sceneId };
    const project = () => projectEntity(key, state, conn.viewer, opts);
    const value = readEntity(state, key) as Label | Stamp | Trap | null;
    const scene = value ? state.scenes[value.sceneId] : undefined;
    if (!value || !scene) return project();
    const kind = parseKey(key)?.kind;
    if ((kind === "label" || kind === "stamp") && namedByMemory(state, scene.id, kind === "label" ? "labels" : "stamps", value.id)) return project();
    const path: object[] = [value, scene.fogEnabled ? FOG_ON : FOG_OFF];
    let ranges: CellRange[];
    if (kind === "label") ranges = [labelCells(value as Label)];
    else if (kind === "stamp") ranges = [stampCells(value as Stamp)];
    else {
      const trap = value as Trap;
      if ("door" in trap.zone) {
        const { cx, cy } = doorChunk(trap.zone.door);
        path.push(state.buildChunks[chunkKey(scene.id, cx, cy)] ?? ABSENT);
      } else path.push(ABSENT);
      ranges = zoneRanges(state, scene.id, trap.zone);
    }
    for (const r of ranges) {
      for (let ty = Math.floor(r.y0 / TILE_CELLS); ty * TILE_CELLS < r.y1; ty++) {
        for (let tx = Math.floor(r.x0 / TILE_CELLS); tx * TILE_CELLS < r.x1; tx++) {
          const fog = keys.fog(scene.id, tx, ty);
          const tile = this.#shared(cls, fog, () => projectEntity(fog, state, conn.viewer, opts));
          path.push((tile as object | null) ?? ABSENT);
        }
      }
    }
    return remembered(path, project);
  }
}

/*
 * Each player connection's stamp table: the stamps its copy holds, by
 * scene, with each one's order (shared/project.ts stampOrder) and the rank
 * its copy holds it at. Never sent. A projection is shared by a class of
 * viewers, and the stamps a copy holds are not (two sockets of one member
 * opened at different times may differ), so the projection hands each
 * candidate stamp over at rank 0 with its order, and each connection ranks
 * it from its own table. A table is kept with the held map it goes with,
 * made with it by a snapshot and handed on with it by each batch, so a
 * snapshot built and never sent changes no connection's table.
 */
export type StampTable = { scenes: Map<SceneId, Map<string, number>>; where: Map<string, SceneId>; ranks: Map<string, number> };
const stampTables = new WeakMap<ReadonlyMap<EntityKey, HeldEntry>, StampTable>();

/** The ranks a player connection's copy holds its stamps at, by id, or undefined for a DM's or one with no table yet. */
export function stampRanksOf(conn: Connection): ReadonlyMap<string, number> | undefined {
  return conn.held === null ? undefined : stampTables.get(conn.held)?.ranks;
}

export function newStampTable(): StampTable {
  return { scenes: new Map(), where: new Map(), ranks: new Map() };
}

function stampTableOf(stamps: Iterable<Stamp>): StampTable {
  const table = newStampTable();
  for (const stamp of stamps) {
    putStamp(table, stamp.id, stamp.sceneId, stampOrder(stamp));
    table.ranks.set(stamp.id, stamp.z);
  }
  return table;
}

function putStamp(table: StampTable, id: string, sceneId: SceneId, order: number): void {
  let orders = table.scenes.get(sceneId);
  if (!orders) table.scenes.set(sceneId, (orders = new Map()));
  orders.set(id, order);
  table.where.set(id, sceneId);
}

function dropStamp(table: StampTable, id: string, sceneId: SceneId): void {
  const orders = table.scenes.get(sceneId);
  orders?.delete(id);
  if (orders?.size === 0) table.scenes.delete(sceneId);
  table.where.delete(id);
  table.ranks.delete(id);
}

/**
 * One player connection's projection with its stamps ranked. The class's
 * projection gives each candidate stamp at rank 0, or null. Each enters,
 * leaves or keeps its place in the connection's table. A scene where one
 * entered, left or changed order is ranked again, and every stamp of it
 * whose rank moved joins the projection, projected through `more`. Then
 * every stamp in the projection takes its current rank, so a stamp edited
 * out of sight at rank 1 is compared at rank 1 and never at 0. The table is
 * changed in place. The projection is copied when it holds a stamp, since
 * its class shares it.
 */
export function rankStamps(table: StampTable, next: ReadonlyMap<EntityKey, unknown>, more: (keys: EntityKey[]) => Map<EntityKey, unknown>): ReadonlyMap<EntityKey, unknown> {
  let out: Map<EntityKey, unknown> | null = null;
  let grown = false;
  let facts: Iterable<[EntityKey, unknown]> = next;
  while (true) {
    const dirty = new Set<SceneId>();
    for (const [key, value] of facts) {
      if (!key.startsWith("stamp:")) continue;
      out ??= new Map(next);
      const id = key.slice("stamp:".length);
      const was = table.where.get(id);
      const stamp = value as Stamp | null | undefined;
      if (!stamp) {
        if (was !== undefined) {
          dropStamp(table, id, was);
          dirty.add(was);
        }
        continue;
      }
      const order = stampOrder(stamp);
      if (was === stamp.sceneId && table.scenes.get(was)!.get(id) === order) continue;
      if (was !== undefined) {
        dropStamp(table, id, was);
        dirty.add(was);
      }
      putStamp(table, id, stamp.sceneId, order);
      dirty.add(stamp.sceneId);
    }
    if (out === null) return next;
    const moved: EntityKey[] = [];
    for (const sceneId of dirty) {
      for (const [id, rank] of stampRanks(table.scenes.get(sceneId) ?? new Map())) {
        if (table.ranks.get(id) === rank) continue;
        table.ranks.set(id, rank);
        const key = keys.stamp(id);
        if (!out.has(key)) moved.push(key);
      }
    }
    if (moved.length === 0) break;
    // A stamp the batch did not touch projects as before, so this changes nothing in the table but its rank, unless the copy and the table had drifted.
    const projected = more(moved);
    for (const [key, value] of projected) out.set(key, value);
    grown = true;
    facts = projected;
  }
  // In key order, as the candidates are, so where a change sits never tells whether the batch touched it.
  if (grown) out = new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const [key, value] of out) {
    if (!value || !key.startsWith("stamp:")) continue;
    const rank = table.ranks.get(key.slice("stamp:".length));
    if (rank !== undefined) out.set(key, rankedStamp(value as Stamp, rank));
  }
  return out;
}

/*
 * Refusals a client's current socket could not be sent, as it held no
 * snapshot then, kept for the snapshot it waits on (RESYNC-REFUSAL-LOST).
 * That snapshot settles every op up to its watermark with no answer, so
 * without them the device could say only that it does not know what became
 * of a refused op, never why. By socket, so they reach only the socket the
 * batch would have sent them to, and die with it.
 */
const kept = new WeakMap<Connection, Reject[]>();

/** The refusals kept for a socket since its last snapshot, oldest first, which it is sent ahead of its next one. Taking them clears them. */
export function takeKeptRejects(conn: Connection): Reject[] {
  const rejects = kept.get(conn) ?? [];
  kept.delete(conn);
  return rejects;
}

function keepRejects(conn: Connection, rejects: readonly Reject[]): void {
  kept.set(conn, [...(kept.get(conn) ?? []), ...rejects].slice(-MAX_KEPT_REFUSALS));
}

/** The kinds of key a preview's frame names (ephemeral.ts cancelLost): a drag's or a ruler's tokens, and a carried ruler's ends. */
const NAMED_BY_PREVIEWS = new Set(["token", "floorLink"]);

/**
 * Sends each connection its `ev` for the batch. Acks and refusals go to the
 * client's current socket only (`current`), never by socket identity, so a
 * client that reconnected during the commit still gets them. A current
 * socket that holds no snapshot is sent nothing and keeps its refusals for
 * the snapshot it waits on (takeKeptRejects).
 *
 * A connection whose held floors the batch changed (heldBy before and
 * after) is projected whole and diffed against what it holds, as every
 * connection is on a global batch, so the rows, casts, roll requests and
 * log lines of a floor it gains or loses come and go with the floor
 * (docs/design/design-v1-floors.md 8.1). The answer says whether any did, so
 * the actor judges held previews again. It is read on a global batch too,
 * since a height edit is global and judges no preview by itself
 * (Tx.rejudge), and a floor hidden in the same batch must still end what
 * showed on it (review FL3-SOL-02).
 *
 * `lost` is given, for each connection, the token and end keys whose
 * deleted change the batch sent it, after its `ev` (docs/design/design-v1-floors.md
 * phase 3, 4.4, D-261110-180): what left that screen's copy, by a Hide, a
 * light, a door, fog or stairs removed, so the actor ends the previews
 * there that name one (ephemeral.ts cancelLost).
 */
export function publishBatch(
  batch: CommittedBatch,
  connections: Iterable<Connection>,
  current: (key: ClientKey) => Connection | undefined,
  history?: (conn: Connection, delivered: boolean) => void,
  lost?: (conn: Connection, keys: EntityKey[]) => void,
): { heldChanged: boolean } {
  const all = [...connections];
  const live = all.filter((conn) => !conn.closed && conn.held !== null);
  const held = new Map(live.map((conn) => [conn, heldBy(batch.after, conn)] as const));
  const changed = new Set(live.filter((conn) => !sameFloors(heldBy(batch.before, conn), held.get(conn)!)));
  // In key order, never the order the reducer wrote them, so the order of a viewer's changes says nothing of work they never see.
  const candidates = [
    ...candidateKeys(
      batch,
      watchedScenes(held.values()),
      live.map((conn) => conn.viewer),
    ),
  ].sort();
  let everything: EntityKey[] | null = null;
  const projections = new Map<string, Map<EntityKey, unknown>>();
  const wholes = new Map<string, Map<EntityKey, unknown>>();
  const projector = new Projector(batch.after);
  for (const conn of all) {
    if (conn.closed) continue;
    if (conn.held === null) {
      const key = conn.key;
      const rejects = key !== null && current(key) === conn ? batch.rejects.get(key) : undefined;
      if (rejects?.length) keepRejects(conn, rejects);
      continue;
    }
    const cls = viewerClass(conn, batch.after);
    const whole = changed.has(conn);
    const known = whole ? wholes : projections;
    let next = known.get(cls);
    if (!next) {
      if (whole) everything ??= [...new Set([...allKeys(batch.before), ...allKeys(batch.after)])].sort();
      next = projector.project(conn, whole ? everything! : candidates, held.get(conn)!);
      known.set(cls, next);
    }
    let mine: ReadonlyMap<EntityKey, unknown> = next;
    let table: StampTable | null = null;
    if (conn.viewer.role !== "dm") {
      table = stampTables.get(conn.held) ?? newStampTable();
      const floors = held.get(conn)!;
      mine = rankStamps(table, next, (more) => projector.project(conn, more, floors));
    }
    const diff = diffProjection(conn.held, mine, hashOf);
    conn.held = diff.held;
    if (table) stampTables.set(diff.held, table);
    const key = conn.key;
    const answered = key !== null && current(key) === conn;
    const acks = answered ? batch.acks.get(key) : undefined;
    const ackDetails = answered && conn.ackDetails ? batch.ackDetails?.get(key) : undefined;
    const rejects = answered ? batch.rejects.get(key) : undefined;
    const restored = answered ? batch.restored.get(key) : undefined;
    const trapped = answered ? batch.trapped?.get(key) : undefined;
    const stamped = answered ? batch.stamped?.get(key) : undefined;
    const blocked = answered ? batch.blocked?.get(key) : undefined;
    if (diff.changes.length === 0 && !acks?.length && !rejects?.length) {
      history?.(conn, false);
      continue;
    }
    const msg: { t: "ev"; seq: number; changes: Change[]; acks?: number[]; ackDetails?: OpAcknowledgment[]; rejects?: Reject[]; restored?: Restored[]; trapped?: number[]; stamped?: Stamped[]; blocked?: number[] } = {
      t: "ev",
      seq: batch.pub,
      changes: diff.changes,
    };
    if (acks?.length) msg.acks = acks;
    if (ackDetails?.length) msg.ackDetails = ackDetails;
    if (rejects?.length) msg.rejects = rejects;
    if (restored?.length) msg.restored = restored;
    if (trapped?.length) msg.trapped = trapped;
    if (stamped?.length) msg.stamped = stamped;
    if (blocked?.length) msg.blocked = blocked;
    conn.send(msg);
    if (lost) {
      const gone = diff.changes.flatMap((c) => ("deleted" in c && NAMED_BY_PREVIEWS.has(parseKey(c.key)?.kind ?? "") ? [c.key] : []));
      if (gone.length > 0) lost(conn, gone);
    }
    history?.(conn, true);
  }
  return { heldChanged: changed.size > 0 };
}

/*
 * What a snapshot's held map keeps as values rather than hashes
 * (shared/project.ts HeldEntry): the map's build chunks, fog and explored
 * tiles and sight tiles. They are most of a snapshot's bytes and most of
 * the time hashing them took, and each is the state's own object or one
 * projection keeps per object, so holding it costs no memory the room does
 * not hold already. A player's copy of each token and the rest are hashed
 * at once, so a socket's held map stays the size design 10.5 counts.
 */
const KEPT_AS_VALUES = new Set(["chunk", "fog", "explored", "sight", "sightAll", "fogAll", "exploredAny"]);

function heldFor(projected: ProjectedState): Map<EntityKey, HeldEntry> {
  const state = projected as unknown as RoomState;
  const held = new Map<EntityKey, HeldEntry>();
  for (const key of allKeys(state)) {
    const value = readEntity(state, key);
    if (value === null) continue;
    if (key === keys.encounterHistory && (value as unknown[]).length === 0) continue;
    const kept = typeof value === "object" && KEPT_AS_VALUES.has(key.slice(0, key.indexOf(":")));
    held.set(key, kept ? value : hashOf(value));
  }
  return held;
}

export type Snapshot = { message: { t: "snapshot"; seq: number; state: unknown; you: { memberId: string; role: Viewer["role"] | "display"; sceneId: string | null }; watermark: number }; held: Map<EntityKey, HeldEntry> };

/**
 * The full projected snapshot for one connection, and the held map that
 * goes with it, holding the values unhashed (shared/project.ts HeldEntry):
 * a room's first snapshot, which also computes sight from nothing, is the
 * longest pause a room load makes (docs/design/design-v1-maps-vision.md 4.3.6).
 * Its `seq` is `pub`, the number the actor hands out with it (counted.ts).
 */
export function buildSnapshot(state: RoomState, pub: number, conn: Connection, watermark: number): Snapshot {
  const viewed = projectState(state, conn.viewer, { sceneId: conn.sceneId });
  const by = conn.previewBy;
  const projected = by === null ? viewed : { ...viewed, log: viewed.log.filter((line) => !previewOmits(line, by)) };
  const held = heldFor(projected);
  if (conn.viewer.role !== "dm") stampTables.set(held, stampTableOf(Object.values(projected.stamps)));
  return {
    message: {
      t: "snapshot",
      seq: pub,
      state: projected,
      you: { memberId: conn.memberId, role: conn.display ? "display" : conn.role, sceneId: viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId }) },
      watermark,
    },
    held,
  };
}
