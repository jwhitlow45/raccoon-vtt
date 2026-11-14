import { randomBytes } from "node:crypto";
import { devNull } from "node:os";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";
import { BACKUP_STORE, BACKUP_SUFFIX, BackupName, BackupRecord, type BackupKind } from "../contract.ts";
import { variantFileName, type AssetMedia } from "../../server/assets/store.ts";
import type { AssetKind, Variant } from "../../server/assets/kinds.ts";
import { syncDir, syncFile, writeDurable } from "./durable.ts";
import type { Cluster } from "./postgres.ts";
import { retention, unlistedStoreFiles } from "./retention.ts";
import { readStamp } from "./versionGuard.ts";

/**
 * Backups (docs/design/design-v1-local-app.md 8.2, D-261113-060): docker/backup.sh's
 * model in Node, so it runs on Windows too. A backup is good only once its
 * completion record, `<name>.good.json`, exists, written last. Images go
 * to one store shared by every backup and named by their own paths, so a
 * picture used by a month of backups is kept once. A failed run deletes
 * nothing but its own unfinished files.
 *
 * The dump and the image list come from one exported snapshot: the list is
 * read in the transaction that exports it, and pg_dump reads that snapshot,
 * so every image the dump names is listed while the game goes on. An image
 * deleted after the snapshot waits in the asset trash for 48 hours, where
 * the copy looks for it, as backup.sh does.
 */

/** Space always left on the disk, as on a server (the 2 GiB floors). */
export const FREE_FLOOR_BYTES = 2 * 1024 ** 3;

export type BackupEnv = {
  cluster: Cluster;
  /** The `raccoon` database. */
  pool: pg.Pool;
  backupsDir: string;
  assetsDir: string;
  log: (msg: string) => void;
  floorBytes?: number;
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => Date;
  /** Tests only: runs once the snapshot's list is written, before any image is copied. */
  afterList?: () => Promise<void>;
};

export type BackupResult = { outcome: "good"; name: string; record: BackupRecord } | { outcome: "failed" | "partial"; reason: string };

export type StoredBackup = { name: string; record: BackupRecord };

