import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import { linesPastStart } from "#shared/logRings.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { allKeys, changedSightKeys, dependents, diffProjection, hashValue, projectEntity, projectState, viewerSceneId, type HeldEntry, type ProjectedState } from "#shared/project.ts";
import type { Change, RefusalCode } from "#shared/protocol.ts";
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
  rejects: Map<ClientKey, Reject[]>;
  restored: Map<ClientKey, Restored[]>;
  /** Each player client's ops in the batch whose trap step refuses their Undo move (docs/design-v1-traps.md 6.5). */
  trapped?: Map<ClientKey, number[]>;
  /** Each client's ops in the batch that wrote a sync record without `at`, with the `at` written. */
  stamped?: Map<ClientKey, Stamped[]>;
};

function viewerClass(conn: Connection, state: RoomState): string {
  const scene = viewerSceneId(state, conn.viewer, { sceneId: conn.sceneId });
  return conn.role === "dm" ? `dm|${conn.memberId}|${scene ?? ""}` : `player|${conn.memberId}`;
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
  return new Set([...touched, ...dependents(batch.before, touched), ...dependents(batch.after, touched), ...passed]);
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
 * The kinds whose projection is the same for every player: the map, the fog
 * (the two layers merged), the party's sight, the scene, and the labels and
 * stamps the fog withholds, none of which reads who the player is or what
 * they own (shared/project.ts). They are projected once per batch for all
 * players, so a change that re-projects the whole map, such as a light
 * level switch, costs one player's projection of it rather than one per
 * player (docs/design-v1-maps-vision.md 4.3.6), and each value is hashed
 * once. Lights and the explored layer are the DM's and project to nothing.
 */
const SAME_FOR_EVERY_PLAYER = new Set(["chunk", "fog", "sight", "scene", "label", "stamp", "light", "explored", "fogDraft"]);

/**
 * Sends each connection its `ev` for the batch. Acks and refusals go to the
 * client's current socket only (`current`), never by socket identity, so a
 * client that reconnected during the commit still gets them.
 */
export function publishBatch(batch: CommittedBatch, connections: Iterable<Connection>, current: (key: ClientKey) => Connection | undefined): void {
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
  const forPlayers = new Map<EntityKey, unknown>();
  for (const conn of all) {
    if (conn.closed || conn.held === null) continue;
    const cls = viewerClass(conn, batch.after);
    let next = projections.get(cls);
    if (!next) {
      next = new Map<EntityKey, unknown>();
      for (const key of candidates) {
        const alike = conn.role === "player" && SAME_FOR_EVERY_PLAYER.has(key.slice(0, key.indexOf(":")));
        if (alike && forPlayers.has(key)) {
          next.set(key, forPlayers.get(key));
          continue;
        }
        const value = projectEntity(key, batch.after, conn.viewer, { sceneId: conn.sceneId });
        if (alike) forPlayers.set(key, value);
        next.set(key, value);
      }
      projections.set(cls, next);
    }
    const diff = diffProjection(conn.held, next, hashOf);
    conn.held = diff.held;
    const key = conn.key;
    const mine = key !== null && current(key) === conn;
    const acks = mine ? batch.acks.get(key) : undefined;
    const rejects = mine ? batch.rejects.get(key) : undefined;
    const restored = mine ? batch.restored.get(key) : undefined;
    const trapped = mine ? batch.trapped?.get(key) : undefined;
    const stamped = mine ? batch.stamped?.get(key) : undefined;
    if (diff.changes.length === 0 && !acks?.length && !rejects?.length) continue;
    const msg: { t: "ev"; seq: number; changes: Change[]; acks?: number[]; rejects?: Reject[]; restored?: Restored[]; trapped?: number[]; stamped?: Stamped[] } = {
      t: "ev",
      seq: batch.seq,
      changes: diff.changes,
    };
    if (acks?.length) msg.acks = acks;
    if (rejects?.length) msg.rejects = rejects;
    if (restored?.length) msg.restored = restored;
    if (trapped?.length) msg.trapped = trapped;
    if (stamped?.length) msg.stamped = stamped;
    conn.send(msg);
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
const KEPT_AS_VALUES = new Set(["chunk", "fog", "explored", "sight"]);

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
  const projected = projectState(state, conn.viewer, { sceneId: conn.sceneId });
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
