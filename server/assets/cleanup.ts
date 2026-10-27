import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { LIMITS } from "#shared/limits.ts";
import type { MemoryChunk, RoomState } from "#shared/model.ts";
import type { ServerOnlyOp } from "#shared/protocol.ts";
import { referencedAssetIds } from "#shared/referencedAssets.ts";
import { ActorClosedError, SysOpRefused, type Logger, type RoomActor } from "../rooms/actor.ts";
import { TooBusyError } from "../rooms/errors.ts";
import { RoomNotFoundError } from "../rooms/gateway.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { isAssetKind, type AssetView } from "./kinds.ts";
import { roomStoredBytes } from "./quota.ts";
import { deleteUnreferencedFiles, purgeTrash, type FileKey } from "./store.ts";

/**
 * Cleanup of unused images (docs/design-v1-dm-tools.md 3.19).
 *
 * Every picker lists a room's images as its library, so an image the
 * room's state does not name may still be one the DM keeps for later. On
 * its own, cleanup therefore deletes only what no picker can reach: scene
 * thumbnails a day after their scene stopped naming them, and files no row
 * names. The DM deletes the rest from the library, where the listing marks
 * each image the state uses outside players' memory. An image only the
 * stamps players remember show is no use the DM can see or act on, so its
 * delete goes through and drops those stamps from every memory first
 * (decision D-261026-34, docs/design-v1-map-discovery.md 5.4).
 *
 * A row is deleted only inside one deletion step for its room
 * (RoomManager.deletionStep). On a loaded room the step runs on the actor's
 * queue against the committed state, after the batch being staged has
 * committed, and the actor drops any asset fact an op read before the
 * deletion. On a room that is not loaded it runs under the room's lock and
 * reads the stored snapshot and every op after it as text, where any
 * appearance of an image's id counts as a use, which can only keep too
 * much. Files go after their rows, into the trash, and only when no row in
 * any room names them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `<sha256>-<kind>-<variant>-v<pipeline>.webp`, the only names the orphan sweep ever touches. */
const VARIANT_FILE = /^([0-9a-f]{64})-([a-z]+)-([a-z]+)-v([1-9][0-9]{0,5})\.webp$/;
/** The two-character folders images live in. tmp, import and trash never match. */
const PREFIX_DIR = /^[0-9a-f]{2}$/;

export type CleanupDeps = {
  pool: pg.Pool;
  manager: RoomManager;
  assetDir: string;
  /** The room storage quota, for a room that is not loaded. 0 turns the read-only switch off, as it does for the actor. */
  quotaBytes: number;
  log: Logger;
};

type DeletedRow = { id: string; sha256: Buffer; kind: string; pipeline: number };

function fileKeys(rows: readonly DeletedRow[]): FileKey[] {
  const seen = new Map<string, FileKey>();
  for (const row of rows) {
    if (!isAssetKind(row.kind)) continue;
    seen.set(`${row.sha256.toString("hex")}-${row.kind}-${row.pipeline}`, { sha256: row.sha256, kind: row.kind, pipeline: row.pipeline });
  }
  return [...seen.values()];
}

/** Every image id the state names, in the lowercase the asset rows use, keeping only well-formed ids. */
function usedIds(state: RoomState): Set<string> {
  const out = new Set<string>();
  for (const id of referencedAssetIds(state)) {
    const lower = id.toLowerCase();
    if (UUID.test(lower)) out.add(lower);
  }
  return out;
}

/** The image ids the state names outside players' memory, the party's and every holder's: the uses the DM sees. */
function liveIds(state: RoomState): Set<string> {
  return usedIds({ ...state, memory: {}, memoryBy: {} });
}

/**
 * The ids among `ids` that the stored snapshot of a room that is not loaded,
 * or any op stored after it, mentions anywhere. Each text is lowercased once
 * and then searched for every id.
 */
