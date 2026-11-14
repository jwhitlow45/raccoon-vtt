import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BACKUP_SUFFIX, type BackupSummary, type SupervisorStatus } from "../contract.ts";
import { listBackups } from "./backup.ts";
import { createRoom, query, roomNames, supervisorDbUrl } from "./testing/dataFixture.ts";
import { startSupervisor, type SupervisorRun } from "./testing/supervisorProcess.ts";

/**
 * Updates and going back (docs/design/design-v1-local-app.md 8.4), with real
 * supervisors that pretend to be other builds (RACCOONVTT_TEST_BUILD): the
 * before-update backup, the refusal of newer data, restoring out of it, and
 * the stops for a missing stamp and another PostgreSQL major.
 */

const PORT = 40432;
type TestBuild = { app: string; snapshotVersion: number; opVersion: number };
const OLD: TestBuild = { app: "0.4.0", snapshotVersion: 40, opVersion: 50 };
const NEW: TestBuild = { app: "0.5.0", snapshotVersion: 46, opVersion: 60 };
const OLDER_SAME_FORMATS: TestBuild = { app: "0.4.9", snapshotVersion: 46, opVersion: 60 };

let data: string;
let current: SupervisorRun | null = null;

async function start(build: TestBuild): Promise<{ run: SupervisorRun; status: SupervisorStatus }> {
  await stop();
  const run = startSupervisor({ data, port: PORT, env: { RACCOONVTT_TEST_BUILD: JSON.stringify(build) } });
  current = run;
  const status = await run.waitFor("running or an error", (s) => (s.state === "running" && !s.backingUp) || s.state === "error", 90_000);
  return { run, status };
}

async function stop(): Promise<void> {
  const run = current;
  current = null;
  if (run) await run.stop();
}

async function stamp(): Promise<{ app: string; snapshot_version: number; op_version: number }> {
  const rows = await query<{ app: string; snapshot_version: number; op_version: number }>(await supervisorDbUrl(data), "select app, snapshot_version, op_version from local_app_stamp");
  assert.equal(rows.length, 1);
  return rows[0] as { app: string; snapshot_version: number; op_version: number };
}

async function backups(run: SupervisorRun): Promise<BackupSummary[]> {
  const out = await run.command({ type: "listBackups" });
  assert.ok(out.ok);
  return (out.value as { backups: BackupSummary[] }).backups;
}

before(async () => {
  data = await mkdtemp(join(tmpdir(), "rvtt-upgrade-"));
});

after(async () => {
  await stop().catch(() => undefined);
  await rm(data, { recursive: true, force: true });
});

