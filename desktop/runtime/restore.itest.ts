import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { BACKUP_STORE, BACKUP_SUFFIX, LOG_FILES, Platform, type RestoreJournal, type SupervisorStatus } from "../contract.ts";
import { listBackups, readFileList, runBackup } from "./backup.ts";
import { deleteJournal, readJournal, writeJournal } from "./journal.ts";
import { Cluster } from "./postgres.ts";
import { BEFORE, LIVE, RESTORING, checkRestorable, noHooks, parseRecord, runRestore, type CrashPoint, type DbName, type ImageFs, type RestoreContext, type RestoreDb } from "./restore.ts";
import { clusterRestoreDb, nodeImageFs } from "./restoreDb.ts";
import { postgresDir, startTestCluster, type TestCluster } from "./testing/cluster.ts";
import { addImage, createRoom, missingImages, query, restoreDatabases, roomNames, supervisorDbUrl } from "./testing/dataFixture.ts";
import { startSupervisor, type SupervisorRun } from "./testing/supervisorProcess.ts";
import { writeStamp, type Build } from "./versionGuard.ts";

/**
 * Restore against the real cluster (docs/design/design-v1-local-app.md 8.3):
 * every row of the next start's table, reached by killing a real
 * supervisor at its crash point, and again with the journal write before
 * that point dropped. Each next start must end with the old data or the
 * restored data whole, its images present, no other restore database left,
 * and the notice its row says. Then the order of the file and database
 * calls, and the cases of their own under the table.
 */

const PORT = 40431;
const NAME = "raccoon-backup";
let data: string;
let backup: string;
let current: SupervisorRun | null = null;

async function startAndWait(env: Record<string, string> = {}): Promise<{ run: SupervisorRun; status: SupervisorStatus }> {
  const run = startSupervisor({ data, port: PORT, env });
  current = run;
  const status = await run.waitFor("running or an error", (s) => s.state === "running" || s.state === "error", 90_000);
  return { run, status };
}

async function stopCurrent(): Promise<void> {
  const run = current;
  current = null;
  if (run) await run.stop();
}

async function url(): Promise<string> {
  return supervisorDbUrl(data);
}

/** Live data differs from the backup by one room, "After", so each outcome is plain. */
async function ensureAfter(): Promise<void> {
  const u = await url();
  if ((await roomNames(u)).includes("After")) return;
  const id = await createRoom(u, "After");
  await addImage(u, join(data, "assets"), id);
}

type Outcome = "old" | "restored";

async function check(status: SupervisorStatus, outcome: Outcome, notice: string | null): Promise<void> {
  assert.equal(status.state, "running", `the start ended ${status.state}: ${JSON.stringify(status.error)}`);
  const u = await url();
  const names = await roomNames(u);
  assert.ok(names.includes("Before"), `the data lost a room both have: ${names.join(", ")}`);
  assert.equal(names.includes("After"), outcome === "old", `expected the ${outcome} data, rooms: ${names.join(", ")}`);
  assert.deepEqual(Object.keys(await restoreDatabases(await supervisorDbUrl(data, "postgres"))), [LIVE]);
  assert.deepEqual(await missingImages(u, join(data, "assets")), []);
  assert.equal(await readJournal(join(data, "restore.json")), null);
  assert.equal(status.notice?.kind ?? null, notice, `notice ${JSON.stringify(status.notice)}`);
}