export async function freeBytesOf(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

function backupName(at: Date): string {
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const id = Array.from(randomBytes(8), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  return `raccoon-${stamp}-${id}`;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** Every good backup, oldest first. A record that does not read is no backup. */
export async function listBackups(backupsDir: string): Promise<StoredBackup[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: StoredBackup[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith(BACKUP_SUFFIX.good)) continue;
    const name = file.slice(0, -BACKUP_SUFFIX.good.length);
    if (!BackupName.safeParse(name).success) continue;
    try {
      const record = BackupRecord.safeParse(JSON.parse(await readFile(join(backupsDir, file), "utf8")));
      if (record.success) found.push({ name, record: record.data });
    } catch {
      // A record cut off mid-write is no backup.
    }
  }
  // Two backups can start within one second, where their names sort by the random part, so the record's time orders them.
  return found.sort((a, b) => a.record.started.localeCompare(b.record.started) || a.name.localeCompare(b.name));
}

/** The image paths a backup lists, relative to the store, or null when its list is gone. */
export async function readFileList(backupsDir: string, name: string): Promise<string[] | null> {
  try {
    const text = await readFile(join(backupsDir, name + BACKUP_SUFFIX.files), "utf8");
    return text.split("\n").filter((line) => line.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

type AssetListRow = { sha256: Buffer; kind: string; pipeline: number; variants: string[]; media: string | null };

/** The files the snapshot's asset rows name, as server/assets/store.ts builds their paths. */
export function listedFiles(rows: readonly AssetListRow[]): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    const hex = row.sha256.toString("hex");
    for (const variant of row.variants) {
      // variantFileName checks every part, so a row that does not parse fails the whole list.
      paths.add(`${hex.slice(0, 2)}/${variantFileName(hex, row.kind as AssetKind, variant as Variant, row.pipeline, row.media as AssetMedia | null)}`);
    }
  }
  return [...paths].sort();
}

/** Where an image is now: in assets/, or in the trash under any day it was deleted. */
async function findSource(assetsDir: string, path: string): Promise<{ file: string; size: number } | null> {
  const live = join(assetsDir, path);
  const size = await sizeOf(live);
  if (size !== null) return { file: live, size };
  let days: string[];
  try {
    days = (await readdir(join(assetsDir, "trash"))).sort().reverse();
  } catch {
    return null;
  }
  for (const day of days) {
    const file = join(assetsDir, "trash", day, path);
    const s = await sizeOf(file);
    if (s !== null) return { file, size: s };
  }
  return null;
}

/** Leftovers of a run that was stopped: unfinished files, and dumps or lists with no completion record. */
async function clearUnfinished(backupsDir: string, store: string): Promise<void> {
  const names = await readdir(backupsDir);
  const good = new Set(names.filter((n) => n.endsWith(BACKUP_SUFFIX.good)).map((n) => n.slice(0, -BACKUP_SUFFIX.good.length)));
  for (const file of names) {
    const unfinished = file.endsWith(".part") || file.startsWith(".");
    const orphan = [BACKUP_SUFFIX.dump, BACKUP_SUFFIX.files].some((s) => file.endsWith(s) && !good.has(file.slice(0, -s.length)));
    if ((unfinished && file !== BACKUP_STORE) || orphan) await rm(join(backupsDir, file), { force: true });
  }
  for (const shard of await readdir(store).catch(() => [] as string[])) {
    for (const file of await readdir(join(store, shard)).catch(() => [] as string[])) {
      if (file.endsWith(".part")) await rm(join(store, shard, file), { force: true });
    }
  }
}

/**
 * One backup. Whatever goes wrong comes back as a failed run with its
 * reason, never as a throw, so a before-update backup that fails always
 * offers Try again or Start without a backup (design 8.4).
 */
export async function runBackup(env: BackupEnv, kind: BackupKind, forVersion?: string): Promise<BackupResult> {
  try {
    return await backupSteps(env, kind, forVersion);
  } catch (err) {
    const reason = firstLine(err);
    env.log(`backup failed: ${reason}`);
    return { outcome: "failed", reason };
  }
}

async function backupSteps(env: BackupEnv, kind: BackupKind, forVersion?: string): Promise<BackupResult> {
  const floor = env.floorBytes ?? FREE_FLOOR_BYTES;
  const freeBytes = env.freeBytes ?? freeBytesOf;
  const now = env.now ?? (() => new Date());
  const store = join(env.backupsDir, BACKUP_STORE);
  await mkdir(store, { recursive: true });
  await clearUnfinished(env.backupsDir, store);

  const started = now();
  const name = backupName(started);
  const dumpPart = join(env.backupsDir, `${name}${BACKUP_SUFFIX.dump}.part`);
  const dump = join(env.backupsDir, name + BACKUP_SUFFIX.dump);
  const list = join(env.backupsDir, name + BACKUP_SUFFIX.files);
  const fail = async (outcome: "failed" | "partial", reason: string): Promise<BackupResult> => {
    await rm(dumpPart, { force: true });
    if (outcome === "failed") await Promise.all([rm(dump, { force: true }), rm(list, { force: true }), rm(`${list}.part`, { force: true })]);
    env.log(`backup ${name}: ${outcome}: ${reason}`);
    return { outcome, reason };
  };

  // 1. The snapshot: the stamp, the database's size and the image list, all as the dump will see them.
  const client = await env.pool.connect();
  let files: string[];
  let dbBytes: number;
  let stamp: Awaited<ReturnType<typeof readStamp>>;
  try {
    await client.query("begin isolation level repeatable read");
    const snapshot = (await client.query<{ id: string }>("select pg_export_snapshot() as id")).rows[0]?.id;
    if (!snapshot) throw new Error("no snapshot");
    stamp = await readStamp(client);
    if (!stamp) {
      await client.query("rollback");
      return fail("failed", "the database has no version stamp");
    }
    dbBytes = Number((await client.query<{ n: string }>("select pg_database_size(current_database())::text as n")).rows[0]?.n ?? 0);
    const rows = (await client.query<{ t: string | null }>("select to_regclass('public.assets')::text as t")).rows[0]?.t
      ? (await client.query<AssetListRow>("select sha256, kind, pipeline, variants, media from assets")).rows
      : [];
    try {
      files = listedFiles(rows);
    } catch {
      await client.query("rollback");
      return fail("failed", "the database's image rows could not be listed");
    }

    // 2. Space for the dump: the last good dump plus a quarter, or the database's own size when larger.
    const last = (await listBackups(env.backupsDir)).at(-1)?.record.dumpBytes ?? 0;
    const estimate = Math.max(last + Math.floor(last / 4), dbBytes);
    const budget = (await freeBytes(env.backupsDir)) - floor;
    if (estimate > budget) {
      await client.query("rollback");
      return fail("failed", `not enough space for the dump: about ${estimate} bytes needed, ${Math.max(0, budget)} free above the floor`);
    }

    // 3. The dump, of the exported snapshot, while the transaction that exported it stays open.
    try {
      await env.cluster.client("pg_dump", ["--dbname=raccoon", "--format=custom", "--exclude-table=backup_runs", `--snapshot=${snapshot}`, `--file=${dumpPart}`]);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      return fail("failed", `pg_dump failed: ${firstLine(err)}`);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    return fail("failed", `the database did not answer: ${firstLine(err)}`);
  } finally {
    client.release();
  }

  // 4. The whole archive read back, every table's data and not only the catalog.
  try {
    await env.cluster.readDump(["--list", `--file=${devNull}`, dumpPart]);
    await env.cluster.readDump([`--file=${devNull}`, dumpPart]);
  } catch (err) {
    return fail("failed", `the dump did not read back whole: ${firstLine(err)}`);
  }
  const dumpBytes = (await sizeOf(dumpPart)) ?? 0;
  await syncFile(dumpPart);

  // 5. The list beside the dump before the dump takes its name, so a dump under its name always has its list.
  await writeDurable(list, files.length > 0 ? `${files.join("\n")}\n` : "", { mode: 0o644 });
  await rename(dumpPart, dump);
  await env.afterList?.();

  // 6. Space for the images the store lacks, then the copy, each through a .part checked by length.
  type Step = { path: string; source: { file: string; size: number } | null; have: number | null };
  const plan = async (): Promise<Step[]> =>
    Promise.all(files.map(async (path) => ({ path, source: await findSource(env.assetsDir, path), have: await sizeOf(join(store, path)) })));
  const needed = (await plan()).filter((s) => s.source && s.have !== s.source.size);
  const need = needed.reduce((sum, s) => sum + (s.source?.size ?? 0), 0);
  if ((await freeBytes(env.backupsDir)) - need < floor) return fail("partial", `not enough space for the images: ${need} bytes to copy`);
  let copied = 0;
  for (const step of needed) {
    const target = join(store, step.path);
    await mkdir(dirname(target), { recursive: true });
    // Deleted since the plan was made: it waits in the trash.
    const source = (await findSource(env.assetsDir, step.path)) ?? step.source;
    if (!source) continue;
    try {
      await copyFile(source.file, `${target}.part`);
      if ((await sizeOf(`${target}.part`)) !== source.size) throw new Error("short copy");
      await syncFile(`${target}.part`);
      await rename(`${target}.part`, target);
      copied++;
    } catch {
      await rm(`${target}.part`, { force: true });
    }
  }

  // 7. The check, from a fresh look: every listed image in the store, at its source's length while the source is there.
  const short = (await plan()).filter((s) => s.have === null || (s.source !== null && s.source.size !== s.have));
  if (short.length > 0) return fail("partial", `${short.length} of ${files.length} listed images are not in the backup's store`);
  for (const dir of new Set(files.map((p) => dirname(join(store, p))))) await syncDir(dir);
  await syncDir(store);

  // 8. The completion record, last of all.
  const record = BackupRecord.parse({
    started: started.toISOString(),
    finished: now().toISOString(),
    kind,
    dataApp: stamp.app,
    snapshotVersion: stamp.snapshotVersion,
    opVersion: stamp.opVersion,
    pgMajor: stamp.pgMajor,
    ...(kind === "before-update" ? { forVersion } : {}),
    dumpBytes,
    dbBytes,
    images: files.length,
  });
  await writeDurable(join(env.backupsDir, name + BACKUP_SUFFIX.good), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  env.log(`backup ${name}: good, ${kind}, ${dumpBytes} byte dump, ${files.length} images listed, ${copied} copied`);

  // 9. Retention, from the completion records only. This run always survives it.
  await applyRetention(env.backupsDir, now().getTime());
  return { outcome: "good", name, record };
}

/** Deletes backups retention drops, record first so a half-deleted backup never counts, then store files no kept list names. */
export async function applyRetention(backupsDir: string, now: number): Promise<string[]> {
  const backups = await listBackups(backupsDir);
  const { keep, drop } = retention(
    backups.map((b) => ({ name: b.name, kind: b.record.kind, started: Date.parse(b.record.started) })),
    now,
  );
  for (const name of drop) {
    await rm(join(backupsDir, name + BACKUP_SUFFIX.good), { force: true });
    await rm(join(backupsDir, name + BACKUP_SUFFIX.dump), { force: true });
    await rm(join(backupsDir, name + BACKUP_SUFFIX.files), { force: true });
  }
  const lists: string[][] = [];
  for (const name of keep) {
    const listed = await readFileList(backupsDir, name);
    // A kept backup whose list is gone keeps every store file, since nothing says which are its own.
    if (listed === null) return drop;
    lists.push(listed);
  }
  const store = join(backupsDir, BACKUP_STORE);
  const held: string[] = [];
  for (const shard of await readdir(store).catch(() => [] as string[])) {
    for (const file of await readdir(join(store, shard)).catch(() => [] as string[])) held.push(`${shard}/${file}`);
  }
  for (const path of unlistedStoreFiles(held, lists)) await rm(join(store, path), { force: true });
  for (const shard of await readdir(store).catch(() => [] as string[])) {
    if ((await readdir(join(store, shard)).catch(() => ["x"])).length === 0) await rm(join(store, shard), { recursive: true, force: true });
  }
  return drop;
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr && e.stderr.trim()) || e.message || String(err);
  return text.trim().split(/\r?\n/)[0] ?? text;
}
