import type pg from "pg";
import { LIMITS } from "#shared/limits.ts";
import { ActorClosedError, RoomActor, type ActorOptions, type DeletionRun, type Logger } from "./actor.ts";
import { ActorGateway } from "./actorGateway.ts";
import { SnapshotBudget, type Clock, type SnapshotBudgetLimits } from "./budgets.ts";
import { CloseWrites } from "./closeWrites.ts";
import { CLOSE } from "./connection.ts";
import { TooBusyError } from "./errors.ts";
import { RoomNotFoundError } from "./gateway.ts";

export { TooBusyError } from "./errors.ts";
import { pruneIds } from "./createIds.ts";
import { pruneReceipts, pruneWatermarks, roomInfo, type RoomInfo } from "./persistence.ts";

/**
 * Loads rooms on demand, once each, and unloads them when idle or to make
 * space (design 10.5 and 16.2).
 *
 * The eviction rule keeps two idle rooms from taking turns evicting each
 * other: only a room loaded for at least ten minutes with no op for ten
 * minutes may be evicted, oldest first, and a pinned room is never evicted.
 * When nothing qualifies the load is refused and the caller's socket closes
 * with 4011. A pinned room that must load may evict the oldest unpinned
 * room whatever its age, so a pinned room's table always gets in.
 */
export type ManagerOptions = {
  maxLoaded: number;
  maxPerCreatorIp: number;
  minLoadedMs: number;
  minIdleMs: number;
  /** How long a room with no sockets and nothing to do stays loaded. */
  idleUnloadMs: number;
  /** How long close() waits for actors to finish and write snapshots: 18 s, so the stop's other steps fit in its 25 s (design 15.4). */
  closeTimeoutMs: number;
  snapshotBudget: Partial<SnapshotBudgetLimits>;
  actor: Partial<ActorOptions>;
  now: Clock;
};

export const DEFAULT_MANAGER_OPTIONS: ManagerOptions = {
  maxLoaded: LIMITS.loadedRooms,
  maxPerCreatorIp: LIMITS.loadedRoomsPerCreatorIp,
  minLoadedMs: 10 * 60_000,
  minIdleMs: 10 * 60_000,
  idleUnloadMs: 60_000,
  closeTimeoutMs: 18_000,
  snapshotBudget: {},
  actor: {},
  now: Date.now,
};

type Entry = {
  roomId: string;
  loading: Promise<RoomActor>;
  actor: RoomActor | null;
  loadedAt: number;
  pinned: boolean;
  createdIp: string | null;
  unloading: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  /** Whether its unload writes a snapshot, as a shutdown's and an eviction's do and a delete's does not. */
  saves: boolean;
  /** Whether its unload threw, which the unload logs and gets past. */
  failed: boolean;
};

/** A room the shutdown cannot show saved, and why (server/shutdown.ts names each). */
export type UnsavedRoom = { roomId: string; why: "unload failed" | "snapshot not written" | "delete failed" | "timed out" | "not checked" };

/**
 * A room's deletion, from its unload to the database's answer. Its unload
 * writes no snapshot, so until the row is gone the room is unsaved at its
 * last commit, `lastSeq`, once the unload has read it (null when nothing
 * was loaded to save).
 */
type Deletion = { done: Promise<void>; lastSeq: number | null };

const DAY_MS = 24 * 60 * 60_000;

/** The commit a room's snapshot should hold once it leaves memory, or null when it holds nothing to save: never loaded, or a replay that failed, which is never snapshotted by design. */
function savedSeqOf(entry: Entry): number | null {
  return entry.actor && !entry.actor.replayFailed ? entry.actor.committed.seq : null;
}

/**
 * A deletion of asset rows for one room (docs/design/design-v1-dm-tools.md 3.19),
 * in the form each state of the room needs.
 */
export type DeletionStep<T> = {
  /**
   * The room is loaded: runs on its actor's queue once the batch being
   * staged has committed, with the committed state (RoomActor.deletionStep),
   * and returns the asset ids whose rows it deleted.
   */
  loaded: DeletionRun<T>;
  /** The room is not loaded: runs under the room's lock, which a load waits for, so the room cannot load halfway through. */
  unloaded: () => Promise<T>;
};

