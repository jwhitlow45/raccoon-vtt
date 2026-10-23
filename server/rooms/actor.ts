import type { FastifyBaseLogger } from "fastify";
import { keys, parseKey, readEntity, type EntityKey } from "#shared/keys.ts";
import { BLOCK_SAVES_TOO_FAST, BLOCKS_AT_QUOTA, BLOCKS_ROOM_TOO_FULL, checkLimits, LIMITS, ROLLING_TOO_FAST, type LimitCheck } from "#shared/limits.ts";
import { serverDraw, type Draw } from "#shared/dice/roll.ts";
import { withTodaysSrdIds } from "#shared/migrate.ts";
import { sightPiecesCheck } from "#shared/visionLimits.ts";
import type { HandoutPage, LogEntry, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply, type PermissionDeps } from "#shared/permissions.ts";
import { projectArchivedLog, projectEntity, visibleAssetIds } from "#shared/project.ts";
import { clientOpSchema, isPoseOp, isResizeOp, serverOnlyOpSchema, type Op, type RefusalCode, type RestoreEntry, type ServerMessage, type ServerOnlyOp } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { restoreAddedAssets } from "#shared/referencedAssets.ts";
import { hpUndoRestore } from "#shared/reducer/hpUndo.ts";
import { stampedAt } from "#shared/reducer/tokens.ts";
import { splitCheck } from "#shared/rules/walls.ts";
import { pitsMoved, withPitsCounted } from "#shared/rules/pitCount.ts";
import { renewOpenDisplay } from "../auth/displaySessions.ts";
import { checkDisplayGrant, checkGrant } from "../auth/grants.ts";
import type { RoomGateway } from "./gateway.ts";
import { roomStoredBytes } from "../assets/quota.ts";
import { SnapshotBudget, TokenBucket, type Clock } from "./budgets.ts";
import { CloseWrites } from "./closeWrites.ts";
import { CLOSE, clientKey, type ClientKey, type Connection } from "./connection.ts";
import { isDiceOp, resolveDice } from "./dice.ts";
import { cancelPreviews, routeEphemeral } from "./ephemeral.ts";
import { exploreOp } from "./explore.ts";
import { buildSnapshot, publishBatch, type Reject, type Restored, type Stamped } from "./fanout.ts";
import type { SocketFilter } from "./gateway.ts";
import {
  assetIdsOf,
  batchCommitted,
  commitBatch,
  CommitOutcomeUnknown,
  loadAssetFacts,
  loadReceipts,
  loadRoom,
  readWatermark,
  setReadOnly,
  writeSnapshot,
  type AssetFact,
  type BatchWrite,
  type OpRecord,
  type Pool,
  type ReceiptRow,
  type RoomInfo,
} from "./persistence.ts";
import { admissionCost, DAY_MS, ReceiptBook, tagOf, type Receipt, type ReceiptCaps } from "./receipts.ts";
import { growthBound, measuredFromStored, SizeGuard, touchedScenes } from "./sizeGuard.ts";
import { keptFrom, NOT_NEWEST, TRAPPED_ON_THE_WAY, plannedOn, poseRestore, posesAfter, ridesChanged, UndoStacks, type UndoEntry, type Walk } from "./undo.ts";
import { describeHpEvent, describeOp, tallyOf } from "./undoLabels.ts";

/**
 * The single writer of one loaded room (design sections 7.2, 7.3, 7.6, 7.7,
 * 10.4 and 16.2).
 *
 * One queue carries ops, `hello`s and room-level commands. Each command is
 * handled synchronously against the staged state, so nothing can interleave
 * between a snapshot and the events after it. Ops accumulate in a batch
 * that commits in one transaction after 20 ms or at 50 ops. While a commit
 * is in flight the queue waits, so a batch is always built on the committed
 * state before it, and nothing is published or acknowledged until its rows
 * are durable. After the commit, every connection gets one `ev` with the
 * batch's changes for its viewer plus that client's acks and refusals.
 */
export type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

export type ActorOptions = {
  batchMs: number;
  maxBatchOps: number;
  queueCap: number;
  snapshotOps: number;
  snapshotIdleMs: number;
  grantRecheckMs: number;
  roomOpsPerSec: number;
  /** The room storage quota. 0 disables the read-only switch. */
  quotaBytes: number;
  retryBaseMs: number;
  retryMaxMs: number;
  now: Clock;
  /** The size guard's byte limits (design 10.5), lowered only by tests that fill a room. */
  sizeLimits: { stateLimit?: number; sceneLimit?: number };
  /** The dice's draw (docs/design-v1-dice.md 4.2). Only tests script it. */
  draw: Draw;
  /** The receipt caps (docs/design-v1-dice.md 1.2), lowered only by tests that fill a room's day. */
  receiptCaps: Partial<ReceiptCaps>;
};

export const DEFAULT_ACTOR_OPTIONS: ActorOptions = {
  batchMs: 20,
  maxBatchOps: 50,
  queueCap: 500,
  snapshotOps: 200,
  snapshotIdleMs: 30_000,
  grantRecheckMs: 60_000,
  roomOpsPerSec: 60,
  quotaBytes: 0,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
  now: Date.now,
  sizeLimits: {},
  draw: serverDraw,
  receiptCaps: {},
};

export type ActorDeps = {
  pool: Pool;
  info: RoomInfo;
  log: Logger;
  budget: SnapshotBudget;
  gateway: RoomGateway;
  options?: Partial<ActorOptions>;
  /** Called whenever the room may be idle: no sockets, nothing queued, nothing in flight. */
  onIdle?: (actor: RoomActor) => void;
  /** The manager's, so shutdown can wait for a closing socket's last-seen stamp. An actor of its own otherwise. */
  closeWrites?: CloseWrites;
};

/** The actor stamped on roster ops the server applies on its own (design 8.1: roster changes come over HTTP). */
export const SERVER_ACTOR: Viewer = { memberId: "server", role: "dm" };

export class SysOpRefused extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "SysOpRefused";
    this.code = code;
  }
}

/**
 * A room whose replay stopped early holds a state that is missing the ops
 * after the failure, while their rows still sit in the database. Any write
 * would reuse their sequence numbers, so the room refuses every change,
 * roster changes from the server included.
 */
export class RoomReplayFailed extends SysOpRefused {
  constructor(roomId: string) {
    super("forbidden", `room ${roomId} could not be fully loaded and is read-only`);
    this.name = "RoomReplayFailed";
  }
}

export class ActorClosedError extends Error {
  constructor(roomId: string) {
    super(`room ${roomId} is no longer loaded`);
    this.name = "ActorClosedError";
  }
}

type Watermark = { sessionId: string; clientId: string; staged: number; committed: number };

/**
 * An asset lookup that has started and whose op has not been processed yet
 * (docs/design-v1-dm-tools.md 3.19): the room's deletion generation when it
 * started, and the asset ids it reads.
 */
type Lookup = { gen: number; ids: ReadonlySet<string> };

/** What a deletion step on a loaded room runs: see RoomActor.deletionStep. */
export type DeletionRun<T> = (state: RoomState, seq: number) => Promise<{ deleted: readonly string[]; result: T }>;

type Command =
  | { t: "op"; conn: Connection; n: number; raw: unknown; group: string | undefined; facts: Map<string, AssetFact>; lookup: Lookup | null }
  | { t: "hello"; conn: Connection; clientId: string; resumeFrom: number; sceneId: string | undefined; stored: number; fresh: boolean }
  | { t: "snapshot"; conn: Connection; key: ClientKey }
  | { t: "sys"; op: ServerOnlyOp; resolve: () => void; reject: (err: Error) => void }
  | { t: "read"; run: () => void }
  | { t: "step"; run: DeletionRun<unknown>; resolve: (value: unknown) => void; reject: (err: Error) => void };

type Batch = {
  before: RoomState;
  ops: OpRecord[];
  touched: EntityKey[];
  global: boolean;
  acks: Map<ClientKey, number[]>;
  rejects: Map<ClientKey, Reject[]>;
  /** What each client's undos and redos in the batch took back, for its toast. */
  restored: Map<ClientKey, Restored[]>;
  /** Each player client's ops whose trap step refuses their Undo move, for the bar (docs/design-v1-traps.md 6.5). */
  trapped: Map<ClientKey, number[]>;
  /** Each client's ops that wrote a sync record without `at`, with the `at` written (docs/design-v1-resync.md 3.4). */
  stamped: Map<ClientKey, Stamped[]>;
  watermarks: Map<ClientKey, number>;
  hellos: Array<{ conn: Connection; key: ClientKey }>;
  sys: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  /** The receipts of the tagged ops this batch settles (docs/design-v1-dice.md 1.2), durable with it. */
  receipts: Receipt[];
  timer: NodeJS.Timeout | null;
  state: RoomState;
  seq: number;
};

type Reduced = { ok: true; inverse: RestoreEntry[] | null; trapped?: true; trapWrote?: ReadonlySet<string> } | { ok: false; code: RefusalCode; message: string };

/** A tagged op past admission (docs/design-v1-dice.md 1.2): whatever becomes of it from here writes its receipt. */
type Admitted = { memberId: string; player: boolean; tag: string; part: number };

/** Ops a room at its storage quota still accepts (design 10.5): deletions, and the one move a deletion needs first. A room whose replay failed accepts none. */
const DELETIONS = new Set<Op["t"]>([
  "token.delete",
  "scene.delete",
  // The players' scene is deleted only once they are moved (permissions.ts MOVE_PLAYERS_FIRST), so a full room must still move them. It writes one field of the room's meta, and adds nothing.
  "room.setPlayerScene",
  "character.delete",
  "monster.delete",
  "template.delete",
  "drawing.delete",
  "drawing.clear",
  "handout.close",
  "encounter.remove",
  "encounter.end",
  "fog.discard",
  "build.clear",
  "token.deleteMany",
  "journal.delete",
  "pin.remove",
  "roll.close",
  // A document's images are freed through the library's delete, which works at the quota too (docs/design-v1-pdf-handouts.md 3.3).
  "handoutDoc.delete",
  // The space a room at its quota most needs back, which a block's players may free too (docs/design-v1-companion-stat-blocks.md 3.6).
  "companionBlock.delete",
  // A player's Withdraw and the DM's Dismiss of an ask for saves free a waiting ask (docs/design-v1-player-save-spell.md 5.4).
  "cast.close",
]);

