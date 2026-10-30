import type pg from "pg";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { dmNumbered, logsInIdOrder, whisperParties } from "#shared/logRings.ts";
import { MAP_DISCOVERY_OP_VERSION, OP_VERSION, SNAPSHOT_VERSION, mapDiscoveryUpgrade, migrateOp, migrateSnapshot, needsMapDiscoveryUpgrade, opMigrations, type MigrationStep } from "#shared/migrate.ts";
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

/**
 * The row count the archive was once trimmed to after every snapshot. It
 * keeps every row now, so this is only what an older archive may show:
 * one that reached it may have lost its oldest rows to the trim.
 */
export const LEGACY_LOG_STORED = 10_000;

/**
 * Whether the archive may take more rows now: false while the shared volume
 * is under its free-space floor (server/assets/quota.ts hasFreeDisk). Asked
 * before each archive write. A refused write skips only the log rows: the
 * ops, receipts and snapshots around them commit as they always do, and the
 * lines stay in the room's live log while it holds them.
 */
export type ArchiveGuard = () => Promise<boolean>;

export const ARCHIVE_ALWAYS: ArchiveGuard = () => Promise.resolve(true);

/** The guard's answer, a failed check counting as no. */
export async function archiveAdmitted(guard: ArchiveGuard): Promise<boolean> {
  try {
    return await guard();
  } catch {
    return false;
  }
}

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
 *
 * A snapshot from before map discovery takes its upgrade step once, over
 * the state recovered from everything stored before it
 * (docs/design-v1-map-discovery.md 5.5, ASTRA-31): just before the first
 * op of op version 26, or after the last op when none is that new. Older
 * ops replay by their own rules first, so the scenes they made or moved
 * the players to are marked by the step alone (MD-R6-1).
 */