export async function textScanUsed(pool: pg.Pool, roomId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ id: string }>(
    `with snap as (select seq from room_snapshots where room_id = $1),
       texts as materialized (
         select lower(s.state::text) as body from room_snapshots s where s.room_id = $1
         union all
         select lower(o.op::text) from room_ops o
         where o.room_id = $1 and o.seq > coalesce((select seq from snap), -1)
       )
     select x.id::text as id from unnest($2::uuid[]) as x(id)
     where exists (select 1 from texts t where strpos(t.body, x.id::text) > 0)`,
    [roomId, [...ids]],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * A room that is not loaded and went read-only at its quota takes edits
 * again once deletions bring it under, without waiting for an op and a
 * snapshot that may never come (design 10.5). A loaded room's actor makes
 * the same check itself after its deletion step. The caller holds the
 * room's lock.
 */
export async function recheckQuotaUnloaded(pool: pg.Pool, roomId: string, quotaBytes: number): Promise<boolean> {
  if (quotaBytes <= 0) return false;
  const { rows } = await pool.query<{ read_only: boolean }>("select read_only from rooms where id = $1", [roomId]);
  if (!rows[0]?.read_only) return false;
  const stored = await roomStoredBytes(pool, roomId);
  if (stored >= quotaBytes) return false;
  await pool.query("update rooms set read_only = false where id = $1", [roomId]);
  return true;
}

// The library ---------------------------------------------------------------

/**
 * A DM's library listing with each image's `bytes`, what deleting it frees
 * from the room's quota (all its variants, the row's own count), and
 * `inUse`, read from the committed state of the room, which a DM asking for
 * its library has loaded anyway. Every kind is marked: the state names maps,
 * handouts and thumbnails as well as token art. A stamp players remember
 * marks nothing, since its image can be deleted (deleteLibraryImages).
 * When the state cannot be known (the room cannot load now, or its replay
 * failed and its state is partial) the images carry no mark at all, so
 * nothing is offered for deletion on a guess.
 */
export async function withInUse(pool: pg.Pool, manager: RoomManager, roomId: string, assets: AssetView[]): Promise<AssetView[]> {
  const { rows } = await pool.query<{ id: string; bytes: string }>("select id::text as id, bytes from assets where room_id = $1", [roomId]);
  const sizes = new Map(rows.map((r) => [r.id, Number(r.bytes)]));
  const sized = assets.map((a) => {
    const bytes = sizes.get(a.id.toLowerCase());
    return bytes === undefined ? a : { ...a, bytes };
  });
  let state: RoomState;
  try {
    const actor = await manager.acquire(roomId);
    if (actor.replayFailed) return sized;
    state = actor.committed.state;
  } catch (err) {
    if (err instanceof TooBusyError || err instanceof RoomNotFoundError) return sized;
    throw err;
  }
  const used = liveIds(state);
  return sized.map((a) => ({ ...a, inUse: used.has(a.id.toLowerCase()) }));
}

export type LibraryDeletion =
  | { ok: true; deleted: string[] }
  | { ok: false; reason: "in_use"; inUse: string[] }
  | { ok: false; reason: "unknown" };

/**
 * Deletes images of the room that its state does not name, all or none: if
 * any of them is named when the step runs, nothing is deleted and the
 * answer lists the ones in use. The stamps players remember with these
 * images are dropped first (forgetRememberedImages), so an image only they
 * show is deleted. Ids that are not this room's rows are ignored. Files
 * follow their rows into the trash when no other room names them.
 */
export async function deleteLibraryImages(deps: CleanupDeps, roomId: string, requested: readonly string[]): Promise<LibraryDeletion> {
  const ids = [...new Set(requested.map((id) => id.toLowerCase()))].filter((id) => UUID.test(id));
  await forgetRememberedImages(deps, roomId, ids);
  type Outcome = { result: LibraryDeletion; rows: DeletedRow[] };
  const remove = async (used: ReadonlySet<string>): Promise<Outcome> => {
    const inUse = ids.filter((id) => used.has(id));
    if (inUse.length > 0) return { result: { ok: false, reason: "in_use", inUse }, rows: [] };
    const { rows } = await deps.pool.query<DeletedRow>(
      "delete from assets where room_id = $1 and id = any($2::uuid[]) returning id::text as id, sha256, kind, pipeline",
      [roomId, ids],
    );
    return { result: { ok: true, deleted: rows.map((r) => r.id) }, rows };
  };
  const outcome = await deps.manager.deletionStep<Outcome>(roomId, {
    loaded: async (state) => {
      // A room whose replay failed holds only part of its state, which could miss a use.
      if (deps.manager.get(roomId)?.replayFailed) return { deleted: [], result: { result: { ok: false, reason: "unknown" }, rows: [] } };
      const done = await remove(usedIds(state));
      return { deleted: done.rows.map((r) => r.id), result: done };
    },
    unloaded: async () => {
      const done = await remove(await textScanUsed(deps.pool, roomId, ids));
      if (done.rows.length > 0) await recheckQuotaUnloaded(deps.pool, roomId, deps.quotaBytes);
      return done;
    },
  });
  if (outcome.rows.length > 0) await removeFiles(deps, roomId, outcome.rows);
  return outcome.result;
}

/**
 * Drops from every memory of the room, the party's and each holder's, the
 * stamps players remember with these images (decision D-261026-34), as a
 * stamp made DM only drops from them (docs/design-v1-map-discovery.md 5.4):
 * one `sys.remember` per scene through the room's actor, stored and
 * replayed as any op, so a reload drops the same entries. Nothing drops
 * while a live use names any of them, since the deletion step then refuses
 * the whole delete and players keep what they remember.
 *
 * Only the actor writes memory, so a room that is not loaded is loaded,
 * but only when its stored memory or a later `sys.remember` mentions one of
 * the images, and a delete of anything else never loads it. Whatever stops
 * the drop (the room cannot load, its replay failed, the actor refused the
 * op or closed) leaves memory as it is. The deletion step's check counts
 * memory as a use, so the delete is then refused as in use, as it is when
 * a remembered stamp of the image is written again in between, rather than
 * deleting art a player still sees.
 */
async function forgetRememberedImages(deps: CleanupDeps, roomId: string, requested: readonly string[]): Promise<void> {
  if (requested.length === 0) return;
  const { rows } = await deps.pool.query<{ id: string }>("select id::text as id from assets where room_id = $1 and id = any($2::uuid[])", [roomId, requested]);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  let actor: RoomActor | null = deps.manager.get(roomId);
  if (!actor) {
    if ((await storedMemoryMentions(deps.pool, roomId, ids)).size === 0) return;
    try {
      actor = await deps.manager.acquire(roomId);
    } catch (err) {
      if (err instanceof TooBusyError || err instanceof RoomNotFoundError) return;
      throw err;
    }
  }
  if (actor.replayFailed) return;
  const state = actor.committed.state;
  const live = liveIds(state);
  if (ids.some((id) => live.has(id))) return;
  for (const op of forgetRememberedStamps(state, new Set(ids))) {
    try {
      await actor.sys(op);
    } catch (err) {
      if (err instanceof SysOpRefused || err instanceof ActorClosedError) return;
      throw err;
    }
  }
}

type RememberOp = Extract<ServerOnlyOp, { t: "sys.remember" }>;

/**
 * One `sys.remember` per scene that drops each remembered stamp whose art is
 * one of these images, from every layer that holds one: scenes in id order,
 * the party's layer before each holder's in id order, chunks in row order.
 */
export function forgetRememberedStamps(state: RoomState, ids: ReadonlySet<string>): RememberOp[] {
  const scenes = new Map<string, Map<string, RememberOp["layers"][number]>>();
  const visit = (chunk: MemoryChunk) => {
    const stamps = Object.entries(chunk.stamps ?? {})
      .filter(([, stamp]) => stamp !== null && "assetId" in stamp.art && ids.has(stamp.art.assetId.toLowerCase()))
      .map(([id]) => id)
      .sort();
    if (stamps.length === 0) return;
    let layers = scenes.get(chunk.sceneId);
    if (!layers) scenes.set(chunk.sceneId, (layers = new Map()));
    const owner = chunk.memberId ?? "";
    let layer = layers.get(owner);
    if (!layer) layers.set(owner, (layer = { ...(chunk.memberId !== undefined ? { memberId: chunk.memberId } : {}), chunks: [] }));
    layer.chunks.push({ cx: chunk.cx, cy: chunk.cy, drop: { stamps } });
  };
  for (const chunk of Object.values(state.memory ?? {})) visit(chunk);
  for (const chunk of Object.values(state.memoryBy ?? {})) visit(chunk);
  return [...scenes.keys()].sort().map((sceneId) => {
    const layers = scenes.get(sceneId)!;
    return {
      t: "sys.remember",
      sceneId,
      layers: [...layers.keys()].sort().map((owner) => {
        const layer = layers.get(owner)!;
        return { ...layer, chunks: layer.chunks.sort((a, b) => a.cy - b.cy || a.cx - b.cx) };
      }),
    };
  });
}

/**
 * The ids among `ids` that a room's stored memory may name: its snapshot's
 * `memory` and `memoryBy`, and any `sys.remember` stored after it, the only
 * op that writes a stamp into memory (a fold or a copy only moves what
 * memory holds already). Read as text, as textScanUsed reads, which can
 * only find too much.
 */
async function storedMemoryMentions(pool: pg.Pool, roomId: string, ids: readonly string[]): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `with snap as (select seq, state from room_snapshots where room_id = $1),
       texts as materialized (
         select lower(coalesce(s.state->'memory', 'null'::jsonb)::text || coalesce(s.state->'memoryBy', 'null'::jsonb)::text) as body from snap s
         union all
         select lower(o.op::text) from room_ops o
         where o.room_id = $1 and o.seq > coalesce((select seq from snap), -1) and o.op->>'t' = 'sys.remember'
       )
     select x.id::text as id from unnest($2::uuid[]) as x(id)
     where exists (select 1 from texts t where strpos(t.body, x.id::text) > 0)`,
    [roomId, [...ids]],
  );
  return new Set(rows.map((r) => r.id));
}

