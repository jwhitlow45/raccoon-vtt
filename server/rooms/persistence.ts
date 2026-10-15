import type pg from "pg";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { OP_VERSION, SNAPSHOT_VERSION, migrateOp, migrateSnapshot, opMigrations, type MigrationStep } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { Queryable } from "../auth/tx.ts";

/**
 * Everything the room engine reads from or writes to Postgres (design
 * section 16): loading a room from its snapshot and op log, committing a
 * batch, writing snapshots, and the small reads around them.
 *
 * The functions take the pool as an argument rather than holding one, so a
 * test can pass a wrapper that fails at a chosen point to exercise the
 * commit failure paths of section 7.2.
 */
export type Pool = Pick<pg.Pool, "query" | "connect">;

export type RoomInfo = { roomId: string; pinned: boolean; createdIp: string | null; readOnly: boolean };

export async function roomInfo(pool: Pool, roomId: string): Promise<RoomInfo | null> {
  const { rows } = await pool.query<{ pinned: boolean; created_ip: string | null; read_only: boolean }>(
    "select pinned, created_ip, read_only from rooms where id = $1",
    [roomId],
  );
  const row = rows[0];
  return row ? { roomId, pinned: row.pinned, createdIp: row.created_ip, readOnly: row.read_only } : null;
}

export type LoadedRoom = {
  state: RoomState;
  seq: number;
  /** The seq of the snapshot row the load started from. */
  snapshotSeq: number;
  /** Replay stopped at an op that did not validate or apply. The room serves reads only. */
  replayFailed: boolean;
  /** How many ops were replayed on top of the snapshot. */
  replayed: number;
  /** Serialized UTF-8 size of the loaded state, so the size guard starts informed. */
  stateBytes: number;
};

type OpRow = { seq: string; at: Date; actor_member_id: string; actor_role: Viewer["role"]; op: unknown; op_version: number };

/**
 * Loads the snapshot, migrates it, then replays every later op through the
 * shared reducer with the envelope each row stored (design 16.2). A replay
 * that fails stops where it is: the state so far is served read-only, so a
 * bug never gets to guess at a room's contents.
 *
 * Each stored op runs through its migrations before the protocol schema
 * checks it, so a rule that tightens later adapts older ops there (see
 * `opMigrations`) instead of stopping their rooms. `migrations` is only
 * for tests.
 */
export async function loadRoom(
  pool: Pool,
  roomId: string,
  onReplayFailure?: (seq: number, reason: string) => void,
  migrations: MigrationStep[] = opMigrations,
): Promise<LoadedRoom | null> {
  const snap = await pool.query<{ seq: string; state: unknown; schema_version: number }>(
    "select seq, state, schema_version from room_snapshots where room_id = $1",
    [roomId],
  );
  const row = snap.rows[0];
  if (!row) return null;
  const snapshotSeq = Number(row.seq);
  let state = migrateSnapshot(row.state, row.schema_version);
  let seq = snapshotSeq;
  let replayFailed = false;
  let replayed = 0;
  const ops = await pool.query<OpRow>(
    "select seq, at, actor_member_id, actor_role, op, op_version from room_ops where room_id = $1 and seq > $2 order by seq",
    [roomId, snapshotSeq],
  );
  for (const r of ops.rows) {
    const rowSeq = Number(r.seq);
    let reason: string | null = null;
    if (rowSeq !== seq + 1) {
      reason = `op ${rowSeq} does not follow ${seq}`;
    } else {
      const stored = storedOp(r, rowSeq, migrations);
      if (!stored.ok) {
        reason = stored.reason;
      } else {
        // The stored version goes in the envelope, so an older op keeps the rules it was applied under (shared/migrate.ts).
        const result = applyOp(state, stored.op, { memberId: r.actor_member_id, role: r.actor_role }, { seq: rowSeq, at: r.at.toISOString(), opVersion: r.op_version });
        if (!result.ok) reason = `op ${rowSeq} (${stored.op.t}) was refused on replay: ${result.message}`;
        else {
          state = result.state;
          seq = rowSeq;
          replayed++;
        }
      }
    }
    if (reason !== null) {
      replayFailed = true;
      onReplayFailure?.(rowSeq, reason);
      break;
    }
  }
  return { state, seq, snapshotSeq, replayFailed, replayed, stateBytes: serializedBytes(state) };
}

