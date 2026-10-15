import { readFile } from "node:fs/promises";
import pg from "pg";

/**
 * The Postgres pool and the self-applying schema.
 *
 * Unlike a read-mostly site, this app cannot fall back to seed data without
 * a database: every room lives in Postgres. So a missing or unreachable
 * database is a boot failure, reported once, clearly, instead of a half-working
 * server.
 *
 * db/schema.sql is applied on the first connection, memoized, so a fresh
 * database and an old one both come up to the current schema with no
 * migration tool. The file must stay idempotent.
 */
let pool: pg.Pool | undefined;
let schemaApplied: Promise<void> | undefined;

export type PoolErrorLog = (err: Error, where: "idle" | "client") => void;

function logToStderr(err: Error, where: "idle" | "client"): void {
  console.error(JSON.stringify({ level: 50, time: Date.now(), msg: `database connection failed (${where})`, err: { message: err.message, code: (err as { code?: unknown }).code } }));
}

export function getPool(databaseUrl: string, log: PoolErrorLog = logToStderr): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      // Rooms batch their writes, so a handful of connections serves every
      // room at once. Postgres runs a process per connection, so more would
      // only cost memory.
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    watchPoolErrors(pool, log);
  }
  return pool;
}

/**
 * A connection that drops while nobody is using it (a database restart, a
 * network blip) is reported as an `error` event: on the pool while the
 * connection is idle in it, and on the client itself while it is checked
 * out between queries. An `error` event with no listener throws, which would
 * end the process and every room with it. The pool already discards the
 * broken connection, and the next query that needs one fails on its own
 * path where the rooms retry, so these listeners only log.
 */
export function watchPoolErrors(p: pg.Pool, log: PoolErrorLog): void {
  p.on("error", (err) => log(err, "idle"));
  p.on("connect", (client) => {
    client.on("error", (err) => log(err, "client"));
  });
}

export function applySchema(p: pg.Pool): Promise<void> {
  schemaApplied ??= (async () => {
    const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
    await p.query(sql);
  })().catch((err: unknown) => {
    // Let the next caller try again instead of caching the failure forever.
    schemaApplied = undefined;
    throw err;
  });
  return schemaApplied;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    schemaApplied = undefined;
  }
}
