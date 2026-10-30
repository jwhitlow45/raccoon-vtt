import { chunkKey, doorChunk, keys, parseKey, partsKey, readEntity, type EntityKey } from "#shared/keys.ts";
import { linesPastStart } from "#shared/logRings.ts";
import type { Label, LogEntry, RoomState, Stamp, Trap, Viewer } from "#shared/model.ts";
import { allKeys, changedSightKeys, dependents, diffProjection, hashValue, namedByMemory, perPlayerScene, playerChunkBatch, projectEntity, projectState, sightHolders, stampCells, viewerSceneId, type HeldEntry, type ProjectedState } from "#shared/project.ts";
import type { Change, RefusalCode } from "#shared/protocol.ts";
import type { OpAcknowledgment } from "#shared/undoContract.ts";
import { visionRules, type PartySight } from "#shared/ruleHooks.ts";
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

/** An op that wrote a sync record without `at`, and the `at` the server wrote (docs/design-v1-resync.md 3.4). */
export type Stamped = { n: number; at: string };

export type CommittedBatch = {
  seq: number;
  before: RoomState;
  after: RoomState;
  touched: EntityKey[];
  global: boolean;
  acks: Map<ClientKey, number[]>;
  ackDetails?: Map<ClientKey, OpAcknowledgment[]>;
  rejects: Map<ClientKey, Reject[]>;
  restored: Map<ClientKey, Restored[]>;
  /** Each player client's ops in the batch whose trap step refuses their Undo move (docs/design-v1-traps.md 6.5). */
  trapped?: Map<ClientKey, number[]>;
  /** Each client's ops in the batch that wrote a sync record without `at`, with the `at` written. */
  stamped?: Map<ClientKey, Stamped[]>;
  /** Each player client's walks the real build stopped short of where their device let them go, each landed at its last clear spot (docs/design-v1-map-discovery.md 6). */
  blocked?: Map<ClientKey, number[]>;
};

function viewerClass(conn: Connection, state: RoomState): string {
  const scene = viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId });
  if (conn.previewBy !== null) return partsKey(["preview", conn.previewBy, conn.memberId]);
  return conn.role === "dm" ? partsKey(["dm", conn.memberId, scene]) : partsKey(["player", conn.memberId]);
}

/**
 * Whether a DM's view as a player leaves a line out
 * (docs/design-v1-per-player-vision.md 7.4, decision 13): a whisper the
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
 * (docs/design-v1-maps-vision.md 4.3.5). Scenes nobody looks at need no
 * diff: a viewer arriving on one gets a snapshot.
 */
export function candidateKeys(batch: CommittedBatch, watched: Iterable<string> = [], viewers: Iterable<Viewer> = []): Set<EntityKey> {
  if (batch.global) return new Set([...allKeys(batch.before), ...allKeys(batch.after)]);
  const touched = [...batch.touched, ...changedSightKeys(batch.before, batch.after, watched)];
  // A viewer's live log starts where a ring of their own fills (shared/logRings.ts), which the roster bounds, so the lines it passed over come and go.
  const passed = linesPastStart(batch.before, batch.after, viewers).map((id) => keys.log(id));
  return new Set([...touched, ...dependents(batch.before, touched, batch.after), ...dependents(batch.after, touched, batch.before), ...passed]);
}

/** The scenes the batch's viewers hold: the player scene, unless a blackout hides it, and each DM's own. */
function watchedScenes(after: RoomState, connections: Iterable<Connection>): Set<string> {
  const out = new Set<string>();
  for (const conn of connections) {
    if (conn.closed || conn.held === null) continue;
    const scene = viewerSceneId(after, conn.viewer, { sceneId: conn.sceneId });
    if (scene !== null) out.add(scene);
  }
  return out;
}