describe("updates and going back", () => {
  test("a first start stamps the data with its build", async () => {
    const { run, status } = await start(OLD);
    assert.equal(status.state, "running");
    // The first start's daily backup holds the data before any room, which a later test restores.
    await run.waitFor("the first daily backup", (s) => s.lastBackup !== null && !s.backingUp);
    await createRoom(await supervisorDbUrl(data), "Old room");
    assert.deepEqual(await stamp(), { app: "0.4.0", snapshot_version: 40, op_version: 50 });
  });

  test("a new version backs up first, with the old data's formats, then stamps and starts", async () => {
    const { run, status } = await start(NEW);
    assert.equal(status.state, "running");
    assert.ok(run.statuses.some((s) => s.step === "backupBeforeUpdate"));
    const before = (await listBackups(join(data, "backups"))).filter((b) => b.record.kind === "before-update");
    assert.equal(before.length, 1);
    assert.deepEqual(
      { dataApp: before[0]?.record.dataApp, snapshot: before[0]?.record.snapshotVersion, op: before[0]?.record.opVersion, forVersion: before[0]?.record.forVersion },
      { dataApp: "0.4.0", snapshot: 40, op: 50, forVersion: "0.5.0" },
    );
    assert.deepEqual(await stamp(), { app: "0.5.0", snapshot_version: 46, op_version: 60 });
    await createRoom(await supervisorDbUrl(data), "New room");
  });

  test("the older build is refused on the newer data, and offers the backups it reads", async () => {
    const { run, status } = await start(OLD);
    assert.deepEqual(status.error, { kind: "newerData", dataApp: "0.5.0" });
    const listed = await backups(run);
    assert.ok(listed.length >= 2);
    assert.ok(listed.every((b) => b.readable), JSON.stringify(listed));
    assert.ok(listed.some((b) => b.kind === "before-update" && b.forVersion === "0.5.0"));
  });

  test("restoring the before-update backup starts the older build, with no new before-update backup", async () => {
    const run = current as SupervisorRun;
    const target = (await backups(run)).find((b) => b.kind === "before-update") as BackupSummary;
    assert.deepEqual(await run.command({ type: "restore", backup: target.name }), { ok: true, value: {} });
    const status = await run.waitFor("running after the restore", (s) => s.state === "running" && s.restore === null && s.notice?.kind === "restored");
    assert.equal(status.error, null);
    assert.deepEqual(await roomNames(await supervisorDbUrl(data)), ["Old room"]);
    assert.equal((await listBackups(join(data, "backups"))).filter((b) => b.record.kind === "before-update").length, 1);
    assert.deepEqual(await stamp(), { app: "0.4.0", snapshot_version: 40, op_version: 50 });
  });

  test("this build restoring an old backup writes its own stamp when its server starts", async () => {
    await start(NEW);
    const run = current as SupervisorRun;
    const updates = (await listBackups(join(data, "backups"))).filter((b) => b.record.kind === "before-update").length;
    const daily = (await backups(run)).find((b) => b.kind === "daily") as BackupSummary;
    assert.ok(daily, "the first start's daily backup, made by the old build");
    const seq = run.latest()?.notice?.seq ?? 0;
    assert.equal((await run.command({ type: "restore", backup: daily.name })).ok, true);
    const done = await run.waitFor("running after the restore", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
    assert.equal(done.notice?.kind, "restored", JSON.stringify(done.notice));
    assert.deepEqual(await roomNames(await supervisorDbUrl(data)), [], "the first start's data, before any room");
    assert.deepEqual(await stamp(), { app: "0.5.0", snapshot_version: 46, op_version: 60 });
    assert.equal((await listBackups(join(data, "backups"))).filter((b) => b.record.kind === "before-update").length, updates, "a restore is no update");
    // A backup in this build's formats, which the older build cannot read.
    await createRoom(await supervisorDbUrl(data), "Newer room");
    assert.equal((await run.command({ type: "backupNow" })).ok, true);
  });

  test("quitting and starting the older build again is refused: the stamp holds this build's formats", async () => {
    const { status } = await start(OLD);
    assert.deepEqual(status.error, { kind: "newerData", dataApp: "0.5.0" });
  });

  test("with no backup the older build reads left, only the download is offered", async () => {
    await stop();
    for (const b of await listBackups(join(data, "backups"))) {
      if (b.record.snapshotVersion <= OLD.snapshotVersion && b.record.opVersion <= OLD.opVersion) {
        for (const suffix of Object.values(BACKUP_SUFFIX)) await rm(join(data, "backups", b.name + suffix), { force: true });
      }
    }
    assert.ok((await listBackups(join(data, "backups"))).length >= 1, "a backup only the newer build reads is still there");
    const { run, status } = await start(OLD);
    assert.deepEqual(status.error, { kind: "noReadableBackup", dataApp: "0.5.0" });
    assert.ok((await backups(run)).every((b) => !b.readable));
  });

  test("an older build with the same formats starts, after its own backup", async () => {
    const { run, status } = await start(OLDER_SAME_FORMATS);
    assert.equal(status.state, "running");
    assert.ok(run.statuses.some((s) => s.step === "backupBeforeUpdate"));
    assert.ok((await listBackups(join(data, "backups"))).some((b) => b.record.forVersion === "0.4.9" && b.record.dataApp === "0.5.0"));
    assert.deepEqual(await stamp(), { app: "0.4.9", snapshot_version: 46, op_version: 60 });
  });

  test("a failed before-update backup starts nothing, Try again retries it, and Start without a backup starts", async () => {
    await stop();
    // A file where the image store goes stops any backup, on every system.
    const store = join(data, "backups", "assets");
    await rename(store, `${store}.aside`);
    await writeFile(store, "not a folder");
    try {
      const { run, status } = await start(NEW);
      assert.equal(status.error?.kind, "backupBeforeUpdateFailed");
      assert.equal(status.port, null, "no server started");
      assert.deepEqual(await stamp(), { app: "0.4.9", snapshot_version: 46, op_version: 60 });
      assert.equal((await run.command({ type: "retry" })).ok, true);
      assert.equal(run.latest()?.error?.kind, "backupBeforeUpdateFailed");
      assert.equal((await run.command({ type: "startWithoutBackup" })).ok, true);
      await run.waitFor("running", (s) => s.state === "running");
      assert.deepEqual(await stamp(), { app: "0.5.0", snapshot_version: 46, op_version: 60 });
    } finally {
      await stop();
      await rm(store, { force: true });
      await rename(`${store}.aside`, store);
    }
    const { status } = await start(OLDER_SAME_FORMATS);
    assert.equal(status.state, "running", "the next update backs up again once the store is a folder again");
  });

  test("a database with rooms and no stamp row stops the start and offers a restore", async () => {
    await query(await supervisorDbUrl(data), "drop table local_app_stamp");
    const { status } = await start(NEW);
    assert.deepEqual(status.error, { kind: "noStamp" });
  });

  test("another PostgreSQL major stops the start, naming both", async () => {
    await stop();
    const file = join(data, "postgres", "PG_VERSION");
    const real = await readFile(file, "utf8");
    await writeFile(file, "18\n");
    try {
      const { status } = await start(NEW);
      assert.deepEqual(status.error, { kind: "pgMajor", dataMajor: 18, bundledMajor: 17 });
    } finally {
      await stop();
      await writeFile(file, real);
    }
  });
});
