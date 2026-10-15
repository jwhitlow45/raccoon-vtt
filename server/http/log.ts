import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LogNames } from "#shared/logText.ts";
import type { LogEntry, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { accessRoutes, type AuthKit, enforce, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import type { GrantContext } from "../auth/types.ts";
import type { RoomActor } from "../rooms/actor.ts";
import type { RoomManager } from "../rooms/manager.ts";
import { readLogPage, type Pool } from "../rooms/persistence.ts";
import { entriesBetween, exportFileName, renderLogExport, sessionsOf, validTimeZone } from "./logExport.ts";

/**
 * Older log pages (design 10.8): rows from `room_log` before a given entry
 * id, projected for the caller exactly as the live log is (design 7.3), so
 * a whisper or an event about a hidden creature never comes back through
 * the archive.
 *
 * A DM may name the scene it is viewing, because the shared projection
 * scopes creature events to one scene. Players always get the player scene.
 */
const Query = z.object({
  before: z.string().regex(/^\d{1,18}:\d{1,6}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sceneId: z.string().min(1).max(64).optional(),
});

/*
 * A page counts the entries the caller may see, and what it answers depends
 * on those alone. A cursor taken from the rows read named rows the caller may
 * not have: a page of whispers between others or of a hidden creature's HP
 * lines came back empty with the id of the newest hidden row, so polling it
 * showed when the DM did something secret, and walking it back listed every
 * hidden row. Whether more rows were left to read leaked the same way, since
 * the hidden rows decided it. So a full page always offers the next with its
 * oldest entry, and a short one never does, which may leave a last empty page.
 * Reading stops once more than SCAN_HIDDEN rows the caller may not see have
 * gone by, so a longer stretch of them ends their history there rather than
 * costing the server without bound. Up to that many change no answer.
 */
const BATCH_ROWS = 100;
const SCAN_HIDDEN = 1_000;

const Instant = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)));
const ExportQuery = z.object({
  from: Instant.optional(),
  to: Instant.optional(),
  tz: z.string().max(64).default("UTC"),
});

/** The whole stored log, oldest first: at most the 10,000 lines a room keeps. */
async function readWholeLog(pool: Pool, roomId: string): Promise<LogEntry[]> {
  const { rows } = await pool.query<{ entry: LogEntry }>(
    `select entry from room_log where room_id = $1
     order by split_part(id, ':', 1)::bigint, split_part(id, ':', 2)::int`,
    [roomId],
  );
  return rows.map((r) => r.entry);
}

type ProjectedLog = { entries: LogEntry[]; names: LogNames; roomName: string };

/** Projected logs kept at once. Each is at most 10,000 lines, and a key goes stale with the room's next op. */
const CACHED_LOGS = 8;

/**
 * The session log as one viewer may read it (docs/design-v1-dm-tools.md
 * 3.10), projected before anything is counted: sessions found from raw rows
 * would tell a player when hidden things happened.
 *
 * A player's rows are projected exactly as `GET /log` projects them,
 * against the committed state, and their names come from their own view,
 * as their Log panel's do. A DM's rows keep every line but whispers the DM
 * is not party to, with names from the whole room's state, every scene's
 * tokens included, since the DM's scene-scoped view would read a creature
 * on another scene as "A creature".
 *
 * One projection is kept per room seq, member and role, so opening the
 * sheet and then exporting projects once. The role is in the key because
 * one member can hold a DM grant on one device and a player grant on
 * another, and a DM's rows must never reach that member's player device.
 */
