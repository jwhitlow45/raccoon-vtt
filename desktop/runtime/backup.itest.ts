import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { BACKUP_STORE, BACKUP_SUFFIX } from "../contract.ts";
import { trashDay } from "../../server/assets/store.ts";
import { applyRetention, listBackups, readFileList, runBackup, type BackupEnv } from "./backup.ts";
import { startTestCluster, type TestCluster } from "./testing/cluster.ts";
import { addImage, createRoom, query, roomNames } from "./testing/dataFixture.ts";
import { writeStamp } from "./versionGuard.ts";

/**
 * Backups against the real cluster (docs/design/design-v1-local-app.md 8.2):
 * a good backup's files and record, a dump that restores, an image deleted
 * mid-run copied from the trash, the store's reuse, a full disk, and
 * retention.
 */

let t: TestCluster;
let pool: pg.Pool;
let env: BackupEnv;
let assets: string;
let backups: string;
let roomA: string;
const logs: string[] = [];

before(async () => {
  t = await startTestCluster("rvtt-backup-");
  await query(t.cluster.url("postgres"), "create database raccoon template template0");
  assets = join(t.dir, "assets");
  backups = join(t.dir, "backups");
  await mkdir(assets, { recursive: true });
  await mkdir(backups, { recursive: true });
  roomA = await createRoom(t.cluster.url(), "Room A");
  await createRoom(t.cluster.url(), "Room B");
  await addImage(t.cluster.url(), assets, roomA);
  await addImage(t.cluster.url(), assets, roomA);
  pool = t.pool("raccoon");
  await writeStamp(pool, { app: "0.4.2", snapshotVersion: 44, opVersion: 58, pgMajor: 17 });
  env = { cluster: t.cluster, pool, backupsDir: backups, assetsDir: assets, log: (m) => logs.push(m) };
});

after(async () => {
  await t?.stop();
});

async function storeFiles(): Promise<string[]> {
  const store = join(backups, BACKUP_STORE);
  const out: string[] = [];
  for (const shard of await readdir(store).catch(() => [] as string[])) for (const f of await readdir(join(store, shard))) out.push(`${shard}/${f}`);
  return out.sort();
}