/**
 * A companion stat block's ops, which a player's save budget counts and the size refusals word for blocks, and every op
 * that writes a character's own stat block, removing it included (docs/design-v1-pc-stats.md 4.1), so creating and
 * deleting characters cannot churn stored blocks either.
 */
function isBlockOp(op: Op): boolean {
  return op.t === "companionBlock.create" || op.t === "companionBlock.update" || op.t === "companionBlock.delete" || writesPcStats(op);
}

/** A block save, which a guard's refusal answers in the block's own words (docs/design-v1-companion-stat-blocks.md 3.4). */
function isBlockSave(op: Op): boolean {
  return op.t === "companionBlock.create" || op.t === "companionBlock.update" || savesPcStats(op);
}

/** A sync record rides with the block and is written by the same people, so a patch naming it alone counts too (docs/design-v1-resync.md 4). */
function writesPcStats(op: Op): boolean {
  return (op.t === "character.create" && op.character.stats !== undefined) || (op.t === "character.update" && (op.patch.stats !== undefined || op.patch.ddbSync !== undefined));
}

/**
 * Removing a character's block and nothing else, which a room at its quota accepts as it accepts deleting a companion's,
 * so BLOCKS_AT_QUOTA's "Deleting a stat block still works" holds for both (docs/design-v1-companion-stat-blocks.md 3.6).
 */
function removesPcStats(op: Op): boolean {
  return op.t === "character.update" && op.patch.stats === null && Object.keys(op.patch).length === 1;
}

/** A character's block written rather than removed: the size guard's refusal of it reads in the block's words. */
function savesPcStats(op: Op): boolean {
  return (op.t === "character.create" && op.character.stats !== undefined) || (op.t === "character.update" && ((op.patch.stats !== undefined && op.patch.stats !== null) || op.patch.ddbSync !== undefined));
}

const NO_FACTS: Map<string, AssetFact> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

export class RoomActor {
  readonly roomId: string;
  /** Never unloaded to make space. The admin page's pin changes it at once (RoomManager.setPinned). */
  pinned: boolean;
  readonly createdIp: string | null;
  readonly loadedAt: number;
  /** True when replay stopped early: the room serves reads only and writes no snapshots. */
  readonly replayFailed: boolean;
  lastOpAt: number;
  readOnly: boolean;
  retrying = false;
  #pool: Pool;
  #log: Logger;
  #budget: SnapshotBudget;
  #gateway: RoomGateway;
  #opts: ActorOptions;
  #onIdle: ((actor: RoomActor) => void) | undefined;
  #closeWrites: CloseWrites;
  #committed: { state: RoomState; seq: number };
  #staged: { state: RoomState; seq: number };
  #snapshotSeq: number;
  #opsSinceSnapshot = 0;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #snapshotting: Promise<void> | null = null;
  #batch: Batch | null = null;
  #inFlight: Batch | null = null;
  #inFlightDone: Promise<void> | null = null;
  #queue: Command[] = [];
  #draining = false;
  #closed = false;
  #closing: Promise<void> | null = null;
  #watermarks = new Map<ClientKey, Watermark>();
  #connections = new Set<Connection>();
  #clients = new Map<ClientKey, Connection>();
  #delayed = new Map<ClientKey, { conn: Connection; cancel: () => void }>();
  /**
   * Table displays that have had a snapshot, the only ones DM sockets count.
   * A display is counted once it can receive events, not when its socket
   * opens: a DM device answers a rise in the count with its camera at once
   * (docs/design-v1-dm-tools.md 3.1), and a `view` that reached a display
   * still waiting for its snapshot was dropped, so a display that connected
   * or reconnected while following the DM showed Fit the map instead.
   */
  #shownDisplays = new WeakSet<Connection>();
  #undo = new UndoStacks();
  #sizes: SizeGuard;
  #roomRate: TokenBucket;
  /** Each member's budget of block saves (docs/design-v1-companion-stat-blocks.md 3.5), made at their first save. */
  #blockSaves = new Map<string, TokenBucket>();
  /** Each member's budget of tagged ops (docs/design-v1-dice.md 4.4), by role, made at their first. */
  #rollBudgets = new Map<string, TokenBucket>();
  /** Every receipt younger than 24 hours, and the staged ones (docs/design-v1-dice.md 1.2). */
  #receipts: ReceiptBook;
  #recheckTimer: NodeJS.Timeout | null = null;
  #reconciling: Promise<void> | null = null;
  #visibleCache = new Map<string, { seq: number; ids: Set<string> }>();
  #stagedVisibleCache = new Map<string, { seq: number; ids: Set<string> }>();
  /**
   * The deletion barrier (docs/design-v1-dm-tools.md 3.19). An op's asset
   * facts are read before it joins the queue, so a deletion can run between
   * the read and the op. Each deletion takes a new generation, a counter of
   * its own since a deletion moves no room seq. `#lookups` holds every
   * lookup whose op is not processed yet, and `#deleted` keeps a deleted id
   * with its generation only while an older such lookup asked for it, so a
   * fact read before the deletion is dropped when its op arrives, and the
   * record never holds more than the outstanding lookups read.
   */
  #deletionGen = 0;
  #lookups = new Set<Lookup>();
  #deleted = new Map<string, number>();
  /** A deletion step's statement in flight: the queue waits for it. */
  #stepRunning: Promise<void> | null = null;