/** One stored op, migrated to the current version and checked with the protocol schema, or why it cannot be replayed. */
function storedOp(r: OpRow, rowSeq: number, migrations: MigrationStep[]): { ok: true; op: Op } | { ok: false; reason: string } {
  let migrated: unknown;
  try {
    migrated = migrateOp(r.op, r.op_version, migrations);
  } catch (err) {
    return { ok: false, reason: `op ${rowSeq} cannot be migrated: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = opSchema.safeParse(migrated);
  if (!parsed.success) return { ok: false, reason: `op ${rowSeq} does not validate: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  return { ok: true, op: parsed.data };
}

export type OpRecord = { seq: number; at: string; actor: Viewer; op: Op; log: LogEntry[] };

export type WatermarkKey = { sessionId: string; clientId: string };

export type BatchWrite = {
  ops: readonly OpRecord[];
  watermarks: ReadonlyArray<WatermarkKey & { n: number }>;
  /**
   * The room's name after this batch, set only when an op in it renamed the
   * room. The join page, the DM link page and the admin CLI read `rooms.name`
   * rather than loading the room, so it is written with the ops that changed it.
   */
  name?: string;
};

/** The error thrown when the COMMIT itself failed, so the outcome must be read back before any retry. */
export class CommitOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super("commit outcome unknown", { cause });
    this.name = "CommitOutcomeUnknown";
  }
}

/**
 * Writes one batch in one transaction (design 7.2): the op rows, the log rows
 * they produced (`on conflict do nothing`, so a replay never duplicates
 * them), the room's new name if it changed, and the client watermarks.
 * Watermarks only ever move up.
 *
 * An error before COMMIT is a clean failure and is rethrown as it is. An
 * error from the COMMIT statement is wrapped, because the connection may
 * have dropped after Postgres applied it.
 */