export class RoomManager {
  readonly gateway: ActorGateway;
  readonly budget: SnapshotBudget;
  readonly options: ManagerOptions;
  /** What closing sockets still write, which shutdown waits for before the pool ends (server/shutdown.ts). */
  readonly closeWrites = new CloseWrites();
  #pool: pg.Pool;
  #log: Logger;
  #entries = new Map<string, Entry>();
  /**
   * Per-room locks. A load waits for one before it creates its entry, so
   * work under the lock on a room that is not loaded (a deletion step, the
   * admin page's pin) never overlaps the room's loading.
   */
  #locks = new Map<string, Promise<void>>();
  #closing = false;
  #unsavedAtClose: readonly UnsavedRoom[] | null = null;
  #deletions = new Map<string, Deletion>();
  #pruneTimer: NodeJS.Timeout;
  #deleteListeners: Array<(roomId: string) => void> = [];

  constructor(deps: { pool: pg.Pool; log: Logger; options?: Partial<ManagerOptions> }) {
    this.#pool = deps.pool;
    this.#log = deps.log;
    this.options = { ...DEFAULT_MANAGER_OPTIONS, ...deps.options };
    this.budget = new SnapshotBudget(this.options.snapshotBudget, this.options.now);
    this.gateway = new ActorGateway(this, deps.pool);
    this.#pruneTimer = setInterval(() => void this.prune(), DAY_MS);
    this.#pruneTimer.unref();
  }