async function removeFiles(deps: CleanupDeps, roomId: string, rows: readonly DeletedRow[]): Promise<void> {
  await deleteUnreferencedFiles(deps.pool, deps.assetDir, fileKeys(rows)).catch((err: unknown) => {
    // The rows are gone, so the files belong to nobody now. The weekly
    // orphan sweep finds whatever this missed.
    deps.log.warn({ err, roomId }, "image rows deleted, but their files were not all moved to the trash");
  });
}

// Thumbnails ----------------------------------------------------------------

export type ThumbSweep = { marked: number; cleared: number; deleted: number; skipped: boolean };

/**
 * Marks the room's scene thumbnails its state does not name as unused since
 * now, clears the mark on any named again, and deletes those unused for a
 * day, rows and then files. Nothing restores an old thumbnail (a restore
 * keeps the current one), so nothing can need one back.
 */
export async function sweepThumbnails(deps: CleanupDeps, roomId: string): Promise<ThumbSweep> {
  type Outcome = { sweep: ThumbSweep; rows: DeletedRow[] };
  const apply = async (used: readonly string[]): Promise<Outcome> => {
    const cleared = await deps.pool.query(
      "update assets set unused_since = null where room_id = $1 and kind = 'thumb' and unused_since is not null and id = any($2::uuid[])",
      [roomId, used],
    );
    const marked = await deps.pool.query(
      "update assets set unused_since = now() where room_id = $1 and kind = 'thumb' and unused_since is null and not (id = any($2::uuid[]))",
      [roomId, used],
    );
    const { rows } = await deps.pool.query<DeletedRow>(
      `delete from assets
       where room_id = $1 and kind = 'thumb' and unused_since <= now() - make_interval(days => $3) and not (id = any($2::uuid[]))
       returning id::text as id, sha256, kind, pipeline`,
      [roomId, used, LIMITS.thumbUnusedDays],
    );
    return { sweep: { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0, deleted: rows.length, skipped: false }, rows };
  };
  const skipped: Outcome = { sweep: { marked: 0, cleared: 0, deleted: 0, skipped: true }, rows: [] };
  const outcome = await deps.manager.deletionStep<Outcome>(roomId, {
    loaded: async (state) => {
      if (deps.manager.get(roomId)?.replayFailed) return { deleted: [], result: skipped };
      const done = await apply([...usedIds(state)]);
      return { deleted: done.rows.map((r) => r.id), result: done };
    },
    unloaded: async () => {
      const { rows } = await deps.pool.query<{ id: string }>("select id::text as id from assets where room_id = $1 and kind = 'thumb'", [roomId]);
      if (rows.length === 0) return { sweep: { marked: 0, cleared: 0, deleted: 0, skipped: false }, rows: [] };
      const used = await textScanUsed(
        deps.pool,
        roomId,
        rows.map((r) => r.id),
      );
      const done = await apply([...used]);
      if (done.rows.length > 0) await recheckQuotaUnloaded(deps.pool, roomId, deps.quotaBytes);
      return done;
    },
  });
  if (outcome.rows.length > 0) await removeFiles(deps, roomId, outcome.rows);
  return outcome.sweep;
}

