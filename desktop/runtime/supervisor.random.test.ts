import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Command } from "../contract.ts";
import { BEFORE, LIVE, RESTORING } from "./restore.ts";
import { Instance, World } from "./testing/fakeWorld.ts";

/**
 * The supervisor over many event orders (docs/design/design-v1-local-app.md
 * 10): start, quit, the switch, the port, a Windows profile change, back up,
 * restore, a server crash, a PostgreSQL crash, the shell going away, a
 * second supervisor starting, and the supervisor killed at any step, an
 * undo included. Database steps of a restore also fail at random, for the
 * undo paths. After each run the computer is started once more, as the DM
 * would, and the rules are checked:
 *
 * - never two app servers, never a restore while one runs, never a backup during a restore;
 * - a killed restore ends finished or undone, `raccoon` holding the old or the restored data whole;
 * - PostgreSQL stopped and the lock free whenever a supervisor exits normally;
 * - every command a supervisor that was not killed received answered exactly once.
 *
 * Process deaths across real processes (Windows job objects, detached
 * spawning) are the smoke tests' to prove, not this one's.
 */

type Event =
  | { kind: "advance"; ms: number }
  | { kind: "command"; command: Command | "restoreNewest" | "restoreOldest" }
  | { kind: "serverCrash" }
  | { kind: "pgCrash" }
  | { kind: "profile"; profile: "open" | "public" | "domain" | "unknown" }
  | { kind: "kill"; within: number }
  | { kind: "second" }
  | { kind: "disconnect" }
  | { kind: "relaunch" };

const command: fc.Arbitrary<Event> = fc
  .oneof(
    fc.boolean().map((on): Command => ({ type: "setNetworkPlay", on })),
    fc.integer({ min: 3170, max: 3173 }).map((port): Command => ({ type: "setPort", port })),
    fc.constant<Command>({ type: "backupNow" }),
    fc.constant<Command>({ type: "listBackups" }),
    fc.constant<Command>({ type: "listRooms" }),
    fc.constant<Command>({ type: "newDmLink", roomId: "ABCD2345" }),
    fc.constant<Command>({ type: "retry" }),
    fc.constant<Command>({ type: "startWithoutBackup" }),
    fc.constant<Command>({ type: "setSettings", patch: { openBrowser: false } }),
    fc.constant<"restoreNewest">("restoreNewest"),
    fc.constant<"restoreOldest">("restoreOldest"),
    fc.constant<Command>({ type: "stop" }),
  )
  .map((c) => ({ kind: "command", command: c }));

const event: fc.Arbitrary<Event> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 20_000 }).map((ms): Event => ({ kind: "advance", ms })) },
  { weight: 6, arbitrary: command },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: "serverCrash" }) },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: "pgCrash" }) },
  { weight: 1, arbitrary: fc.constantFrom("open", "public", "domain", "unknown").map((profile): Event => ({ kind: "profile", profile })) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 40 }).map((within): Event => ({ kind: "kill", within })) },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: "second" }) },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: "disconnect" }) },
  { weight: 2, arbitrary: fc.constant<Event>({ kind: "relaunch" }) },
);

async function settle(world: World, ms = 120_000): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) await world.clock.advance(1_000);
}

function answeredOnce(inst: Instance): string[] {
  const problems: string[] = [];
  for (const [id, command] of inst.sent) {
    const n = inst.answers.get(id)?.length ?? 0;
    if (n !== 1) problems.push(`${command.type} #${id} answered ${n} times`);
  }
  return problems;
}

