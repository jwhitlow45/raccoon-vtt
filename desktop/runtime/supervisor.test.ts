import assert from "node:assert/strict";
import { test } from "node:test";
import { CRASH_RESTART_MS, START_PARTS, endsHeadless, type StartPart } from "./supervisor.ts";
import { BEFORE, LIVE } from "./restore.ts";
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

test("the log names each status and each part of a start as it begins", async () => {
  const world = new World();
  await started(world);
  const at = (line: string) => {
    const i = world.logs.indexOf(line);
    assert.ok(i >= 0, `no "${line}" in ${JSON.stringify(world.logs)}`);
    return i;
  };
  const order = [
    "status: starting",
    `start: ${START_PARTS.lock.words}`,
    "status: starting, initdb",
    `start: ${START_PARTS.initdb.words}`,
    "status: starting, startDatabase",
    `start: ${START_PARTS.startDatabase.words}`,
    `start: ${START_PARTS.openDatabase.words}`,
    `start: ${START_PARTS.versionCheck.words}`,
    `start: ${START_PARTS.network.words}`,
    `start: ${START_PARTS.stamp.words}`,
    "status: starting, startServer",
    "start: waiting for the app server to answer",
    "status: running, running",
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

/** A world whose start goes as far as `call`, which answers `lateMs` past its part's bound. */
function late(call: string, part: StartPart, lateMs = 30_000): { world: World; inst: Instance } {
  const world = new World();
  world.seed();
  world.settings = { ...world.settings, port: 3170 };
  world.delays.set(call, [START_PARTS[part].ms + lateMs]);
  const inst = new Instance(world);
  void inst.sup.start();
  return { world, inst };
}

test("a part past its bound shows stalled while the start keeps it, refuses Try again, and the start goes on when the part answers late", async () => {
  const cases: [string, StartPart][] = [
    ["lock.acquire", "lock"],
    ["network.firewallRule", "firewall"],
    ["pg.start", "startDatabase"],
    ["restore.pending", "restorePending"],
    ["db.open", "openDatabase"],
    ["backups.list", "backups"],
    ["db.readStamp", "versionCheck"],
    ["ports.free", "port"],
    ["network.read", "network"],
    ["db.writeStamp", "stamp"],
  ];
  for (const [call, part] of cases) {
    const { world, inst } = late(call, part);
    const { words, ms } = START_PARTS[part];
    await world.clock.advance(ms - 1_000);
    assert.notEqual(inst.latest()?.state, "error", `${call}: stalled before its bound`);
    await world.clock.advance(2_000);
    assert.deepEqual(inst.latest()?.error, { kind: "stalled", what: words, seconds: ms / 1000 }, call);
    const retry = await answer(world, inst, { type: "retry" }, 100);
    assert.deepEqual(retry, { ok: false, failure: { error: "busy" } }, `${call}: Try again waits for the part`);
    await run(world, 30_000);
    assert.equal(inst.latest()?.state, "running", `${call}: the start goes on once the part answers`);
    assert.equal(world.pg.epoch, 1, `${call}: PostgreSQL started once`);
    assert.equal(world.serving().length, 1, call);
    assert.ok(world.logs.includes(`${words} ended after all`), call);
    assert.deepEqual(world.violations, [], call);
  }
});

test("Quit while a part is past its bound ends what can end early, waits for the rest, and lets the lock go only after", async () => {
  // pg_ctl and initdb end early: nothing they would have done is done after the stop.
  for (const [call, part, seed] of [
    ["pg.start", "startDatabase", true],
    ["pg.init", "initdb", false],
  ] as const) {
    const world = new World();
    if (seed) world.seed();
    world.delays.set(call, [START_PARTS[part].ms + 300_000]);
    const inst = new Instance(world);
    void inst.sup.start();
    await world.clock.advance(START_PARTS[part].ms + 1_000);
    assert.equal(inst.latest()?.error?.kind, "stalled", call);
    const stalledAt = inst.statuses.length;
    assert.equal((await answer(world, inst, { type: "stop" }, 5_000)).ok, true, `${call}: Quit answers without waiting out the part`);
    assert.equal(inst.latest()?.state, "stopped", call);
    assert.ok(!inst.statuses.slice(stalledAt).some((s) => s.error !== null && s.error.kind !== "stalled"), `${call}: a start ended by Quit reports no error`);
    assert.equal(world.lockOwner, null, call);
    await world.clock.advance(400_000);
    assert.equal(world.pg.running, false, `${call}: nothing starts after the stop`);
    assert.equal(world.pg.inited, seed, `${call}: no initdb finished after the stop`);
    assert.deepEqual(world.violations, [], call);
  }

  // Opening the database can't end early, so Quit waits for it, keeps the lock meanwhile, and starts no part after it.
  {
    const { world, inst } = late("db.open", "openDatabase", 200_000);
    await world.clock.advance(START_PARTS.openDatabase.ms + 1_000);
    assert.equal(inst.latest()?.error?.kind, "stalled");
    const id = inst.issue({ type: "stop" });
    await world.clock.advance(100_000);
    assert.equal(inst.answers.has(id), false, "Quit waits for the open");
    assert.equal(world.lockOwner, inst, "and keeps the lock meanwhile");
    await run(world, 120_000);
    assert.equal(inst.answers.get(id)?.[0]?.ok, true);
    assert.equal(inst.latest()?.state, "stopped");
    assert.equal(world.lockOwner, null);
    assert.equal(world.pg.running, false);
    assert.ok(!world.logs.includes(`start: ${START_PARTS.backups.words}`), "no part begins once Quit is asked");
    assert.deepEqual(world.violations, []);
  }

  // The stamp is the last part: once it ends, the server is not started for a Quit already asked.
  {
    const { world, inst } = late("db.writeStamp", "stamp", 200_000);
    await world.clock.advance(START_PARTS.stamp.ms + 1_000);
    const id = inst.issue({ type: "stop" });
    await run(world, 220_000);
    assert.equal(inst.answers.get(id)?.[0]?.ok, true);
    assert.equal(world.serverStarts.length, 0, "no app server started after Quit");
    assert.equal(world.lockOwner, null);
    assert.deepEqual(world.violations, []);
  }
});

test("a start that fails after PostgreSQL launched, then Quit, leaves no PostgreSQL running", async () => {
  const world = new World();
  world.seed();
  world.startFailsAfterLaunch = true;
  const inst = await started(world);
  assert.equal(inst.latest()?.error?.kind, "databaseFailed");
  assert.equal(world.pg.running, true, "the launched postmaster outlived the failed start");
  assert.equal((await answer(world, inst, { type: "stop" })).ok, true);
  assert.equal(world.pg.running, false);
  assert.equal(world.lockOwner, null);
});

test("a restore finished at start that keeps flushing never shows stalled, however long it takes, and says how far it is", async () => {
  const world = new World();
  world.seed();
  const name = world.backupName();
  const live = world.live();
  world.backups.push({ name, record: { started: "2026-11-01T04:00:00.000Z", finished: "2026-11-01T04:00:05.000Z", kind: "daily", dataApp: BUILD.app, snapshotVersion: BUILD.snapshotVersion, opVersion: BUILD.opVersion, pgMajor: 17, dumpBytes: 100, dbBytes: 1000, images: 0 } });
  const id = "a".repeat(32);
  live.tag = { kind: "restored", id };
  world.journal = { id, backup: name, state: "finishing" };
  // 8,000 images at 100 ms a flush: 800 s, past the 600 s a fixed bound once gave the whole part.
  world.images = Array.from({ length: 8_000 }, (_, i) => `token/${String(i).padStart(4, "0")}.png`);
  world.flushMs = 100;
  const inst = new Instance(world);
  void inst.sup.start();
  const percents = new Set<number>();
  for (let t = 0; t < 900_000 && inst.latest()?.state !== "running"; t += 10_000) {
    await world.clock.advance(10_000);
    const s = inst.latest();
    assert.notEqual(s?.error?.kind, "stalled", `stalled at ${t / 1000} s though it kept flushing`);
    if (s?.percent !== undefined) percents.add(s.percent);
  }
  assert.equal(inst.latest()?.state, "running");
  assert.equal(world.journal, null);
  assert.ok(percents.size >= 5 && Math.max(...percents) >= 90, `the status said how far it was: ${[...percents].join(", ")}`);
  assert.equal(inst.latest()?.percent, undefined, "and stops saying so once it is done");

  // One flush that hangs past the bound does show it, and the start goes on when it ends.
  const slow = new World();
  slow.seed();
  slow.backups.push(world.backups[0]!);
  slow.live().tag = { kind: "restored", id };
  slow.journal = { id, backup: name, state: "finishing" };
  slow.images = ["token/one.png", "token/two.png"];
  slow.flushMs = 30_000;
  slow.delays.set("fs.syncFile", [START_PARTS.recover.ms + 60_000]);
  const waiting = new Instance(slow);
  void waiting.sup.start();
  await slow.clock.advance(START_PARTS.recover.ms + 5_000);
  assert.deepEqual(waiting.latest()?.error, { kind: "stalled", what: START_PARTS.recover.words, seconds: START_PARTS.recover.ms / 1000 });
  // The held flush ends near 210 s (held 180 s, then its own 30 s), and the next takes 30 s more: the stall clears as the work moves again.
  await slow.clock.advance(100_000);
  assert.equal(waiting.latest()?.state, "recovering", "back to its step while the next flush runs");
  assert.equal(waiting.latest()?.error, null);
  await run(slow, 70_000);
  assert.equal(waiting.latest()?.state, "running");
  assert.deepEqual(slow.violations, []);
});

test("an undo held past its bound between its state read and its drop is never joined by a second recovery, and the original survives", async () => {
  const world = new World();
  world.seed();
  const original = world.live();
  original.content = "orig";
  const id = "b".repeat(32);
  world.dbs.set(BEFORE, original);
  world.dbs.set(LIVE, { content: "restored", tag: { kind: "restored", id }, stamp: original.stamp, rooms: 1 });
  world.journal = { id, backup: "raccoon-2026-11-01-040000-abcd1234", state: "undoing" };
  // The first walker's first session end answers 700 s late, past the 600 s a fixed bound once gave recovery.
  world.delays.set("db.endSessions", [700_000]);
  const inst = new Instance(world);
  void inst.sup.start();
  await world.clock.advance(START_PARTS.recover.ms + 5_000);
  assert.equal(inst.latest()?.error?.kind, "stalled");
  assert.deepEqual(await answer(world, inst, { type: "retry" }, 100), { ok: false, failure: { error: "busy" } });
  await world.clock.advance(500_000);
  // Try again again at 625 s, once a fixed 600 s bound would have let go of the first, which is still held.
  assert.deepEqual(await answer(world, inst, { type: "retry" }, 100), { ok: false, failure: { error: "busy" } });
  await run(world, 120_000);
  assert.equal(inst.latest()?.state, "running");
  assert.deepEqual([...world.dbs.keys()], [LIVE]);
  assert.equal(world.live().content, "orig", "the original is raccoon again");
  assert.deepEqual(world.violations, []);
});

test("a headless supervisor ends on a stop, never on a stalled part, which it waits out to running", async () => {
  // As main.ts's headless emitter decides: each status a run with no shell would print, and whether it ends there.
  const { world, inst } = late("db.open", "openDatabase", 60_000);
  await run(world, START_PARTS.openDatabase.ms + 90_000);
  assert.ok(inst.statuses.some((s) => s.error?.kind === "stalled"), "the part stalled");
  assert.deepEqual(inst.statuses.filter(endsHeadless), [], "and no status on the way would have ended a headless run");
  assert.equal(inst.latest()?.state, "running");

  const failed = new World();
  failed.seed();
  failed.startFailsAfterLaunch = true;
  const stopped = await started(failed);
  assert.equal(stopped.latest()?.error?.kind, "databaseFailed");
  assert.equal(endsHeadless(stopped.latest()!), true, "a stop still ends it");
});