class ProjectedLogs {
  #pool: Pool;
  #cache = new Map<string, ProjectedLog>();
  #pending = new Map<string, Promise<ProjectedLog>>();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  get(actor: RoomActor, viewer: Viewer): Promise<ProjectedLog> {
    const keyAt = (seq: number) => `${actor.roomId}|${seq}|${viewer.memberId}|${viewer.role}`;
    const key = keyAt(actor.committed.seq);
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const work = (async () => {
      const rows = await readWholeLog(this.#pool, actor.roomId);
      // The state is taken after the read, and rows past it left out, so every row kept is projected against a state
      // that already holds it.
      const { state, seq } = actor.committed;
      const kept = rows.filter((e) => Number(e.id.slice(0, e.id.indexOf(":"))) <= seq);
      const projected = projectState({ ...state, log: kept }, viewer, { sceneId: null });
      const view = viewer.role === "dm" ? state : projected;
      const log: ProjectedLog = {
        entries: projected.log,
        names: { members: view.members, tokens: view.tokens, characters: view.characters, handouts: view.handouts, encounter: view.encounter } as LogNames,
        roomName: state.meta.name,
      };
      this.#cache.set(keyAt(seq), log);
      while (this.#cache.size > CACHED_LOGS) this.#cache.delete(this.#cache.keys().next().value!);
      return log;
    })().finally(() => this.#pending.delete(key));
    this.#pending.set(key, work);
    return work;
  }
}

export function registerLogRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager }): Promise<void> {
  const logs = new ProjectedLogs(kit.pool);
  /** Rooms with an export being rendered: one at a time per room. */
  const exporting = new Set<string>();

  /**
   * Every listing and every export is charged against one limit per member
   * and room, cached or not (ratelimit.ts logExport), before anything is
   * read, so the answers and the limit left never depend on hidden ops.
   */
  async function grantAndCheck(req: FastifyRequest, reply: FastifyReply, roomId: string): Promise<GrantContext> {
    const grant = await requireGrant(kit, req, reply, roomId);
    enforce(await kit.limits.logExport(roomId, grant.memberId, kit.ip(req)));
    return grant;
  }

  return accessRoutes(app, (r) => {
    r.get("/api/rooms/:id/log/sessions", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await grantAndCheck(req, reply, roomId);
      await kit.limits.recordLogExport(roomId, grant.memberId, kit.ip(req));
      const actor = await deps.manager.acquire(roomId);
      const log = await logs.get(actor, { memberId: grant.memberId, role: grant.role });
      reply.header("cache-control", "no-store");
      return { sessions: sessionsOf(log.entries), lines: log.entries.length };
    });

    r.get("/api/rooms/:id/log/export", async (req, reply) => {
      const roomId = roomParam(req);
      const query = ExportQuery.safeParse(req.query);
      if (!query.success || !validTimeZone(query.data.tz)) throw new HttpError(400, "invalid_query");
      const { from, to, tz } = query.data;
      const grant = await grantAndCheck(req, reply, roomId);
      if (exporting.has(roomId)) throw new HttpError(429, "busy", { retryAfter: 2 });
      exporting.add(roomId);
      try {
        await kit.limits.recordLogExport(roomId, grant.memberId, kit.ip(req));
        const actor = await deps.manager.acquire(roomId);
        const log = await logs.get(actor, { memberId: grant.memberId, role: grant.role });
        const entries = entriesBetween(log.entries, from, to);
        const body = renderLogExport({ roomName: log.roomName, entries, names: log.names, me: grant.memberId, tz });
        // A session is named for the evening it started, everything for its newest line.
        const name = exportFileName(log.roomName, from === undefined ? entries.at(-1)?.at : entries[0]?.at, tz);
        return reply
          .header("content-type", "text/markdown; charset=utf-8")
          .header("content-disposition", `attachment; filename="${name}"`)
          .header("cache-control", "no-store")
          .send(body);
      } finally {
        exporting.delete(roomId);
      }
    });

    r.get("/api/rooms/:id/log", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId);
      const query = Query.safeParse(req.query);
      if (!query.success) throw new HttpError(400, "invalid_query");
      const { before, limit, sceneId } = query.data;
      const actor = await deps.manager.acquire(roomId);
      const scene = grant.role === "dm" ? (sceneId ?? actor.committed.state.meta.playerSceneId) : null;
      const viewer = { memberId: grant.memberId, role: grant.role };
      const entries: LogEntry[] = [];
      let cursor = before ?? null;
      let hidden = 0;
      let moreRows = true;
      while (entries.length < limit && moreRows && hidden <= SCAN_HIDDEN) {
        const rows = await readLogPage(kit.pool, roomId, cursor, BATCH_ROWS);
        moreRows = rows.length === BATCH_ROWS;
        cursor = rows[rows.length - 1]?.id ?? cursor;
        const shown = actor.projectLog(rows, viewer, scene);
        hidden += rows.length - shown.length;
        entries.push(...shown);
      }
      const page = entries.slice(0, limit);
      const oldest = page[page.length - 1];
      return { entries: page.reverse(), nextBefore: page.length === limit && oldest ? oldest.id : null };
    });
  });
}