describe("runBackup", () => {
  test("a good backup: dump, list and record, with the data's own formats, and every listed image in the store", async () => {
    const result = await runBackup(env, "manual");
    assert.equal(result.outcome, "good", JSON.stringify(result));
    if (result.outcome !== "good") return;
    const { name, record } = result;
    for (const suffix of Object.values(BACKUP_SUFFIX)) await stat(join(backups, name + suffix));
    assert.equal(record.kind, "manual");
    assert.equal(record.dataApp, "0.4.2");
    assert.equal(record.snapshotVersion, 44);
    assert.equal(record.opVersion, 58);
    assert.equal(record.pgMajor, 17);
    assert.equal(record.forVersion, undefined);
    assert.equal(record.images, 4);
    assert.ok(record.dbBytes > 1_000_000, `dbBytes ${record.dbBytes}`);
    assert.ok(record.dumpBytes > 0);
    const part = join(backups, `${name}${BACKUP_SUFFIX.dump}.part`);
    assert.equal(t.given.filter((p) => p === part).length, 3, "pg_dump writes the dump, and pg_restore reads it twice, by PostgreSQL's spelling of its path");
    const list = await readFileList(backups, name);
    assert.equal(list?.length, 4);
    for (const path of list ?? []) {
      assert.deepEqual(await readFile(join(backups, BACKUP_STORE, path)), await readFile(join(assets, path)));
    }
    const listed = await listBackups(backups);
    assert.deepEqual(listed.map((b) => b.name), [name]);
  });

  test("the dump restores: rooms, assets and the stamp, without the backup log", async () => {
    const [newest] = (await listBackups(backups)).slice(-1);
    assert.ok(newest);
    await query(t.cluster.url("postgres"), "create database restore_check template template0");
    await t.cluster.client("pg_restore", ["--dbname=restore_check", "--no-owner", "--single-transaction", "--exit-on-error", join(backups, newest.name + BACKUP_SUFFIX.dump)]);
    const url = t.cluster.url("restore_check");
    assert.deepEqual(await roomNames(url), ["Room A", "Room B"]);
    assert.equal((await query<{ n: number }>(url, "select count(*)::int as n from assets"))[0]?.n, 2);
    assert.equal((await query<{ app: string }>(url, "select app from local_app_stamp"))[0]?.app, "0.4.2");
    // backup_runs is a log for the hosted admin page, never part of a backup (docker/backup.sh).
    assert.equal((await query<{ t: string | null }>(url, "select to_regclass('public.backup_runs')::text as t"))[0]?.t, null);
    await query(t.cluster.url("postgres"), "drop database restore_check");
  });

  test("a before-update backup records the version being installed", async () => {
    const result = await runBackup(env, "before-update", "0.5.0");
    assert.equal(result.outcome, "good");
    if (result.outcome === "good") {
      assert.equal(result.record.forVersion, "0.5.0");
      assert.equal(result.record.dataApp, "0.4.2");
    }
  });

  test("an image already in the store at its length is not copied again", async () => {
    const before = await storeFiles();
    const mtimes = await Promise.all(before.map(async (p) => (await stat(join(backups, BACKUP_STORE, p))).mtimeMs));
    logs.length = 0;
    const result = await runBackup(env, "manual");
    assert.equal(result.outcome, "good");
    assert.deepEqual(await storeFiles(), before);
    const again = await Promise.all(before.map(async (p) => (await stat(join(backups, BACKUP_STORE, p))).mtimeMs));
    assert.deepEqual(again, mtimes);
    assert.match(logs.join("\n"), /4 images listed, 0 copied/);
  });

  test("an image deleted after the snapshot is copied from the asset trash", async () => {
    const paths = await addImage(t.cluster.url(), assets, roomA);
    let moved = "";
    const result = await runBackup(
      {
        ...env,
        async afterList() {
          // As the server's deleteIfUnreferenced does: the row goes, the file moves to today's trash.
          const day = trashDay(new Date());
          for (const p of paths) {
            const to = join(assets, "trash", day, p);
            await mkdir(dirname(to), { recursive: true });
            await rename(join(assets, p), to);
            moved = to;
          }
        },
      },
      "manual",
    );
    assert.equal(result.outcome, "good", JSON.stringify(result));
    assert.ok(moved);
    for (const p of paths) assert.deepEqual(await readFile(join(backups, BACKUP_STORE, p)), await readFile(join(assets, "trash", trashDay(new Date()), p)));
  });

  test("a disk under the 2 GiB floor ends the run without deleting anything", async () => {
    const backupsBefore = (await readdir(backups)).sort();
    const storeBefore = await storeFiles();
    const failed = await runBackup({ ...env, freeBytes: async () => 2 * 1024 ** 3 + 10 }, "manual");
    assert.equal(failed.outcome, "failed");
    if (failed.outcome === "failed") assert.match(failed.reason, /not enough space for the dump/);
    assert.deepEqual((await readdir(backups)).sort(), backupsBefore);
    assert.deepEqual(await storeFiles(), storeBefore);

    // Room for the dump but not for a new image: partial, and nothing deleted.
    await addImage(t.cluster.url(), assets, roomA);
    let calls = 0;
    const partial = await runBackup({ ...env, freeBytes: async () => (calls++ === 0 ? 10 * 1024 ** 3 : 2 * 1024 ** 3 + 10) }, "manual");
    assert.equal(partial.outcome, "partial", JSON.stringify(partial));
    assert.deepEqual(await storeFiles(), storeBefore);
    for (const name of backupsBefore.filter((n) => n.endsWith(BACKUP_SUFFIX.good))) await stat(join(backups, name));
    // A partial run never counts.
    assert.equal((await listBackups(backups)).length, backupsBefore.filter((n) => n.endsWith(BACKUP_SUFFIX.good)).length);
  });

  test("a listed image found nowhere ends the run partial, with no completion record", async () => {
    const paths = await addImage(t.cluster.url(), assets, roomA);
    await rm(join(assets, paths[0] as string));
    const count = (await listBackups(backups)).length;
    const result = await runBackup(env, "manual");
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    if (result.outcome === "partial") assert.match(result.reason, /1 of \d+ listed images are not in the backup's store/);
    assert.equal((await listBackups(backups)).length, count);
    await query(t.cluster.url(), "delete from assets where sha256 = $1", [Buffer.from((paths[0] as string).slice(3, 67), "hex")]);
  });

  test("the next run clears what a stopped or partial run left", async () => {
    const result = await runBackup(env, "manual");
    assert.equal(result.outcome, "good");
    const names = await readdir(backups);
    const good = new Set(names.filter((n) => n.endsWith(BACKUP_SUFFIX.good)).map((n) => n.slice(0, -BACKUP_SUFFIX.good.length)));
    for (const n of names) {
      if (n === BACKUP_STORE) continue;
      assert.ok(!n.endsWith(".part"), n);
      const base = n.replace(/\.(dump|files|good\.json)$/, "");
      assert.ok(good.has(base), `${n} has no completion record`);
    }
  });
});

describe("retention", () => {
  test("old backups go, record first, and store files no kept list names with them", async () => {
    const all = await listBackups(backups);
    assert.ok(all.length >= 5);
    // A store file no list names, as a pruned backup leaves.
    const orphan = join(backups, BACKUP_STORE, "ff", `${"f".repeat(64)}-map-full-v1.webp`);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "x");
    // Far in the future, every daily and by-hand backup is past the last 4 weeks but the newest 7.
    const dropped = await applyRetention(backups, Date.now() + 365 * 24 * 3600 * 1000);
    const kept = await listBackups(backups);
    assert.equal(kept.filter((b) => b.record.kind !== "before-update").length, Math.min(7, all.filter((b) => b.record.kind !== "before-update").length));
    for (const name of dropped) {
      for (const suffix of Object.values(BACKUP_SUFFIX)) await assert.rejects(stat(join(backups, name + suffix)));
    }
    await assert.rejects(stat(orphan));
    await assert.rejects(stat(dirname(orphan)), "an empty shard folder goes too");
    // Every image a kept backup lists is still in the store.
    for (const b of kept) for (const p of (await readFileList(backups, b.name)) ?? []) await stat(join(backups, BACKUP_STORE, p));
  });
});
