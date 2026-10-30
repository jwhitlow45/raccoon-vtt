import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ROOM_ARCHIVE_BYTES_SQL, ROOM_QUOTA_BYTES_SQL } from "../assets/quota.ts";
import { AdminLoginLimits, AdminSessions, adminCookieSettings } from "../auth/adminSessions.ts";
import { enforce, HttpError, parseBody, roomParam, type AuthKit, accessRoutes } from "../auth/http.ts";
import { parseRoomId } from "../auth/roomId.ts";
import { verifyTurnstile } from "../auth/turnstile.ts";
import { deleteRoomAndFiles } from "./rooms.ts";

/**
 * The admin page's routes (docs/design-v1-dm-tools.md 3.18), which exist
 * only when the server has ADMIN_PASSWORD_HASH. Without it none is
 * registered, so every /api/admin route answers 404 like any unknown path.
 *
 * - `POST /api/admin/login {password, turnstileToken?}` and `DELETE /api/admin/session`
 * - `GET /api/admin/storage` and `GET /api/admin/rooms`
 * - `POST /api/admin/rooms/:id/pin {pinned}`
 * - `DELETE /api/admin/rooms/:id {confirm}`, the room ID typed to confirm
 *
 * The page lists rooms and storage and deletes or pins rooms. It never
 * shows a room's contents, DM link, player password or members, and cannot
 * enter a room: the listing's fields are an allowlist. Every answer is
 * `no-store`. CSRF and the per-request limit apply as to every route.
 */

const LoginBody = z.object({ password: z.string().min(1).max(256), turnstileToken: z.string().max(2048).optional() });
const PinBody = z.object({ pinned: z.boolean() });
const DeleteBody = z.object({ confirm: z.string().max(64) });

const HOUR_MS = 3600_000;

/** One room as the admin page lists it. Nothing here comes from the room's state. */
export type AdminRoom = {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  /**
   * The room's size on disk: what its storage quota counts (server/assets/quota.ts), a file shared by rooms counted
   * in each, plus its log archive, which the quota leaves out. So a room can show more than its quota and still take
   * uploads.
   */
  bytes: number;
  images: number;
  loaded: boolean;
  sockets: number;
  pinned: boolean;
  readOnly: boolean;
};

export type BackupRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "good" | "partial" | "failed" | "gone";
  dump: string | null;
  dumpBytes: number | null;
  imagesCopied: number | null;
  error: string | null;
};

export type AdminStorage = {
  /** The image volume, as the free-disk guard reads it. Null when it cannot be read. */
  volume: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  databaseBytes: number;
  /** Image files on disk, each counted once however many rooms share it. */
  images: { count: number; bytes: number };
  /** Scene thumbnails marked unused, which cleanup deletes after a day, and deleted files in the trash. */
  cleanup: { waiting: { count: number; bytes: number }; trash: { files: number; bytes: number } };
  backup: { last: BackupRun | null; lastGood: BackupRun | null; warning: string | null };
};

/**
 * Every room with what the admin page shows of it, newest activity first.
 * The size is the room's size on disk (roomPhysicalBytes): the quota's own
 * sum, starter picks left out as there, plus the log archive and its access
 * rows, which uploads and the read-only switch never count. The page and the CLI's list-rooms
 * agree. The image count counts starter picks, since they are the room's
 * images all the same.
 */