async function scenario(seed: number, events: readonly Event[], platform: "linux" | "win32"): Promise<void> {
  const world = new World(seed);
  world.platform = platform;
  world.seed();
  world.failRate = 0.04;
  const finished: Instance[] = [];
  let current = new Instance(world);
  void current.sup.start();

  for (const e of events) {
    switch (e.kind) {
      case "advance":
        await world.clock.advance(e.ms);
        break;
      case "command": {
        if (current.dead || current.stopped) break;
        let c: Command;
        if (e.command === "restoreNewest" || e.command === "restoreOldest") {
          const pick = e.command === "restoreNewest" ? world.backups.at(-1) : world.backups[0];
          if (!pick) break;
          c = { type: "restore", backup: pick.name };
        } else c = e.command;
        current.issue(c);
        if (c.type === "stop") current.stopped = true;
        break;
      }
      case "serverCrash":
        world.crashServer();
        break;
      case "pgCrash":
        world.crashPostgres();
        break;
      case "profile":
        world.setProfile(e.profile);
        break;
      case "kill":
        current.budget = Math.min(current.budget, e.within);
        break;
      case "second": {
        // Another copy on the same folder: it must refuse while the first runs, and change nothing.
        if (current.dead || current.stopped || world.lockOwner !== current) break;
        const second = new Instance(world);
        void second.sup.start();
        await world.clock.advance(1_000);
        const s = second.latest();
        if (!current.dead && s?.state !== "error") world.violate(`a second supervisor did not stop: ${s?.state}`);
        if (!current.dead && s?.error?.kind !== "alreadyRunning") world.violate(`a second supervisor stopped with ${s?.error?.kind}`);
        second.issue({ type: "stop" });
        await world.clock.advance(1_000);
        finished.push(second);
        break;
      }
      case "disconnect":
        if (current.dead || current.stopped) break;
        // A closed channel stops the supervisor the same way the stop command does.
        current.stopped = true;
        void current.sup.stop();
        break;
      case "relaunch":
        if (!current.dead && !current.stopped) break;
        await world.clock.advance(500);
        finished.push(current);
        current = new Instance(world);
        void current.sup.start();
        break;
    }
  }

  // The DM opens the app once more, on a calm computer.
  world.failRate = 0;
  world.crashAfterMs = null;
  current.budget = Number.POSITIVE_INFINITY;
  await settle(world, 60_000);
  if (current.dead || current.stopped) {
    finished.push(current);
    current = new Instance(world);
    void current.sup.start();
    await settle(world, 60_000);
  }
  for (let i = 0; i < 3 && current.latest()?.state === "error"; i++) {
    current.issue({ type: "retry" });
    await settle(world, 60_000);
  }

  const status = current.latest();
  if (process.env.SUPERVISOR_RANDOM_REPLAY) console.log(current.statuses.map((x) => `${x.state}/${x.step ?? ""}/${x.restore ?? ""}`).join(" "));
  assert.equal(status?.state, "running", `the last start ended ${status?.state} ${JSON.stringify(status?.error)} (seed ${seed})`);
  assert.deepEqual([...world.dbs.keys()].sort(), [LIVE], `databases left: ${[...world.dbs.keys()]} (seed ${seed})`);
  assert.equal(world.journal, null, `the journal was left (seed ${seed})`);
  const content = world.dbs.get(LIVE)?.content ?? "";
  assert.ok(content === "orig" || content.startsWith("restored:"), `raccoon holds ${content} (seed ${seed})`);
  if (world.lastRestore) {
    // Whatever happened after the newest restore began, its data is the old or the restored, whole.
    const ok = content === world.lastRestore.before || content === world.lastRestore.after || content.startsWith("restored:");
    assert.ok(ok, `after a restore raccoon holds ${content}, not ${world.lastRestore.before} or ${world.lastRestore.after}`);
  }
  assert.equal(world.dbs.has(BEFORE) || world.dbs.has(RESTORING), false);

  current.issue({ type: "stop" });
  current.stopped = true;
  await settle(world, 30_000);
  finished.push(current);
  assert.equal(world.pg.running, false, `PostgreSQL still runs after a normal exit (seed ${seed})`);
  assert.equal(world.lockOwner, null, `the lock is still held after a normal exit (seed ${seed})`);
  assert.equal(world.serving().length, 0);
  for (const inst of finished) {
    if (inst.dead) continue;
    assert.deepEqual(answeredOnce(inst), [], `seed ${seed}`);
    const trail = inst.statuses.slice(-12).map((s) => `${s.state}/${s.step ?? ""}/${s.restore ?? ""}`).join(" ");
    if (inst.stopped || inst === current) assert.equal(inst.latest()?.state, "stopped", `a supervisor asked to stop ended ${inst.latest()?.state} (seed ${seed}): ${trail}`);
  }
  assert.deepEqual(world.violations, [], `seed ${seed}`);
}

test("the supervisor keeps its rules over random event orders, on Linux and on Windows", async () => {
  // A failing run's counterexample, as fast-check prints it, runs alone with SUPERVISOR_RANDOM_REPLAY.
  const replay = process.env.SUPERVISOR_RANDOM_REPLAY;
  if (replay) {
    const [seed, events, platform] = JSON.parse(replay) as [number, Event[], "linux" | "win32"];
    await scenario(seed, events, platform);
    return;
  }
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.array(event, { minLength: 5, maxLength: 60 }), fc.constantFrom<"linux" | "win32">("linux", "win32"), (seed, events, platform) =>
      scenario(seed, events, platform),
    ),
    { numRuns: Number(process.env.SUPERVISOR_RANDOM_RUNS ?? 120) },
  );
});

test("a restore killed at every call ends finished or undone on the next start", async () => {
  // Each budget kills the supervisor one call further into the same restore, so every step of it, the undo's included, is a crash point.
  for (let budget = 1; budget < 160; budget++) {
    const world = new World(budget);
    world.seed();
    const first = new Instance(world);
    void first.sup.start();
    await settle(world, 10_000);
    first.issue({ type: "backupNow" });
    await settle(world, 10_000);
    world.dbs.get(LIVE)!.content = "changed";
    const name = world.backups.at(-1)?.name;
    assert.ok(name);
    first.budget = budget;
    first.issue({ type: "restore", backup: name });
    await settle(world, 30_000);
    // A budget past the restore's last call: the crash comes after it.
    first.kill();
    const next = new Instance(world);
    void next.sup.start();
    await settle(world, 30_000);
    assert.equal(next.latest()?.state, "running", `budget ${budget}: ${JSON.stringify(next.latest()?.error)}`);
    assert.deepEqual([...world.dbs.keys()], [LIVE], `budget ${budget}`);
    assert.equal(world.journal, null, `budget ${budget}`);
    const content = world.dbs.get(LIVE)?.content;
    assert.ok(content === "changed" || content === `restored:${name}`, `budget ${budget}: ${content}`);
    assert.deepEqual(world.violations, [], `budget ${budget}`);
    next.issue({ type: "stop" });
    await settle(world, 10_000);
    assert.equal(world.pg.running, false);
  }
});