// Files no row names ----------------------------------------------------------

/**
 * Walks the image folders and moves to the trash each file named like an
 * asset variant whose (hash, kind, pipeline) no row in any room names and
 * which is more than a day old, so an upload between placing its file and
 * writing its row (another process's, such as the CLI's import) is never
 * caught. tmp, import and trash are never walked. The final check runs
 * under the file lock, as every deletion does.
 */
export async function sweepOrphanFiles(pool: pg.Pool, assetDir: string, now: number = Date.now()): Promise<number> {
  let dirs: string[];
  try {
    dirs = (await readdir(assetDir, { withFileTypes: true })).filter((d) => d.isDirectory() && PREFIX_DIR.test(d.name)).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let moved = 0;
  for (const dir of dirs.sort()) {
    const candidates = new Map<string, FileKey>();
    for (const name of await readdir(join(assetDir, dir))) {
      const m = VARIANT_FILE.exec(name);
      if (!m || m[1]!.slice(0, 2) !== dir || !isAssetKind(m[2])) continue;
      const age = await stat(join(assetDir, dir, name)).then(
        (s) => now - s.mtimeMs,
        () => 0,
      );
      if (age <= LIMITS.orphanFileDays * DAY_MS) continue;
      const key = { sha256: Buffer.from(m[1]!, "hex"), kind: m[2], pipeline: Number(m[4]) };
      candidates.set(`${m[1]}-${m[2]}-${m[4]}`, key);
    }
    if (candidates.size === 0) continue;
    const keys = [...candidates.values()];
    const { rows } = await pool.query<{ k: string }>(
      `select distinct encode(sha256, 'hex') || '-' || kind || '-' || pipeline as k from assets where sha256 = any($1::bytea[])`,
      [keys.map((k) => k.sha256)],
    );
    const named = new Set(rows.map((r) => r.k));
    const orphans = keys.filter((k) => !named.has(`${k.sha256.toString("hex")}-${k.kind}-${k.pipeline}`));
    if (orphans.length > 0) moved += await deleteUnreferencedFiles(pool, assetDir, orphans);
  }
  return moved;
}

// The daily job ---------------------------------------------------------------

export type CleanupReport = { rooms: number; thumbsDeleted: number; orphanFiles: number | null; trashDaysPurged: number };

/**
 * Once a day in the server process: every room's thumbnails, the trash's
 * purge, and the walk for files no row names, which runs on the first pass
 * after the server starts and then every seventh. A restart only brings the
 * walk forward, which is harmless, since it keeps every file a row names
 * and every file younger than a day. Rooms go one at a time, so the job
 * holds at most one room's queue at once.
 */
export class CleanupJob {
  #deps: CleanupDeps;
  #timer: NodeJS.Timeout | null = null;
  #passes = 0;
  #running: Promise<CleanupReport> | null = null;
  #stopped = false;

  constructor(deps: CleanupDeps) {
    this.#deps = deps;
  }

  /** The first pass after `firstMs`, then one a day. Unref'd, so it never keeps a process alive. */
  start(firstMs: number): void {
    const schedule = (ms: number) => {
      if (this.#stopped) return;
      this.#timer = setTimeout(() => {
        void this.run()
          .catch((err: unknown) => this.#deps.log.error({ err }, "image cleanup failed"))
          .finally(() => schedule(DAY_MS));
      }, ms);
      this.#timer.unref();
    };
    schedule(firstMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running?.catch(() => undefined);
  }

  run(): Promise<CleanupReport> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #pass(): Promise<CleanupReport> {
    const { pool, assetDir, log } = this.#deps;
    const walk = this.#passes % 7 === 0;
    this.#passes++;
    const { rows } = await pool.query<{ room_id: string }>("select distinct room_id from assets where kind = 'thumb' order by room_id");
    let thumbsDeleted = 0;
    for (const { room_id: roomId } of rows) {
      if (this.#stopped) break;
      try {
        thumbsDeleted += (await sweepThumbnails(this.#deps, roomId)).deleted;
      } catch (err) {
        log.warn({ err, roomId }, "thumbnail cleanup failed for a room");
      }
    }
    const orphanFiles = walk && !this.#stopped ? await sweepOrphanFiles(pool, assetDir) : null;
    const purged = await purgeTrash(assetDir);
    const report: CleanupReport = { rooms: rows.length, thumbsDeleted, orphanFiles, trashDaysPurged: purged.length };
    log.info(report, "image cleanup done");
    return report;
  }
}

// Routes ----------------------------------------------------------------------

const DeleteBody = z.object({ ids: z.array(z.string().regex(/^[0-9a-f-]{36}$/i, "not an asset id")).min(1).max(LIMITS.libraryDeleteMax) });

export type CleanupOptions = {
  /** When the first daily pass runs, 10 minutes after boot by default. Tests pass null for no job at all. */
  firstPassMs?: number | null;
};

/**
 * The library delete route and the daily job. Registered after the asset
 * routes, whose service it reads for the image volume.
 *
 * `POST /api/rooms/:id/assets/delete {ids}`: DM only, at most 500 ids.
 * Answers `{deleted}` with the ids whose rows went, or 409 `asset_in_use`
 * with `inUse` when the state names any of them, in which case nothing is
 * deleted, or 409 `state_unknown` when the room's replay failed and its
 * state cannot say what is in use. A stamp players remember is dropped
 * before the check, so only a use outside memory refuses an image, unless
 * the drop could not run or memory took the image up again meanwhile.
 */
export async function registerCleanup(app: FastifyInstance, opts: CleanupOptions = {}): Promise<CleanupJob> {
  const deps: CleanupDeps = {
    pool: app.pool,
    manager: app.rooms,
    assetDir: app.assets.assetDir,
    quotaBytes: app.rooms.options.actor.quotaBytes ?? app.config.ROOM_QUOTA_MB * 1024 * 1024,
    log: app.log,
  };
  const job = new CleanupJob(deps);
  app.decorate("cleanup", job);
  const first = opts.firstPassMs === undefined ? 10 * 60_000 : opts.firstPassMs;
  if (first !== null) job.start(first);
  app.addHook("onClose", async () => job.stop());

  app.post<{ Params: { id: string } }>("/api/rooms/:id/assets/delete", async (req, reply) => {
    const roomId = req.params.id;
    if (!ROOM_ID.test(roomId)) return reply.code(404).send({ error: "not_found" });
    const grant = await app.auth.grant(req, reply, roomId);
    if (!grant || grant.role !== "dm") return reply.code(403).send({ error: "forbidden" });
    const body = DeleteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = await deleteLibraryImages(deps, roomId, body.data.ids);
    if (result.ok) {
      if (result.deleted.length > 0) req.log.info({ roomId, images: result.deleted.length }, "a DM deleted library images");
      return { deleted: result.deleted };
    }
    if (result.reason === "in_use") return reply.code(409).send({ error: "asset_in_use", inUse: result.inUse });
    // The room's replay failed, so its state is partial and could miss a use: nothing is deleted on a guess.
    return reply.code(409).send({ error: "state_unknown" satisfies ApiErrorCode });
  });
  return job;
}

declare module "fastify" {
  interface FastifyInstance {
    cleanup: CleanupJob;
  }
}
