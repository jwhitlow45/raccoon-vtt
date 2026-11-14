import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import pg from "pg";
import type { BackupRecord } from "../contract.ts";
import { syncDir, syncFile } from "./durable.ts";
import { RESTORE_STATEMENT_MS, dbConfig, type Cluster } from "./postgres.ts";
import { BEFORE, LIVE, RESTORING, parseTag, tagText, type DbName, type DbState, type ImageFs, type RestoreDb, type Tag } from "./restore.ts";
import { readStamp, writeStampIn, type Build } from "./versionGuard.ts";

/**
 * The restore's database operations on the bundled cluster. Renames, drops
 * and comments run from a connection to the `postgres` database, since a
 * database cannot be renamed or dropped while anyone, its renamer included,
 * is connected to it.
 */

const NAMES: readonly DbName[] = [LIVE, BEFORE, RESTORING];

function ident(name: DbName): string {
  // Only the three fixed names ever reach SQL, so quoting them is enough.
  if (!NAMES.includes(name)) throw new Error(`not a restore database: ${name}`);
  return `"${name}"`;
}

function literal(tag: Tag): string {
  // tagText is built from a fixed word and 32 hex characters, so it holds no quote.
  return `'${tagText(tag)}'`;
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(dbConfig(url, RESTORE_STATEMENT_MS));
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function clusterRestoreDb(cluster: Cluster): RestoreDb {
  const admin = <T>(work: (client: pg.Client) => Promise<T>) => withClient(cluster.url("postgres"), work);
  return {
    async state(): Promise<DbState> {
      const { rows } = await admin((c) =>
        c.query<{ datname: string; comment: string | null }>(
          "select datname, shobj_description(oid, 'pg_database') as comment from pg_database where datname = any($1::text[])",
          [[...NAMES]],
        ),
      );
      const of = (name: string) => rows.find((r) => r.datname === name);
      const live = of(LIVE);
      const restoring = of(RESTORING);
      return {
        live: live ? { tag: parseTag(live.comment) } : null,
        before: of(BEFORE) !== undefined,
        restoring: restoring ? { tag: parseTag(restoring.comment) } : null,
      };
    },
    async createRestoring(tag) {
      await admin(async (c) => {
        await c.query(`create database ${ident(RESTORING)} template template0`);
        await c.query(`comment on database ${ident(RESTORING)} is ${literal(tag)}`);
      });
    },
    async setTag(name, tag) {
      await admin((c) => c.query(`comment on database ${ident(name)} is ${literal(tag)}`));
    },
    async rename(from, to) {
      await admin((c) => c.query(`alter database ${ident(from)} rename to ${ident(to)}`));
    },
    async drop(name) {
      await admin((c) => c.query(`drop database if exists ${ident(name)} with (force)`));
    },
    async endSessions(names) {
      await admin((c) =>
        c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = any($1::text[]) and pid <> pg_backend_pid()", [names]),
      );
    },
    async load(dumpFile) {
      await cluster.client("pg_restore", [`--dbname=${RESTORING}`, "--no-owner", "--single-transaction", "--exit-on-error", cluster.pgPath(dumpFile)]);
      await withClient(cluster.url(RESTORING), (c) => c.query("select count(*) from rooms"));
    },
    async stampRestored(build: Build, record: BackupRecord) {
      await withClient(cluster.url(RESTORING), async (c) => {
        const stamp = await readStamp(c);
        await c.query("begin");
        await writeStampIn(c, {
          app: build.app,
          snapshotVersion: stamp?.snapshotVersion ?? record.snapshotVersion,
          opVersion: stamp?.opVersion ?? record.opVersion,
          pgMajor: stamp?.pgMajor ?? record.pgMajor,
        });
        await c.query("commit");
      });
    },
  };
}

async function size(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

export const nodeImageFs: ImageFs = {
  size,
  async isDir(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async mkdir(path) {
    await mkdir(path);
  },
  copy: (from, to) => copyFile(from, to),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  syncFile: (path) => syncFile(path),
  syncDir: (path) => syncDir(path),
};
