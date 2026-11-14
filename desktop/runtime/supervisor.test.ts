import assert from "node:assert/strict";
import { test } from "node:test";
import { CRASH_RESTART_MS } from "./supervisor.ts";
import { BUILD, Instance, World } from "./testing/fakeWorld.ts";

/**
 * The supervisor's states one case at a time (docs/design/design-v1-local-app.md
 * 8.4, 9, 10 and 14), on the in-memory computer the randomized test uses.
 */

async function run(world: World, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) await world.clock.advance(250);
}

async function started(world: World, inst = new Instance(world)): Promise<Instance> {
  void inst.sup.start();
  await run(world, 5_000);
  return inst;
}

async function answer(world: World, inst: Instance, command: Parameters<Instance["issue"]>[0], ms = 10_000) {
  const id = inst.issue(command);
  for (let t = 0; t < ms && !inst.answers.has(id); t += 50) await world.clock.advance(50);
  const got = inst.answers.get(id)?.[0];
  assert.ok(got, `no answer to ${command.type}`);
  return got;
}

test("a first start sets up the database, picks port 3170 and saves it", async () => {
  const world = new World();
  const inst = await started(world);
  const steps = inst.statuses.map((s) => s.step);
  assert.ok(steps.includes("initdb"), "the initdb step shows");
  assert.equal(inst.latest()?.state, "running");
  assert.equal(world.settings.port, 3170);
  assert.equal(inst.latest()?.port, 3170);
  assert.equal(world.dbs.get("raccoon")?.stamp?.app, BUILD.app);
  assert.deepEqual(world.violations, []);
});