/*
 * Hashes of projected values, kept for the life of each value object.
 * Values are the state's own entities or built by projection, and are
 * never changed after, so an object is hashed once however many
 * connections and batches compare it: a sight tile of 1,368 characters
 * every player receives (docs/design-v1-maps-vision.md 4.3.5), or a chunk
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
 * Projection classes (docs/design-v1-per-player-vision.md 6.9): the kinds
 * whose projection for a player reads no more than one of three things,
 * each projected once per batch for every player who shares that thing
 * rather than once per player. A change that re-projects the whole map,
 * such as a light level switch, then costs one projection per class
 * (docs/design-v1-maps-vision.md 4.3.6), and each value is hashed once.
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
 * same for every player, as it always was.
 */
const SCENE_KINDS = new Set(["scene", "light", "explored", "fogDraft", "sightAll", "fogAll", "exploredAny", "exploredBy", "holders"]);
const FOG_KINDS = new Set(["fog", "label", "stamp", "trap"]);

/**
 * What a player reads on a per-player scene, by which both the fan-out and
 * the drag preview's judgment (ephemeral.ts judgedBy) put players who read
 * the same together (docs/design-v1-per-player-vision.md 6.9 and 7.5). One
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

/** A player's three classes, each a string naming what it reads. */
type PlayerClasses = { scene: string; sight: string; fog: string };

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
 * remembered box (docs/design-v1-map-discovery.md decision 6), which the
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

  constructor(state: RoomState) {
    this.#state = state;
  }

  project(conn: Connection, candidates: readonly EntityKey[]): Map<EntityKey, unknown> {
    const out = new Map<EntityKey, unknown>();
    const own = (key: EntityKey) => () => projectEntity(key, this.#state, conn.viewer, { sceneId: conn.sceneId });
    if (conn.role === "dm") {
      for (const key of candidates) out.set(key, own(key)());
      return out;
    }
    const of = this.#classesOf(conn);
    this.#prepareChunks(conn, of.fog, candidates);
    for (const key of candidates) {
      const kind = key.slice(0, key.indexOf(":"));
      if (SCENE_KINDS.has(kind)) out.set(key, this.#shared(of.scene, key, own(key)));
      else if (kind === "sight") out.set(key, this.#shared(of.sight, key, own(key)));
      // A chunk holds what its fog class holds (docs/design-v1-map-discovery.md 5.6), a holder's own sight and fog among them.
      else if (kind === "fog" || kind === "chunk") out.set(key, this.#shared(of.fog, key, own(key)));
      else if (FOG_KINDS.has(kind)) out.set(key, this.#shared(of.fog, key, () => this.#fogged(conn, of.fog, key)));
      else out.set(key, own(key)());
    }
    if (conn.previewBy !== null) {
      for (const [key, value] of out) if (key.startsWith("log:") && value !== null && previewOmits(value as LogEntry, conn.previewBy)) out.set(key, null);
    }
    return out;
  }

  /** Populate the class once, cutting the union of changed chunks' neighborhoods together. */
  #prepareChunks(conn: Connection, cls: string, candidates: readonly EntityKey[]): void {
    if (this.#byClass.has(cls)) return;
    const values = new Map<EntityKey, unknown>();
    this.#byClass.set(cls, values);
    const sceneId = viewerSceneId(this.#state, conn.viewer, { sceneId: conn.sceneId });
    if (sceneId === null || !this.#state.scenes[sceneId]?.fogEnabled) return;
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
   * The classes of a player's socket, a table display's or a preview's.
   * Sight holders are the scene's players whose entry is on, as projection
   * reads them, and the sight object is the one their projection reads.
   */
  #classesOf(conn: Connection): PlayerClasses {
    const state = this.#state;
    const sceneId = viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId });
    const scene = sceneId === null ? undefined : state.scenes[sceneId];
    // Encoded arrays, since a scene id, which the DM names, may hold any separator (FANOUT-CLASS-KEYS).
    if (sceneId === null || !scene || !perPlayerScene(scene)) return { scene: partsKey(["scene", sceneId]), sight: partsKey(["sight", sceneId, "party"]), fog: partsKey(["fog", sceneId, "party"]) };
    const { sight, fog } = perPlayerClasses(state, sceneId, conn.memberId, this.#sights);
    return { scene: partsKey(["scene", sceneId]), sight: partsKey(["sight", sceneId, sight]), fog: partsKey(["fog", sceneId, fog]) };
  }

  /** A label, stamp or found trap for a fog class, through the memo when it stands on the class's own scene. */
  #fogged(conn: Connection, cls: string, key: EntityKey): unknown {
    const state = this.#state;
    const opts = { sceneId: conn.sceneId };
    const project = () => projectEntity(key, state, conn.viewer, opts);
    const value = readEntity(state, key) as Label | Stamp | Trap | null;
    const sceneId = viewerSceneId(state, conn.viewer, opts);
    const scene = sceneId === null ? undefined : state.scenes[sceneId];
    if (!value || !scene || value.sceneId !== scene.id) return project();
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

/**
 * Sends each connection its `ev` for the batch. Acks and refusals go to the
 * client's current socket only (`current`), never by socket identity, so a
 * client that reconnected during the commit still gets them.
 */
export function publishBatch(batch: CommittedBatch, connections: Iterable<Connection>, current: (key: ClientKey) => Connection | undefined, history?: (conn: Connection, delivered: boolean) => void): void {
  const all = [...connections];
  // In key order, never the order the reducer wrote them, so the order of a viewer's changes says nothing of work they never see.
  const candidates = [
    ...candidateKeys(
      batch,
      watchedScenes(batch.after, all),
      all.filter((conn) => !conn.closed && conn.held !== null).map((conn) => conn.viewer),
    ),
  ].sort();
  const projections = new Map<string, Map<EntityKey, unknown>>();
  const projector = new Projector(batch.after);
  for (const conn of all) {
    if (conn.closed || conn.held === null) continue;
    const cls = viewerClass(conn, batch.after);
    let next = projections.get(cls);
    if (!next) {
      next = projector.project(conn, candidates);
      projections.set(cls, next);
    }
    const diff = diffProjection(conn.held, next, hashOf);
    conn.held = diff.held;
    const key = conn.key;
    const mine = key !== null && current(key) === conn;
    const acks = mine ? batch.acks.get(key) : undefined;
    const ackDetails = mine && conn.ackDetails ? batch.ackDetails?.get(key) : undefined;
    const rejects = mine ? batch.rejects.get(key) : undefined;
    const restored = mine ? batch.restored.get(key) : undefined;
    const trapped = mine ? batch.trapped?.get(key) : undefined;
    const stamped = mine ? batch.stamped?.get(key) : undefined;
    const blocked = mine ? batch.blocked?.get(key) : undefined;
    if (diff.changes.length === 0 && !acks?.length && !rejects?.length) {
      history?.(conn, false);
      continue;
    }
    const msg: { t: "ev"; seq: number; changes: Change[]; acks?: number[]; ackDetails?: OpAcknowledgment[]; rejects?: Reject[]; restored?: Restored[]; trapped?: number[]; stamped?: Stamped[]; blocked?: number[] } = {
      t: "ev",
      seq: batch.seq,
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
    history?.(conn, true);
  }
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
 * longest pause a room load makes (docs/design-v1-maps-vision.md 4.3.6).
 */
export function buildSnapshot(state: RoomState, seq: number, conn: Connection, watermark: number): Snapshot {
  const viewed = projectState(state, conn.viewer, { sceneId: conn.sceneId });
  const by = conn.previewBy;
  const projected = by === null ? viewed : { ...viewed, log: viewed.log.filter((line) => !previewOmits(line, by)) };
  return {
    message: {
      t: "snapshot",
      seq,
      state: projected,
      you: { memberId: conn.memberId, role: conn.display ? "display" : conn.role, sceneId: viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId }) },
      watermark,
    },
    held: heldFor(projected),
  };
}