export async function listRoomsForAdmin(pool: pg.Pool): Promise<Array<Omit<AdminRoom, "loaded" | "sockets">>> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    created_at: Date;
    last_active_at: Date;
    pinned: boolean;
    read_only: boolean;
    images: number;
    bytes: string;
  }>(
    // The quota's own sums, per room. Its subqueries alias their tables with one letter, so the room here has a longer name.
    `select room.id, room.name, room.created_at, room.last_active_at, room.pinned, room.read_only,
       (select count(*)::int from assets a where a.room_id = room.id) as images,
       ${ROOM_QUOTA_BYTES_SQL.replaceAll("$1", "room.id")} + ${ROOM_ARCHIVE_BYTES_SQL.replaceAll("$1", "room.id")} as bytes
     from rooms room order by room.last_active_at desc, room.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    lastActiveAt: r.last_active_at.toISOString(),
    bytes: Number(r.bytes),
    images: r.images,
    pinned: r.pinned,
    readOnly: r.read_only,
  }));
}

/**
 * What the page warns about backups: the last run not good, or no good one
 * for 36 hours. A run in progress is no warning by itself.
 */
export function backupWarning(last: BackupRun | null, lastGood: BackupRun | null, now: number): string | null {
  if (!lastGood) return "No good backup has run yet. Check that the backup service is running.";
  if (last && last.outcome !== "good" && last.outcome !== "running") return `The last backup did not finish well (${last.outcome}).`;
  const at = Date.parse(lastGood.finishedAt ?? lastGood.startedAt);
  if (now - at > 36 * HOUR_MS) return "No good backup in the last 36 hours.";
  return null;
}

type RunRow = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: BackupRun["outcome"];
  dump: string | null;
  dump_bytes: string | null;
  images_copied: number | null;
  error: string | null;
};

function toRun(row: RunRow | undefined): BackupRun | null {
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    outcome: row.outcome,
    dump: row.dump,
    dumpBytes: row.dump_bytes === null ? null : Number(row.dump_bytes),
    imagesCopied: row.images_copied,
    error: row.error,
  };
}

async function trashSize(assetDir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files++;
        bytes += await stat(path).then(
          (s) => s.size,
          () => 0,
        );
      }
    }
  };
  await walk(join(assetDir, "trash"));
  return { files, bytes };
}

async function storage(app: FastifyInstance): Promise<AdminStorage> {
  const pool = app.pool;
  const assetDir = app.hasDecorator("assets") ? app.assets.assetDir : app.config.ASSET_DIR;
  const volume = await statfs(assetDir).then(
    (s) => ({ totalBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize, freeBytes: s.bavail * s.bsize }),
    () => null,
  );
  const [db, images, waiting, runs, good, trash] = await Promise.all([
    pool.query<{ bytes: string }>("select pg_database_size(current_database()) as bytes"),
    pool.query<{ count: number; bytes: string }>(
      `select count(*)::int as count, coalesce(sum(bytes), 0) as bytes
       from (select distinct on (sha256, kind, pipeline) bytes from assets order by sha256, kind, pipeline) files`,
    ),
    pool.query<{ count: number; bytes: string }>(
      "select count(*)::int as count, coalesce(sum(bytes), 0) as bytes from assets where unused_since is not null",
    ),
    pool.query<RunRow>("select * from backup_runs order by started_at desc limit 1"),
    pool.query<RunRow>("select * from backup_runs where outcome = 'good' order by started_at desc limit 1"),
    trashSize(assetDir),
  ]);
  const last = toRun(runs.rows[0]);
  const lastGood = toRun(good.rows[0]);
  return {
    volume,
    databaseBytes: Number(db.rows[0]?.bytes ?? 0),
    images: { count: images.rows[0]?.count ?? 0, bytes: Number(images.rows[0]?.bytes ?? 0) },
    cleanup: { waiting: { count: waiting.rows[0]?.count ?? 0, bytes: Number(waiting.rows[0]?.bytes ?? 0) }, trash },
    backup: { last, lastGood, warning: backupWarning(last, lastGood, Date.now()) },
  };
}

export async function registerAdminRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  const hash = kit.config.ADMIN_PASSWORD_HASH;
  if (!hash) return;
  const sessions = new AdminSessions(kit.pool, adminCookieSettings(kit.config), hash);
  const limits = new AdminLoginLimits(kit.pool);

  const timer = setInterval(() => {
    void sessions.prune().catch((err: unknown) => app.log.warn({ err }, "admin session cleanup failed"));
  }, HOUR_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!(await sessions.valid(req))) throw new HttpError(401, "no_session");
  }

  await accessRoutes(app, (r) => {
    // Every answer, refusals included, so nothing of the page sits in a cache.
    r.addHook("onRequest", async (_req, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
    });

    r.post("/api/admin/login", async (req, reply) => {
      const body = parseBody(LoginBody, req.body);
      const ip = kit.ip(req);
      enforce(await limits.check(ip));
      const turnstile = await verifyTurnstile(kit.config, body.turnstileToken, kit.clientIp(req));
      if (turnstile === "failed") throw new HttpError(403, "turnstile_failed");
      if (turnstile === "unavailable") throw new HttpError(503, "turnstile_unavailable");
      if (!(await kit.hasher.verify(hash, body.password))) {
        await limits.recordFailure(ip);
        req.log.warn({ ip: kit.clientIp(req) }, "admin login failed");
        throw new HttpError(403, "bad_password");
      }
      const token = await sessions.create();
      sessions.setCookie(reply, token);
      req.log.info({ ip: kit.clientIp(req) }, "admin signed in");
      return reply.code(204).send();
    });

    r.delete("/api/admin/session", async (req, reply) => {
      await sessions.end(req);
      sessions.clearCookie(reply);
      return reply.code(204).send();
    });

    r.get("/api/admin/storage", async (req) => {
      await requireAdmin(req);
      return storage(app);
    });

    r.get("/api/admin/rooms", async (req) => {
      await requireAdmin(req);
      const rooms = await listRoomsForAdmin(kit.pool);
      return {
        rooms: rooms.map((room): AdminRoom => {
          const actor = app.rooms.get(room.id);
          return { ...room, loaded: actor !== null, sockets: actor?.connectionCount ?? 0 };
        }),
      };
    });

    r.post("/api/admin/rooms/:id/pin", async (req, reply) => {
      await requireAdmin(req);
      const roomId = roomParam(req);
      const { pinned } = parseBody(PinBody, req.body);
      if (!(await app.rooms.setPinned(roomId, pinned))) throw new HttpError(404, "room_not_found");
      req.log.info({ ip: kit.clientIp(req), roomId, pinned }, "admin changed a room's pin");
      return reply.code(204).send();
    });

    r.delete("/api/admin/rooms/:id", async (req, reply) => {
      await requireAdmin(req);
      const roomId = roomParam(req);
      const { confirm } = parseBody(DeleteBody, req.body);
      if (parseRoomId(confirm.trim()) !== roomId) throw new HttpError(400, "confirm_mismatch");
      if (!(await deleteRoomAndFiles(app, roomId, req.log))) throw new HttpError(404, "room_not_found");
      req.log.info({ ip: kit.clientIp(req), roomId }, "admin deleted a room");
      return reply.code(204).send();
    });
  });
}