  get loadedRoomIds(): string[] {
    return [...this.#entries.values()].filter((e) => !e.unloading).map((e) => e.roomId);
  }

  /** The room's actor if it is loaded right now, without loading it. */
  get(roomId: string): RoomActor | null {
    const entry = this.#entries.get(roomId);
    return entry && !entry.unloading && entry.actor && !entry.actor.closed ? entry.actor : null;
  }

  /** True while any room is retrying a commit (design 7.2): `/healthz` reports it as degraded. */
  degraded(): boolean {
    for (const entry of this.#entries.values()) if (entry.actor?.retrying) return true;
    return false;
  }

  /**
   * The loaded actor, loading the room when needed. Throws RoomNotFoundError
   * when the room has no row or no snapshot, and TooBusyError when nothing
   * can be unloaded to make space.
   */
  async acquire(roomId: string): Promise<RoomActor> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.#closing) throw new TooBusyError();
      const existing = this.#entries.get(roomId);
      if (existing) {
        if (existing.unloading) {
          await existing.unloading.catch(() => undefined);
          continue;
        }
        const actor = await existing.loading;
        if (!actor.closed) return actor;
        continue;
      }
      const info = await roomInfo(this.#pool, roomId);
      if (!info) throw new RoomNotFoundError(roomId);
      // Checked and the entry created in one synchronous step, so a lock
      // taken meanwhile is always seen. The row is read again after it,
      // since what ran under the lock may have changed it. Waiting is not
      // an attempt.
      const lock = this.#locks.get(roomId);
      if (lock) {
        await lock;
        attempt--;
        continue;
      }
      if (this.#entries.has(roomId)) continue;
      return this.#load(info).loading;
    }
    throw new TooBusyError();
  }

  /**
   * Runs `fn` holding the room's lock. A load waits for the lock before it
   * creates its entry, so a room not loaded when `fn` starts stays unloaded
   * until it ends. A room already loaded is not stopped by it.
   */
  async withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    for (let held = this.#locks.get(roomId); held; held = this.#locks.get(roomId)) await held;
    let release!: () => void;
    this.#locks.set(roomId, new Promise<void>((resolve) => (release = resolve)));
    try {
      return await fn();
    } finally {
      this.#locks.delete(roomId);
      release();
    }
  }

  /**
   * A deletion step for one room (docs/design/design-v1-dm-tools.md 3.19): on its
   * actor's queue when it is loaded, otherwise under the room's lock. A
   * room that unloads or loads while the step waits is looked at again, so
   * the step always runs in the form the room's state needs.
   */
  async deletionStep<T>(roomId: string, step: DeletionStep<T>): Promise<T> {
    for (;;) {
      const entry = this.#entries.get(roomId);
      if (entry) {
        if (entry.unloading) {
          await entry.unloading.catch(() => undefined);
          continue;
        }
        const actor = await entry.loading.catch(() => null);
        if (!actor || actor.closed) {
          await (entry.unloading ?? Promise.resolve()).catch(() => undefined);
          if (this.#entries.get(roomId) === entry && !entry.unloading) await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        try {
          return await actor.deletionStep(step.loaded);
        } catch (err) {
          if (err instanceof ActorClosedError) continue;
          throw err;
        }
      }
      const outcome = await this.withRoomLock(roomId, async () =>
        // Loaded while the lock was awaited: the actor's form, outside the lock.
        this.#entries.has(roomId) ? { again: true as const } : { again: false as const, result: await step.unloaded() },
      );
      if (!outcome.again) return outcome.result;
    }
  }

  /**
   * The admin page's pin (docs/design/design-v1-dm-tools.md 3.18): the row, and
   * the loaded room at once, so a pinned room is never evicted from that
   * moment. Under the room's lock, so a load that read the row before the
   * change cannot create the room with the old value. False when there is
   * no such room.
   */
  async setPinned(roomId: string, pinned: boolean): Promise<boolean> {
    return this.withRoomLock(roomId, async () => {
      const result = await this.#pool.query("update rooms set pinned = $2 where id = $1", [roomId, pinned]);
      if (result.rowCount !== 1) return false;
      const entry = this.#entries.get(roomId);
      if (entry) {
        entry.pinned = pinned;
        if (entry.actor) entry.actor.pinned = pinned;
        else
          void entry.loading.then(
            (actor) => {
              actor.pinned = pinned;
            },
            () => undefined,
          );
      }
      return true;
    });
  }

  /** Runs `fn` against the loaded actor, loading once more if the room unloaded underneath it. */
  async withRoom<T>(roomId: string, fn: (actor: RoomActor) => Promise<T> | T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const actor = await this.acquire(roomId);
      try {
        return await fn(actor);
      } catch (err) {
        if (err instanceof ActorClosedError && attempt < 2) continue;
        throw err;
      }
    }
  }

  closeAllSockets(code: number): void {
    for (const entry of this.#entries.values()) entry.actor?.closeSockets({ all: true }, code);
  }

  /** Called as a room is about to be deleted, loaded or not, so work reading it outside the actor (archive scans) stops. */
  onDelete(listener: (roomId: string) => void): void {
    this.#deleteListeners.push(listener);
  }

  /**
   * A room's deletion (the gateway's): `remove` unloads it through
   * unloadForDelete and deletes its row. It is kept until the database
   * answers, so a shutdown meanwhile tells a deleted room from one left
   * unsaved by a delete that failed or never ran (close()).
   */
  async deleting<T>(roomId: string, remove: () => Promise<T>): Promise<T> {
    let settle!: () => void;
    const deletion: Deletion = { done: new Promise<void>((resolve) => (settle = resolve)), lastSeq: null };
    this.#deletions.set(roomId, deletion);
    try {
      return await remove();
    } finally {
      settle();
      if (this.#deletions.get(roomId) === deletion) this.#deletions.delete(roomId);
    }
  }

  /** Closes the room's sockets with 4009 and drops it from memory without a snapshot, ahead of deleting its rows. */
  async unloadForDelete(roomId: string): Promise<void> {
    for (const listener of this.#deleteListeners) listener(roomId);
    const entry = this.#entries.get(roomId);
    if (!entry) return;
    await (entry.unloading ?? this.#unload(entry, { code: CLOSE.roomClosed, snapshot: false }));
    const deletion = this.#deletions.get(roomId);
    if (deletion) deletion.lastSeq = savedSeqOf(entry);
  }

  /** Unloads one room on request (tests and the admin tools). Without the snapshot it behaves like a crash. */
  async unload(roomId: string, code: number = CLOSE.evicted, snapshot = true): Promise<void> {
    const entry = this.#entries.get(roomId);
    if (!entry) return;
    if (entry.unloading) {
      await entry.unloading.catch(() => undefined);
      return;
    }
    await this.#unload(entry, { code, snapshot, flush: snapshot });
  }

  /**
   * Shutdown (design 15.4): sockets already closed with 1012 by the socket
   * layer, actors finish and write snapshots, bounded in time. It resolves
   * with every room it cannot show saved and never rejects, so one room's
   * failure stops no other room's snapshot, and the stop names them all and
   * exits 1 (server/shutdown.ts). An actor logs a snapshot write that fails
   * and goes on, so a room counts as saved only once its stored snapshot
   * reads its last commit, or once its row is gone, deleted on purpose. A
   * room being deleted is checked after the database answers its delete,
   * loaded or not, so a delete that fails leaves it unsaved.
   */
  async close(): Promise<readonly UnsavedRoom[]> {
    this.#closing = true;
    clearInterval(this.#pruneTimer);
    const entries = new Map([...this.#entries.values()].map((entry) => [entry.roomId, entry]));
    const roomIds = new Set([...entries.keys(), ...this.#deletions.keys()]);
    const checked = new Map<string, UnsavedRoom["why"] | null>();
    const work = Promise.all(
      [...roomIds].map(async (roomId) => {
        const entry = entries.get(roomId);
        if (entry) await (entry.unloading ?? this.#unload(entry, { code: CLOSE.restarting, snapshot: true }));
        // Read after the unload: a delete may begin while the stop unloads the room, and waits for that unload.
        const deletion = this.#deletions.get(roomId);
        if (deletion) await deletion.done;
        const lastSeq = deletion ? (entry ? savedSeqOf(entry) : deletion.lastSeq) : entry?.saves ? savedSeqOf(entry) : null;
        checked.set(roomId, await this.#unsavedWhy(roomId, lastSeq, { failed: entry?.failed ?? false, deleting: deletion !== undefined }));
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.options.closeTimeoutMs);
    });
    if ((await Promise.race([work, deadline])) === "late") this.#log.error({ rooms: roomIds.size - checked.size }, "room shutdown did not finish in time");
    clearTimeout(timer);
    // A room still loading or being deleted at the deadline would have been saved or gone by now, so it counts too.
    const unsaved = [...roomIds].flatMap((roomId): UnsavedRoom[] => {
      const entry = entries.get(roomId);
      const late = (entry?.saves ?? false) || this.#deletions.has(roomId);
      const why = checked.has(roomId) ? checked.get(roomId) : late ? "timed out" : null;
      return why ? [{ roomId, why }] : [];
    });
    if (unsaved.length > 0) this.#log.error({ rooms: unsaved }, "rooms not saved at shutdown");
    this.#unsavedAtClose = unsaved;
    return unsaved;
  }

  /** What the last close() could not show saved, or null before it has finished. */
  get unsavedAtClose(): readonly UnsavedRoom[] | null {
    return this.#unsavedAtClose;
  }

  /**
   * Why a room the stop has done with is not saved at `lastSeq`, its last
   * commit, or null when it is, when its row is gone, or when there is
   * nothing to save (`lastSeq` null).
   */
  async #unsavedWhy(roomId: string, lastSeq: number | null, how: { failed: boolean; deleting: boolean }): Promise<UnsavedRoom["why"] | null> {
    if (lastSeq === null) return null;
    try {
      const { rows } = await this.#pool.query<{ room: boolean; seq: string | null }>(
        "select exists (select 1 from rooms where id = $1) as room, (select seq::text from room_snapshots where room_id = $1) as seq",
        [roomId],
      );
      const row = rows[0];
      if (!row?.room) {
        this.#log.info({ roomId }, "room deleted during shutdown");
        return null;
      }
      if (how.failed) return "unload failed";
      if (Number(row.seq ?? 0) >= lastSeq) return null;
      return how.deleting ? "delete failed" : "snapshot not written";
    } catch (err) {
      this.#log.error({ err, roomId }, "room snapshot could not be checked at shutdown");
      return "not checked";
    }
  }

  #load(info: RoomInfo): Entry {
    const now = this.options.now();
    const active = [...this.#entries.values()].filter((e) => !e.unloading);
    if (active.length >= this.options.maxLoaded) this.#evictOne(active, info.pinned);
    if (info.createdIp !== null) {
      const sameIp = active.filter((e) => e.createdIp === info.createdIp && !e.unloading);
      if (sameIp.length >= this.options.maxPerCreatorIp) this.#evictOne(sameIp, info.pinned);
    }
    const entry: Entry = {
      roomId: info.roomId,
      loading: Promise.reject(new Error("unset")),
      actor: null,
      loadedAt: now,
      pinned: info.pinned,
      createdIp: info.createdIp,
      unloading: null,
      idleTimer: null,
      saves: false,
      failed: false,
    };
    entry.loading.catch(() => undefined);
    entry.loading = RoomActor.load({
      pool: this.#pool,
      info,
      log: this.#log,
      budget: this.budget,
      gateway: this.gateway,
      options: this.options.actor,
      onIdle: (actor) => this.#onIdle(entry, actor),
      closeWrites: this.closeWrites,
    })
      .then((actor) => {
        if (!actor) throw new RoomNotFoundError(info.roomId);
        entry.actor = actor;
        this.#log.info({ roomId: info.roomId, seq: actor.committed.seq, readOnly: actor.readOnly }, "room loaded");
        // A room nobody connects to after loading still has to leave memory eventually.
        this.#onIdle(entry, actor);
        return actor;
      })
      .catch((err: unknown) => {
        if (this.#entries.get(info.roomId) === entry) this.#entries.delete(info.roomId);
        throw err;
      });
    this.#entries.set(info.roomId, entry);
    return entry;
  }

  /** Picks and evicts one room from `candidates` under the design 10.5 rule, or throws TooBusyError. */
  #evictOne(candidates: Entry[], forPinned: boolean): void {
    const now = this.options.now();
    const loaded = candidates.filter((e) => e.actor !== null && !e.pinned && !e.unloading);
    const eligible = forPinned
      ? loaded
      : loaded.filter((e) => now - e.loadedAt >= this.options.minLoadedMs && now - e.actor!.lastOpAt >= this.options.minIdleMs);
    eligible.sort((a, b) => a.loadedAt - b.loadedAt);
    const victim = eligible[0];
    if (!victim) throw new TooBusyError();
    this.#log.info({ roomId: victim.roomId, forPinned }, "unloading a room to make space");
    void this.#unload(victim, { code: CLOSE.evicted, snapshot: true });
  }

  #unload(entry: Entry, opts: { code: number; snapshot: boolean; flush?: boolean }): Promise<void> {
    if (entry.unloading) return entry.unloading;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.saves = opts.snapshot;
    entry.unloading = (async () => {
      try {
        const actor = await entry.loading.catch(() => null);
        if (actor) await actor.shutdown(opts);
      } catch (err) {
        entry.failed = true;
        this.#log.error({ err, roomId: entry.roomId }, "room unload failed");
      } finally {
        if (this.#entries.get(entry.roomId) === entry) this.#entries.delete(entry.roomId);
      }
    })();
    return entry.unloading;
  }

  #onIdle(entry: Entry, actor: RoomActor): void {
    if (entry.unloading || entry.idleTimer || this.#closing) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (!entry.unloading && actor.idle) void this.#unload(entry, { code: CLOSE.evicted, snapshot: true });
    }, this.options.idleUnloadMs);
  }

  /** The daily cleanup of rows past their use, of every room, loaded or not. */
  async prune(): Promise<void> {
    try {
      const n = await pruneWatermarks(this.#pool);
      if (n > 0) this.#log.info({ rows: n }, "pruned stale client watermarks");
    } catch (err) {
      this.#log.warn({ err }, "watermark prune failed");
    }
    try {
      const n = await pruneReceipts(this.#pool);
      if (n > 0) this.#log.info({ rows: n }, "pruned old roll receipts");
    } catch (err) {
      this.#log.warn({ err }, "receipt prune failed");
    }
    // A room loaded again prunes its own rows then, and one that never is keeps them until this.
    try {
      const n = await pruneIds(this.#pool, this.options.now());
      if (n > 0) this.#log.info({ rows: n }, "pruned old id rows");
    } catch (err) {
      this.#log.warn({ err }, "id row prune failed");
    }
  }
}