export async function commitBatch(pool: Pool, roomId: string, batch: BatchWrite): Promise<void> {
  const client = await pool.connect();
  let committing = false;
  let broken = false;
  try {
    await client.query("begin");
    if (batch.ops.length > 0) {
      const seqs: number[] = [];
      const ats: string[] = [];
      const members: string[] = [];
      const roles: string[] = [];
      const ops: string[] = [];
      for (const r of batch.ops) {
        seqs.push(r.seq);
        ats.push(r.at);
        members.push(r.actor.memberId);
        roles.push(r.actor.role);
        ops.push(JSON.stringify(r.op));
      }
      await client.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         select $1, s, a::timestamptz, m, r, o::jsonb, $7
         from unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[]) as t(s, a, m, r, o)`,
        [roomId, seqs, ats, members, roles, ops, OP_VERSION],
      );
      const logIds: string[] = [];
      const logAts: string[] = [];
      const entries: string[] = [];
      for (const r of batch.ops) {
        for (const e of r.log) {
          logIds.push(e.id);
          logAts.push(e.at);
          entries.push(JSON.stringify(e));
        }
      }
      if (logIds.length > 0) {
        await client.query(
          `insert into room_log (room_id, id, at, entry)
           select $1, i, a::timestamptz, e::jsonb from unnest($2::text[], $3::text[], $4::text[]) as t(i, a, e)
           on conflict do nothing`,
          [roomId, logIds, logAts, entries],
        );
      }
      if (batch.name === undefined) await client.query("update rooms set last_active_at = now() where id = $1", [roomId]);
      else await client.query("update rooms set last_active_at = now(), name = $2 where id = $1", [roomId, batch.name]);
    }
    if (batch.watermarks.length > 0) {
      await client.query(
        `insert into client_watermarks (room_id, session_id, client_id, n, updated_at)
         select $1, s::uuid, c, n, now() from unnest($2::text[], $3::text[], $4::bigint[]) as t(s, c, n)
         on conflict (room_id, session_id, client_id) do update
           set n = greatest(client_watermarks.n, excluded.n), updated_at = now()`,
        [roomId, batch.watermarks.map((w) => w.sessionId), batch.watermarks.map((w) => w.clientId), batch.watermarks.map((w) => w.n)],
      );
    }
    committing = true;
    await client.query("commit");
  } catch (err) {
    if (committing) {
      // The connection's transaction state is unknown, so the pool must not hand it to anyone else.
      broken = true;
      throw new CommitOutcomeUnknown(err);
    }
    await client.query("rollback").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Whether a batch whose COMMIT answer was lost is in the database (design
 * 7.2): the room's `max(seq)` for a batch with ops, and the watermark rows
 * for a batch that holds only watermark updates.
 */
export async function batchCommitted(pool: Pool, roomId: string, batch: BatchWrite): Promise<boolean> {
  const last = batch.ops[batch.ops.length - 1];
  if (last) {
    const { rows } = await pool.query<{ max: string | null }>("select max(seq)::text as max from room_ops where room_id = $1", [roomId]);
    return Number(rows[0]?.max ?? 0) >= last.seq;
  }
  if (batch.watermarks.length === 0) return true;
  const { rows } = await pool.query<{ session_id: string; client_id: string; n: string }>(
    `select session_id, client_id, n::text from client_watermarks
     where room_id = $1 and session_id = any($2::uuid[]) and client_id = any($3::text[])`,
    [roomId, batch.watermarks.map((w) => w.sessionId), batch.watermarks.map((w) => w.clientId)],
  );
  const stored = new Map(rows.map((r) => [`${r.session_id}|${r.client_id}`, Number(r.n)]));
  return batch.watermarks.every((w) => (stored.get(`${w.sessionId}|${w.clientId}`) ?? -1) >= w.n);
}

export async function readWatermark(pool: Pool, roomId: string, key: WatermarkKey): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select n::text from client_watermarks where room_id = $1 and session_id = $2 and client_id = $3",
    [roomId, key.sessionId, key.clientId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Writes the committed state as the room's snapshot, then prunes what it
 * covers (design 16.2): ops at or below its seq that are also older than an
 * hour, and log rows past the stored cap. Returns the serialized size in UTF-8 bytes.
 */
export async function writeSnapshot(pool: Pool, roomId: string, seq: number, state: RoomState): Promise<number> {
  const json = JSON.stringify(state);
  await pool.query(
    `insert into room_snapshots (room_id, seq, state, schema_version, written_at) values ($1, $2, $3::jsonb, $4, now())
     on conflict (room_id) do update set seq = excluded.seq, state = excluded.state, schema_version = excluded.schema_version, written_at = now()`,
    [roomId, seq, json, SNAPSHOT_VERSION],
  );
  await pool.query("delete from room_ops where room_id = $1 and seq <= $2 and at < now() - interval '1 hour'", [roomId, seq]);
  await pool.query(
    `delete from room_log where room_id = $1 and id in (
       select id from room_log where room_id = $1
       order by split_part(id, ':', 1)::bigint desc, split_part(id, ':', 2)::int desc
       offset $2)`,
    [roomId, LIMITS.logStored],
  );
  return Buffer.byteLength(json);
}

/** Watermark rows unused for 7 days (design 16.2). Run daily. */
export async function pruneWatermarks(pool: Pool): Promise<number> {
  const result = await pool.query("delete from client_watermarks where updated_at < now() - interval '7 days'");
  return result.rowCount ?? 0;
}

export async function setReadOnly(pool: Pool, roomId: string, readOnly: boolean): Promise<void> {
  await pool.query("update rooms set read_only = $2 where id = $1", [roomId, readOnly]);
}

/** Older log rows, newest first, strictly before `before` (a `"<seq>:<index>"` id). */
export async function readLogPage(pool: Pool, roomId: string, before: string | null, limit: number): Promise<LogEntry[]> {
  const { rows } = before
    ? await pool.query<{ entry: LogEntry }>(
        `select entry from room_log where room_id = $1
         and (split_part(id, ':', 1)::bigint, split_part(id, ':', 2)::int) < ($2::bigint, $3::int)
         order by split_part(id, ':', 1)::bigint desc, split_part(id, ':', 2)::int desc limit $4`,
        [roomId, before.split(":")[0], before.split(":")[1] ?? "0", limit],
      )
    : await pool.query<{ entry: LogEntry }>(
        `select entry from room_log where room_id = $1
         order by split_part(id, ':', 1)::bigint desc, split_part(id, ':', 2)::int desc limit $2`,
        [roomId, limit],
      );
  return rows.map((r) => r.entry);
}

export type AssetFact = { id: string; roomId: string; kind: "map" | "token" | "handout" | "thumb"; width: number; height: number; uploaders: string[] };

/** The rows behind the asset ids an op names, for the reference checks in canApply (design 8.2). */
export async function loadAssetFacts(pool: Queryable, ids: readonly string[]): Promise<Map<string, AssetFact>> {
  const facts = new Map<string, AssetFact>();
  if (ids.length === 0) return facts;
  const { rows } = await pool.query<{ id: string; room_id: string; kind: AssetFact["kind"]; width: number; height: number; uploaders: string[] | null }>(
    `select a.id, a.room_id, a.kind, a.width, a.height,
       array(select u.member_id from asset_uploaders u where u.asset_id = a.id) as uploaders
     from assets a where a.id = any($1::uuid[])`,
    [ids],
  );
  for (const r of rows) facts.set(r.id, { id: r.id, roomId: r.room_id, kind: r.kind, width: r.width, height: r.height, uploaders: r.uploaders ?? [] });
  return facts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every `assetId` string in a raw op, and a scene's `thumb`, found before
 * the op is parsed, so the rows can be read outside the actor's synchronous
 * pipeline. Only well-formed UUIDs are worth a query. The walk is bounded by
 * the frame size.
 */
export function assetIdsOf(raw: unknown, depth = 0): string[] {
  if (depth > 8 || raw === null || typeof raw !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) out.push(...assetIdsOf(item, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((key === "assetId" || key === "thumb") && typeof value === "string" && UUID.test(value)) out.push(value.toLowerCase());
    else if (value && typeof value === "object") out.push(...assetIdsOf(value, depth + 1));
  }
  return out;
}