/** Starts a supervisor with test variables, restores, lets it die at its point, then starts a plain one. */
async function crashThenStart(env: Record<string, string>): Promise<SupervisorStatus> {
  await stopCurrent();
  const { run } = await startAndWait(env);
  await ensureAfter();
  const reply = run.command({ type: "restore", backup });
  const first = await Promise.race([reply, run.exited.then(() => null)]);
  if (first !== null) assert.equal(first.ok, true, JSON.stringify(first));
  const exit = await run.exited;
  current = null;
  const meant = `the supervisor was meant to die at ${env.RESTORE_TEST_CRASH_AT}: ${run.output().slice(-2000)}`;
  // Windows has no signals: a process that kills itself ends with code 1.
  assert.deepEqual(exit, process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" }, meant);
  const said = await readFile(join(data, "logs", LOG_FILES.supervisor), "utf8");
  assert.ok(said.trimEnd().endsWith(`killed at the restore point ${env.RESTORE_TEST_CRASH_AT}, for a test`), meant);
  return (await startAndWait()).status;
}

before(async () => {
  data = await mkdtemp(join(tmpdir(), "rvtt-restore-"));
  const { run } = await startAndWait();
  const u = await url();
  const id = await createRoom(u, "Before");
  await addImage(u, join(data, "assets"), id);
  await addImage(u, join(data, "assets"), id);
  // The first start's daily backup runs in the background. Back up now would be busy beside it.
  await run.waitFor("the first daily backup", (s) => s.lastBackup !== null && !s.backingUp);
  assert.deepEqual(await run.command({ type: "backupNow" }), { ok: true, value: {} });
  const listed = await listBackups(join(data, "backups"));
  assert.equal(listed.length, 2, "the first start's daily backup and this one");
  backup = (listed.find((b) => b.record.kind === "manual") as { name: string }).name;
});

after(async () => {
  await stopCurrent().catch(() => undefined);
  await rm(data, { recursive: true, force: true });
});

// Each: the crash point, the journal states whose writes are dropped, what fails first, and the end.
const ROWS: Array<{ at: CrashPoint; drop?: string; fail?: CrashPoint; outcome: Outcome; notice: "restoreInterrupted" | "restoreFinished" | null; row: string }> = [
  { at: "preparing", outcome: "old", notice: "restoreInterrupted", row: "R not own: journal deleted" },
  { at: "images", outcome: "old", notice: "restoreInterrupted", row: "R not own: journal deleted" },
  { at: "created", outcome: "old", notice: "restoreInterrupted", row: "R and N restoring: N dropped" },
  { at: "loaded", outcome: "old", notice: "restoreInterrupted", row: "R and N restoring: N dropped" },
  { at: "restored", outcome: "old", notice: "restoreInterrupted", row: "R and N restored: N dropped" },
  { at: "swapping", outcome: "old", notice: "restoreInterrupted", row: "R and N, journal swapping: N dropped" },
  { at: "renamedLive", outcome: "restored", notice: "restoreFinished", row: "no R, B, N restored: N renamed, then finished" },
  { at: "renamedRestoring", outcome: "restored", notice: "restoreFinished", row: "R own, B, swapping: finish" },
  { at: "finishing", outcome: "restored", notice: "restoreFinished", row: "R own, B, finishing: finish" },
  { at: "dropped", outcome: "restored", notice: "restoreFinished", row: "R own restored, no B: tagged finished" },
  { at: "finished", outcome: "restored", notice: "restoreFinished", row: "R own finished: journal deleted" },
  { at: "journalDeleted", outcome: "restored", notice: null, row: "R, no journal: nothing" },
  // The journal write before the point lost.
  { at: "preparing", drop: "preparing", outcome: "old", notice: null, row: "R, no journal: nothing" },
  { at: "loaded", drop: "preparing", outcome: "old", notice: null, row: "R and N, no journal: N dropped, then nothing" },
  { at: "swapping", drop: "swapping", outcome: "old", notice: "restoreInterrupted", row: "R and N, journal preparing: N dropped" },
  { at: "renamedLive", drop: "swapping", outcome: "old", notice: "restoreInterrupted", row: "no R, B, N restored, preparing: N renamed, then undone" },
  { at: "renamedRestoring", drop: "swapping", outcome: "old", notice: "restoreInterrupted", row: "R restored, B, preparing: undo" },
  { at: "finishing", drop: "finishing", outcome: "restored", notice: "restoreFinished", row: "R own, B, swapping: finish" },
  { at: "dropped", drop: "finishing", outcome: "restored", notice: "restoreFinished", row: "R own restored, swapping: tagged finished" },
  { at: "finished", drop: "finishing", outcome: "restored", notice: "restoreFinished", row: "R own finished, swapping: journal deleted" },
  // Undo, after a failure, cut off.
  { at: "undoing", fail: "renamedRestoring", outcome: "old", notice: "restoreInterrupted", row: "no R, B, N restored, undoing: B renamed back" },
  { at: "undoing", fail: "renamedRestoring", drop: "undoing", outcome: "restored", notice: "restoreFinished", row: "no R, B, N restored, swapping: N renamed, then finished" },
  { at: "undoing", fail: "dropped", outcome: "old", notice: "restoreInterrupted", row: "R restored, B, undoing: undo" },
  { at: "undoDropped", fail: "dropped", outcome: "old", notice: "restoreInterrupted", row: "no R, B, no N: B renamed back" },
  { at: "undoRenamed", fail: "dropped", outcome: "old", notice: "restoreInterrupted", row: "R not own, undoing: journal deleted" },
];

describe("a supervisor killed at each crash point", () => {
  for (const r of ROWS) {
    const label = `${r.at}${r.drop ? `, ${r.drop} write lost` : ""}${r.fail ? `, after ${r.fail} failed` : ""}: ${r.row}`;
    test(label, async () => {
      const env: Record<string, string> = { RESTORE_TEST_CRASH_AT: r.at };
      if (r.drop) env.RESTORE_TEST_DROP_JOURNAL = r.drop;
      if (r.fail) env.RESTORE_TEST_FAIL_BEFORE = r.fail;
      const status = await crashThenStart(env);
      await check(status, r.outcome, r.notice);
    });
  }
});

/** The cluster under a stopped supervisor, for states no step leaves. */
async function bareCluster(): Promise<Cluster> {
  const secrets = JSON.parse(await readFile(join(data, "secrets.json"), "utf8")) as { databasePassword: string };
  const c = new Cluster({
    binDir: join(postgresDir(), "bin"),
    pgData: join(data, "postgres"),
    logFile: join(data, "logs", "postgres.log"),
    password: secrets.databasePassword,
    platform: Platform.parse(process.platform),
  });
  await c.start();
  return c;
}

describe("states no step leaves", () => {
  test("N tagged restoring beside B, with no raccoon: B renamed back, N dropped", async () => {
    await stopCurrent();
    const c = await bareCluster();
    const admin = c.url("postgres");
    const id = "a".repeat(32);
    await query(admin, `alter database ${LIVE} rename to ${BEFORE}`);
    await query(admin, `create database ${RESTORING} template template0`);
    await query(admin, `comment on database ${RESTORING} is 'raccoonvtt-restoring:${id}'`);
    await c.stop();
    await writeJournal(join(data, "restore.json"), { id, backup, state: "swapping" });
    const { status } = await startAndWait();
    // Whatever the live data was before, it is back, alone.
    assert.equal(status.state, "running");
    assert.deepEqual(Object.keys(await restoreDatabases(await supervisorDbUrl(data, "postgres"))), [LIVE]);
    assert.equal(status.notice?.kind, "restoreInterrupted");
    assert.equal(await readJournal(join(data, "restore.json")), null);
  });

  test("raccoon, B and N together stop the start, and nothing is deleted", async () => {
    await stopCurrent();
    const c = await bareCluster();
    const admin = c.url("postgres");
    await query(admin, `create database ${BEFORE} template template0`);
    await query(admin, `create database ${RESTORING} template template0`);
    await c.stop();
    const { run, status } = await startAndWait();
    assert.equal(status.state, "error");
    assert.deepEqual(status.error, { kind: "restoreTangled" });
    assert.deepEqual(Object.keys(await restoreDatabases(await supervisorDbUrl(data, "postgres"))).sort(), [LIVE, BEFORE, RESTORING].sort());
    // Sorted out by hand, a retry starts.
    await query(await supervisorDbUrl(data, "postgres"), `drop database ${BEFORE}`);
    await query(await supervisorDbUrl(data, "postgres"), `drop database ${RESTORING}`);
    assert.equal((await run.command({ type: "retry" })).ok, true);
    await run.waitFor("running", (s) => s.state === "running");
  });
});

describe("cases of their own", () => {
  test("a restore that runs through: restored data, the restored notice, the server back", async () => {
    await stopCurrent();
    const { run } = await startAndWait();
    await ensureAfter();
    assert.deepEqual(await run.command({ type: "restore", backup }), { ok: true, value: {} });
    const status = await run.waitFor("the restored notice and running", (s) => s.notice?.kind === "restored" && s.state === "running" && s.restore === null);
    await check(status, "restored", "restored");
    assert.ok(run.statuses.some((s) => s.state === "restoring" && s.restore === "images"));
    assert.ok(run.statuses.some((s) => s.restore === "database"));
  });

  test("Back up now and Rooms on this computer are refused while a restore runs", async () => {
    const run = current as SupervisorRun;
    await ensureAfter();
    const restoring = run.command({ type: "restore", backup });
    const answer = await restoring;
    assert.equal(answer.ok, true);
    const [backupNow, rooms] = await Promise.all([run.command({ type: "backupNow" }), run.command({ type: "listRooms" })]);
    assert.deepEqual(backupNow, { ok: false, failure: { error: "restoring" } });
    assert.deepEqual(rooms, { ok: false, failure: { error: "restoring" } });
    const second = await run.command({ type: "restore", backup });
    assert.deepEqual(second, { ok: false, failure: { error: "busy" } });
    await run.waitFor("running again", (s) => s.state === "running" && s.restore === null && s.notice?.kind === "restored");
  });

  test("a session held open on raccoon is ended before the renames", async () => {
    const run = current as SupervisorRun;
    await ensureAfter();
    const held = new pg.Client({ connectionString: await url() });
    let ended = false;
    held.on("error", () => (ended = true));
    await held.connect();
    await held.query("begin");
    await held.query("select count(*) from rooms");
    const seq = run.latest()?.notice?.seq ?? 0;
    assert.equal((await run.command({ type: "restore", backup })).ok, true);
    const status = await run.waitFor("restored", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
    await check(status, "restored", "restored");
    await assert.rejects(held.query("select 1"));
    void ended;
    await held.end().catch(() => undefined);
  });

  test("an image deleted from assets/ after step 3, with the journal still there, is copied back by finish", async () => {
    await ensureAfter();
    await stopCurrent();
    const { run } = await startAndWait({ RESTORE_TEST_CRASH_AT: "renamedRestoring" });
    await ensureAfter();
    void run.command({ type: "restore", backup });
    await run.exited;
    current = null;
    const list = (await readFileList(join(data, "backups"), backup)) ?? [];
    const gone = join(data, "assets", list[0] as string);
    await rm(gone);
    const { status } = await startAndWait();
    await check(status, "restored", "restoreFinished");
    assert.deepEqual(await readFile(gone), await readFile(join(data, "backups", BACKUP_STORE, list[0] as string)));
  });

  test("an image the backup lists that is already in assets/ is still there, unchanged", async () => {
    const run = current as SupervisorRun;
    await ensureAfter();
    const list = (await readFileList(join(data, "backups"), backup)) ?? [];
    const kept = join(data, "assets", list[1] as string);
    const bytes = await readFile(kept);
    const seq = run.latest()?.notice?.seq ?? 0;
    assert.equal((await run.command({ type: "restore", backup })).ok, true);
    await run.waitFor("restored", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
    assert.deepEqual(await readFile(kept), bytes);
  });

  test("a damaged dump fails the restore, and nothing changes", async () => {
    const run = current as SupervisorRun;
    await ensureAfter();
    assert.equal((await run.command({ type: "backupNow" })).ok, true);
    const damaged = (await listBackups(join(data, "backups"))).at(-1)?.name as string;
    await truncate(join(data, "backups", damaged + BACKUP_SUFFIX.dump), 200);
    const seq = run.latest()?.notice?.seq ?? 0;
    assert.equal((await run.command({ type: "restore", backup: damaged })).ok, true);
    const status = await run.waitFor("the failure", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
    await check(status, "old", "restoreFailed");
    await rm(join(data, "backups", damaged + BACKUP_SUFFIX.good));
  });

  test("an image that fails to copy fails the restore, and nothing changes", async (t) => {
    if (process.platform === "win32") return t.skip("folder permissions work otherwise on Windows");
    const run = current as SupervisorRun;
    await ensureAfter();
    const list = (await readFileList(join(data, "backups"), backup)) ?? [];
    const target = join(data, "assets", list[0] as string);
    await rm(target);
    await chmod(dirname(target), 0o500);
    try {
      const seq = run.latest()?.notice?.seq ?? 0;
      assert.equal((await run.command({ type: "restore", backup })).ok, true);
      const status = await run.waitFor("the failure", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
      assert.equal(status.notice?.kind, "restoreFailed");
      assert.ok((await roomNames(await url())).includes("After"));
      assert.deepEqual(Object.keys(await restoreDatabases(await supervisorDbUrl(data, "postgres"))), [LIVE]);
    } finally {
      await chmod(dirname(target), 0o700);
      await copyFile(join(data, "backups", BACKUP_STORE, list[0] as string), target);
    }
  });

  test("a finished restore's journal put back after retention pruned its backup is deleted without it", async () => {
    const run = current as SupervisorRun;
    await ensureAfter();
    assert.equal((await run.command({ type: "backupNow" })).ok, true);
    const pruned = (await listBackups(join(data, "backups"))).at(-1)?.name as string;
    const seq = run.latest()?.notice?.seq ?? 0;
    assert.equal((await run.command({ type: "restore", backup: pruned })).ok, true);
    await run.waitFor("restored", (s) => s.state === "running" && s.restore === null && (s.notice?.seq ?? 0) > seq);
    const comment = (await restoreDatabases(await supervisorDbUrl(data, "postgres")))[LIVE] ?? "";
    const id = /raccoonvtt-finished:([0-9a-f]{32})/.exec(comment)?.[1];
    assert.ok(id, comment);
    await stopCurrent();
    for (const suffix of Object.values(BACKUP_SUFFIX)) await rm(join(data, "backups", pruned + suffix));
    await writeJournal(join(data, "restore.json"), { id, backup: pruned, state: "finishing" });
    const { status } = await startAndWait();
    assert.equal(status.state, "running");
    assert.equal(status.notice?.kind, "restoreFinished");
    assert.equal(await readJournal(join(data, "restore.json")), null);
  });
});

// ---------------------------------------------------------------------------
// The order of the calls, in-process on a cluster of its own

describe("call order", () => {
  let t: TestCluster;
  let assets: string;
  let backups: string;
  let name: string;
  const build: Build = { app: "0.5.0", snapshotVersion: 46, opVersion: 60, pgMajor: 17 };

  before(async () => {
    t = await startTestCluster("rvtt-restore-order-");
    await query(t.cluster.url("postgres"), "create database raccoon template template0");
    assets = join(t.dir, "assets");
    backups = join(t.dir, "backups");
    await mkdir(backups, { recursive: true });
    const id = await createRoom(t.cluster.url(), "Ordered");
    await addImage(t.cluster.url(), assets, id);
    await addImage(t.cluster.url(), assets, id);
    const pool = t.pool("raccoon");
    await writeStamp(pool, build);
    const result = await runBackup({ cluster: t.cluster, pool, backupsDir: backups, assetsDir: assets, log: () => undefined }, "manual");
    assert.equal(result.outcome, "good");
    if (result.outcome === "good") name = result.name;
    await pool.end();
  });

  after(async () => {
    await t?.stop();
  });

  function recorded(calls: string[]): { db: RestoreDb; fs: ImageFs } {
    const real = clusterRestoreDb(t.cluster);
    const db: RestoreDb = {
      state: () => real.state(),
      createRestoring: async (tag) => (calls.push("db create"), real.createRestoring(tag)),
      setTag: async (n, tag) => (calls.push(`db tag ${n} ${tag.kind}`), real.setTag(n, tag)),
      rename: async (from: DbName, to: DbName) => (calls.push(`db rename ${from} ${to}`), real.rename(from, to)),
      drop: async (n) => (calls.push(`db drop ${n}`), real.drop(n)),
      endSessions: (names) => real.endSessions(names),
      load: async (f) => (calls.push("db load"), real.load(f)),
      stampRestored: (b, r) => real.stampRestored(b, r),
    };
    const fs: ImageFs = {
      ...nodeImageFs,
      mkdir: async (p) => (calls.push(`mkdir ${p}`), nodeImageFs.mkdir(p)),
      copy: async (a, b) => (calls.push(`copy ${b}`), nodeImageFs.copy(a, b)),
      syncFile: async (p) => (calls.push(`syncFile ${p}`), nodeImageFs.syncFile(p)),
      syncDir: async (p) => (calls.push(`syncDir ${p}`), nodeImageFs.syncDir(p)),
    };
    return { db, fs };
  }

  test("every listed image and its folder flushed before any rename, a new shard folder's parent too, and no drop before the swap", async () => {
    const list = (await readFileList(backups, name)) ?? [];
    // A shard folder gone entirely, so the restore must make it again.
    await rm(join(assets, dirname(list[0] as string)), { recursive: true, force: true });
    const calls: string[] = [];
    const { db, fs } = recorded(calls);
    const journalFile = join(t.dir, "restore.json");
    const ctx: RestoreContext = {
      db,
      fs,
      journal: { read: () => readJournal(journalFile), write: (j: RestoreJournal) => writeJournal(journalFile, j), delete: () => deleteJournal(journalFile) },
      backupsDir: backups,
      assetsDir: assets,
      build,
      hooks: noHooks,
      log: () => undefined,
      freeBytes: async () => 100 * 1024 ** 3,
      floorBytes: 2 * 1024 ** 3,
      readRecord: async (n) => parseRecord(await readFile(join(backups, n + BACKUP_SUFFIX.good), "utf8")),
    };
    const checked = await checkRestorable(ctx, name);
    assert.ok(checked.ok);
    if (!checked.ok) return;
    const out = await runRestore(ctx, name, checked, () => undefined);
    assert.deepEqual(out, { ok: true });
    assert.ok(t.given.includes(join(backups, name + BACKUP_SUFFIX.dump)), "pg_restore gets the dump by PostgreSQL's spelling of its path");
    const firstRename = calls.findIndex((c) => c.startsWith("db rename"));
    assert.ok(firstRename > 0, calls.join("\n"));
    for (const p of list) {
      const file = join(assets, p);
      const synced = calls.indexOf(`syncFile ${file}`);
      const folder = calls.indexOf(`syncDir ${dirname(file)}`);
      assert.ok(synced >= 0 && synced < firstRename, `${p} flushed before the renames`);
      assert.ok(folder >= 0 && folder < firstRename, `${p}'s folder flushed before the renames`);
    }
    const made = calls.indexOf(`mkdir ${join(assets, dirname(list[0] as string))}`);
    const parent = calls.indexOf(`syncDir ${assets}`);
    assert.ok(made >= 0 && parent > made && parent < firstRename, calls.join("\n"));
    const secondRename = calls.indexOf(`db rename ${RESTORING} ${LIVE}`);
    const drop = calls.indexOf(`db drop ${BEFORE}`);
    assert.ok(secondRename > firstRename && drop > secondRename, calls.join("\n"));
    assert.ok(!calls.includes(`db drop ${LIVE}`));
    assert.ok(calls.indexOf(`db tag ${RESTORING} restored`) < firstRename);
    assert.equal((await query<{ app: string }>(t.cluster.url(), "select app from local_app_stamp"))[0]?.app, "0.5.0");
    await stat(join(assets, list[0] as string));
  });
});