  private constructor(deps: ActorDeps, loaded: { state: RoomState; seq: number; snapshotSeq: number; replayFailed: boolean; stateBytes: number }, receipts: readonly ReceiptRow[]) {
    this.roomId = deps.info.roomId;
    this.pinned = deps.info.pinned;
    this.createdIp = deps.info.createdIp;
    this.readOnly = deps.info.readOnly || loaded.replayFailed;
    this.replayFailed = loaded.replayFailed;
    this.#pool = deps.pool;
    this.#log = deps.log;
    this.#closeWrites = deps.closeWrites ?? new CloseWrites();
    this.#budget = deps.budget;
    this.#gateway = deps.gateway;
    this.#opts = { ...DEFAULT_ACTOR_OPTIONS, ...deps.options };
    this.#onIdle = deps.onIdle;
    this.loadedAt = this.#opts.now();
    this.lastOpAt = this.loadedAt;
    this.#committed = { state: loaded.state, seq: loaded.seq };
    this.#staged = this.#committed;
    this.#snapshotSeq = loaded.snapshotSeq;
    this.#opsSinceSnapshot = loaded.seq - loaded.snapshotSeq;
    this.#sizes = new SizeGuard(this.#opts.sizeLimits);
    this.#sizes.stateMeasured(measuredFromStored(loaded.stateBytes, loaded.state));
    this.#roomRate = new TokenBucket(this.#opts.roomOpsPerSec, this.#opts.roomOpsPerSec * 2, this.#opts.now);
    this.#receipts = new ReceiptBook(this.#opts.now, this.#opts.receiptCaps);
    // Who admitted a stored receipt is read from the member's kind now, which the DM grants keep (reconcileKinds).
    this.#receipts.load(
      receipts.map((r) => ({
        memberId: r.memberId,
        tag: r.tag,
        part: r.part,
        state: r.state,
        ...(r.seq !== null ? { seq: r.seq } : {}),
        ...(r.code !== null ? { code: r.code as RefusalCode } : {}),
        ...(r.message !== null ? { message: r.message } : {}),
        at: Date.parse(r.at),
        player: loaded.state.members[r.memberId]?.kind !== "dm",
      })),
    );
    this.#recheckTimer = setInterval(() => void this.#recheckGrants(), this.#opts.grantRecheckMs);
    this.#recheckTimer.unref();
  }

  /** Loads the room (design 16.2) and reconciles its DM labels with the grants that exist. Null when the room has no snapshot. */
  static async load(deps: ActorDeps): Promise<RoomActor | null> {
    const loaded = await loadRoom(deps.pool, deps.info.roomId, (seq, reason) => {
      deps.log.error({ roomId: deps.info.roomId, seq, reason }, "room replay failed, serving it read-only");
    });
    if (!loaded) return null;
    // The receipts younger than 24 hours, so a restart keeps the duplicate rule and the day's caps (docs/design-v1-dice.md 1.2).
    const now = deps.options?.now ?? DEFAULT_ACTOR_OPTIONS.now;
    const receipts = await loadReceipts(deps.pool, deps.info.roomId, new Date(now() - DAY_MS));
    const actor = new RoomActor(deps, loaded, receipts);
    await actor.reconcileKinds();
    if (actor.#opsSinceSnapshot >= actor.#opts.snapshotOps) actor.#scheduleSnapshot();
    return actor;
  }

  get committed(): { state: RoomState; seq: number } {
    return this.#committed;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  /** Sessions with a socket open in this room right now, for the DM devices list. */
  openSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const conn of this.#connections) if (!conn.closed) ids.add(conn.sessionId);
    return ids;
  }

  /** Nothing to do and nobody listening: the manager may unload (design 16.2). */
  get idle(): boolean {
    return (
      this.#connections.size === 0 &&
      this.#queue.length === 0 &&
      this.#batch === null &&
      this.#inFlight === null &&
      this.#snapshotting === null &&
      this.#stepRunning === null
    );
  }

  /** How many deleted asset ids the barrier keeps for outstanding lookups, for its tests. */
  get deletionRecordSize(): number {
    return this.#deleted.size;
  }

  // Connections.

  attach(conn: Connection): boolean {
    if (this.#closed) return false;
    this.#connections.add(conn);
    this.#broadcastPresence(conn);
    return true;
  }

  detach(conn: Connection): void {
    if (!this.#connections.delete(conn)) return;
    const key = conn.key;
    if (key !== null) {
      if (this.#clients.get(key) === conn) this.#clients.delete(key);
      const delayed = this.#delayed.get(key);
      if (delayed && delayed.conn === conn) {
        delayed.cancel();
        this.#delayed.delete(key);
      }
    }
    cancelPreviews(conn, this.#connections);
    this.#broadcastPresence();
    this.#maybeIdle();
    // A socket makes no HTTP request in its whole life, so the session's last
    // sight (the DM devices list) is stamped when it goes, not when it came.
    this.#closeWrites.run(
      () => this.#pool.query("update sessions set last_seen_at = now() where id = $1", [conn.sessionId]),
      (err) => this.#log.warn({ err, roomId: this.roomId }, "last seen update failed"),
    );
  }

  /**
   * The X-card (docs/design-v1-dm-tools.md 3.11) to every socket of the
   * room: DMs on any scene, players behind a blackout, and table displays.
   * The message names no one, the sender's own device gets it too, and
   * nothing about it is stored.
   */
  xcard(at: string): void {
    for (const conn of this.#connections) if (!conn.closed) conn.send({ t: "xcard", at });
  }

  /**
   * The `access` signal (design 10.2) to every DM socket that has its
   * snapshot. A socket still waiting for one asks the server for everything
   * once it opens, so it needs no signal.
   */
  notifyAccess(): void {
    for (const conn of this.#connections) {
      if (!conn.closed && conn.role === "dm" && conn.held !== null) conn.send({ t: "access" });
    }
  }

  closeSockets(filter: SocketFilter, code: number): void {
    for (const conn of this.#connections) {
      if ("all" in filter || filter.sessionIds.includes(conn.sessionId)) conn.close(code);
    }
    if (code === CLOSE.grantRevoked) void this.reconcileKinds();
  }

  // Inbound messages. Each one runs its database reads first, then joins the queue.

  async hello(conn: Connection, msg: { clientId: string; resumeFrom: number; sceneId?: string | undefined }): Promise<void> {
    const key = clientKey(conn.sessionId, msg.clientId);
    const fresh = conn.helloCount === 0;
    conn.helloCount++;
    let stored = 0;
    if (!this.#watermarks.has(key)) {
      try {
        stored = await readWatermark(this.#pool, this.roomId, { sessionId: conn.sessionId, clientId: msg.clientId });
      } catch (err) {
        // Guessing 0 could strand the client behind a gap forever, so the
        // socket is dropped and the client's reconnect tries again.
        this.#log.warn({ err, roomId: this.roomId }, "watermark read failed");
        conn.close(1011, "try again");
        return;
      }
    }
    if (conn.closed) return;
    this.#enqueue({ t: "hello", conn, clientId: msg.clientId, resumeFrom: msg.resumeFrom, sceneId: msg.sceneId, stored, fresh });
  }

  /** `group` is the undo group the client sent the op under (design 7.7): ops of one gesture undo as one step. */
  async op(conn: Connection, n: number, raw: unknown, group?: string): Promise<void> {
    if (this.#queue.length >= this.#opts.queueCap || this.#closed) {
      conn.send({ t: "retry", n, code: "busy" });
      return;
    }
    const ids = [...new Set([...assetIdsOf(raw), ...this.#restoreAssetIds(conn, raw)])];
    let facts = NO_FACTS;
    let lookup: Lookup | null = null;
    if (ids.length > 0) {
      // The asset lookup is a database read, so an op over its rate is
      // turned away before it, not after: a flood of asset ops must not
      // hold the pool connections this room's commits need. `busy` spends
      // no op number, so answering it ahead of the sequence checks is safe.
      // The op still counts toward the abuse rule, as it would in the queue.
      if (!conn.opRate.wouldAllow() || this.#roomRate.tokens < 1) {
        if (conn.opRate.count()) conn.close(CLOSE.abuse, "op rate");
        else conn.send({ t: "retry", n, code: "busy" });
        return;
      }
      // Registered with the deletion generation before the read starts, in
      // this same synchronous step, so no deletion can run between the two
      // and find the lookup missing.
      lookup = { gen: this.#deletionGen, ids: new Set(ids) };
      this.#lookups.add(lookup);
      facts = await loadAssetFacts(this.#pool, ids).catch((err: unknown) => {
        this.#log.warn({ err, roomId: this.roomId }, "asset lookup failed");
        return new Map<string, AssetFact>();
      });
    }
    if (conn.closed || this.#queue.length >= this.#opts.queueCap || this.#closed) {
      if (lookup) this.#endLookup(lookup);
      if (!conn.closed) conn.send({ t: "retry", n, code: "busy" });
      return;
    }
    this.#enqueue({ t: "op", conn, n, raw, group, facts, lookup });
  }

  /**
   * The images the step an undo or a redo would take would put back, read
   * with the op's other asset facts, so a restore never brings back a
   * reference to an image deleted since (docs/design-v1-dm-tools.md 2.6).
   * The step, or what it would add, may change before the op is processed
   * (an op ahead of it in the queue). The queue step then answers `busy`,
   * and the client's retry reads again.
   */
  #restoreAssetIds(conn: Connection, raw: unknown): string[] {
    if (raw === null || typeof raw !== "object") return [];
    const { t, log } = raw as { t?: unknown; log?: unknown };
    if ((t !== "undo" && t !== "redo") || log !== undefined) return [];
    const step = this.#undo.peek(conn.memberId, t);
    if (!step) return [];
    return restoreAddedAssets(step.entries, this.#staged.state).map((ref) => ref.assetId.toLowerCase());
  }

  /**
   * Runs a deletion step on this room's queue (docs/design-v1-dm-tools.md
   * 3.19). The batch being staged is committed first and awaited, so the
   * committed state `run` gets equals the staged one and nothing it relies
   * on can still be abandoned. If that commit is still being retried when
   * the room shuts down, the step is refused and runs nothing. While `run`
   * is awaited the queue waits, so no op is applied meanwhile. The ids it
   * returns as deleted are recorded under a new deletion generation, and a
   * room that went read-only at its quota checks its size again at once.
   */
  deletionStep<T>(run: DeletionRun<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#closed) {
        reject(new ActorClosedError(this.roomId));
        return;
      }
      this.#enqueue({ t: "step", run, resolve: resolve as (value: unknown) => void, reject });
    });
  }

  #runStep(cmd: Extract<Command, { t: "step" }>): void {
    if (this.#batch) {
      // Flush first: the step goes back to the front and runs once the commit lands.
      this.#queue.unshift(cmd);
      this.#commitNow();
      return;
    }
    // Started in a microtask, so the queue is marked as held before `run` can settle, even by throwing at once.
    this.#stepRunning = Promise.resolve().then(async () => {
      let deleted = 0;
      try {
        const { deleted: ids, result } = await cmd.run(this.#committed.state, this.#committed.seq);
        this.#recordDeletion(ids);
        deleted = ids.length;
        cmd.resolve(result);
      } catch (err) {
        cmd.reject(err as Error);
      } finally {
        this.#stepRunning = null;
        this.#drain();
      }
      if (deleted > 0) await this.#checkQuota().catch((err: unknown) => this.#log.warn({ err, roomId: this.roomId }, "quota recheck failed"));
    });
  }

  /** Keeps only the deleted ids an outstanding lookup, older than this deletion by construction, asked for. */
  #recordDeletion(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const gen = ++this.#deletionGen;
    for (const raw of ids) {
      const id = raw.toLowerCase();
      for (const lookup of this.#lookups) {
        if (lookup.ids.has(id)) {
          this.#deleted.set(id, gen);
          break;
        }
      }
    }
  }

  /**
   * The op's facts as they stand at the front of the queue: a fact for an
   * asset deleted since its lookup started is dropped, so permissions answer
   * `gone` as for an asset that never existed. The lookup is done then, and
   * each deleted id no other older lookup asked for leaves the record.
   */
  #settleFacts(lookup: Lookup | null, facts: Map<string, AssetFact>): Map<string, AssetFact> {
    if (!lookup) return facts;
    let settled = facts;
    for (const id of lookup.ids) {
      const gen = this.#deleted.get(id);
      if (gen !== undefined && gen > lookup.gen && settled.has(id)) {
        if (settled === facts) settled = new Map(facts);
        settled.delete(id);
      }
    }
    this.#endLookup(lookup);
    return settled;
  }

  #endLookup(lookup: Lookup): void {
    if (!this.#lookups.delete(lookup)) return;
    for (const id of lookup.ids) {
      const gen = this.#deleted.get(id);
      if (gen === undefined) continue;
      let wanted = false;
      for (const other of this.#lookups) {
        if (other.gen < gen && other.ids.has(id)) {
          wanted = true;
          break;
        }
      }
      if (!wanted) this.#deleted.delete(id);
    }
  }

  ephemeral(conn: Connection, msg: { sceneId: string; e: Parameters<typeof routeEphemeral>[3] }): void {
    if (conn.held === null || !conn.eph.take()) return;
    routeEphemeral(this.#committed.state, conn, msg.sceneId, msg.e, this.#connections);
  }

  /** A DM's `scene` request (design 7.1): counted against the snapshot budget's abuse rule, then answered with `resync`. */
  scene(conn: Connection): void {
    const delayed = this.#budget.delay(this.#budget.keys(conn.sessionId, conn.ip, this.pinned)) > 0;
    if (this.#budget.request(conn.sessionId, delayed)) {
      this.closeSockets({ sessionIds: [conn.sessionId] }, CLOSE.abuse);
      return;
    }
    this.#resync(conn, "scene");
  }

  // Server-side commands.

  /** Applies a roster op through the queue and resolves once it is durable. */
  sys(op: ServerOnlyOp): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#closed) {
        reject(new ActorClosedError(this.roomId));
        return;
      }
      this.#enqueue({ t: "sys", op, resolve, reject });
    });
  }

  /** Runs `fn` on the committed state in queue order, for copies that must not interleave with a snapshot. */
  read<T>(fn: (state: RoomState, seq: number) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#closed) {
        reject(new ActorClosedError(this.roomId));
        return;
      }
      this.#enqueue({
        t: "read",
        run: () => {
          try {
            resolve(fn(this.#committed.state, this.#committed.seq));
          } catch (err) {
            reject(err as Error);
          }
        },
      });
    });
  }

  /** The assets a player's projection refers to (design 11.2), cached per committed seq. */
  visibleAssets(memberId: string): Set<string> {
    const cached = this.#visibleCache.get(memberId);
    if (cached && cached.seq === this.#committed.seq) return cached.ids;
    const ids = visibleAssetIds(this.#committed.state, { memberId, role: "player" }, { sceneId: null });
    this.#visibleCache.set(memberId, { seq: this.#committed.seq, ids });
    return ids;
  }

  /**
   * The lines a committed op of this seq wrote, `<seq>:<index>`, while the
   * in-memory log still holds them, for the receipt lookup
   * (docs/design-v1-dice.md 1.2). Null once they left it: the archive has
   * them, or pruned them.
   */
  committedLines(seq: number): LogEntry[] | null {
    const prefix = `${seq}:`;
    const lines = this.#committed.state.log.filter((e) => e.id.startsWith(prefix));
    return lines.length > 0 ? lines : null;
  }

  /** How many receipts the room holds younger than 24 hours, staged ones included, and one member's: for the receipt tests. */
  receiptCounts(memberId?: string): { room: number; member: number; players: number } {
    return { room: this.#receipts.size, member: memberId === undefined ? 0 : this.#receipts.countOf(memberId), players: this.#receipts.players };
  }

  /** Projects log rows from the database for a viewer with each line's own rules, as the live log's (design 7.3). */
  projectLog(entries: LogEntry[], viewer: Viewer, sceneId: string | null): LogEntry[] {
    return projectArchivedLog(this.#committed.state, entries, viewer, { sceneId });
  }

  /**
   * A member labelled `dm` with no current DM grant becomes a player, so a
   * grant removed in the database alone (the admin CLI, an expired epoch)
   * is never undone by this room's next snapshot.
   */
  reconcileKinds(): Promise<void> {
    // A room whose replay failed cannot write the relabel, and the load must not wait on one.
    if (this.#closed || this.replayFailed) return Promise.resolve();
    this.#reconciling ??= (async () => {
      try {
        const { rows } = await this.#pool.query<{ member_id: string }>(
          `select distinct g.member_id from grants g join rooms r on r.id = g.room_id
           where g.room_id = $1 and g.role = 'dm' and g.epoch = r.dm_epoch`,
          [this.roomId],
        );
        const granted = new Set(rows.map((r) => r.member_id));
        for (const member of Object.values(this.#staged.state.members)) {
          if (member.kind === "dm" && !granted.has(member.id)) {
            await this.sys({ t: "sys.memberSetKind", memberId: member.id, kind: "player" }).catch(() => undefined);
          }
        }
      } catch (err) {
        this.#log.warn({ err, roomId: this.roomId }, "member kind reconcile failed");
      } finally {
        this.#reconciling = null;
      }
    })();
    return this.#reconciling;
  }

  /**
   * Stops the room (design 15.4 and 16.2): sockets close with `code`, queued
   * work is dropped (clients keep those ops pending and resend them), the
   * accumulating batch commits, the in-flight commit finishes its current
   * attempt, and the committed state is written as the snapshot.
   */
  shutdown(opts: { code: number; snapshot: boolean; flush?: boolean }): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      if (this.#recheckTimer) clearInterval(this.#recheckTimer);
      if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
      for (const d of this.#delayed.values()) d.cancel();
      this.#delayed.clear();
      for (const conn of this.#connections) conn.close(opts.code);
      const queued = this.#queue;
      this.#queue = [];
      for (const cmd of queued) {
        if (cmd.t === "sys" || cmd.t === "step") cmd.reject(new ActorClosedError(this.roomId));
        if (cmd.t === "read") cmd.run();
        if (cmd.t === "op" && cmd.lookup) this.#endLookup(cmd.lookup);
      }
      if (this.#batch && (opts.flush ?? true)) this.#commitNow();
      else if (this.#batch) {
        // Simulating a crash: the accumulating batch is lost like it would be.
        if (this.#batch.timer) clearTimeout(this.#batch.timer);
        for (const s of this.#batch.sys) s.reject(new ActorClosedError(this.roomId));
        this.#receipts.abandoned(this.#batch.receipts);
        this.#batch = null;
      }
      if (this.#inFlightDone) await this.#inFlightDone;
      // A deletion statement already sent finishes before the room leaves memory, so a reload never overlaps it.
      if (this.#stepRunning) await this.#stepRunning;
      if (opts.snapshot) await this.#writeSnapshot();
    })();
    return this.#closing;
  }

  // The queue.

  #enqueue(cmd: Command): void {
    this.#queue.push(cmd);
    this.#drain();
  }

  #drain(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      while (this.#inFlight === null && this.#stepRunning === null && !this.#closed) {
        const cmd = this.#queue.shift();
        if (!cmd) break;
        this.#handle(cmd);
        if (this.#batch && this.#batch.ops.length >= this.#opts.maxBatchOps) this.#commitNow();
      }
    } finally {
      this.#draining = false;
    }
    this.#maybeIdle();
  }

  #handle(cmd: Command): void {
    switch (cmd.t) {
      case "op":
        return this.#processOp(cmd, this.#settleFacts(cmd.lookup, cmd.facts));
      case "hello":
        return this.#processHello(cmd);
      case "snapshot":
        if (!cmd.conn.closed && this.#clients.get(cmd.key) === cmd.conn) this.#snapshot(cmd.conn, cmd.key);
        return;
      case "sys":
        return this.#processSys(cmd);
      case "read":
        return cmd.run();
      case "step":
        return this.#runStep(cmd);
    }
  }

  // The op pipeline of design 7.2, in its order.

  #processOp(cmd: Extract<Command, { t: "op" }>, facts: Map<string, AssetFact>): void {
    const conn = cmd.conn;
    if (conn.closed) return;
    const key = conn.key;
    const wm = key === null ? undefined : this.#watermarks.get(key);
    if (key === null || !wm) {
      conn.close(CLOSE.authFailure, "op before hello");
      return;
    }
    const n = cmd.n;
    // Every op message counts toward the sustained-abuse rule, duplicates and gaps included.
    if (conn.opRate.count()) {
      conn.close(CLOSE.abuse, "op rate");
      return;
    }
    if (n <= wm.committed) {
      conn.send({ t: "ev", seq: this.#committed.seq, changes: [], acks: [n] });
      return;
    }
    if (n <= wm.staged) return;
    if (n > wm.staged + 1) {
      conn.send({ t: "retry", n, code: "gap" });
      return;
    }
    if (!conn.opRate.allow() || !this.#roomRate.take()) {
      conn.send({ t: "retry", n, code: "busy" });
      return;
    }
    const viewer = conn.viewer;
    const parsed = clientOpSchema.safeParse(cmd.raw);
    if (!parsed.success) {
      this.#refuse(key, wm, n, "invalid", parsed.error.issues[0]?.message ?? "invalid op");
      return;
    }
    // A page left open across the dragon turtle's rename still names the old id, which nothing would rename once stored.
    const clientOp = withTodaysSrdIds(parsed.data);
    let op: Op = clientOp;
    let restoredFrom: "undo" | "redo" | null = null;
    let step: UndoEntry | null = null;
    let fromLog = false;
    if (op.t === "undo" && op.log !== undefined) {
      // Taking an HP change back from the log (features section 10): not a
      // step of anyone's stack, but a restore built from the log line and
      // the creature as it stands now, which is checked, stored and replayed
      // like every other (design 7.7).
      const decision = canApply(op, viewer, this.#staged.state, this.#permissionDeps(viewer, facts));
      if (!decision.ok || op.of !== undefined) {
        this.#refuse(key, wm, n, decision.ok ? "invalid" : decision.code, decision.ok ? "an undo names one step" : decision.message);
        return;
      }
      const built = hpUndoRestore(this.#staged.state, op.log);
      const label = built.event ? describeHpEvent(built.event, this.#staged.state) : null;
      if (!built.ok) {
        this.#refuse(key, wm, n, built.code, label ? `could not undo ${label}: ${built.message}` : `could not undo that change: ${built.message}`);
        return;
      }
      const checked = checkServerOp({ t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: op.log });
      if (!checked.ok) {
        this.#refuse(key, wm, n, "invalid", checked.message);
        return;
      }
      restoredFrom = "undo";
      fromLog = true;
      step = { entries: built.entries, label: label ?? "an HP change" };
      op = checked.op;
    } else if (op.t === "undo" || op.t === "redo") {
      // Checked before the pop, so the newer step it found stays for an undo meant for it.
      if (op.t === "undo" && op.of !== undefined && !this.#undo.newestIs(viewer.memberId, { client: key, n: op.of })) {
        this.#refuse(key, wm, n, "invalid", NOT_NEWEST);
        return;
      }
      // The images this step would put back must have been read with the op (#restoreAssetIds). A step that changed since,
      // under an op of the same member ahead of this one, is not popped: the client sends the op again and it is read anew.
      const next = this.#undo.peek(viewer.memberId, op.t);
      const asked = cmd.lookup?.ids ?? NO_IDS;
      if (next && restoreAddedAssets(next.entries, this.#staged.state).some((ref) => !asked.has(ref.assetId.toLowerCase()))) {
        conn.send({ t: "retry", n, code: "busy" });
        return;
      }
      step = op.t === "undo" ? this.#undo.popUndo(viewer.memberId) : this.#undo.popRedo(viewer.memberId);
      if (!step) {
        this.#refuse(key, wm, n, "invalid", `nothing to ${op.t}`);
        return;
      }
      // A move a trap stopped, or that showed its player a line, is the DM's to take back (docs/design-v1-traps.md 6.5). The step is dropped, as a failed guard drops it.
      if (op.t === "undo" && viewer.role === "player" && step.trapped) {
        this.#refuse(key, wm, n, "invalid", `could not undo ${step.label}: ${TRAPPED_ON_THE_WAY}`);
        return;
      }
      restoredFrom = op.t;
      let entries = step.entries;
      let quiet: string[] | undefined;
      if (step.poses) {
        const state = this.#staged.state;
        const shown = (id: string) => (viewer.role === "dm" ? (state.tokens[id] ?? null) : (projectEntity(keys.token(id), state, viewer, { sceneId: state.meta.playerSceneId }) as Partial<Token> | null));
        const moved = poseRestore(state, { ...step, poses: step.poses }, (id) => shown(id) !== null, (id) => shown(id)?.path !== undefined);
        if (!moved.ok) {
          this.#refuse(key, wm, n, moved.code, `could not ${op.t} ${step.label}: ${moved.message}`);
          return;
        }
        entries = moved.entries;
        quiet = moved.quiet;
      }
      // `deps` turns on the reference checks (design 7.7). It is stored with the op, so replay checks it the same way.
      // A redo of walks around walls keeps their routes, which only permissions read (docs/design-v1-movement.md 7.4).
      const routes = op.t === "redo" && step.routed && step.routes ? { routes: step.routes } : {};
      // A controlled ride the step ended or made shares its turn again when put back on that turn (docs/design-v1-attach.md 8.3).
      const rides = step.poses && step.rides && step.rides.length > 0 ? { rides: step.rides } : {};
      const checked = checkServerOp({ t: "sys.restore", entries, from: op.t, deps: true, ...(step.teleport ? { teleport: true as const } : {}), ...routes, ...rides, ...(quiet ? { quiet } : {}) });
      if (!checked.ok) {
        this.#refuse(key, wm, n, "invalid", checked.message);
        return;
      }
      op = checked.op;
    }
    // A tag already settled is answered from its receipt, before anything else is looked at (docs/design-v1-dice.md 4.2).
    const tagged = tagOf(op);
    if (tagged) {
      const settled = this.#receipts.find(viewer.memberId, tagged.tag, tagged.part);
      if (settled) {
        this.#answerFromReceipt(key, wm, n, settled);
        return;
      }
    }
    if (this.replayFailed) {
      this.#refuse(key, wm, n, "quota", "the room could not be fully loaded and is read-only");
      return;
    }
    if (this.readOnly && !DELETIONS.has(op.t) && !removesPcStats(op)) {
      this.#refuse(key, wm, n, "quota", isBlockSave(op) ? BLOCKS_AT_QUOTA : "the room is full: it is at its storage quota, so only deletions are accepted");
      return;
    }
    /*
     * Admission (docs/design-v1-dice.md 1.2), before any permission check, so an op that permissions refuse later has
     * paid for its receipt: the day's caps must have room for one more, then the member's budget is charged. A refusal
     * here leaves no receipt, draws nothing and applies nothing, so refused traffic never spends the room's day. Past
     * this point every outcome writes the op's receipt, in the batch that settles it. Refused, never `busy`, so the
     * device's later ops go on, as with block saves.
     */
    let admitted: Admitted | null = null;
    if (tagged) {
      const player = viewer.role === "player";
      const full = this.#receipts.refusal(viewer.memberId, player);
      if (full !== null) {
        this.#refuse(key, wm, n, "quota", full);
        return;
      }
      if (!this.#rollBudget(viewer).take(admissionCost(op))) {
        this.#refuse(key, wm, n, "quota", ROLLING_TOO_FAST);
        return;
      }
      admitted = { memberId: viewer.memberId, player, ...tagged };
    }
    /*
     * A player's block saves past their budget (docs/design-v1-companion-stat-blocks.md 3.5) are refused, never answered
     * `busy`: a refusal advances the op sequence, so the device's moves and HP changes after it go on at once, while `busy`
     * would hold every later op behind the save. A delete counts, so creating and deleting cannot churn the op log.
     */
    if (viewer.role === "player" && isBlockOp(op) && !this.#blockSaveBudget(viewer.memberId).take()) {
      this.#refuse(key, wm, n, "quota", BLOCK_SAVES_TOO_FAST, admitted);
      return;
    }
    op = withAssetSizes(op, facts);
    const decision = canApply(op, viewer, this.#staged.state, this.#permissionDeps(viewer, facts));
    if (!decision.ok) {
      const message = restoredFrom && step ? `could not ${restoredFrom} ${step.label}: ${decision.message}` : decision.message;
      this.#refuse(key, wm, n, decision.code, message, admitted);
      return;
    }
    // The server rolls, only now that the op is permitted, so no refusal depends on the dice (docs/design-v1-dice.md 4.2).
    if (isDiceOp(op)) {
      const resolved = resolveDice(op, this.#staged.state, viewer, { draw: this.#opts.draw });
      if (!resolved.ok) {
        this.#refuse(key, wm, n, resolved.code, resolved.message, admitted);
        return;
      }
      const checked = checkServerOp(resolved.op);
      if (!checked.ok) {
        this.#refuse(key, wm, n, "invalid", checked.message, admitted);
        return;
      }
      op = checked.op;
    }
    const before = this.#staged.state;
    const reduced = this.#reduce(op, viewer);
    if (!reduced.ok) {
      // A restore that failed says which step it was, so a refused undo is never a riddle.
      const message = restoredFrom && step ? `could not ${restoredFrom} ${step.label}: ${reduced.message}` : reduced.message;
      this.#refuse(key, wm, n, reduced.code, message, admitted);
      return;
    }
    wm.staged = n;
    const batch = this.#ensureBatch();
    push(batch.acks, key, n);
    if (reduced.trapped && viewer.role === "player") push(batch.trapped, key, n);
    const stamped = stampedAt(op, this.#staged.state);
    if (stamped !== undefined) push(batch.stamped, key, { n, at: stamped });
    batch.watermarks.set(key, n);
    if (admitted) this.#stageReceipt(batch, admitted, { state: "committed", seq: this.#staged.seq });
    if (restoredFrom && step) {
      push(batch.restored, key, { n, what: step.label });
      const inverse = reduced.inverse;
      // A change taken back from the log goes on no stack. Redone, it would come back with no line to say so, and its own line
      // would read as taken back for good. The DM deals it again instead, which the log records.
      if (inverse && !fromLog) this.#undo.pushRestored(viewer.memberId, restoredFrom, inverse, step.label, step.poses ? posesAfter(this.#staged.state, inverse, this.#shows(viewer), keptFrom(step.poses, before)) : undefined, step.origin, step.teleport === true, step);
    } else if (UndoStacks.records(viewer.role, op) && reduced.inverse) {
      // A player's move or resize takes back only the move or the resize (undo.ts poseRestore). The DM's undo restores whole
      // values, as for every other op. What a trap wrote on the way stays as it is (docs/design-v1-traps.md 6.5).
      const pose = viewer.role === "player" && (isPoseOp(op) || isResizeOp(op));
      const trapWrote = reduced.trapWrote;
      const inverse = pose && trapWrote ? reduced.inverse.filter((e) => !trapWrote.has(e.key)) : reduced.inverse;
      const poses = pose ? posesAfter(this.#staged.state, inverse, this.#shows(viewer), plannedOn(before, op)) : undefined;
      // A teleport's step remembers it, so its redo passes the wall again (docs/design-v1-maps-vision.md 4.1).
      const teleport = op.t === "token.move" && op.teleport !== undefined;
      // A player's walk keeps its route for the redo (docs/design-v1-movement.md 7.4), a plain move as its one straight piece.
      const walk: Walk | undefined =
        poses && op.t === "token.move" && !teleport ? { tokenId: op.tokenId, route: op.route ?? [[op.x, op.y, 0, 0]], routed: op.route !== undefined } : undefined;
      const rides = poses ? ridesChanged(before, this.#staged.state) : undefined;
      this.#undo.push(viewer.memberId, inverse, describeOp(clientOp, before, viewer, this.#staged.state), cmd.group, poses, { client: key, n }, tallyOf(clientOp, before, this.#staged.state), teleport, walk, rides, reduced.trapped === true);
    }
    this.#scheduleCommit();
  }

  /** Which tokens a viewer sees in the staged room, as their undo's poses read links (undo.ts poseOf). */
  #shows(viewer: Viewer): (tokenId: string) => boolean {
    const state = this.#staged.state;
    return (id) => viewer.role === "dm" || projectEntity(keys.token(id), state, viewer, { sceneId: state.meta.playerSceneId }) !== null;
  }

  #blockSaveBudget(memberId: string): TokenBucket {
    let bucket = this.#blockSaves.get(memberId);
    if (!bucket) {
      bucket = new TokenBucket(1000 / LIMITS.companionBlockWriteRefillMs, LIMITS.companionBlockWriteBurst, this.#opts.now);
      this.#blockSaves.set(memberId, bucket);
    }
    return bucket;
  }

  /** Each member's budget of tagged ops (docs/design-v1-dice.md 4.4), by the role they act in. */
  #rollBudget(viewer: Viewer): TokenBucket {
    const key = `${viewer.role}:${viewer.memberId}`;
    let bucket = this.#rollBudgets.get(key);
    if (!bucket) {
      const dm = viewer.role === "dm";
      bucket = new TokenBucket(1000 / (dm ? LIMITS.dmRollRefillMs : LIMITS.playerRollRefillMs), dm ? LIMITS.dmRollBurst : LIMITS.playerRollBurst, this.#opts.now);
      this.#rollBudgets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * A refusal. One after admission (`admitted`) writes the op's receipt with
   * the same words, so the same tag sent again is refused again.
   */
  #refuse(key: ClientKey, wm: Watermark, n: number, code: RefusalCode, message: string, admitted: Admitted | null = null): void {
    wm.staged = n;
    const batch = this.#ensureBatch();
    const words = message.slice(0, 200);
    push(batch.rejects, key, { n, code, message: words });
    batch.watermarks.set(key, n);
    if (admitted) this.#stageReceipt(batch, admitted, { state: "refused", code, message: words });
    this.#scheduleCommit();
  }

  #stageReceipt(batch: Batch, admitted: Admitted, outcome: Pick<Receipt, "state" | "seq" | "code" | "message">): void {
    const receipt: Receipt = { memberId: admitted.memberId, tag: admitted.tag, part: admitted.part, player: admitted.player, at: this.#opts.now(), ...outcome };
    this.#receipts.stage(receipt);
    batch.receipts.push(receipt);
  }

  /**
   * A tagged op whose tag is settled (docs/design-v1-dice.md 1.2), whatever
   * its `n`: a committed one is answered with its ack and no change, a
   * refused one with the same refusal. It spends no budget and draws
   * nothing, so any retry with the same tag within 24 hours is safe.
   */
  #answerFromReceipt(key: ClientKey, wm: Watermark, n: number, receipt: Receipt): void {
    if (receipt.state === "refused") {
      this.#refuse(key, wm, n, receipt.code ?? "invalid", receipt.message ?? "refused");
      return;
    }
    wm.staged = n;
    const batch = this.#ensureBatch();
    push(batch.acks, key, n);
    batch.watermarks.set(key, n);
    this.#scheduleCommit();
  }

  /** Steps 7 and 8: reduce on the staged state, then check the limits on what came out. */
  #reduce(op: Op, viewer: Viewer): Reduced {
    const seq = this.#staged.seq + 1;
    const at = new Date(this.#opts.now()).toISOString();
    const result = applyOp(this.#staged.state, op, viewer, { seq, at });
    if (!result.ok) return result;
    // The limits read the op as it would apply with no trap step: what a trap writes is reserved or counted ahead, so a
    // springing never changes whether an op passes (docs/design-v1-traps.md 6.7). The room stored is the op's real result.
    const measured = result.withoutTraps ? result.withoutTraps() : result;
    if (!measured.ok) return measured;
    const sceneIds = scenesOf(op, this.#staged.state, measured.state);
    const before = this.#staged.state;
    // `before` with no scene too, so a show past the room's handout pages says that showing counts them again.
    const limits: LimitCheck = checkLimits(measured.state, sceneIds[0] ?? null, before, viewer.role);
    if (!limits.ok) return limits;
    for (const sceneId of sceneIds.slice(1)) {
      const more = checkLimits(measured.state, sceneId, before, viewer.role);
      if (!more.ok) return more;
    }
    // The split's counting pass (docs/design-v1-maps-vision.md 2.1), on every scene whose walls the op may have changed. Over a
    // cap it refuses with `quota` before any piece is built. Both it and the sight cap read every pit border as raised, so a
    // pit trap counts its walls from the start and opening one never raises a count (docs/design-v1-traps.md 6.7).
    const moved = [...new Set([...wallsMoved(this.#staged.state, measured.state), ...pitsMoved(this.#staged.state, measured.state, trapsTouched(measured.touched))])];
    for (const sceneId of moved) {
      const split = splitCheck(withPitsCounted(measured.state, sceneId), sceneId);
      if (!split.ok) return split;
    }
    // The cap on a vision scene's potential sight pieces (docs/design-v1-maps-vision.md 2.4), on every scene whose walls or
    // vision the op may have changed.
    for (const sceneId of new Set([...sceneIds, ...moved])) {
      const sight = sightPiecesCheck(withPitsCounted(measured.state, sceneId), sceneId, withPitsCounted(this.#staged.state, sceneId));
      if (!sight.ok) return sight;
    }
    // Every scene the op wrote into, read from what it touched, so no op's growth escapes its scenes' bounds.
    const grown = [...new Set([...sceneIds, ...touchedScenes(this.#staged.state, measured.state, measured.touched), ...touchedScenes(this.#staged.state, result.state, result.touched)])];
    const size = this.#sizes.check(measured.state, grown, growthBound(this.#staged.state, measured.state, measured.touched), this.#staged.state);
    // The state limit is what refuses a block save here, since the projected scene leaves blocks out: it says what to do.
    if (!size.ok) return isBlockSave(op) ? { ...size, message: BLOCKS_ROOM_TOO_FULL } : size;
    // The room stored is the real one, larger only by what a public springing changed, which every viewer sees anyway: the
    // guard counts that too, so its bounds stay bounds of what is stored.
    if (measured !== result) this.#sizes.grew(growthBound(measured.state, result.state, [...new Set([...measured.touched, ...result.touched])]), grown);
    this.#staged = { state: result.state, seq };
    const batch = this.#ensureBatch();
    batch.ops.push({ seq, at, actor: viewer, op, log: result.log });
    batch.touched.push(...result.touched);
    if (result.global) batch.global = true;
    this.lastOpAt = this.#opts.now();
    // Read only when the op goes on an undo stack: working it out hashes what the op touched.
    return {
      ok: true,
      get inverse() {
        return result.inverse;
      },
      ...(result.trapped ? { trapped: true as const } : {}),
      ...(result.trapWrote ? { trapWrote: result.trapWrote } : {}),
    };
  }

  #permissionDeps(viewer: Viewer, facts: Map<string, AssetFact>): PermissionDeps {
    return {
      canUseAsset: (memberId, assetId, kind) => {
        const fact = facts.get(assetId.toLowerCase());
        if (!fact || fact.roomId !== this.roomId || fact.kind !== kind) return false;
        if (viewer.role === "dm") return true;
        if (fact.uploaders.includes(memberId)) return true;
        return this.#stagedVisibleAssets(memberId).has(fact.id);
      },
      // A restore puts back only an image that is still a row of this room, of the kind its place takes
      // (docs/design-v1-dm-tools.md 2.6). Its facts were read with the op, and the barrier dropped any deleted since.
      restoredAssetUsable: (assetId, kind) => {
        const fact = facts.get(assetId.toLowerCase());
        return fact !== undefined && fact.roomId === this.roomId && fact.kind === kind;
      },
    };
  }

  #stagedVisibleAssets(memberId: string): Set<string> {
    const cached = this.#stagedVisibleCache.get(memberId);
    if (cached && cached.seq === this.#staged.seq) return cached.ids;
    const ids = visibleAssetIds(this.#staged.state, { memberId, role: "player" }, { sceneId: null });
    this.#stagedVisibleCache.set(memberId, { seq: this.#staged.seq, ids });
    return ids;
  }

  #processSys(cmd: Extract<Command, { t: "sys" }>): void {
    const op = cmd.op;
    const members = this.#staged.state.members;
    // Already done: a join retried after its member arrived, or a removal of a member already gone.
    if ((op.t === "sys.memberJoin" && members[op.member.id]) || (op.t === "sys.memberRemove" && !members[op.memberId])) {
      cmd.resolve();
      return;
    }
    if (op.t === "sys.memberSetKind") {
      const member = this.#staged.state.members[op.memberId];
      if (!member) {
        cmd.reject(new SysOpRefused("gone", "member is not here"));
        return;
      }
      if (member.kind === op.kind) {
        cmd.resolve();
        return;
      }
    }
    if (this.replayFailed) {
      cmd.reject(new RoomReplayFailed(this.roomId));
      return;
    }
    const checked = checkServerOp(op);
    if (!checked.ok) {
      cmd.reject(new SysOpRefused("invalid", checked.message));
      return;
    }
    const reduced = this.#reduce(checked.op, SERVER_ACTOR);
    if (!reduced.ok) {
      cmd.reject(new SysOpRefused(reduced.code, reduced.message));
      return;
    }
    this.#ensureBatch().sys.push(cmd);
    this.#scheduleCommit();
  }

  // Hello and snapshots (design 7.2 and 10.4).

  #processHello(cmd: Extract<Command, { t: "hello" }>): void {
    const conn = cmd.conn;
    if (conn.closed) return;
    const key = clientKey(conn.sessionId, cmd.clientId);
    const delayed = this.#delayed.get(key);
    if (delayed) {
      // A reconnect replaces the client's delayed request instead of spending the budget twice.
      delayed.cancel();
      this.#delayed.delete(key);
    }
    conn.clientId = cmd.clientId;
    conn.held = null;
    this.#clients.set(key, conn);
    if (conn.role === "dm") {
      const scenes = this.#staged.state.scenes;
      conn.sceneId = cmd.sceneId !== undefined && scenes[cmd.sceneId] ? cmd.sceneId : this.#staged.state.meta.playerSceneId;
    }
    if (cmd.fresh) {
      const over = this.#budget.delay(this.#budget.keys(conn.sessionId, conn.ip, this.pinned)) > 0;
      if (this.#budget.request(conn.sessionId, over)) {
        this.closeSockets({ sessionIds: [conn.sessionId] }, CLOSE.abuse);
        return;
      }
    }
    let wm = this.#watermarks.get(key);
    if (!wm) {
      wm = { sessionId: conn.sessionId, clientId: cmd.clientId, staged: cmd.stored, committed: cmd.stored };
      this.#watermarks.set(key, wm);
    }
    const settled = cmd.resumeFrom - 1;
    if (settled > wm.committed) {
      // The client says every lower n is settled: raise through the next
      // batch and answer once that is durable, so the watermark it gets
      // back is one it can rely on.
      if (settled > wm.staged) wm.staged = settled;
      const batch = this.#ensureBatch();
      batch.watermarks.set(key, Math.max(batch.watermarks.get(key) ?? 0, wm.staged));
      batch.hellos.push({ conn, key });
      this.#scheduleCommit();
      return;
    }
    this.#snapshot(conn, key);
  }

  #snapshot(conn: Connection, key: ClientKey): void {
    if (conn.closed) return;
    const budgetKeys = this.#budget.keys(conn.sessionId, conn.ip, this.pinned);
    const delay = this.#budget.delay(budgetKeys);
    if (delay > 0) {
      this.#delaySnapshot(conn, key, delay);
      return;
    }
    const wm = this.#watermarks.get(key);
    const snapshot = buildSnapshot(this.#committed.state, this.#committed.seq, conn, wm?.committed ?? 0);
    const bytes = conn.send(snapshot.message);
    conn.held = snapshot.held;
    conn.helloPending = false;
    conn.helloAllowed = false;
    this.#budget.record(budgetKeys, bytes);
    conn.send(this.#presenceFor(conn, this.#online(), this.#displayCount()));
    if (conn.display && !this.#shownDisplays.has(conn)) {
      this.#shownDisplays.add(conn);
      this.#broadcastPresence(conn);
    }
  }

  #delaySnapshot(conn: Connection, key: ClientKey, delay: number): void {
    const due = this.#opts.now() + delay;
    conn.send({ t: "wait", ms: delay });
    const interval = conn.every(2000, () => conn.send({ t: "wait", ms: Math.max(0, due - this.#opts.now()) }));
    const timer = conn.after(delay, () => {
      conn.cancel(interval);
      this.#delayed.delete(key);
      this.#queue.unshift({ t: "snapshot", conn, key });
      this.#drain();
    });
    this.#delayed.set(key, {
      conn,
      cancel: () => {
        conn.cancel(interval);
        conn.cancel(timer);
      },
    });
  }

  #resync(conn: Connection, reason: string): void {
    const key = conn.key;
    if (key !== null) {
      const delayed = this.#delayed.get(key);
      if (delayed && delayed.conn === conn) {
        delayed.cancel();
        this.#delayed.delete(key);
      }
    }
    conn.held = null;
    conn.helloAllowed = true;
    conn.helloPending = false;
    conn.send({ t: "resync", reason });
  }

  // Batches (design 7.2).

  #ensureBatch(): Batch {
    if (!this.#batch) {
      this.#batch = {
        before: this.#committed.state,
        ops: [],
        touched: [],
        global: false,
        acks: new Map(),
        rejects: new Map(),
        restored: new Map(),
        trapped: new Map(),
        stamped: new Map(),
        watermarks: new Map(),
        hellos: [],
        sys: [],
        receipts: [],
        timer: null,
        state: this.#committed.state,
        seq: this.#committed.seq,
      };
    }
    return this.#batch;
  }

  #scheduleCommit(): void {
    const batch = this.#batch;
    if (!batch || this.#inFlight) return;
    if (batch.ops.length >= this.#opts.maxBatchOps) {
      this.#commitNow();
      return;
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        batch.timer = null;
        this.#commitNow();
      }, this.#opts.batchMs);
    }
  }

  #commitNow(): void {
    const batch = this.#batch;
    if (!batch || this.#inFlight) return;
    this.#batch = null;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    if (batch.ops.length > 0) this.#explore(batch);
    batch.state = this.#staged.state;
    batch.seq = this.#staged.seq;
    this.#inFlight = batch;
    this.#inFlightDone = this.#runCommit(batch);
  }

  /**
   * The explore step (docs/design-v1-maps-vision.md 4.3.3): what the party
   * now sees on the player scene that its explored layer lacks goes into
   * that layer, by one server-made op at the end of the same batch, so
   * players never see sight outside the ground they have explored. Replay
   * applies the stored bits and never computes sight.
   *
   * It runs none of an op's checks. It only ever adds bits the party sees,
   * on tiles inside the scene, and never refuses: a refused explore would
   * leave the party's sight standing in fog. The room for it was reserved
   * by every earlier op's size check (sizeGuard.ts), and its growth only
   * spends that reserve. The protocol schema still checks it, because
   * replay checks every stored op against it.
   */
  #explore(batch: Batch): void {
    const state = this.#staged.state;
    const op = exploreOp(state);
    if (!op) return;
    const checked = checkServerOp(op);
    if (!checked.ok) {
      this.#log.error({ roomId: this.roomId, message: checked.message }, "explore op does not validate");
      return;
    }
    const seq = this.#staged.seq + 1;
    const at = new Date(this.#opts.now()).toISOString();
    const result = applyOp(state, checked.op, SERVER_ACTOR, { seq, at });
    if (!result.ok) {
      this.#log.error({ roomId: this.roomId, message: result.message }, "explore op refused");
      return;
    }
    this.#sizes.grew(growthBound(state, result.state, result.touched), [op.sceneId]);
    this.#staged = { state: result.state, seq };
    batch.ops.push({ seq, at, actor: SERVER_ACTOR, op: checked.op, log: result.log });
    batch.touched.push(...result.touched);
    if (result.global) batch.global = true;
  }

  async #runCommit(batch: Batch): Promise<void> {
    const write: BatchWrite = {
      ops: batch.ops,
      watermarks: [...batch.watermarks].map(([key, n]) => {
        const wm = this.#watermarks.get(key)!;
        return { sessionId: wm.sessionId, clientId: wm.clientId, n };
      }),
      ...(batch.state.meta.name !== batch.before.meta.name ? { name: batch.state.meta.name } : {}),
      receipts: batch.receipts.map((r) => ({
        memberId: r.memberId,
        tag: r.tag,
        part: r.part,
        state: r.state,
        seq: r.seq ?? null,
        code: r.code ?? null,
        message: r.message ?? null,
        at: new Date(r.at).toISOString(),
      })),
    };
    let attempt = 0;
    // Once a COMMIT's answer is lost, the batch may be durable, so nothing is
    // written again until a read says whether it is. A failed read proves
    // nothing either way: writing on a guess would hit the batch's own rows
    // and fail on their keys forever. So the read is retried with the same
    // backoff until it answers.
    let outcomeUnknown = false;
    for (;;) {
      try {
        if (outcomeUnknown) {
          if (await batchCommitted(this.#pool, this.roomId, write)) {
            this.#log.warn({ roomId: this.roomId, seq: batch.seq }, "commit answer lost, batch found committed");
            break;
          }
          outcomeUnknown = false;
        }
        await commitBatch(this.#pool, this.roomId, write);
        break;
      } catch (err) {
        if (err instanceof CommitOutcomeUnknown) outcomeUnknown = true;
        if (this.#closed) {
          this.#abandon(batch, err);
          return;
        }
        this.retrying = true;
        this.#log.warn({ err, roomId: this.roomId, attempt, outcomeUnknown }, outcomeUnknown ? "batch outcome unknown, reading it back" : "batch commit failed, retrying");
        await sleep(Math.min(this.#opts.retryMaxMs, this.#opts.retryBaseMs * 2 ** attempt));
        attempt++;
      }
    }
    this.retrying = false;
    this.#committed = { state: batch.state, seq: batch.seq };
    this.#receipts.committed(batch.receipts);
    for (const [key, n] of batch.watermarks) {
      const wm = this.#watermarks.get(key);
      if (wm && wm.committed < n) wm.committed = n;
    }
    if (batch.ops.length > 0) this.#opsSinceSnapshot += batch.ops.length;
    publishBatch(
      {
        seq: batch.seq,
        before: batch.before,
        after: batch.state,
        touched: batch.touched,
        global: batch.global,
        acks: batch.acks,
        rejects: batch.rejects,
        restored: batch.restored,
        trapped: batch.trapped,
        stamped: batch.stamped,
      },
      this.#connections,
      (key) => this.#clients.get(key),
    );
    for (const s of batch.sys) s.resolve();
    for (const h of batch.hellos) {
      if (!h.conn.closed && this.#clients.get(h.key) === h.conn && h.conn.held === null) this.#snapshot(h.conn, h.key);
    }
    this.#resyncOrphanedDms();
    if (batch.ops.length > 0) this.#scheduleSnapshot();
    // The queue waited for this commit and resumes now.
    this.#inFlight = null;
    this.#inFlightDone = null;
    this.#drain();
  }

  /** A batch that could not commit while the room was shutting down. Its clients still hold those ops and resend them. */
  #abandon(batch: Batch, err: unknown): void {
    this.retrying = false;
    this.#log.error({ err, roomId: this.roomId, ops: batch.ops.length }, "batch abandoned at shutdown");
    this.#staged = this.#committed;
    // The batch's receipts go with it and give back their slots (docs/design-v1-dice.md 1.2). Their clients resend the ops.
    this.#receipts.abandoned(batch.receipts);
    for (const s of batch.sys) s.reject(new ActorClosedError(this.roomId));
    this.#inFlight = null;
    this.#inFlightDone = null;
  }

  /** A DM whose scene was deleted under them gets a fresh hello, which lands on the player scene. */
  #resyncOrphanedDms(): void {
    for (const conn of this.#connections) {
      if (conn.role === "dm" && conn.held !== null && conn.sceneId !== null && !this.#committed.state.scenes[conn.sceneId]) {
        conn.sceneId = null;
        this.#resync(conn, "scene deleted");
      }
    }
  }

  // Snapshots (design 16.2).

  #scheduleSnapshot(): void {
    if (this.replayFailed || this.#closed) return;
    if (this.#opsSinceSnapshot >= this.#opts.snapshotOps) {
      void this.#writeSnapshot();
      return;
    }
    if (this.#opsSinceSnapshot > 0 && !this.#snapshotTimer) {
      this.#snapshotTimer = setTimeout(() => {
        this.#snapshotTimer = null;
        void this.#writeSnapshot();
      }, this.#opts.snapshotIdleMs);
    }
  }

  #writeSnapshot(): Promise<void> {
    if (this.#snapshotting) return this.#snapshotting;
    if (this.replayFailed) return Promise.resolve();
    const { state, seq } = this.#committed;
    if (seq <= this.#snapshotSeq) return Promise.resolve();
    this.#snapshotting = (async () => {
      try {
        const bytes = await writeSnapshot(this.#pool, this.roomId, seq, state);
        this.#snapshotSeq = seq;
        this.#opsSinceSnapshot = this.#committed.seq - seq;
        this.#sizes.stateMeasured(measuredFromStored(bytes, state));
        await this.#checkQuota();
      } catch (err) {
        this.#log.error({ err, roomId: this.roomId, seq }, "snapshot write failed");
      } finally {
        this.#snapshotting = null;
      }
    })();
    return this.#snapshotting.then(() => {
      if (!this.#closed && this.#opsSinceSnapshot >= this.#opts.snapshotOps) this.#scheduleSnapshot();
      this.#maybeIdle();
    });
  }

  /** A room at its storage quota becomes read-only except for deletions (design 10.5), and recovers when it shrinks. */
  async #checkQuota(): Promise<void> {
    if (this.#opts.quotaBytes <= 0 || this.replayFailed) return;
    const stored = await roomStoredBytes(this.#pool as Parameters<typeof roomStoredBytes>[0], this.roomId);
    const over = stored >= this.#opts.quotaBytes;
    if (over !== this.readOnly) {
      this.readOnly = over;
      await setReadOnly(this.#pool, this.roomId, over);
      this.#log.info({ roomId: this.roomId, stored }, over ? "room reached its quota, now read-only" : "room back under its quota");
    }
  }

  // Presence and grants.

  /** Members with a socket open. A table display is no member, so it is never listed (docs/design-v1-dm-tools.md 3.1). */
  #online(): string[] {
    const ids = new Set<string>();
    for (const conn of this.#connections) if (!conn.closed && !conn.display) ids.add(conn.memberId);
    return [...ids].sort();
  }

  #displayCount(): number {
    let n = 0;
    for (const conn of this.#connections) if (!conn.closed && conn.display && this.#shownDisplays.has(conn)) n++;
    return n;
  }

  /** DM sockets also learn how many table displays are open, so a DM device sends its camera only while one is. */
  #presenceFor(conn: Connection, online: string[], displays: number): Extract<ServerMessage, { t: "presence" }> {
    return conn.role === "dm" ? { t: "presence", online, displays } : { t: "presence", online };
  }

  #broadcastPresence(except?: Connection): void {
    const online = this.#online();
    const displays = this.#displayCount();
    for (const conn of this.#connections) {
      if (conn !== except && conn.held !== null) conn.send(this.#presenceFor(conn, online, displays));
    }
  }

  async #recheckGrants(): Promise<void> {
    if (this.#closed) return;
    for (const conn of [...this.#connections]) {
      if (conn.closed) continue;
      if (conn.display) {
        await this.#recheckDisplay(conn);
        continue;
      }
      let grant: Awaited<ReturnType<typeof checkGrant>>;
      try {
        grant = await checkGrant(this.#pool as Parameters<typeof checkGrant>[0], this.#gateway, conn.sessionId, this.roomId);
      } catch (err) {
        this.#log.warn({ err, roomId: this.roomId }, "grant recheck failed");
        continue;
      }
      if (conn.closed) continue;
      if (!grant) {
        conn.close(CLOSE.grantRevoked);
        continue;
      }
      if (grant.memberId !== conn.memberId || grant.role !== conn.role) {
        conn.memberId = grant.memberId;
        conn.role = grant.role;
        this.#resync(conn, "role");
      }
    }
    await this.reconcileKinds();
  }

  /**
   * A table display (docs/design-v1-dm-tools.md 3.1) closes with 4001 when
   * its grant is gone or stale or its session was deleted or expired, and
   * otherwise renews its session, so a connected display never expires.
   */
  async #recheckDisplay(conn: Connection): Promise<void> {
    try {
      const grant = await checkDisplayGrant(this.#pool, this.#gateway, conn.sessionId, this.roomId);
      if (conn.closed) return;
      if (!grant) {
        conn.close(CLOSE.grantRevoked);
        return;
      }
      await renewOpenDisplay(this.#pool, conn.sessionId);
    } catch (err) {
      this.#log.warn({ err, roomId: this.roomId }, "display recheck failed");
    }
  }

  #maybeIdle(): void {
    if (!this.#closed && this.idle) this.#onIdle?.(this);
  }
}

function push<T>(map: Map<ClientKey, T[]>, key: ClientKey, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Server-built ops skip `clientOpSchema`, but replay checks every stored op
 * against the protocol schema (design 16.2). One that does not match would
 * apply now and stop the room's next load, leaving it read-only. Checking
 * here refuses it while that refusal is still cheap.
 */
function checkServerOp(op: ServerOnlyOp): { ok: true; op: ServerOnlyOp } | { ok: false; message: string } {
  const parsed = serverOnlyOpSchema.safeParse(op);
  if (parsed.success) return { ok: true, op: parsed.data };
  return { ok: false, message: `server op ${op.t} does not validate: ${parsed.error.issues[0]?.message ?? "invalid"}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `scene.setMap`, `scene.create` and a phase list carry the map's
 * canonical size, and a handout's pages each page's, which only the asset
 * row knows (design 5). The row's
 * values replace whatever the client sent, before authorization sees the
 * op. An asset the room cannot use keeps the client's numbers, and
 * authorization refuses it.
 */
function withAssetSizes(op: Op, facts: Map<string, AssetFact>): Op {
  // A handout's page sizes lay out the viewer before any image loads (docs/design-v1-pdf-handouts.md 3.1).
  if (op.t === "handout.show" && "pages" in op.handout) return { ...op, handout: { ...op.handout, pages: pagesWithSizes(op.handout.pages, facts) } };
  if (op.t === "handoutDoc.create") return { ...op, doc: { ...op.doc, pages: pagesWithSizes(op.doc.pages, facts) } };
  // A phase's size decides its grid, so it comes from the asset row too (docs/design-v1-maps-vision.md 3.4).
  if (op.t === "scene.update" && op.patch.phases) {
    const phases = op.patch.phases.map((phase) => {
      const fact = facts.get(phase.assetId.toLowerCase());
      return fact && fact.kind === "map" ? { ...phase, widthPx: fact.width, heightPx: fact.height } : phase;
    });
    return { ...op, patch: { ...op.patch, phases } };
  }
  if (op.t === "scene.setMap" && op.map) {
    const fact = facts.get(op.map.assetId.toLowerCase());
    if (fact && fact.kind === "map") return { ...op, map: { ...op.map, widthPx: fact.width, heightPx: fact.height } };
  }
  if (op.t === "scene.create" && op.scene.map) {
    const fact = facts.get(op.scene.map.assetId.toLowerCase());
    if (fact && fact.kind === "map") return { ...op, scene: { ...op.scene, map: { ...op.scene.map, widthPx: fact.width, heightPx: fact.height } } };
  }
  return op;
}

/** Each page's size from its asset row, where the row is a handout image. */
function pagesWithSizes(pages: HandoutPage[], facts: Map<string, AssetFact>): HandoutPage[] {
  return pages.map((page) => {
    const fact = facts.get(page.assetId.toLowerCase());
    return fact && fact.kind === "handout" ? { ...page, width: fact.width, height: fact.height } : page;
  });
}

/**
 * The scenes whose walls an op may have changed, for the split's counting
 * pass. Every op that writes geometry moves its scene's walls version
 * (build ops, automatic walls, and restores of either), and a new scene
 * (a duplicate) brings its chunks with it.
 */
/** The trap ids among an op's touched keys. */
function trapsTouched(touched: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of touched) if (key.startsWith("trap:")) out.push(key.slice(5));
  return out;
}

function wallsMoved(before: RoomState, after: RoomState): string[] {
  if (before.scenes === after.scenes) return [];
  const out: string[] = [];
  for (const [id, scene] of Object.entries(after.scenes)) {
    const was = before.scenes[id];
    if (!was || was.wallsVersion !== scene.wallsVersion) out.push(id);
  }
  return out;
}

/** The scenes whose per-scene limits an op can push, for checkLimits (design 10.5). */
function scenesOf(op: Op, before: RoomState, after: RoomState): string[] {
  const out = new Set<string>();
  const tokenScene = (id: string) => {
    const t = before.tokens[id] ?? after.tokens[id];
    if (t) out.add(t.sceneId);
  };
  switch (op.t) {
    case "scene.create":
      out.add(op.scene.id);
      break;
    case "scene.update":
    case "scene.setMap":
    case "scene.setGrid":
    case "scene.setPhase":
    case "drawing.clear":
    case "fog.draft":
    case "fog.publish":
    case "fog.discard":
    case "fog.live":
    case "fog.reset":
    case "build.paint":
    case "build.erase":
    case "build.rect":
    case "build.poly":
    case "build.edge":
    case "build.label":
    case "build.clear":
    case "build.walls":
    case "build.stamps":
    case "build.lights":
    case "build.height":
    case "build.stairs":
    case "build.rough":
    case "door.set":
      out.add(op.sceneId);
      break;
    case "scene.duplicate":
      // Only the copy's counts are new. The scenes after the original move in the order and change nothing else.
      out.add(op.newSceneId);
      break;
    case "token.create":
      out.add(op.token.sceneId);
      break;
    case "token.update":
      tokenScene(op.tokenId);
      if (op.patch.sceneId !== undefined) out.add(op.patch.sceneId);
      break;
    case "token.move":
      tokenScene(op.tokenId);
      break;
    case "token.moveMany":
      for (const m of op.moves) tokenScene(m.tokenId);
      break;
    // Wave 5: a group edit can grow every scene it names a token on, and a pin counts on its scene.
    case "token.updateMany":
      for (const id of op.tokenIds) tokenScene(id);
      break;
    case "pin.put":
      out.add(op.pin.sceneId);
      break;
    case "template.create":
      out.add(op.template.sceneId);
      break;
    case "template.update": {
      const t = before.templates[op.templateId];
      if (t) out.add(t.sceneId);
      break;
    }
    case "drawing.create":
      out.add(op.drawing.sceneId);
      break;
    case "sys.restore":
      for (const entry of op.entries) {
        const parsed = parseKey(entry.key);
        if (!parsed) continue;
        if (parsed.kind === "chunk" || parsed.kind === "fog" || parsed.kind === "fogDraft") out.add(parsed.sceneId);
        else if (parsed.kind === "scene") out.add(parsed.id);
        else if (
          parsed.kind === "token" ||
          parsed.kind === "template" ||
          parsed.kind === "drawing" ||
          parsed.kind === "label" ||
          parsed.kind === "stamp" ||
          parsed.kind === "light" ||
          parsed.kind === "pin" ||
          parsed.kind === "trap"
        ) {
          const restored = entry.value as { sceneId?: string } | null | undefined;
          if (restored?.sceneId) out.add(restored.sceneId);
          const current = readEntity(after, entry.key) as { sceneId?: string } | null;
          if (current?.sceneId) out.add(current.sceneId);
        }
      }
      break;
    default:
      break;
  }
  return [...out];
}
