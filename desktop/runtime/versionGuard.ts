import type pg from "pg";
import { STAMP_TABLE, VersionStamp } from "../contract.ts";

/**
 * The format stamp and the checks a start makes with it
 * (docs/design/design-v1-local-app.md 8.4, D-261113-102, 109). The stamp is
 * a one-row table in the `raccoon` database, so it commits as durably as the
 * data, travels in every dump, and a restore brings back the restored
 * data's own. db/schema.sql never names the table, and a hosted server
 * never has it. Its columns are only ever added to.
 */

export type Build = { app: string; snapshotVersion: number; opVersion: number; pgMajor: number };

type Db = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

const CREATE = `create table if not exists ${STAMP_TABLE} (
  app text not null,
  snapshot_version integer not null,
  op_version integer not null,
  pg_major integer not null,
  written_at timestamptz not null
)`;

type StampRow = { app: string; snapshot_version: number; op_version: number; pg_major: number; written_at: Date };

export async function readStamp(db: Db): Promise<VersionStamp | null> {
  const exists = await db.query<{ t: string | null }>(`select to_regclass('public.${STAMP_TABLE}')::text as t`);
  if (!exists.rows[0]?.t) return null;
  const { rows } = await db.query<StampRow>(`select app, snapshot_version, op_version, pg_major, written_at from ${STAMP_TABLE} order by written_at desc limit 1`);
  const row = rows[0];
  if (!row) return null;
  return VersionStamp.parse({
    app: row.app,
    snapshotVersion: row.snapshot_version,
    opVersion: row.op_version,
    pgMajor: row.pg_major,
    writtenAt: row.written_at.toISOString(),
  });
}

/** Whether the database holds no room: no `rooms` table yet, or an empty one. */
export async function roomsEmpty(db: Db): Promise<boolean> {
  const exists = await db.query<{ t: string | null }>("select to_regclass('public.rooms')::text as t");
  if (!exists.rows[0]?.t) return true;
  const { rows } = await db.query<{ any: boolean }>("select exists (select 1 from rooms) as any");
  return rows[0]?.any !== true;
}

/** Replaces the stamp in one committed transaction. */
export async function writeStamp(pool: pg.Pool, stamp: Omit<VersionStamp, "writtenAt">): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await writeStampIn(client, stamp);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The same, inside a transaction the caller holds. */
export async function writeStampIn(db: Db, stamp: Omit<VersionStamp, "writtenAt">): Promise<void> {
  await db.query(CREATE);
  await db.query(`delete from ${STAMP_TABLE}`);
  await db.query(`insert into ${STAMP_TABLE} (app, snapshot_version, op_version, pg_major, written_at) values ($1, $2, $3, $4, now())`, [
    stamp.app,
    stamp.snapshotVersion,
    stamp.opVersion,
    stamp.pgMajor,
  ]);
}

export function stampOf(build: Build): Omit<VersionStamp, "writtenAt"> {
  return { app: build.app, snapshotVersion: build.snapshotVersion, opVersion: build.opVersion, pgMajor: build.pgMajor };
}

export type Verdict =
  /** The data is this build's: start. */
  | { kind: "current" }
  /** A new database: this build's once stamped. */
  | { kind: "new" }
  /** Rooms with no stamp: nothing says which build wrote them. */
  | { kind: "noStamp" }
  /** A newer build's formats: refuse (D-261113-061). */
  | { kind: "newer"; dataApp: string }
  /** Another build's data in formats this one reads: back up before stamping. */
  | { kind: "update"; dataApp: string };

/**
 * The start's decision from the stamp (design 8.4). Any format step blocks a
 * downgrade, stricter than the self-hosting rules: one rule keeps the check
 * simple, at the cost of refusing some downgrades a server would allow. An
 * older build with the same formats starts normally, after a backup.
 */
export function judge(stamp: VersionStamp | null, empty: boolean, build: Build): Verdict {
  if (!stamp) return empty ? { kind: "new" } : { kind: "noStamp" };
  if (stamp.snapshotVersion > build.snapshotVersion || stamp.opVersion > build.opVersion) return { kind: "newer", dataApp: stamp.app };
  if (stamp.app !== build.app) return { kind: "update", dataApp: stamp.app };
  return { kind: "current" };
}

/** Whether this build reads data in these formats: a backup it may restore. */
export function readable(formats: { snapshotVersion: number; opVersion: number }, build: Build): boolean {
  return formats.snapshotVersion <= build.snapshotVersion && formats.opVersion <= build.opVersion;
}