export async function loadRoom(
  pool: Pool,
  roomId: string,
  onReplayFailure?: (seq: number, reason: string) => void,
  migrations: MigrationStep[] = opMigrations,
  admitArchive: ArchiveGuard = ARCHIVE_ALWAYS,
): Promise<LoadedRoom | null> {
  const snap = await pool.query<{ seq: string; state: unknown; schema_version: number }>(
    "select seq, state, schema_version from room_snapshots where room_id = $1",
    [roomId],
  );
  const row = snap.rows[0];
  if (!row) return null;
  const snapshotSeq = Number(row.seq);
  // The reducer finds a line by its id in each log, so a stored log out of order is put in order before any op meets it.
  let state = logsInIdOrder(migrateSnapshot(row.state, row.schema_version));
  // An import's lines are numbered at seq 0. One made before imports wrote them to the archive has none there, so its
  // lines still in the log are written now, and Show older reaches them once the live log moves past them. An import
  // writes them all in its transaction, so one of them in the archive means they came. An archive that once held
  // LEGACY_LOG_STORED rows may have had some of them trimmed while the archive kept only that many, and is left as it
  // is. Either way they are not written, and they are not written while the disk is short of space either.
  const imported = state.log.filter((e) => e.id.startsWith("0:"));
  if (imported.length > 0) {
    const { rows } = await pool.query<{ held: boolean }>(
      `select exists (select 1 from room_log where room_id = $1 and id = any($2::text[]))
           or exists (select 1 from room_log where room_id = $1 offset $3) as held`,
      [roomId, imported.map((e) => e.id), LEGACY_LOG_STORED - 1],
    );
    if (!rows[0]?.held && (await archiveAdmitted(admitArchive))) await archiveLines(pool, roomId, imported);
  }
  let seq = snapshotSeq;
  let replayFailed = false;
  let replayed = 0;
  let upgrade = needsMapDiscoveryUpgrade(row.schema_version);
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
        if (upgrade && r.op_version >= MAP_DISCOVERY_OP_VERSION) {
          state = mapDiscoveryUpgrade(state);
          upgrade = false;
        }
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
  if (upgrade) state = mapDiscoveryUpgrade(state);
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

/** One receipt as the table holds it (docs/design-v1-dice.md 1.2). */
export type ReceiptRow = {
  memberId: string;
  tag: string;
  part: number;
  state: "committed" | "refused";
  seq: number | null;
  code: string | null;
  message: string | null;
  /** ISO time it was written. */
  at: string;
};

export type BatchWrite = {
  ops: readonly OpRecord[];
  watermarks: ReadonlyArray<WatermarkKey & { n: number }>;
  /** The receipts of the tagged ops this batch settles, written with them, so a settled op and its receipt are durable together. */
  receipts?: readonly ReceiptRow[];
  /**
   * The room's name after this batch, set only when an op in it renamed the
   * room. The join page, the DM link page and the admin CLI read `rooms.name`
   * rather than loading the room, so it is written with the ops that changed it.
   */
  name?: string;
  /** False when the free-disk guard refused the batch's log rows (ArchiveGuard): the rest commits without them. */
  archive?: boolean;
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
 * them), the room's new name if it changed, the receipts of the tagged ops
 * it settles, and the client watermarks. Watermarks only ever move up.
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
      if (batch.archive !== false) await archiveLines(client, roomId, batch.ops.flatMap((r) => r.log));
      if (batch.name === undefined) await client.query("update rooms set last_active_at = now() where id = $1", [roomId]);
      else await client.query("update rooms set last_active_at = now(), name = $2 where id = $1", [roomId, batch.name]);
    }
    const receipts = batch.receipts ?? [];
    if (receipts.length > 0) {
      // A tag used again after its 24 hours of memory replaces its old row, which keeps the newest outcome.
      await client.query(
        `insert into roll_receipts (room_id, member_id, tag, part, state, seq, code, message, at)
         select $1, m, t, p, s, q, c, g, a::timestamptz
         from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[], $7::text[], $8::text[], $9::text[]) as x(m, t, p, s, q, c, g, a)
         on conflict (room_id, member_id, tag, part) do update
           set state = excluded.state, seq = excluded.seq, code = excluded.code, message = excluded.message, at = excluded.at`,
        [
          roomId,
          receipts.map((r) => r.memberId),
          receipts.map((r) => r.tag),
          receipts.map((r) => r.part),
          receipts.map((r) => r.state),
          receipts.map((r) => r.seq),
          receipts.map((r) => r.code),
          receipts.map((r) => r.message),
          receipts.map((r) => r.at),
        ],
      );
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
 * hour. The log archive is never trimmed: it keeps every line for the
 * members who may read it. Returns the serialized size in UTF-8 bytes.
 */
export async function writeSnapshot(pool: Pool, roomId: string, seq: number, state: RoomState): Promise<number> {
  const json = JSON.stringify(state);
  await pool.query(
    `insert into room_snapshots (room_id, seq, state, schema_version, written_at) values ($1, $2, $3::jsonb, $4, now())
     on conflict (room_id) do update set seq = excluded.seq, state = excluded.state, schema_version = excluded.schema_version, written_at = now()`,
    [roomId, seq, json, SNAPSHOT_VERSION],
  );
  await pool.query("delete from room_ops where room_id = $1 and seq <= $2 and at < now() - interval '1 hour'", [roomId, seq]);
  return Buffer.byteLength(json);
}

/** The room's receipts written since `since`: those younger than 24 hours, which the actor holds in memory (docs/design-v1-dice.md 1.2). */
export async function loadReceipts(pool: Pool, roomId: string, since: Date): Promise<ReceiptRow[]> {
  const { rows } = await pool.query<{ member_id: string; tag: string; part: number; state: ReceiptRow["state"]; seq: string | null; code: string | null; message: string | null; at: Date }>(
    `select member_id, tag, part, state, seq::text, code, message, at from roll_receipts
     where room_id = $1 and at > $2 order by at`,
    [roomId, since.toISOString()],
  );
  return rows.map((r) => ({ memberId: r.member_id, tag: r.tag, part: r.part, state: r.state, seq: r.seq === null ? null : Number(r.seq), code: r.code, message: r.message, at: r.at.toISOString() }));
}

/** One member's receipts of one tag, every part, read by key: the lookup reads nothing of anyone else's. */
export async function readReceipts(pool: Pool, roomId: string, memberId: string, tag: string): Promise<ReceiptRow[]> {
  const { rows } = await pool.query<{ part: number; state: ReceiptRow["state"]; seq: string | null; code: string | null; message: string | null; at: Date }>(
    `select part, state, seq::text, code, message, at from roll_receipts
     where room_id = $1 and member_id = $2 and tag = $3 order by part`,
    [roomId, memberId, tag],
  );
  return rows.map((r) => ({ memberId, tag, part: r.part, state: r.state, seq: r.seq === null ? null : Number(r.seq), code: r.code, message: r.message, at: r.at.toISOString() }));
}

/**
 * Writes log lines to the archive (`room_log`), each with its op seq, line
 * number and access rows (lineAccess) in one statement, so a row either
 * lands with all of its metadata or not at all, whether or not the caller
 * holds a transaction. A row already stored is left as it is: `on conflict`
 * never writes a line twice, so a replay or a second load is harmless. One
 * stored without metadata (an older server's write) gets it here, but only
 * when its entry is this very line, so its access rows come from what it
 * holds. An id the metadata cannot hold (storedKey) is stored without any,
 * which leaves its room on the complete raw reader.
 */
export async function archiveLines(q: Queryable, roomId: string, lines: readonly LogEntry[]): Promise<void> {
  if (lines.length === 0) return;
  const seen = new Set<string>();
  const src: { ids: string[]; ats: string[]; entries: string[]; seqs: (string | null)[]; nos: (number | null)[] } = { ids: [], ats: [], entries: [], seqs: [], nos: [] };
  const access = accessColumns();
  for (const e of lines) {
    // One statement cannot update a row twice, so a line named twice is written once.
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const key = storedKey(e.id);
    src.ids.push(e.id);
    src.ats.push(e.at);
    src.entries.push(JSON.stringify(e));
    src.seqs.push(key?.seq ?? null);
    src.nos.push(key?.line ?? null);
    if (key) access.add(e, key);
  }
  await q.query(
    `with src as (
       insert into room_log (room_id, id, at, entry, seq, line_no)
       select $1, i, a::timestamptz, e::jsonb, s, n from unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::int[]) as t(i, a, e, s, n)
       on conflict (room_id, id) do update set seq = excluded.seq, line_no = excluded.line_no
         where room_log.seq is null and excluded.seq is not null and room_log.entry = excluded.entry
       returning id
     )
     insert into room_log_access (room_id, stream, member_id, seq, line_no, id)
     select $1, st, m, s, n, i from unnest($7::text[], $8::text[], $9::text[], $10::bigint[], $11::int[]) as x(i, st, m, s, n)
     where i in (select id from src)
     on conflict do nothing`,
    [roomId, src.ids, src.ats, src.entries, src.seqs, src.nos, ...access.params()],
  );
}

/**
 * The streams a reader's archive reads come from (room_log_access): the
 * shared and DM lines, each party reader's copies and each member's
 * whispers. They only narrow which rows a read looks at: every row read is
 * projected for its reader, as the raw reader's are.
 */
export type LogStream = "shared" | "dm" | "party" | "whisper";
export type LogAccess = { stream: LogStream; memberId: string };

/** A stored id as the reducer writes it: decimal with no leading zero, the seq a bigint and the line six digits at most. */
const STORED_ID = /^(0|[1-9]\d{0,17}):(0|[1-9]\d{0,5})$/;

/**
 * A stored id's op seq (as text, since it is a bigint) and line number, or
 * null for an id the metadata cannot hold. Two ids that differ only by a
 * leading zero would share one key, so only the reducer's own form counts.
 */
export function storedKey(id: string): { seq: string; line: number } | null {
  const m = STORED_ID.exec(id);
  return m ? { seq: m[1]!, line: Number(m[2]) } : null;
}

/**
 * The streams a line is a candidate in, for every reader the projector
 * (shared/project.ts projectLogEntry) could ever let read it: a whisper in
 * each of its parties', a party copy in its one reader's, a line numbered
 * with the DM's in the DM stream, and every other line in the shared one.
 *
 * It goes by what a line's id and fields say alone, never by what anyone
 * can see now, so a later change of sight never needs a row rewritten. A
 * line from before op version 19 that only lineAudience's event rule makes
 * a DM line (neverRead) is filed as shared: the projector still keeps it
 * from players, and a rule about events can change without leaving a
 * readable line out of every player's stream.
 */
export function lineAccess(entry: Pick<LogEntry, "id" | "kind" | "from" | "to">): LogAccess[] {
  if (entry.kind === "whisper") return whisperParties(entry).map((memberId) => ({ stream: "whisper", memberId }));
  if (entry.to !== undefined) return entry.to[0] === undefined ? [] : [{ stream: "party", memberId: entry.to[0] }];
  return [{ stream: dmNumbered(entry.id) ? "dm" : "shared", memberId: "" }];
}

/** The streams a viewer's reads merge: a player's own party copies, a DM's lines, and each one's own whispers. */
export function readerStreams(viewer: Viewer): LogAccess[] {
  const own: LogAccess = viewer.role === "dm" ? { stream: "dm", memberId: "" } : { stream: "party", memberId: viewer.memberId };
  return [{ stream: "shared", memberId: "" }, own, { stream: "whisper", memberId: viewer.memberId }];
}

function accessColumns() {
  const ids: string[] = [];
  const streams: string[] = [];
  const members: string[] = [];
  const seqs: string[] = [];
  const nos: number[] = [];
  return {
    add(e: Pick<LogEntry, "id" | "kind" | "from" | "to">, key: { seq: string; line: number }) {
      for (const a of lineAccess(e)) {
        ids.push(e.id);
        streams.push(a.stream);
        members.push(a.memberId);
        seqs.push(key.seq);
        nos.push(key.line);
      }
    },
    params: () => [ids, streams, members, seqs, nos],
  };
}

/**
 * Whether a room holds an archive row without its metadata. Only this
 * decides whether a read may use the access rows: any such row, from an
 * older server, a backfill not yet done or an id the metadata cannot hold,
 * sends the read to the complete raw reader. Quick only with the partial
 * index on rows whose seq is null (logHistoryMigration.ts), so asked only
 * once that index is valid.
 */
export async function archiveIncomplete(q: Queryable, roomId: string): Promise<boolean> {
  const { rows } = await q.query<{ incomplete: boolean }>("select exists (select 1 from room_log where room_id = $1 and seq is null) as incomplete", [roomId]);
  return rows[0]?.incomplete === true;
}

/** Up to `limit` of a room's rows without metadata, for the backfill: by the partial index, in no order, since each batch completes the rows it read. */
export async function incompleteLines(q: Queryable, roomId: string, limit: number): Promise<{ id: string; entry: LogEntry }[]> {
  const { rows } = await q.query<{ id: string; entry: LogEntry }>("select id, entry from room_log where room_id = $1 and seq is null limit $2", [roomId, Math.trunc(limit)]);
  return rows;
}

/**
 * Completes stored rows' metadata: the numbers and every access row, in one
 * statement, so a row's seq is set only with all of its access rows. Only a
 * row still without them is touched, so a second run, or a write that
 * repaired the row first, changes nothing. Every id must pass storedKey.
 * Returns how many rows it completed.
 */
export async function completeLines(q: Queryable, roomId: string, rows: readonly { id: string; entry: LogEntry }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const ids: string[] = [];
  const seqs: string[] = [];
  const nos: number[] = [];
  const access = accessColumns();
  for (const { id, entry } of rows) {
    const key = storedKey(id);
    if (!key) throw new Error(`log row ${JSON.stringify(id)} has no stored id`);
    ids.push(id);
    seqs.push(key.seq);
    nos.push(key.line);
    // The row's own id, not the entry's, names it: they agree for every line the reducer writes.
    access.add({ ...entry, id }, key);
  }
  const { rows: out } = await q.query<{ completed: string }>(
    `with done as (
       update room_log l set seq = c.s, line_no = c.n
       from unnest($2::text[], $3::bigint[], $4::int[]) as c(i, s, n)
       where l.room_id = $1 and l.id = c.i and l.seq is null
       returning l.id
     ), acc as (
       insert into room_log_access (room_id, stream, member_id, seq, line_no, id)
       select $1, st, m, s, n, i from unnest($5::text[], $6::text[], $7::text[], $8::bigint[], $9::int[]) as x(i, st, m, s, n)
       where i in (select id from done)
       on conflict do nothing
     )
     select count(*)::text as completed from done`,
    [roomId, ids, seqs, nos, ...access.params()],
  );
  return Number(out[0]?.completed ?? 0);
}

/**
 * The next `limit` candidate ids of one stream inside a range, in the
 * range's order, by the access table's key: `after` is the last id this
 * stream gave, which the next call starts past.
 */
export async function fetchAccessIds(q: Queryable, range: LogScanRange, access: LogAccess, after: { seq: string; line: number } | null, limit: number): Promise<{ id: string; seq: string; line: number }[]> {
  const params: unknown[] = [range.roomId, access.stream, access.memberId, range.maxSeq];
  const where = ["room_id = $1", "stream = $2", "member_id = $3", "seq <= $4"];
  const asc = range.order === "asc";
  const bounds: [LogBound | undefined, ">" | "<"][] = [
    [range.lower, ">"],
    [range.upper, "<"],
  ];
  for (const [b, op] of bounds) {
    // Past the first call the stream's own last id replaces the bound it travels from.
    const travelling = (op === ">") === asc;
    if (travelling && after) {
      params.push(after.seq, after.line);
      where.push(`(seq, line_no) ${op} ($${params.length - 1}::bigint, $${params.length}::int)`);
      continue;
    }
    if (!b) continue;
    params.push(b.seq, b.index);
    where.push(`(seq, line_no) ${op}${b.inclusive ? "=" : ""} ($${params.length - 1}::bigint, $${params.length}::int)`);
  }
  const dir = asc ? "asc" : "desc";
  params.push(Math.trunc(limit));
  // The seq comes back as text under another name: an output column named seq would be what `order by seq` sorts, as text.
  const { rows } = await q.query<{ id: string; seq_text: string; line_no: number }>(
    `select id, seq::text as seq_text, line_no from room_log_access where ${where.join(" and ")} order by seq ${dir}, line_no ${dir} limit $${params.length}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, seq: r.seq_text, line: r.line_no }));
}

/** The lines one op wrote in a reader's streams, by the access table's key and then the archive's, in line order. */
export async function readOpLinesByAccess(q: Queryable, roomId: string, seq: number, streams: readonly LogAccess[]): Promise<LogEntry[]> {
  const { rows } = await q.query<{ id: string; entry: LogEntry }>(
    `select l.id, l.entry from unnest($3::text[], $4::text[]) as s(stream, member_id)
     join room_log_access a on a.room_id = $1 and a.stream = s.stream and a.member_id = s.member_id and a.seq = $2
     join room_log l on l.room_id = a.room_id and l.id = a.id
     order by a.line_no`,
    [roomId, seq, streams.map((s) => s.stream), streams.map((s) => s.memberId)],
  );
  const seen = new Set<string>();
  return rows.flatMap((r) => (seen.has(r.id) ? [] : (seen.add(r.id), [r.entry])));
}

/** The log rows one op wrote, `<seq>:<index>`, in order. An older archive's trim or a short disk may have kept some out. */
export async function readLogLines(q: Queryable, roomId: string, seq: number): Promise<LogEntry[]> {
  const { rows } = await q.query<{ entry: LogEntry }>(
    `select entry from room_log where room_id = $1 and split_part(id, ':', 1) = $2
     order by split_part(id, ':', 2)::int`,
    [roomId, String(seq)],
  );
  return rows.map((r) => r.entry);
}

/**
 * Receipt retention (docs/design-v1-dice.md 1.2): rows older than 7 days
 * go, and of those older than 24 hours each room keeps its newest 10,000. A
 * receipt younger than 24 hours is never deleted, by count or anything
 * else, so the duplicate rule holds for its whole day. Run daily.
 */
export async function pruneReceipts(pool: Pool): Promise<number> {
  const old = await pool.query("delete from roll_receipts where at < now() - interval '1 day' * $1", [LIMITS.receiptDays]);
  const over = await pool.query(
    `delete from roll_receipts r using (
       select room_id, member_id, tag, part from (
         select room_id, member_id, tag, part, row_number() over (partition by room_id order by at desc) as n
         from roll_receipts where at < now() - interval '24 hours'
       ) aged where aged.n > $1
     ) x
     where r.room_id = x.room_id and r.member_id = x.member_id and r.tag = x.tag and r.part = x.part`,
    [LIMITS.receiptsKeptOlder],
  );
  return (old.rowCount ?? 0) + (over.rowCount ?? 0);
}

/** Watermark rows unused for 7 days (design 16.2). Run daily. */
export async function pruneWatermarks(pool: Pool): Promise<number> {
  const result = await pool.query("delete from client_watermarks where updated_at < now() - interval '7 days'");
  return result.rowCount ?? 0;
}

export async function setReadOnly(pool: Pool, roomId: string, readOnly: boolean): Promise<void> {
  await pool.query("update rooms set read_only = $2 where id = $1", [roomId, readOnly]);
}

/** One end of an archive scan: an entry id, split, and whether the id itself is inside. */
export type LogBound = { seq: string; index: number; inclusive: boolean };

/**
 * A pass over one room's archive in id order, numeric by op seq then line
 * index, through rows at or below `maxSeq`: the committed seq the reader
 * captured, so a row committed later never meets a state that lacks it.
 */
export type LogScanRange = { roomId: string; maxSeq: number; order: "asc" | "desc"; lower?: LogBound; upper?: LogBound };

/**
 * Opens a cursor named `name` over the ids of a range, on a connection in
 * a transaction. The ids are ordered once, by one sort for the whole pass,
 * and fetched a batch at a time (fetchLogIds) with their entries read by
 * key (readLogEntries), so no batch sorts the room again and no batch holds
 * more than its own rows.
 */
export async function declareLogScan(client: Queryable, name: string, range: LogScanRange): Promise<void> {
  const params: unknown[] = [range.roomId, range.maxSeq];
  const where = ["room_id = $1", "split_part(id, ':', 1)::bigint <= $2"];
  const key = "(split_part(id, ':', 1)::bigint, split_part(id, ':', 2)::int)";
  for (const [bound, op] of [
    [range.lower, ">"],
    [range.upper, "<"],
  ] as const) {
    if (!bound) continue;
    params.push(bound.seq, bound.index);
    where.push(`${key} ${op}${bound.inclusive ? "=" : ""} ($${params.length - 1}::bigint, $${params.length}::int)`);
  }
  const dir = range.order === "asc" ? "asc" : "desc";
  await client.query(
    `declare ${name} no scroll cursor for select id from room_log where ${where.join(" and ")}
     order by split_part(id, ':', 1)::bigint ${dir}, split_part(id, ':', 2)::int ${dir}`,
    params,
  );
}

export async function fetchLogIds(client: Queryable, name: string, n: number): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(`fetch ${Math.trunc(n)} from ${name}`);
  return rows.map((r) => r.id);
}

/** The entries of `ids`, in that order, read by the archive's key. */
export async function readLogEntries(client: Queryable, roomId: string, ids: readonly string[]): Promise<LogEntry[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<{ id: string; entry: LogEntry }>("select id, entry from room_log where room_id = $1 and id = any($2::text[])", [roomId, ids]);
  const byId = new Map(rows.map((r) => [r.id, r.entry]));
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
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