test("a crash restarts the server after 1, 2, 4, 8 and 16 s, then stops with the log's last line", async () => {
  const world = new World();
  world.seed();
  world.crashAfterMs = 500;
  const inst = await started(world);
  await run(world, 60_000);
  const gaps = world.serverStarts.slice(1).map((t, i) => t - (world.serverStarts[i] as number) - 500);
  // The design's waits, written out, so a change to the constant has to change this test too.
  assert.deepEqual(gaps, [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.deepEqual([...CRASH_RESTART_MS], gaps);
  const error = inst.latest()?.error;
  assert.deepEqual(error, { kind: "serverCrashed", logLine: "fake server crashed" });
  // Try again starts afresh, with the waits from the beginning.
  world.crashAfterMs = null;
  assert.equal((await answer(world, inst, { type: "retry" })).ok, true);
  assert.equal(inst.latest()?.state, "running");
});

test("a server that ran a minute has its crashes forgiven", async () => {
  const world = new World();
  world.seed();
  world.crashAfterMs = 61_000;
  const inst = await started(world);
  await run(world, 8 * 63_000);
  assert.ok(world.serverStarts.length >= 7, `${world.serverStarts.length} starts`);
  assert.notEqual(inst.latest()?.state, "error");
});

test("Windows: a public network binds loopback, and a private one restarts the server for players", async () => {
  const world = new World();
  world.platform = "win32";
  world.profile = "public";
  world.seed();
  const inst = await started(world);
  assert.equal(inst.latest()?.network, "public");
  assert.equal(inst.latest()?.host, "127.0.0.1");
  assert.equal(inst.latest()?.shareOrigin, null);
  world.setProfile("open");
  await run(world, 5_000);
  assert.ok(inst.statuses.some((s) => s.step === "openToNetwork"));
  assert.equal(inst.latest()?.host, "0.0.0.0");
  assert.equal(inst.latest()?.shareOrigin, "http://10.0.0.20:3170");
  world.setProfile("domain");
  await run(world, 5_000);
  assert.equal(inst.latest()?.host, "127.0.0.1");
  assert.equal(inst.latest()?.network, "domain");
});

test("the switch restarts the server on the other address and saves the setting", async () => {
  const world = new World();
  world.seed();
  const inst = await started(world);
  assert.equal(inst.latest()?.host, "0.0.0.0");
  assert.equal((await answer(world, inst, { type: "setNetworkPlay", on: false })).ok, true);
  assert.ok(inst.statuses.some((s) => s.step === "closeToNetwork"));
  assert.equal(inst.latest()?.host, "127.0.0.1");
  assert.equal(inst.latest()?.network, "off");
  assert.equal(world.settings.networkPlay, false);
});

test("a saved port taken at a later start offers the next one, and taking it starts the server there", async () => {
  const world = new World();
  world.seed();
  world.settings = { ...world.settings, port: 3170 };
  world.portTaken.add(3170);
  const inst = await started(world, new Instance(world));
  await run(world, 10_000);
  assert.deepEqual(inst.latest()?.error, { kind: "portInUse", port: 3170, next: 3171 });
  assert.equal((await answer(world, inst, { type: "setPort", port: 3171 })).ok, true);
  assert.equal(inst.latest()?.state, "running");
  assert.equal(inst.latest()?.port, 3171);
  assert.equal(world.settings.port, 3171);
});

test("Back up now and the rooms are refused during a restore, and a second backup while one runs is busy", async () => {
  const world = new World();
  world.seed();
  const inst = await started(world);
  await run(world, 5_000);
  const name = world.backups.at(-1)?.name;
  assert.ok(name, "the first start's daily backup");
  const backing = inst.issue({ type: "backupNow" });
  await world.clock.advance(10);
  assert.deepEqual(await answer(world, inst, { type: "backupNow" }), { ok: false, failure: { error: "busy" } });
  await run(world, 3_000);
  assert.equal(inst.answers.get(backing)?.[0]?.ok, true);

  const restoring = inst.issue({ type: "restore", backup: name });
  for (let t = 0; t < 1_000 && !inst.answers.has(restoring); t += 1) await world.clock.advance(1);
  assert.equal(inst.answers.get(restoring)?.[0]?.ok, true);
  // All three at once, while the restore runs.
  const ids = [inst.issue({ type: "backupNow" }), inst.issue({ type: "listRooms" }), inst.issue({ type: "restore", backup: name })];
  await world.clock.advance(1);
  assert.equal(inst.latest()?.state, "restoring");
  assert.deepEqual(
    ids.map((id) => inst.answers.get(id)?.[0]),
    [
      { ok: false, failure: { error: "restoring" } },
      { ok: false, failure: { error: "restoring" } },
      { ok: false, failure: { error: "busy" } },
    ],
  );
  await run(world, 10_000);
  assert.equal(inst.latest()?.state, "running");
  assert.equal(inst.latest()?.notice?.kind, "restored");
  assert.equal(world.dbs.get("raccoon")?.content, `restored:${name}`);
  assert.deepEqual(world.violations, []);
});

test("an update backs up first, with the old formats, then stamps the data as this build's", async () => {
  const world = new World();
  world.seed({ app: "0.4.0", snapshotVersion: 44, opVersion: 58 });
  const inst = await started(world);
  await run(world, 5_000);
  assert.ok(inst.statuses.some((s) => s.step === "backupBeforeUpdate"));
  const before = world.backups.find((b) => b.record.kind === "before-update");
  assert.equal(before?.record.dataApp, "0.4.0");
  assert.equal(before?.record.snapshotVersion, 44);
  assert.equal(before?.record.forVersion, BUILD.app);
  assert.equal(world.dbs.get("raccoon")?.stamp?.app, BUILD.app);
  assert.equal(inst.latest()?.state, "running");
});

test("a failed backup before an update starts nothing until Start without a backup", async () => {
  const world = new World();
  world.seed({ app: "0.4.0" });
  world.backupFails = true;
  const inst = await started(world);
  assert.deepEqual(inst.latest()?.error, { kind: "backupBeforeUpdateFailed", reason: "the disk is full" });
  assert.equal(world.serverStarts.length, 0);
  assert.equal(world.dbs.get("raccoon")?.stamp?.app, "0.4.0", "the stamp is untouched");
  await answer(world, inst, { type: "retry" });
  assert.equal(inst.latest()?.error?.kind, "backupBeforeUpdateFailed");
  await answer(world, inst, { type: "startWithoutBackup" });
  assert.equal(inst.latest()?.state, "running");
  assert.equal(world.dbs.get("raccoon")?.stamp?.app, BUILD.app);
});

test("data a newer build saved is refused, offering a restore only when a readable backup exists", async () => {
  const world = new World();
  world.seed({ app: "0.6.0", snapshotVersion: BUILD.snapshotVersion + 1 });
  const inst = await started(world);
  assert.deepEqual(inst.latest()?.error, { kind: "noReadableBackup", dataApp: "0.6.0" });
  world.backups.push({
    name: "raccoon-2026-10-30-120000-aaaaaaaa",
    record: {
      started: "2026-10-30T12:00:00.000Z",
      finished: "2026-10-30T12:00:01.000Z",
      kind: "before-update",
      dataApp: BUILD.app,
      snapshotVersion: BUILD.snapshotVersion,
      opVersion: BUILD.opVersion,
      pgMajor: 17,
      forVersion: "0.6.0",
      dumpBytes: 1,
      dbBytes: 1,
      images: 0,
    },
  });
  await answer(world, inst, { type: "retry" });
  assert.deepEqual(inst.latest()?.error, { kind: "newerData", dataApp: "0.6.0" });
  assert.equal(world.serverStarts.length, 0);
  // Restoring the before-update backup brings back its own stamp, and the start goes on with no new backup.
  assert.equal((await answer(world, inst, { type: "restore", backup: "raccoon-2026-10-30-120000-aaaaaaaa" })).ok, true);
  await run(world, 10_000);
  assert.equal(inst.latest()?.state, "running");
  assert.equal(world.backups.filter((b) => b.record.kind === "before-update").length, 1);
});

test("a database with rooms and no stamp stops the start", async () => {
  const world = new World();
  world.seed();
  world.dbs.get("raccoon")!.stamp = null;
  const inst = await started(world);
  assert.deepEqual(inst.latest()?.error, { kind: "noStamp" });
  assert.equal(world.serverStarts.length, 0);
});

test("stop answers only once the server is closed and PostgreSQL has shut down, and frees the lock", async () => {
  const world = new World();
  world.seed();
  const inst = await started(world);
  const id = inst.issue({ type: "stop" });
  let pgAtAnswer: boolean | null = null;
  for (let t = 0; t < 10_000 && !inst.answers.has(id); t += 10) {
    await world.clock.advance(10);
    if (inst.answers.has(id)) pgAtAnswer = world.pg.running;
  }
  assert.equal(pgAtAnswer, false);
  assert.equal(world.serving().length, 0);
  assert.equal(world.lockOwner, null);
  assert.equal(inst.latest()?.state, "stopped");
});

test("PostgreSQL crashing stops the server, starts PostgreSQL again and restarts the server", async () => {
  const world = new World();
  world.seed();
  const inst = await started(world);
  const epoch = world.pg.epoch;
  world.crashPostgres();
  await run(world, 10_000);
  assert.equal(world.pg.running, true);
  assert.ok(world.pg.epoch > epoch);
  assert.equal(world.serving().length, 1);
  assert.equal(inst.latest()?.state, "running");
  assert.deepEqual(world.violations, []);
});

test("a supervisor killed with PostgreSQL running leaves it to the next one, which stops and starts it", async () => {
  const world = new World();
  world.seed();
  const first = await started(world);
  first.kill();
  assert.equal(world.pg.running, true);
  const next = await started(world);
  assert.equal(next.latest()?.state, "running");
  assert.deepEqual(world.violations, []);
});

test("the daily backup runs once the server is up, then again only after 24 hours", async () => {
  const world = new World();
  world.seed();
  await started(world);
  await run(world, 5_000);
  const daily = () => world.backups.filter((b) => b.record.kind === "daily").length;
  assert.equal(daily(), 1);
  await world.clock.advance(2 * 60 * 60 * 1000);
  assert.equal(daily(), 1);
  await world.clock.advance(23 * 60 * 60 * 1000);
  await run(world, 5_000);
  assert.equal(daily(), 2);
});

test("a restore asked for during a backup waits for it, and a crash restart due meanwhile does not leave the start hanging", async () => {
  const world = new World();
  world.seed();
  const inst = await started(world);
  await run(world, 5_000);
  const name = world.backups.at(-1)?.name;
  assert.ok(name);
  const backup = inst.issue({ type: "backupNow" });
  await world.clock.advance(100);
  // The server crashes while the backup runs, so a restart is due in 1 s, inside the restore's wait.
  assert.equal(world.crashServer(), true);
  const restore = inst.issue({ type: "restore", backup: name });
  await run(world, 20_000);
  assert.equal(inst.answers.get(backup)?.[0]?.ok, true);
  assert.equal(inst.answers.get(restore)?.[0]?.ok, true);
  assert.equal(inst.latest()?.notice?.kind, "restored");
  assert.equal(inst.latest()?.state, "running", inst.statuses.slice(-6).map((x) => `${x.state}/${x.step}`).join(" "));
  assert.equal(inst.latest()?.step, "running");
  assert.equal(world.serving().length, 1);
  assert.deepEqual(world.violations, []);
});
