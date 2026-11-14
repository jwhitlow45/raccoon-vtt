import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os, { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import pg from "pg";
import { Platform } from "../contract.ts";
import { dataIdentity } from "./dataDir.ts";
import { lockLocation } from "./lock.ts";
import { parentProblem, pgPaths, PROGRAMDATA_FOLDER, windowsDeps } from "./pgPaths.ts";
import { loopbackPort } from "./ports.ts";
import { BOOT_RECORD, Cluster, DatabaseFailed, uncertainWords } from "./postgres.ts";
import { bootId, isAlive, processFacts, processStamp } from "./processInfo.ts";
import { postgresDir, startTestCluster, type TestCluster } from "./testing/cluster.ts";
import { killSupervisor, startSupervisor, type SupervisorRun } from "./testing/supervisorProcess.ts";

/**
 * The bundled PostgreSQL with its real programs (docs/design/design-v1-local-app.md
 * 2, 6, 8.1 and 10, D-261113-084, 093): initdb's locale, a start on a free
 * loopback port whatever holds 5432, a stale postmaster.pid, and a
 * postmaster a killed supervisor left running, which the next one stops
 * only when the supervisor named in supervisor.json is gone.
 */

const platform = Platform.parse(process.platform);
const temps: string[] = [];
const clusters: TestCluster[] = [];
const supervisors: SupervisorRun[] = [];

after(async () => {
  for (const s of supervisors) await s.stop().catch(() => undefined);
  for (const c of clusters) await c.stop();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rvtt-pg-")));
  temps.push(dir);
  return dir;
}

async function cluster(): Promise<TestCluster> {
  const c = await startTestCluster("rvtt-pg-cluster-");
  clusters.push(c);
  return c;
}

function supervisor(data: string, port: number): SupervisorRun {
  const run = startSupervisor({ data, port });
  supervisors.push(run);
  return run;
}

async function postmasterPid(data: string): Promise<number> {
  return Number((await readFile(join(data, "postgres", "postmaster.pid"), "utf8")).split("\n")[0]);
}

/** A connection as the app makes one, from the data folder's own secrets and the port PostgreSQL wrote down. */
async function connect(data: string): Promise<pg.Client> {
  const password = (JSON.parse(await readFile(join(data, "secrets.json"), "utf8")) as { databasePassword: string }).databasePassword;
  const port = (await readFile(join(data, "postgres", "postmaster.pid"), "utf8")).split("\n")[3]?.trim();
  const client = new pg.Client({ connectionString: `postgres://raccoon:${password}@127.0.0.1:${port}/raccoon` });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

/** A pid nothing runs as: a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid as number));
  });
}

describe("the cluster", () => {
  test("initdb uses the C locale and the builtin C.UTF-8 provider, and listens on loopback only with no socket file", async () => {
    const c = await cluster();
    const pool = c.pool();
    const { rows } = await pool.query<{ datname: string; datlocprovider: string; datcollate: string; datctype: string; datlocale: string | null }>(
      "select datname, datlocprovider, datcollate, datctype, datlocale from pg_database where datname in ('postgres', 'template0', 'template1') order by datname",
    );
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.datlocprovider, "b", `${r.datname} uses the builtin provider`);
      assert.equal(r.datlocale, "C.UTF-8", `${r.datname} uses C.UTF-8`);
      assert.equal(r.datcollate, "C");
      assert.equal(r.datctype, "C");
    }
    const show = async (name: string) => (await pool.query<Record<string, string>>(`show ${name}`)).rows[0]?.[name];
    assert.equal(await show("server_encoding"), "UTF8");
    assert.equal(await show("lc_messages"), "C");
    assert.equal(await show("listen_addresses"), "127.0.0.1");
    assert.equal(await show("unix_socket_directories"), "");
    assert.equal(await show("jit"), "off");
    assert.equal(await show("TimeZone"), "UTC");
    assert.equal(await show("password_encryption"), "scram-sha-256");
    const hba = (await readFile(join(c.dir, "postgres", "pg_hba.conf"), "utf8")).split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    assert.deepEqual(hba, ["host all raccoon 127.0.0.1/32 scram-sha-256"]);
    // A wrong password is refused: scram, never trust.
    const wrong = new pg.Client({ connectionString: c.cluster.url("postgres").replace(/:[^:@]+@/, ":wrong@") });
    wrong.on("error", () => undefined);
    await assert.rejects(wrong.connect(), /password authentication failed/);
  });

  test("it starts on a free loopback port while something holds 5432, and stops cleanly", async () => {
    // Hold 5432 if nothing does yet. If something does, it is held already.
    const holder = net.createServer();
    await new Promise<void>((resolve) => {
      holder.once("error", () => resolve());
      holder.listen({ host: "127.0.0.1", port: 5432 }, () => resolve());
    });
    try {
      const c = await cluster();
      assert.notEqual(c.cluster.port, 5432);
      await c.pool().query("select 1");
      const pid = await c.cluster.postmasterPid();
      assert.ok(pid !== null && isAlive(pid));
      await c.cluster.stop();
      assert.equal(existsSync(join(c.dir, "postgres", "postmaster.pid")), false);
      assert.deepEqual(await c.cluster.leftover(), { kind: "none" });
      assert.ok(pid !== null && !isAlive(pid), "the postmaster is gone");
      // And it starts again, on a port picked anew.
      await c.cluster.start();
      const again = new pg.Client({ connectionString: c.cluster.url("postgres") });
      await again.connect();
      await again.query("select 1");
      await again.end();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  test("a postmaster.pid naming a dead pid, or a live process that is not the postmaster, is cleared and the start works", async () => {
    const c = await cluster();
    await c.cluster.stop();
    const pidFile = join(c.dir, "postgres", "postmaster.pid");
    const write = (pid: number, startedSec: number) =>
      writeFile(pidFile, [pid, join(c.dir, "postgres"), startedSec, 5999, "", "127.0.0.1", "  1234   5678", "ready   ", ""].join("\n"));

    await write(await deadPid(), Math.floor(Date.now() / 1000));
    assert.deepEqual(await c.cluster.leftover(), { kind: "stale" });
    await c.cluster.clearLeftover(await c.cluster.leftover());
    await c.cluster.start();
    await c.cluster.stop();

    // A live process that did not start when the file says: a reused pid. It
    // is no ancestor of the new postmaster, which PostgreSQL would forgive on
    // its own, so a file left in place would stop the start.
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await write(sleeper.pid as number, 1000);
      assert.deepEqual(await c.cluster.leftover(), { kind: "stale" });
      // A stop with nothing running is no failure, whatever postmaster.pid says.
      await c.cluster.stop();
      assert.ok(isAlive(sleeper.pid as number), "the reused pid's process is never signalled");
      await c.cluster.clearLeftover(await c.cluster.leftover());
      await c.cluster.start();
      const pid = await c.cluster.postmasterPid();
      assert.ok(pid !== null && pid !== sleeper.pid);
      assert.deepEqual(await c.cluster.leftover(), { kind: "running", pid });
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("a start whose port was taken in between tries another, and a failed start says what this start logged", async () => {
    const c = await cluster();
    await c.cluster.stop();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen({ host: "127.0.0.1", port: 0 }, () => resolve()));
    const taken = (holder.address() as net.AddressInfo).port;
    try {
      const picks: number[] = [];
      const retrying = new Cluster({
        ...c.cluster.opts,
        pickPort: async () => {
          const port = picks.length === 0 ? taken : await loopbackPort();
          picks.push(port);
          return port;
        },
      });
      const port = await retrying.start();
      assert.equal(picks.length, 2, "the taken port was tried, then another");
      assert.equal(port, picks[1]);
      assert.notEqual(port, taken);
      await retrying.stop();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }

    const conf = join(c.dir, "postgres", "postgresql.conf");
    const before = await readFile(conf, "utf8");
    await writeFile(conf, `${before}\nnonsense_setting = 1\n`);
    try {
      await assert.rejects(c.cluster.start(), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed);
        assert.match(err.logLine, /contains errors/, err.logLine);
        return true;
      });
    } finally {
      await writeFile(conf, before);
    }
    await c.cluster.start();
    await c.cluster.stop();

    // A pg_ctl that fails before PostgreSQL writes a line: its own words, never the log's older last line.
    if (platform !== "win32") {
      const bin = join(c.dir, "fake-bin");
      await mkdir(bin);
      await writeFile(join(bin, "pg_ctl"), "#!/bin/sh\necho 'pg_ctl: could not start, for this test' >&2\nexit 1\n", { mode: 0o755 });
      const broken = new Cluster({ ...c.cluster.opts, binDir: bin });
      await assert.rejects(broken.start(), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed);
        assert.equal(err.logLine, "pg_ctl: could not start, for this test");
        return true;
      });
    }
  });

  test("a stepped clock (120 s) keeps the live postmaster and its postmaster.pid, and the one that started it still stops it", async () => {
    const c = await cluster();
    const pid = await c.cluster.postmasterPid();
    assert.ok(pid !== null);
    // Another reader of the same folder, where a clock step since the start
    // moved the start reading and no working folder can be read (as on
    // macOS and Windows).
    const stepped = new Cluster({
      ...c.cluster.opts,
      proc: {
        stamp: (p) => processStamp(p, platform),
        facts: async (p) => {
          const facts = await processFacts(p, platform);
          return { ...facts, cwd: null, start: (facts.start ?? 0) + 120_000 };
        },
        bootId: () => bootId(platform),
        uid: process.getuid?.() ?? null,
      },
    });
    const found = await stepped.leftover();
    assert.deepEqual(found, { kind: "uncertain", pid });
    const recorded = (await readFile(join(c.dir, "postgres", BOOT_RECORD), "utf8").catch(() => "")).trim();
    assert.equal(recorded, await bootId(platform), "the start recorded this boot, none on Windows");
    await assert.rejects(stepped.clearLeftover(found), (err: unknown) => err instanceof DatabaseFailed && err.logLine === uncertainWords(pid));
    assert.ok(isAlive(pid), "the postmaster runs on");
    assert.ok(existsSync(join(c.dir, "postgres", "postmaster.pid")), "and its file stays");
    await c.pool().query("select 1");
    await c.cluster.stop();
    assert.equal(isAlive(pid), false, "the cluster that started it stops it");
  });

  test("an init cut off after PG_VERSION and before the app's settings leaves no postgres/, and the next start makes it whole", async () => {
    const dir = await dataDir();
    const opts = {
      binDir: join(postgresDir(), "bin"),
      pgData: join(dir, "postgres"),
      logFile: join(dir, "postgres.log"),
      password: "test-password-0123456789abcdef",
      platform,
    };
    const cut = new Cluster({
      ...opts,
      afterInitdb: async () => {
        throw new Error("killed after initdb");
      },
    });
    await assert.rejects(cut.init(), /killed after initdb/);
    assert.equal(existsSync(opts.pgData), false);
    const staging = (await readdir(dir)).filter((n) => n.startsWith("postgres.init-"));
    assert.equal(staging.length, 1);
    assert.ok(existsSync(join(dir, staging[0]!, "PG_VERSION")), "initdb wrote PG_VERSION before it was cut off");

    const whole = new Cluster(opts);
    assert.equal(whole.needsInit(), true);
    await whole.init();
    await whole.start();
    try {
      const client = new pg.Client({ connectionString: whole.url("postgres") });
      await client.connect();
      const show = async (name: string) => (await client.query<Record<string, string>>(`show ${name}`)).rows[0]?.[name];
      assert.equal(await show("listen_addresses"), "127.0.0.1");
      assert.equal(await show("TimeZone"), "UTC");
      await client.end();
    } finally {
      await whole.stop();
    }
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("postgres.init-")), []);
    assert.equal((await readdir(dir)).filter((n) => n.startsWith("postgres.incomplete-")).length, 1);
  });
});

describe("a postmaster left running", { skip: platform === "win32" && "the Windows smoke test kills the shell and checks what is left" }, () => {
  test("the next supervisor stops the one a killed supervisor left, starts its own, and the data folder is private", async () => {
    const data = await dataDir();
    const first = supervisor(data, 40412);
    await first.waitFor("running", (s) => s.state === "running", 120_000);
    if (platform !== "win32") {
      assert.equal((await stat(data)).mode & 0o777, 0o700, "the data folder is 0700");
      assert.equal((await stat(join(data, "secrets.json"))).mode & 0o777, 0o600, "secrets.json is 0600");
    }
    const left = await postmasterPid(data);
    await killSupervisor(first);
    assert.ok(isAlive(left), "a killed supervisor leaves its postmaster running");

    const second = supervisor(data, 40413);
    await second.waitFor("running", (s) => s.state === "running", 120_000);
    assert.equal(isAlive(left), false, "the old postmaster was stopped");
    const now = await postmasterPid(data);
    assert.notEqual(now, left);
    const client = await connect(data);
    assert.equal((await client.query<{ n: number }>("select 1 as n")).rows[0]?.n, 1);
    await client.end();
    const log = await readFile(join(data, "logs", "postgres.log"), "utf8");
    assert.match(log, /received fast shutdown request/, "the old postmaster got a clean, fast stop");
    await second.stop();
    assert.equal(isAlive(now), false, "a supervisor that stops normally stops PostgreSQL");
  });

  test("while the supervisor named in supervisor.json still runs, a second one that got a lock ends as already running and touches nothing", async () => {
    const data = await dataDir();
    const first = supervisor(data, 40414);
    await first.waitFor("running", (s) => s.state === "running", 120_000);
    const postmaster = await postmasterPid(data);
    const owner = await readFile(join(data, "supervisor.json"), "utf8");
    // Two locks for one folder, as when its canonical path changed between
    // two starts: the first keeps listening on a socket no path names now.
    const at = lockLocation(dataIdentity(data, platform).hash, { platform, uid: process.getuid?.() ?? 0, home: os.homedir() });
    if ("error" in at) throw new Error("this machine's lock path is too long");
    await unlink(at.path);

    const second = supervisor(data, 40415);
    const refused = await second.waitFor("an error", (s) => s.state === "error", 120_000);
    assert.deepEqual(refused.error, { kind: "alreadyRunning" });
    assert.equal(await postmasterPid(data), postmaster, "the first postmaster was not stopped");
    assert.ok(isAlive(postmaster));
    assert.equal(await readFile(join(data, "supervisor.json"), "utf8"), owner, "the owner record still names the first");
    assert.equal(first.latest()?.state, "running");
    const client = await connect(data);
    await client.query("select 1");
    await client.end();
    await second.stop();
    assert.ok(isAlive(postmaster), "stopping the refused supervisor leaves the first one's database alone");
    await first.stop();
  });
});

describe("on Windows, a data folder whose path PostgreSQL can't open", { skip: platform !== "win32" && "PostgreSQL opens paths in the ANSI code page on Windows only" }, () => {
  test("Windows says é fits the runner's code page and Ж does not", async () => {
    const dir = await dataDir();
    const latin = join(dir, "Tést");
    const awkward = join(dir, "RaccoonVTT Tést Жук");
    await mkdir(latin);
    await mkdir(awkward);
    const deps = windowsDeps();
    assert.equal((await deps.read(latin)).fits, true, "the runner's code page is cp1252");
    const reading = await deps.read(awkward);
    assert.equal(reading.fits, false);
    if (reading.short !== null && reading.shortFits) assert.ok(existsSync(reading.short), reading.short);
  });

  test("RaccoonVTT's folder in ProgramData, as desktop.yml makes it with the installer's script, is one the app accepts", async () => {
    const facts = await windowsDeps().inspect(join(process.env.ProgramData ?? "C:\\ProgramData", PROGRAMDATA_FOLDER));
    assert.equal(parentProblem(facts), null, JSON.stringify(facts));
  });

  for (const route of ["as Windows allows", "through a junction"] as const) {
    test(`a cluster there is made, started, dumped, read back and stopped, ${route}`, async () => {
      const dir = await dataDir();
      const data = join(dir, "RaccoonVTT Tést Жук", "data");
      await mkdir(join(data, "logs"), { recursive: true });
      await mkdir(join(data, "backups"));
      const record = join(data, "postgres-link.json");
      const real = windowsDeps();
      const deps = route === "through a junction" ? { ...real, read: async () => ({ fits: false, short: null, shortFits: false }) } : real;
      const paths = await pgPaths({ data, program: postgresDir() }, record, platform, deps);
      const chosen = JSON.parse(await readFile(record, "utf8")) as { how: string; folder?: string };
      const linkFolder = chosen.how === "junction" ? chosen.folder! : null;
      if (route === "through a junction") assert.ok(linkFolder !== null, JSON.stringify(chosen));
      try {
        const c = new Cluster({
          binDir: join(postgresDir(), "bin"),
          pgData: join(data, "postgres"),
          logFile: join(data, "logs", "postgres.log"),
          password: "test-password-0123456789abcdef",
          platform,
          pgPath: paths.map,
        });
        await c.init();
        await c.start();
        try {
          const dump = join(data, "backups", "x.dump");
          await c.client("pg_dump", ["--dbname=postgres", "--format=custom", `--file=${c.pgPath(dump)}`]);
          await c.readDump(["--list", `--file=${devNull}`, c.pgPath(dump)]);
          assert.ok((await stat(dump)).size > 0);
        } finally {
          await c.stop();
        }
        assert.equal(existsSync(join(data, "postgres", "postmaster.pid")), false, "stopped cleanly");
        const again = await pgPaths({ data, program: postgresDir() }, record, platform, { ...real, read: async () => assert.fail("the record comes first") });
        assert.equal(again.map(join(data, "postgres")), paths.map(join(data, "postgres")), "the next start gives PostgreSQL the same path");
      } finally {
        if (linkFolder !== null) {
          // rmdir takes a junction away without following it.
          await rmdir(join(linkFolder, "data"));
          await rm(join(linkFolder, "key"));
          await rmdir(linkFolder);
        }
      }
    });
  }
});
