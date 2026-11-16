import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { Platform } from "../contract.ts";
import { BOOT_RECORD, Cluster, DatabaseFailed, Ended, pgEnv, postmasterKind, runToExit, uncertainWords, type ProcessLookup, type Programs } from "./postgres.ts";
import { isAlive, listProcesses, processStamp, systemShell, type ListedProcess } from "./processInfo.ts";

/**
 * The cluster's own rules, with stand-ins for PostgreSQL's programs and for
 * the process readings (postgres.itest.ts runs the real ones): which
 * postmaster.pid may go, a stepped clock, the boot recorded beside it, the
 * postmaster this process started, and an init cut off before the app's
 * settings.
 */

const platform = Platform.parse(process.platform);
const posixOnly = platform === "win32" && "the stand-in programs are shell scripts";
const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rvtt-pgunit-")));
  temps.push(dir);
  return dir;
}

/** Stand-in pg_ctl and initdb that record each call, as PostgreSQL's would act on the folder. */
async function programs(dir: string): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const log = join(dir, "calls");
  await writeFile(log, "");
  // pg_ctl start writes postmaster.pid naming RVTT_FAKE_PID, started now. pg_ctl stop removes it.
  // With RVTT_FAKE_HOLD it leaves a process holding its pipes, as the
  // Windows postmaster does, and writes its pid there. RVTT_FAKE_LATE fails
  // after 0.8 s, RVTT_FAKE_FAIL fails at once, and RVTT_FAKE_HANG never
  // ends, writing its own pid there and its log saying PostgreSQL is ready.
  //
  // With RVTT_FAKE_CHILD it launches a postmaster of its own, as
  // `postgres -D <folder> -p <port>` as real pg_ctl does, so a process
  // listing knows it as pg_ctl's (asStarted), and writes its pid there.
  // The postmaster writes postmaster.pid after RVTT_FAKE_PIDAFTER s,
  // marked starting, then ready after RVTT_FAKE_READYAFTER s (never when
  // unset), naming RVTT_FAKE_TAKENBY's pid then instead of its own when
  // that is set, and lives RVTT_FAKE_LIFE s. It ignores SIGTERM when
  // RVTT_FAKE_STUBBORN is set, and ends on SIGUSR1 after writing
  // "immediate" beside postgres/, standing in for SIGQUIT, unless
  // RVTT_FAKE_DEAF is set, which ignores both, as a postmaster whose child
  // is stuck in the kernel does. pg_ctl stop -m fast sends it SIGTERM, -m immediate SIGUSR1,
  // after RVTT_FAKE_SLOWSTOP s, and as -w does fails when it still runs a
  // second later. RVTT_FAKE_PGCTL says what pg_ctl does meanwhile: "wait" as -w does
  // (exit 0 once ready, 1 once the postmaster is gone), "fail" (exit 1 at
  // once, as when its own wait runs out), "failsoon" (exit 1 after 0.3 s),
  // or "hang".
  await writeFile(
    join(bin, "postgres"),
    [
      "#!/bin/sh",
      `d="$2"`,
      `if [ -n "$RVTT_FAKE_STUBBORN" ]; then trap '' TERM; fi`,
      `trap 'echo ended > "$(dirname "$d")/immediate"; exit 0' USR1`,
      `if [ -n "$RVTT_FAKE_DEAF" ]; then trap '' TERM USR1; fi`,
      `sleep "\${RVTT_FAKE_PIDAFTER:-0}"`,
      `started=$(date +%s)`,
      `w() { printf '%s\\n%s\\n%s\\n5999\\n\\n\\n\\n%s\\n' "$2" "$d" "$started" "$1" > "$d/postmaster.pid"; }`,
      `w starting $$`,
      `if [ -n "$RVTT_FAKE_READYAFTER" ]; then sleep "$RVTT_FAKE_READYAFTER"; w ready "\${RVTT_FAKE_TAKENBY:-$$}"; fi`,
      // Not exec: the shell keeps the command line that names the folder.
      `n=$(( \${RVTT_FAKE_LIFE:-30} * 5 )); while [ "$n" -gt 0 ]; do sleep 0.2; n=$((n - 1)); done`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "pg_ctl"),
    [
      "#!/bin/sh",
      `if [ "$1" = stop ] && [ "$5" = immediate ]; then echo "pg_ctl stop immediate" >> '${log}'; else echo "pg_ctl $1" >> '${log}'; fi`,
      `if [ "$1" = start ] && [ -z "$RVTT_FAKE_CHILD" ]; then printf '%s\\n%s\\n%s\\n5999\\n' "$RVTT_FAKE_PID" "$3" "$(date +%s)" > "$3/postmaster.pid"; fi`,
      `if [ "$1" = stop ] && [ -n "$RVTT_FAKE_SLOWSTOP" ]; then sleep "$RVTT_FAKE_SLOWSTOP"; fi`,
      `if [ "$1" = stop ] && [ -n "$RVTT_FAKE_CHILD" ]; then p=$(head -1 "$3/postmaster.pid"); if [ "$5" = immediate ]; then kill -USR1 "$p"; else kill "$p"; fi; n=0; while kill -0 "$p" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.1; n=$((n + 1)); done; if kill -0 "$p" 2>/dev/null; then echo "pg_ctl: server does not shut down" >&2; exit 1; fi; fi`,
      `if [ "$1" = stop ]; then rm -f "$3/postmaster.pid"; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_HOLD" ]; then sleep 30 & echo $! > "$RVTT_FAKE_HOLD"; fi`,
      // $10 is -o's "-p <port>", split in two as pg_ctl's own shell splits it.
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_CHILD" ]; then "$(dirname "$0")/postgres" -D "$3" \${10} & c=$!; echo $c > "$RVTT_FAKE_CHILD"; fi`,
      `if [ "$RVTT_FAKE_PGCTL" = wait ]; then while kill -0 $c 2>/dev/null; do [ "$(sed -n 8p "$3/postmaster.pid" 2>/dev/null)" = ready ] && exit 0; sleep 0.1; done; echo "pg_ctl: could not start server" >&2; exit 1; fi`,
      `if [ "$RVTT_FAKE_PGCTL" = fail ]; then echo "pg_ctl: server did not start in time" >&2; exit 1; fi`,
      `if [ "$RVTT_FAKE_PGCTL" = failsoon ]; then sleep 0.3; echo "pg_ctl: could not start server" >&2; exit 1; fi`,
      `if [ "$RVTT_FAKE_PGCTL" = hang ]; then echo $$ > "$RVTT_FAKE_HANG"; exec sleep 30; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_LATE" ]; then sleep 0.8; echo "pg_ctl: could not start server" >&2; exit 1; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_FAIL" ]; then echo "pg_ctl: could not start server" >&2; exit 1; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_HANG" ]; then echo $$ > "$RVTT_FAKE_HANG"; echo "LOG:  database system is ready to accept connections" >> "$5"; exec sleep 30; fi`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // initdb makes PG_VERSION first, as the real one does, then its own
  // postgresql.conf. It makes no folder, as the real one can't through a
  // junction on Windows (pgPaths.ts), so the cluster gives it one.
  await writeFile(
    join(bin, "initdb"),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --pgdata=*) d="\${a#--pgdata=}";; esac; done\nif [ -n "$RVTT_FAKE_INIT_INNER" ] && [ -z "$RVTT_FAKE_INNER" ]; then RVTT_FAKE_INNER=1 "$0" "$@"; exit $?; fi\nif [ -n "$RVTT_FAKE_INNER" ]; then sleep 1; echo done > "$RVTT_FAKE_INIT_INNER"; fi\n[ -d "$d" ] || { echo "initdb: error: could not create directory \\"$d\\"" >&2; exit 1; }\necho 17 > "$d/PG_VERSION"\necho "# initdb's defaults" > "$d/postgresql.conf"\necho "local all all trust" > "$d/pg_hba.conf"\necho "initdb $d" >> '${log}'\n`,
    { mode: 0o755 },
  );
  return { bin, calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean) };
}

/**
 * What the system says about the pid: by default this computer's own
 * postgres, run as this user, started when postmaster.pid says, in the boot
 * "boot-now", with the start reading this computer gives, the one its
 * listing carries too. `offsetMs` moves its start, as a clock step since
 * does. `boot` is this boot's id, "" for none, or an error for a refused read.
 */
type Look = { exe?: string | null; cwd?: string | null; uid?: number | null; offsetMs?: number; boot?: string | Error; stamp?: () => Promise<number | null>; facts?: ProcessLookup["facts"] };
function lookup(o: Look = {}): ProcessLookup {
  return {
    list: asStarted,
    stamp: o.stamp ?? ((pid: number) => processStamp(pid)),
    facts:
      o.facts ??
      (async () => ({
        exe: o.exe === undefined ? "/opt/raccoonvtt/postgres/bin/postgres" : o.exe,
        cwd: o.cwd ?? null,
        uid: o.uid === undefined ? 501 : o.uid,
        start: Date.now() + (o.offsetMs ?? 0),
      })),
    bootId: async () => {
      if (o.boot instanceof Error) throw o.boot;
      return o.boot ?? "boot-now";
    },
    uid: 501,
  };
}

/**
 * This computer's processes, as the listing would show the stand-in
 * postmaster and pg_ctl were they PostgreSQL's. Each stand-in is a script,
 * so the system lists it after its shell, `/bin/sh <bin>/postgres -D ...`,
 * where the program pg_ctl starts, or pg_ctl itself, is listed alone.
 */
async function asStarted(): Promise<ListedProcess[]> {
  return (await listProcesses()).map((p) => {
    const run = /^\/bin\/sh (\S+\/bin\/(?:postgres -D|pg_ctl start -D) .*)$/.exec(p.commandLine)?.[1];
    return run === undefined ? p : { pid: p.pid, commandLine: run, stamp: p.stamp ?? null };
  });
}

/** Waits for `ready`, checking every 50 ms, and fails after `ms`, so a slow runner waits longer instead of failing at a fixed moment. */
async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** asStarted, counting each listing, so a test waits for passes rather than for time. */
function counted(): { list: () => Promise<ListedProcess[]>; count: () => number } {
  let n = 0;
  return {
    list: async () => {
      n++;
      return asStarted();
    },
    count: () => n,
  };
}

/** Ends a stand-in a test left running, if it still runs. */
function end(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

function cluster(dir: string, bin: string, proc: ProcessLookup, extra: { afterInitdb?: () => Promise<void>; platform?: Platform; renameDir?: (from: string, to: string) => Promise<void> } = {}): Cluster {
  return new Cluster({ binDir: bin, pgData: join(dir, "postgres"), logFile: join(dir, "postgres.log"), password: "pw", platform, pickPort: async () => 41659, proc, ...extra });
}

/** A postmaster.pid naming `pid`, written at `startedSec`. */
async function pidFile(dir: string, pid: number, startedSec = Math.floor(Date.now() / 1000)): Promise<string> {
  await mkdir(join(dir, "postgres"), { recursive: true });
  const file = join(dir, "postgres", "postmaster.pid");
  await writeFile(file, `${pid}\n${join(dir, "postgres")}\n${startedSec}\n5999\n`);
  return file;
}

describe("a postmaster.pid found at a start", () => {
  test("is this folder's postmaster only when the program is postgres and it is this folder's, and stale only on evidence", async () => {
    const dir = await folder();
    const pg = join(dir, "postgres");
    await pidFile(dir, process.pid);
    const kind = async (proc: ProcessLookup, on: Platform = "darwin") => (await cluster(dir, "/none", proc, { platform: on }).leftover()).kind;
    const cases: [string, Platform, Look, string][] = [
      ["a postgres that started when the file says", "darwin", {}, "running"],
      ["Windows: postgres.exe that started when the file says", "win32", { exe: "postgres.exe", uid: null }, "running"],
      ["Linux: postgres working in this folder, whatever the clock says", "linux", { cwd: pg, offsetMs: 120_000 }, "running"],
      ["Linux: /usr/bin/node working in this folder", "linux", { exe: "/usr/bin/node", cwd: pg }, "stale"],
      ["Windows: another program by its CIM name", "win32", { exe: "svchost.exe", uid: null }, "stale"],
      ["a program that reused the pid", "darwin", { exe: "/usr/local/bin/node" }, "stale"],
      ["another user's process, its program unknown", "linux", { exe: null, uid: 0 }, "stale"],
      ["a postgres started at another time, as through a stepped clock", "darwin", { offsetMs: 120_000 }, "uncertain"],
      ["Linux: postgres working in another folder", "linux", { cwd: dir }, "uncertain"],
      ["Linux: postgres whose working folder can't be read", "linux", { cwd: null }, "uncertain"],
      ["nothing could be read, as when every read is refused", "linux", { exe: null, uid: null }, "uncertain"],
      ["Windows: nothing could be read", "win32", { exe: null, uid: null }, "uncertain"],
    ];
    for (const [what, on, look, want] of cases) assert.equal(await kind(lookup(look), on), want, what);
    await pidFile(dir, 2 ** 30);
    assert.equal(await kind(lookup()), "stale", "a dead pid");
  });

  test("a postmaster.pid is from an earlier boot only when the boot recorded beside it is another, never by the clock", async () => {
    const dir = await folder();
    const refused = { facts: async () => Promise.reject(Object.assign(new Error("EACCES: permission denied, readlink '/proc/1/exe'"), { code: "EACCES" })) };
    const kind = async (look: Look, on: Platform = "linux") => (await cluster(dir, "/none", lookup({ ...refused, ...look }), { platform: on }).leftover()).kind;
    const record = (id: string) => writeFile(join(dir, "postgres", BOOT_RECORD), `${id}\n`);
    // Written 30 s into this boot, then the clock was stepped 120 s forward:
    // by the wall clock the file is from before this boot.
    const file = await pidFile(dir, process.pid, Math.floor((Date.now() - 150_000) / 1000));
    assert.equal(await kind({}), "uncertain", "no boot recorded is no evidence");
    await record("boot-now");
    assert.equal(await kind({}), "uncertain", "this boot recorded, with the inspection refused");
    assert.equal(await kind({}, "darwin"), "uncertain");
    assert.equal(await kind({ boot: "" }), "uncertain", "this boot's id not read");
    assert.equal(await kind({ boot: new Error("sysctl failed") }, "darwin"), "uncertain", "this boot's id refused");
    const c = cluster(dir, "/none", lookup(refused), { platform: "linux" });
    await assert.rejects(c.clearLeftover(await c.leftover()), DatabaseFailed);
    assert.ok(existsSync(file), "the stepped clock never reaches the unlink");

    await record("");
    assert.equal(await kind({}), "uncertain", "an empty record is no evidence");
    await record("boot-before");
    assert.equal(await kind({ boot: "" }, "win32"), "uncertain", "Windows has no boot id, so its CIM name carries it");
    assert.equal(await kind({ cwd: join(dir, "postgres"), facts: undefined }), "running", "Linux: this folder's postgres is running, whatever was recorded");
    assert.equal(await kind({}), "stale", "a recorded boot that is not this one");
    assert.equal(await kind({}, "darwin"), "stale");
    const before = cluster(dir, "/none", lookup(refused), { platform: "linux" });
    await before.clearLeftover(await before.leftover());
    assert.equal(existsSync(file), false, "and only then does the file go");
  });

  test("an inspection the system refuses keeps the file, and the start stops with words", async () => {
    const dir = await folder();
    const file = await pidFile(dir, process.pid);
    for (const look of [
      { facts: async () => Promise.reject(Object.assign(new Error("EACCES: permission denied, readlink '/proc/1/exe'"), { code: "EACCES" })) },
      { exe: null, cwd: null, uid: null },
      { offsetMs: 120_000 },
    ] satisfies Look[]) {
      const c = cluster(dir, "/none", lookup(look), { platform: "linux" });
      const found = await c.leftover();
      assert.deepEqual(found, { kind: "uncertain", pid: process.pid });
      await assert.rejects(c.clearLeftover(found), (err: unknown) => err instanceof DatabaseFailed && err.logLine === uncertainWords(process.pid));
      assert.ok(existsSync(file), "postmaster.pid stays, so no second postmaster opens the folder");
    }
    assert.doesNotMatch(uncertainWords(1), /[\u2014;]/);
  });
});

describe("the postmaster this process started", { skip: posixOnly }, () => {
  test("is stopped at Quit though a clock step since its start makes it look uncertain", async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    let offsetMs = 0;
    const c = cluster(dir, bin, lookup({ facts: async () => ({ exe: "/opt/raccoonvtt/postgres/bin/postgres", cwd: null, uid: 501, start: Date.now() + offsetMs }) }), { platform: "darwin" });
    process.env.RVTT_FAKE_PID = String(process.pid);
    try {
      await c.start();
    } finally {
      delete process.env.RVTT_FAKE_PID;
    }
    offsetMs = 120_000;
    assert.equal((await c.leftover()).kind, "uncertain", "the start time alone no longer matches");
    await c.stop();
    assert.deepEqual(await calls(), ["pg_ctl start", "pg_ctl stop"]);
  });

  test("a pid reused since the start, with another start reading, is never signalled, nor is /usr/bin/node working in the data folder", async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    let stamp = 4242;
    const c = cluster(dir, bin, lookup({ stamp: async () => stamp, exe: "/usr/bin/node", cwd: join(dir, "postgres") }), { platform: "linux" });
    process.env.RVTT_FAKE_PID = String(process.pid);
    try {
      await c.start();
    } finally {
      delete process.env.RVTT_FAKE_PID;
    }
    stamp = 9999;
    await c.stop();
    const found = await c.leftover();
    assert.equal(found.kind, "stale");
    await c.clearLeftover(found);
    assert.deepEqual(await calls(), ["pg_ctl start"], "pg_ctl never ran against node");
  });
});

describe("a start", { skip: posixOnly }, () => {
  test("records this boot beside the postmaster before it starts, and with no boot id removes an older record", async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const recorded = join(dir, "postgres", BOOT_RECORD);
    const at: string[] = [];
    const start = async (boot: string) => {
      // The port is picked just before pg_ctl start runs.
      const pickPort = async () => {
        at.push(existsSync(recorded) ? (await readFile(recorded, "utf8")).trim() : "none");
        return 41659;
      };
      const c = new Cluster({ ...cluster(dir, bin, lookup({ boot }), { platform: "darwin" }).opts, pickPort });
      process.env.RVTT_FAKE_PID = String(process.pid);
      try {
        await c.start();
      } finally {
        delete process.env.RVTT_FAKE_PID;
      }
      await c.stop();
    };
    await start("boot-a");
    await start("boot-b");
    await start("");
    assert.deepEqual(at, ["boot-a", "boot-b", "none"]);
    assert.deepEqual(await calls(), ["pg_ctl start", "pg_ctl stop", "pg_ctl start", "pg_ctl stop", "pg_ctl start", "pg_ctl stop"]);
  });

  /** Every process a stand-in left, ended once the file's tests are done and never before a test's own checks. */
  const strays: number[] = [];
  after(() => {
    for (const pid of strays) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  });

  /** Runs one start with the stand-in's variables set. The processes named in its pid files are left for the test to check. */
  async function startWith(dir: string, c: Cluster, vars: Record<string, string>, signal?: AbortSignal): Promise<{ ms: number; error: unknown; pid: (file: string) => Promise<number> }> {
    Object.assign(process.env, { RVTT_FAKE_PID: String(process.pid), ...vars });
    const began = Date.now();
    let error: unknown = null;
    try {
      await c.start(signal);
    } catch (err) {
      error = err;
    } finally {
      for (const key of ["RVTT_FAKE_PID", ...Object.keys(vars)]) delete process.env[key];
    }
    const ms = Date.now() - began;
    for (const file of Object.values(vars).filter((v) => v.startsWith(dir) && existsSync(v))) strays.push(Number((await readFile(file, "utf8")).trim()));
    return { ms, error, pid: async (file) => Number((await readFile(file, "utf8")).trim()) };
  }

  /** Whether a process has ended, given a moment for the system to reap it. */
  async function ended(pid: number): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  test("answers when pg_ctl exits, though the postmaster it started still holds pg_ctl's pipes, as on Windows", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const holder = join(dir, "holder.pid");
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_HOLD: holder });
    assert.equal(error, null);
    assert.equal(c.port, 41659);
    assert.ok(ms < 5_000, `the start answered after ${ms} ms, not at pg_ctl's exit`);
    assert.equal(await ended(await pid(holder)), false, "the process holding the pipes still runs");
  });

  /** No live process, so a postmaster.pid naming it is stale. */
  const DEAD = String(2 ** 30);

  test("a pg_ctl start that fails while the postmaster holds its pipes fails at once with pg_ctl's words", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { ms, error } = await startWith(dir, c, { RVTT_FAKE_PID: DEAD, RVTT_FAKE_HOLD: join(dir, "holder.pid"), RVTT_FAKE_FAIL: "1" });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl: could not start server", String(error));
    assert.ok(ms < 5_000, `the failure came after ${ms} ms`);
  });

  test("a failed start stops only a postmaster leftover() confirms, never a program that reused the pid", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const c = cluster(dir, bin, lookup({ exe: "/usr/bin/node" }), { platform: "darwin" });
    const { error } = await startWith(dir, c, { RVTT_FAKE_FAIL: "1" });
    assert.ok(error instanceof DatabaseFailed);
    assert.deepEqual(await calls(), ["pg_ctl start"], "no pg_ctl stop against node");
  });

  test("a failed exit just before the limit keeps pg_ctl's words, since the limit stops at the exit", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const c = new Cluster({ ...cluster(dir, bin, lookup(), { platform: "darwin" }).opts, startLimitMs: 1_000 });
    // It fails at 0.8 s, and the pipe it leaves open makes the drain run past 1 s.
    const { error } = await startWith(dir, c, { RVTT_FAKE_PID: DEAD, RVTT_FAKE_HOLD: join(dir, "holder.pid"), RVTT_FAKE_LATE: "1" });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl: could not start server", String(error));
  });

  test("a pg_ctl start that never exits and launched nothing is ended at its limit, and waited for until it exits", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const hung = join(dir, "pg_ctl.pid");
    const c = new Cluster({ ...cluster(dir, bin, lookup(), { platform: "darwin" }).opts, startLimitMs: 1_000 });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_PID: DEAD, RVTT_FAKE_HANG: hung });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start did not finish in 1 s", String(error));
    assert.equal(await ended(await pid(hung)), true, "pg_ctl is gone before the start answers");
  });

  for (const how of ["pg_ctl's own wait runs out", "pg_ctl is ended at its limit"] as const) {
    test(`a postmaster still starting when ${how} is waited for, and becomes the start's once it is ready`, { timeout: 15_000 }, async () => {
      const dir = await folder();
      const { bin, calls } = await programs(dir);
      await mkdir(join(dir, "postgres"));
      const postmaster = join(dir, "postmaster.child");
      const c = new Cluster({ ...cluster(dir, bin, lookup(), { platform: "darwin" }).opts, startLimitMs: 500 });
      const vars: Record<string, string> = how === "pg_ctl's own wait runs out" ? { RVTT_FAKE_PGCTL: "fail" } : { RVTT_FAKE_PGCTL: "hang", RVTT_FAKE_HANG: join(dir, "pg_ctl.pid") };
      const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_READYAFTER: "1.5", ...vars });
      assert.equal(error, null);
      assert.equal(c.port, 41659);
      assert.equal(await ended(await pid(postmaster)), false, "the postmaster runs on as the start's");
      assert.deepEqual(await calls(), ["pg_ctl start"], "it was never stopped");
    });
  }

  // The postmaster holds pg_ctl's stderr, so pg_ctl's failure is heard a second after its exit, here still before the file.
  test("a postmaster that writes postmaster.pid only after pg_ctl gave up is waited for too, and becomes the start's", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { error } = await startWith(dir, c, { RVTT_FAKE_CHILD: join(dir, "postmaster.child"), RVTT_FAKE_PGCTL: "fail", RVTT_FAKE_PIDAFTER: "2", RVTT_FAKE_READYAFTER: "0.5" });
    assert.equal(error, null);
    assert.deepEqual(await calls(), ["pg_ctl start"], "it was never stopped");
  });

  test("a postmaster.pid that says ready for another process never makes the start succeed, which waits for its own postmaster to end", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "fail", RVTT_FAKE_READYAFTER: "0.5", RVTT_FAKE_TAKENBY: DEAD, RVTT_FAKE_LIFE: "2" });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl: server did not start in time", String(error));
    assert.ok(ms >= 1_500, `answered after ${ms} ms, before its own postmaster ended`);
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), ["pg_ctl start"], "the file names no postmaster of this folder, so pg_ctl stop is never asked");
  });

  test("a postmaster that dies while it is waited for fails the start with pg_ctl's words", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { error } = await startWith(dir, c, { RVTT_FAKE_CHILD: join(dir, "postmaster.child"), RVTT_FAKE_PGCTL: "fail", RVTT_FAKE_LIFE: "1" });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl: server did not start in time", String(error));
  });

  // A postmaster postmaster.pid names is stopped through pg_ctl stop. One
  // without the file yet is killed, on the listing's word that it is this
  // folder's postgres.
  const STOPPED = ["pg_ctl start", "pg_ctl stop"];
  const KILLED = ["pg_ctl start"];
  for (const [when, vars, abortMs, expected] of [
    ["while pg_ctl waits", { RVTT_FAKE_PGCTL: "wait" }, 500, STOPPED],
    ["before the postmaster has written postmaster.pid", { RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_PIDAFTER: "0.8" }, 100, KILLED],
    ["after pg_ctl failed and once the postmaster wrote postmaster.pid", { RVTT_FAKE_PGCTL: "fail", RVTT_FAKE_PIDAFTER: "0.5" }, 1_500, STOPPED],
    // The postmaster holds pg_ctl's stderr, so pg_ctl's failure is heard a second after its exit, still before the file.
    ["when pg_ctl then fails before the postmaster has written postmaster.pid", { RVTT_FAKE_PGCTL: "failsoon", RVTT_FAKE_PIDAFTER: "2" }, 100, KILLED],
    // The reviewers' probe: the controller fails, and its postmaster would publish its pid only 8 s later.
    ["after pg_ctl failed, while the postmaster would write postmaster.pid only 8 s later", { RVTT_FAKE_PGCTL: "fail", RVTT_FAKE_PIDAFTER: "8" }, 1_500, KILLED],
  ] as const) {
    test(`a start cancelled ${when} stops the postmaster it launched and answers only once it has ended`, { timeout: 15_000 }, async () => {
      const dir = await folder();
      const { bin, calls } = await programs(dir);
      await mkdir(join(dir, "postgres"));
      const postmaster = join(dir, "postmaster.child");
      const unconfirmed: boolean[] = [];
      const c = new Cluster({ ...cluster(dir, bin, lookup(), { platform: "darwin" }).opts, unconfirmed: (on) => unconfirmed.push(on) });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), abortMs);
      const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, ...vars }, abort.signal);
      assert.deepEqual(unconfirmed, [], "the pg_ctl start the cancel waits on is no doubt about the end");
      assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
      assert.ok(ms < 8_000, `the start answered after ${ms} ms`);
      // Checked here, before anything of the test's own ends them.
      assert.equal(await ended(await pid(postmaster)), true, "the postmaster it launched was stopped");
      assert.deepEqual(await calls(), expected);
      assert.equal(existsSync(join(dir, "postgres", "postmaster.pid")), false, "stopped by pg_ctl, or killed before it wrote the file");
      assert.equal(c.port, null);
    });
  }

  test("a postmaster is known by its program's real path, though the cluster was given the programs through a link", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    // As /var is /private/var on macOS, and an AppImage's or a translocated app's folder is a mount of another.
    await mkdir(join(dir, "linked"));
    const link = join(dir, "linked", "bin");
    await symlink(bin, link);
    const postmaster = join(dir, "postmaster.child");
    const c = cluster(dir, link, lookup(), { platform: "darwin" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_PIDAFTER: "0.8" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.ok(ms < 8_000, `the start answered after ${ms} ms`);
    assert.equal(await ended(await pid(postmaster)), true, "the postmaster it launched was killed as exactly this folder's");
    assert.deepEqual(await calls(), KILLED);
  });

  test("a start whose process listing fails holds on, says it can't confirm PostgreSQL ended, and answers once a listing proves it", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let failing = true;
    const unconfirmed: boolean[] = [];
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => {
        if (failing) throw new Error("Get-CimInstance failed");
        return asStarted();
      },
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, listRetryMs: 100, unconfirmed: (on) => unconfirmed.push(on) });
    setTimeout(() => (failing = false), 3_000);
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "fail" });
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl: server did not start in time", String(error));
    assert.ok(ms >= 3_000, `answered after ${ms} ms, while no listing had worked`);
    assert.deepEqual(unconfirmed, [true, false]);
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), STOPPED);
  });

  test("a postmaster the listing still shows after its kill holds the start, which says so after a while and answers only once the listing shows none", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    // Exactly this folder's postmaster, which no kill reaches: the listing names it, and nothing runs as its pid.
    let ghost = true;
    const unconfirmed: boolean[] = [];
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => [...(await asStarted()), ...(ghost ? [{ pid: Number(DEAD), commandLine: `${join(bin, "postgres")} -D ${join(dir, "postgres")} -p 5` }] : [])],
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, unsureAfterMs: 500, unconfirmed: (on) => unconfirmed.push(on) });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    setTimeout(() => (ghost = false), 2_500);
    const { ms, error } = await startWith(dir, c, { RVTT_FAKE_FAIL: "1" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.ok(ms >= 2_500, `answered after ${ms} ms, while the listing still showed a postmaster`);
    assert.deepEqual(unconfirmed, [true, false]);
  });

  test("a process that names this folder as a postmaster would, but is not exactly what pg_ctl starts, is never signalled, and holds the start until it ends", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    const pg = join(dir, "postgres");
    await mkdir(pg);
    // pg_ctl's exact command, run by another program than the bundled postgres.
    await mkdir(join(dir, "other", "bin"), { recursive: true });
    await writeFile(join(dir, "other", "bin", "postgres"), "#!/bin/sh\nwhile :; do sleep 0.2; done\n", { mode: 0o755 });
    const idle = "setInterval(() => undefined, 1000)";
    const loose = [
      spawn(join(dir, "other", "bin", "postgres"), ["-D", pg, "-p", "5"], { stdio: "ignore" }),
      // A tool or a search that names the folder.
      spawn(process.execPath, ["-e", idle, "postgres", "-D", pg], { stdio: "ignore" }),
      // Another cluster, in a folder whose name starts with this one's.
      spawn(process.execPath, ["-e", idle, "postgres", "-D", `${pg} other`, "-p", "5"], { stdio: "ignore" }),
    ];
    for (const child of loose) strays.push(child.pid as number);
    const said: string[] = [];
    const unconfirmed: boolean[] = [];
    // postmaster.pid names one of them, which leftover() knows is no postgres.
    const c = new Cluster({ ...cluster(dir, bin, lookup({ exe: process.execPath }), { platform: "darwin" }).opts, log: (m) => said.push(m), unconfirmed: (on) => unconfirmed.push(on) });
    const alive: boolean[] = [];
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    setTimeout(() => {
      for (const child of loose) {
        alive.push(isAlive(child.pid as number));
        child.kill("SIGKILL");
      }
    }, 2_500);
    const { ms, error } = await startWith(dir, c, { RVTT_FAKE_PID: String(loose[1]?.pid), RVTT_FAKE_FAIL: "1" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.deepEqual(alive, [true, true, true], "none of them was signalled");
    assert.ok(ms >= 2_500, `answered after ${ms} ms, while they ran`);
    assert.deepEqual(unconfirmed, [true, false]);
    assert.deepEqual(await calls(), ["pg_ctl start"], "nor asked to stop, though the file names one");
    for (const child of loose) assert.match(said.join("\n"), new RegExp(`process ${child.pid} names this data folder .*: \\S.* -D ${pg}`), "the log names each, with its command line");
  });

  test("a postmaster only loosely listed, which postmaster.pid names and leftover() confirms, is stopped through pg_ctl and never killed", { timeout: 30_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    // The listing as it is, so the stand-in reads `/bin/sh <bin>/postgres ...`, as a postmaster the exact form misses would.
    const c = cluster(dir, bin, { ...lookup(), list: () => listProcesses() }, { platform: "darwin" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_LIFE: "15" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.ok(ms < 10_000, `the start answered after ${ms} ms, not when the postmaster ended on its own`);
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), STOPPED);
  });

  test("a loosely listed postmaster the file names is never stopped when leftover() reads another start than the listing did", { timeout: 30_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    // leftover() reads a start the listing's row does not have, as for a pid reused between the two.
    const c = cluster(dir, bin, { ...lookup({ stamp: async () => 1 }), list: () => listProcesses() }, { platform: "darwin" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_LIFE: "3" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(await ended(await pid(postmaster)), true, "it ended on its own");
    assert.deepEqual(await calls(), ["pg_ctl start"], "no pg_ctl stop went out");
  });

  test("the shell pg_ctl execs the postmaster from is ended only on pg_ctl's exact command, and holds the start while it runs", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    const pg = join(dir, "postgres");
    await mkdir(pg);
    const idle = () => spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    const exact = idle();
    const loose = idle();
    for (const child of [exact, loose]) strays.push(child.pid as number);
    let exactEnded: number | null = null;
    const began = Date.now();
    exact.once("exit", () => (exactEnded = Date.now() - began));
    // Each stands in for the shell, listed as pg_ctl's command: one for the bundled postgres, one for another.
    const shell = (program: string) => `/bin/sh -c exec "${program}" -D "${pg}" -p 5 < "/dev/null" >> "${join(dir, "postgres.log")}" 2>&1`;
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => [
        ...(await asStarted()),
        ...(exact.exitCode === null && exact.signalCode === null ? [{ pid: exact.pid as number, commandLine: shell(join(bin, "postgres")) }] : []),
        ...(loose.exitCode === null && loose.signalCode === null ? [{ pid: loose.pid as number, commandLine: shell(join(dir, "other", "postgres")) }] : []),
      ],
    };
    const unconfirmed: boolean[] = [];
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, unconfirmed: (on) => unconfirmed.push(on) });
    let looseAlive = false;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    setTimeout(() => {
      looseAlive = loose.exitCode === null && loose.signalCode === null;
      loose.kill("SIGKILL");
    }, 2_000);
    const { ms, error } = await startWith(dir, c, { RVTT_FAKE_PID: DEAD, RVTT_FAKE_FAIL: "1" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(exact.signalCode, "SIGKILL", "the exact one was killed");
    assert.ok(exactEnded !== null && exactEnded < 2_000, `it ended ${exactEnded} ms in`);
    assert.equal(looseAlive, true, "the other was never signalled");
    assert.ok(ms >= 2_000, `answered after ${ms} ms, while the other ran`);
    assert.deepEqual(unconfirmed, [true, false]);
  });

  test("a pg_ctl start left running after pg_ctl answered, as its fork before the shell, holds the start and is never signalled", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    const pg = join(dir, "postgres");
    await mkdir(pg);
    const stage = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    strays.push(stage.pid as number);
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => [
        ...(await asStarted()),
        ...(stage.exitCode === null && stage.signalCode === null ? [{ pid: stage.pid as number, commandLine: `${join(bin, "pg_ctl")} start -D ${pg} -l ${join(dir, "postgres.log")} -w -t 1800 -o -p 5` }] : []),
      ],
    };
    const said: string[] = [];
    const unconfirmed: boolean[] = [];
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, log: (m) => said.push(m), unconfirmed: (on) => unconfirmed.push(on) });
    let alive: boolean | null = null;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    setTimeout(() => {
      alive = stage.exitCode === null && stage.signalCode === null;
      stage.kill("SIGKILL");
    }, 2_000);
    const { ms, error } = await startWith(dir, c, { RVTT_FAKE_PID: DEAD, RVTT_FAKE_FAIL: "1" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(alive, true, "never signalled");
    assert.ok(ms >= 2_000, `answered after ${ms} ms, while it ran`);
    assert.deepEqual(unconfirmed, [true, false]);
    assert.match(said.join("\n"), new RegExp(`pg_ctl start \\(pid ${stage.pid}\\) for this data folder still runs and may yet start PostgreSQL`));
  });

  test("on Windows the cmd.exe pg_ctl starts the postmaster through counts as one of this folder's", async () => {
    const dir = await folder();
    const pg = join(dir, "postgres");
    const rows: ListedProcess[] = [
      { pid: 7, commandLine: `"C:/pg/postgres.exe" -D "${pg}" -p 5  `, exe: "C:\\pg\\postgres.exe" },
      { pid: 8, commandLine: `"${systemShell()}" /C ""C:/pg/postgres.exe" -D "${pg}" -p 5 < "nul" >> "${join(dir, "postgres.log")}" 2>&1"`, exe: systemShell() },
      { pid: 9, commandLine: `"${systemShell()}" /C ""C:/pg/postgres.exe" -D "${pg}.incomplete-5" -p 5 < "nul" 2>&1"`, exe: systemShell() },
    ];
    rows.push({ pid: 10, commandLine: `"C:/pg/pg_ctl.exe" start -D "${pg}" -l log -w`, exe: "C:\\pg\\pg_ctl.exe" });
    const c = cluster(dir, "/none", { ...lookup(), list: async () => rows }, { platform: "win32" });
    assert.deepEqual((await c.postmasters()).map((p) => p.pid), [7, 8, 10], "and so does pg_ctl.exe starting it");
  });

  /** A start reading that differs at every read, so the postmaster running is never the one this process started. */
  const neverMine = (): (() => Promise<number>) => {
    let n = 0;
    return async () => ++n;
  };

  /** Runs `work` with the stand-in's variables set, as they were for the start. */
  async function withVars<T>(vars: Record<string, string>, work: () => Promise<T>): Promise<T> {
    Object.assign(process.env, vars);
    try {
      return await work();
    } finally {
      for (const key of Object.keys(vars)) delete process.env[key];
    }
  }

  test("a stop of a postmaster it can't count as its own proves the end by identity, though pg_ctl stop said it ended", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const c = cluster(dir, bin, lookup({ stamp: neverMine() }), { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    // With RVTT_FAKE_CHILD gone, the stand-in pg_ctl stop removes postmaster.pid and ends nothing.
    await c.stop();
    assert.equal(await ended(await pid(postmaster)), true, "the stop answered only once its postmaster had ended");
    assert.deepEqual(await calls(), STOPPED);
  });

  test("a pg_ctl stop -w that ended the postmaster this process started is proof, so a listing that always fails never holds that Quit", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let listed = 0;
    const unconfirmed: boolean[] = [];
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => {
        listed++;
        throw new Error("Get-CimInstance failed");
      },
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, unconfirmed: (on) => unconfirmed.push(on) });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    await withVars({ RVTT_FAKE_CHILD: postmaster }, () => c.stop());
    assert.equal(await ended(await pid(postmaster)), true);
    assert.equal(listed, 0, "no listing was needed");
    assert.deepEqual(unconfirmed, []);
    assert.deepEqual(await calls(), STOPPED);
  });

  test("a postmaster the fast stop leaves running is stopped immediate, which ends its children, before any kill", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const vars = { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_STUBBORN: "1" };
    const { error, pid } = await startWith(dir, c, { ...vars, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    await withVars(vars, () => c.stop());
    assert.equal(await ended(await pid(postmaster)), true);
    assert.ok(existsSync(join(dir, "immediate")), "it ended through the immediate stop, not a kill");
    assert.deepEqual(await calls(), ["pg_ctl start", "pg_ctl stop", "pg_ctl stop immediate"]);
  });

  test("a postmaster postmaster.pid names is never killed though both pg_ctl stops fail: it is asked immediate again, and the stop holds until it ends", { timeout: 60_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const said: string[] = [];
    const unconfirmed: boolean[] = [];
    // A child the postmaster has just forked, listed with its command line, as one is until it renames itself.
    const forked = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    strays.push(forked.pid as number);
    let forking = false;
    let listings = 0;
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => {
        listings++;
        return [
          ...(await asStarted()),
          ...(forking && forked.exitCode === null && forked.signalCode === null ? [{ pid: forked.pid as number, commandLine: `${join(bin, "postgres")} -D ${join(dir, "postgres")} -p 41659` }] : []),
        ];
      },
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, unsureAfterMs: 300, immediateAgainMs: 1_000, log: (m) => said.push(m), unconfirmed: (on) => unconfirmed.push(on) });
    const vars = { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_DEAF: "1" };
    const { error, pid } = await startWith(dir, c, { ...vars, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    const child = await pid(postmaster);
    forking = true;
    let stopped = false;
    const stopping = withVars(vars, () => c.stop()).then(() => (stopped = true));
    try {
      // A stop that ends early ends each wait too, so a killed postmaster fails on the check that names it.
      await until("the end unconfirmed, and immediate asked again", async () => stopped || (unconfirmed.length > 0 && (await calls()).filter((call) => call === "pg_ctl stop immediate").length >= 2));
      assert.equal(isAlive(child), true, "it was never killed");
      assert.equal(forked.signalCode, null, "nor was the child it forked, while it runs named");
      assert.equal(stopped, false, "the stop holds while it runs");
      assert.deepEqual(unconfirmed, [true]);
      const asked = await calls();
      assert.deepEqual(asked.slice(0, 3), ["pg_ctl start", "pg_ctl stop", "pg_ctl stop immediate"]);
      assert.ok(asked.slice(3).every((call) => call === "pg_ctl stop immediate"), `then only immediate again: ${asked.join(", ")}`);
      assert.match(said.join("\n"), new RegExp(`PostgreSQL \\(pid ${child}\\) still runs after pg_ctl stop -m immediate, so it is asked again`));
      // With its postmaster.pid gone it is no longer named, but it was, so it may have children, and it ends itself within a minute.
      await rm(join(dir, "postgres", "postmaster.pid"));
      const seen = listings;
      await until("two passes without the file", () => listings >= seen + 2 || stopped);
      assert.equal(isAlive(child), true, "a postmaster the file once named is never killed");
      assert.equal(stopped, false);
    } finally {
      // It ends as a postmaster in immediate mode does once its children have, and a failed check above leaves nothing running for the tests after.
      end(child);
      await stopping;
    }
    assert.deepEqual(unconfirmed, [true, false]);
    assert.equal(forked.signalCode, "SIGKILL", "with no postmaster named that runs, the one left is killed");
  });

  test("a pass never signals a row of its listing after waiting on a pg_ctl stop, by which time the pid may be another program's", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    // Listed beside the named postmaster with its exact command, as a child it has just forked is, and by the next listing an unrelated program with that pid.
    const other = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    strays.push(other.pid as number);
    let stopping = false;
    let listings = 0;
    const proc: ProcessLookup = {
      ...lookup({ stamp: neverMine(), exe: null }),
      list: async () => {
        const rows = await asStarted();
        if (!stopping || ++listings > 1) return rows;
        return [...rows, { pid: other.pid as number, commandLine: `${join(bin, "postgres")} -D ${join(dir, "postgres")} -p 41659` }];
      },
    };
    // Neither its own nor confirmed by leftover(), so the stop leaves it to the proof, whose first pass stops it through pg_ctl.
    const c = cluster(dir, bin, proc, { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    stopping = true;
    await withVars({ RVTT_FAKE_CHILD: postmaster }, () => c.stop());
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), STOPPED);
    assert.equal(other.signalCode, null, "the row from before the stop was never signalled");
    assert.ok(listings >= 2, "a new pass took a new listing");
  });

  test("a pass stops the postmaster it lists with nothing read in between, so a pid reused meanwhile is never the one pg_ctl stop reaches", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    // The program that takes the postmaster's pid, as postmaster.pid will name it, once a read of its start would let it.
    const other = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    strays.push(other.pid as number);
    let listedInStop = false;
    let reused = false;
    let reads = 0;
    const proc: ProcessLookup = {
      ...lookup({ exe: null }),
      // Every reading differs, so the postmaster is never counted as the one this process started, and a read after the stop's first listing is slow, and in it the postmaster ends and its pid is reused.
      stamp: async () => {
        if (listedInStop && !reused) {
          reused = true;
          end(Number((await readFile(postmaster, "utf8")).trim()));
          await pidFile(dir, other.pid as number);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return ++reads;
      },
      list: async () => {
        const rows = await asStarted();
        if (stopping) listedInStop = true;
        return rows;
      },
    };
    let stopping = false;
    // Neither its own nor confirmed by leftover() (no program name), so the stop leaves it to the proof, whose first pass stops it through pg_ctl.
    const c = cluster(dir, bin, proc, { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    stopping = true;
    await withVars({ RVTT_FAKE_CHILD: postmaster }, () => c.stop());
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), STOPPED);
    assert.equal(other.signalCode, null, "pg_ctl stop never reached the program that took the pid");
    assert.equal(reused, false, "nothing was read between the listing and the stop");
  });

  /** A deaf postmaster the stop can't end, which the listing stops showing once the stop begins, read afterwards as `then` says. */
  async function unlisted(then: "same" | "unreadable" | "another"): Promise<{ stopped: () => boolean; stopping: Promise<unknown>; child: number; said: string[]; unconfirmed: boolean[] }> {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let hidden: number | null = null;
    let reading: "real" | typeof then = "real";
    const said: string[] = [];
    const unconfirmed: boolean[] = [];
    const proc: ProcessLookup = {
      ...lookup(),
      stamp: async (pid) => (reading === "real" || reading === "same" ? processStamp(pid) : reading === "unreadable" ? null : 1),
      // A listing that misses it, as macOS ps does for a process whose arguments it can't read, and the readings after that.
      list: async () => {
        const rows = await asStarted();
        if (hidden === null) return rows;
        reading = then;
        return rows.filter((p) => p.pid !== hidden);
      },
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, unsureAfterMs: 300, log: (m) => said.push(m), unconfirmed: (on) => unconfirmed.push(on) });
    const vars = { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_DEAF: "1" };
    const { error, pid } = await startWith(dir, c, { ...vars, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    const child = await pid(postmaster);
    hidden = child;
    let stopped = false;
    const stopping = withVars(vars, () => c.stop()).then(() => (stopped = true));
    return { stopped: () => stopped, stopping, child, said, unconfirmed };
  }

  test("a remembered postmaster the listing misses, alive with the start it had, holds the proof until it ends", { timeout: 30_000 }, async () => {
    const { stopped, stopping, child, said, unconfirmed } = await unlisted("same");
    try {
      await until("the end unconfirmed", () => unconfirmed.length > 0 || stopped());
      assert.equal(stopped(), false, "the stop holds while it runs");
      assert.match(said.join("\n"), new RegExp(`PostgreSQL \\(pid ${child}\\), which this process started or saw named, still runs with the start it had, though the listing does not show it`));
      assert.equal(isAlive(child), true, "never killed");
    } finally {
      end(child);
      await stopping;
    }
    assert.deepEqual(unconfirmed, [true, false]);
  });

  test("a remembered postmaster the listing misses, alive with a start that can't be read, holds the proof too, as uncertain", { timeout: 30_000 }, async () => {
    const { stopped, stopping, child, said, unconfirmed } = await unlisted("unreadable");
    try {
      await until("the end unconfirmed", () => unconfirmed.length > 0 || stopped());
      assert.equal(stopped(), false, "the stop holds while it may run");
      assert.match(said.join("\n"), new RegExp(`PostgreSQL \\(pid ${child}\\), which this process started or saw named, still runs and its start can't be read, so it may be, though the listing does not show it`));
    } finally {
      end(child);
      await stopping;
    }
    assert.deepEqual(unconfirmed, [true, false]);
  });

  test("a remembered pid the listing misses, alive with another start, is a later process and holds nothing", { timeout: 30_000 }, async () => {
    const { stopping, child, said, unconfirmed } = await unlisted("another");
    try {
      await stopping;
      assert.equal(isAlive(child), true, "the stop let go while that process still runs, and never signalled it");
      assert.doesNotMatch(said.join("\n"), new RegExp(`pid ${child}\\), which this process`));
      assert.deepEqual(unconfirmed, []);
    } finally {
      end(child);
    }
  });

  test("the postmaster this process started is never killed though its postmaster.pid can't be read, or is gone, before the stop", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const unconfirmed: boolean[] = [];
    const listing = counted();
    const c = new Cluster({ ...cluster(dir, bin, { ...lookup(), list: listing.list }, { platform: "darwin" }).opts, unsureAfterMs: 300, unconfirmed: (on) => unconfirmed.push(on) });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    const child = await pid(postmaster);
    const file = join(dir, "postgres", "postmaster.pid");
    // A file that can't be read, as while an antivirus scan holds it on Windows.
    await rm(file);
    await mkdir(file);
    let stopped = false;
    const stopping = c.stop().then(() => (stopped = true));
    try {
      // A stop that ends early ends each wait too, so a killed postmaster fails on the check that names it.
      await until("two passes while the file can't be read", () => listing.count() >= 2 || stopped);
      assert.equal(isAlive(child), true, "never killed while postmaster.pid can't be read");
      await rmdir(file);
      const seen = listing.count();
      await until("two passes without the file, and the end unconfirmed", () => (listing.count() >= seen + 2 && unconfirmed.length > 0) || stopped);
      assert.equal(isAlive(child), true, "nor once it is gone");
      assert.equal(stopped, false, "the stop holds while it runs");
      assert.deepEqual(unconfirmed, [true]);
    } finally {
      // It ends on its own, as a postmaster does within a minute of losing its postmaster.pid.
      end(child);
      await stopping;
    }
    assert.deepEqual(unconfirmed, [true, false]);
    assert.deepEqual(await calls(), ["pg_ctl start"], "pg_ctl stop had no file to go by");
  });

  test("a kept pid that now runs with another start reading is a later process, so the record no longer spares it", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let reads = 0;
    // The start reading recorded at the start, and another in the listing and at every read after, as for a process that reused the pid.
    const proc: ProcessLookup = { ...lookup({ stamp: async () => (++reads === 1 ? 1 : 2) }), list: async () => (await asStarted()).map((p) => ({ ...p, stamp: 2 })) };
    const c = cluster(dir, bin, proc, { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    const child = await pid(postmaster);
    await rm(join(dir, "postgres", "postmaster.pid"));
    const stopping = c.stop();
    let bound: NodeJS.Timeout | undefined;
    try {
      // Bounded below the test's timeout, so a stop that waits on it fails on this check.
      const done = await Promise.race([stopping.then(() => true), new Promise<boolean>((resolve) => (bound = setTimeout(() => resolve(false), 10_000)))]);
      assert.equal(done, true, "the stop did not wait on it");
      assert.equal(await ended(child), true, "an exact postmaster no record spares and no file names is killed");
    } finally {
      clearTimeout(bound);
      end(child);
      await stopping;
    }
  });

  test("a kept pid whose start reading can't be read now is still spared", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let reads = 0;
    const listing = counted();
    // The listing can't read its start either.
    const c = cluster(dir, bin, { ...lookup({ stamp: async () => (++reads === 1 ? 1 : null) }), list: async () => (await listing.list()).map((p) => ({ ...p, stamp: null })) }, { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    const child = await pid(postmaster);
    await rm(join(dir, "postgres", "postmaster.pid"));
    let stopped = false;
    const stopping = c.stop().then(() => (stopped = true));
    try {
      // A stop that ends early ends the wait too, so a killed postmaster fails on the check that names it.
      await until("three passes", () => listing.count() >= 3 || stopped);
      assert.equal(isAlive(child), true, "never killed");
    } finally {
      end(child);
      await stopping;
    }
  });

  test("a postmaster a cancel saw named is never killed once its postmaster.pid is gone, though both stops failed", { timeout: 60_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const listing = counted();
    const c = cluster(dir, bin, { ...lookup(), list: listing.list }, { platform: "darwin" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    let alive: boolean | null = null;
    // Once the fast stop and the immediate one have failed, the file goes, and after two passes more the test ends the postmaster itself.
    const watching = (async () => {
      await until("the immediate stop", async () => (await calls()).includes("pg_ctl stop immediate"));
      await rm(join(dir, "postgres", "postmaster.pid"));
      const seen = listing.count();
      await until("two passes without the file", () => listing.count() >= seen + 2);
      const child = Number((await readFile(postmaster, "utf8")).trim());
      alive = isAlive(child);
      end(child);
    })();
    const vars = { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_DEAF: "1" };
    const { error } = await startWith(dir, c, { ...vars, RVTT_FAKE_PGCTL: "wait" }, abort.signal);
    await watching;
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(alive, true, "never killed with its file gone");
    assert.deepEqual((await calls()).slice(0, 3), ["pg_ctl start", "pg_ctl stop", "pg_ctl stop immediate"]);
  });

  test("a postmaster the start waited on as named is never killed once its postmaster.pid is gone", { timeout: 60_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const abort = new AbortController();
    let listings = 0;
    // pg_ctl gives up at once, and its postmaster, named but never ready, is waited on, a listing at a time. Nothing else lists before the cancel, so by the second listing the first wait has seen the file name it. Then the file goes and the start is cancelled.
    const list = async (): Promise<ListedProcess[]> => {
      const rows = await asStarted();
      if (++listings === 2) {
        await rm(join(dir, "postgres", "postmaster.pid"));
        abort.abort();
      }
      return rows;
    };
    const c = cluster(dir, bin, { ...lookup(), list }, { platform: "darwin" });
    let alive: boolean | null = null;
    const watching = (async () => {
      await until("two passes of the proof", () => listings >= 4);
      const child = Number((await readFile(postmaster, "utf8")).trim());
      alive = isAlive(child);
      end(child);
    })();
    const { error } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "fail" }, abort.signal);
    await watching;
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(alive, true, "never killed with its file gone");
    assert.deepEqual(await calls(), ["pg_ctl start"]);
  });

  test("a postmaster.pid that can't be read never lets a cancel kill the postmaster it can't rule out", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const file = join(dir, "postgres", "postmaster.pid");
    await mkdir(file);
    const postmaster = join(dir, "postmaster.child");
    const unconfirmed: boolean[] = [];
    const c = new Cluster({ ...cluster(dir, bin, lookup(), { platform: "darwin" }).opts, unconfirmed: (on) => unconfirmed.push(on) });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    let alive: boolean | null = null;
    setTimeout(() => {
      void readFile(postmaster, "utf8").then((text) => {
        alive = isAlive(Number(text.trim()));
        return rmdir(file);
      });
    }, 2_000);
    const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_PIDAFTER: "10" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.equal(alive, true, "not killed while postmaster.pid could not be read");
    assert.ok(ms >= 2_000 && ms < 8_000, `answered after ${ms} ms`);
    assert.equal(await ended(await pid(postmaster)), true, "killed once the file was surely absent");
    assert.deepEqual(await calls(), KILLED);
    assert.deepEqual(unconfirmed, [true, false]);
  });

  test("a slow but clean first pg_ctl stop never reads as a postmaster that outlived its end", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const unconfirmed: boolean[] = [];
    // Neither its own nor confirmed by leftover() (no program name), so the stop leaves it to the proof, whose first pass stops it.
    const c = new Cluster({ ...cluster(dir, bin, lookup({ stamp: neverMine(), exe: null }), { platform: "darwin" }).opts, unsureAfterMs: 300, unconfirmed: (on) => unconfirmed.push(on) });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    await withVars({ RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_SLOWSTOP: "1" }, () => c.stop());
    assert.equal(await ended(await pid(postmaster)), true);
    assert.deepEqual(await calls(), STOPPED);
    assert.deepEqual(unconfirmed, [], "a pg_ctl stop of 1 s, past a 0.3 s bound, is no postmaster that outlived its end");
  });

  test("a cancel whose listing fails waits a retry's length before the next, not a quarter second", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    let failing = true;
    let failed = 0;
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => {
        if (!failing) return asStarted();
        failed++;
        throw new Error("Get-CimInstance failed");
      },
    };
    const c = new Cluster({ ...cluster(dir, bin, proc, { platform: "darwin" }).opts, listRetryMs: 1_000 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    setTimeout(() => (failing = false), 2_600);
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait" }, abort.signal);
    assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
    assert.ok(failed <= 4, `${failed} listings in 2.5 s while they failed`);
    assert.equal(await ended(await pid(postmaster)), true);
  });
});

describe("a program the cluster ends", { skip: posixOnly }, () => {
  // Each stand-in's pid file. A test that fails or times out leaves its program running, which would hold the run open.
  const pidFiles: string[] = [];
  after(async () => {
    for (const file of pidFiles) {
      const pid = Number(await readFile(file, "utf8").catch(() => ""));
      try {
        if (pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // Already ended.
      }
    }
  });

  test("is answered for only once its exit is seen, and an end it does not take is logged while the wait goes on", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const pidFile = join(dir, "stubborn.pid");
    pidFiles.push(pidFile);
    const said: string[] = [];
    let answered: unknown = undefined;
    const run = runToExit("/bin/sh", ["-c", `trap '' TERM; echo $$ > '${pidFile}'; while :; do sleep 0.1; done`], { env: process.env, limitMs: 500, killSignal: "SIGTERM", endWaitMs: 300, log: (m) => said.push(m) });
    void run.then(
      () => (answered = "resolved"),
      (err: unknown) => (answered = err),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(answered, undefined, "not answered while the program still runs");
    assert.match(said.join("\n"), /^sh \(pid \d+\) has not ended \d+ s after it was ended, so the data folder stays locked until it does$/m);
    process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    await assert.rejects(run, (err: unknown) => err instanceof Ended && err.message === "sh did not finish in 1 s");
  });

  test("a kill that fails, as EPERM does, never answers the run: only its exit does", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const pidFile = join(dir, "unkillable.pid");
    pidFiles.push(pidFile);
    const said: string[] = [];
    let answered: unknown = undefined;
    const kill = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = function (this: ChildProcess): boolean {
      this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
      return false;
    };
    let run: Promise<void>;
    try {
      run = runToExit("/bin/sh", ["-c", `echo $$ > '${pidFile}'; while :; do sleep 0.1; done`], { env: process.env, limitMs: 500, endWaitMs: 300, log: (m) => said.push(m) });
      void run.then(
        () => (answered = "resolved"),
        (err: unknown) => (answered = err),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } finally {
      ChildProcess.prototype.kill = kill;
    }
    assert.equal(answered, undefined, "not answered while the program still runs");
    assert.match(said.join("\n"), /^sh \(pid \d+\): kill EPERM, so the data folder stays locked until it exits$/m);
    process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    await assert.rejects(run, (err: unknown) => err instanceof Ended && err.message === "sh did not finish in 1 s");
  });

  test("a program that never started answers at once with the spawn's error", async () => {
    await assert.rejects(runToExit("/nonexistent/initdb", [], { env: process.env }), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
  });

  test("init is never cancelled, and answers only once initdb's restricted copy, which does the work on Windows, has ended", { timeout: 15_000 }, async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    const marker = join(dir, "inner.done");
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    process.env.RVTT_FAKE_INIT_INNER = marker;
    try {
      await c.init();
    } finally {
      delete process.env.RVTT_FAKE_INIT_INNER;
    }
    assert.ok(existsSync(marker), "the restricted copy finished before init answered");
    assert.equal(c.needsInit(), false);
  });
});

describe("a postmaster by its command line", () => {
  const unix: Programs = { postgres: "/opt/r/postgres/bin/postgres", shell: "/usr/bin/dash", pgCtl: "/opt/r/postgres/bin/pg_ctl" };
  const windows: Programs = {
    postgres: "C:\\Program Files\\RaccoonVTT\\resources\\postgres\\bin\\postgres.exe",
    shell: "C:\\Windows\\System32\\cmd.exe",
    pgCtl: "C:\\Program Files\\RaccoonVTT\\resources\\postgres\\bin\\pg_ctl.exe",
  };
  // Each path stands for its own real path here, as the bundled program's does, with Windows' separators on Windows.
  const kind = (p: ListedProcess, folders: string[], on: Platform) => postmasterKind(p, folders, on, on === "win32" ? windows : unix, async (path) => (on === "win32" ? path.replaceAll("/", "\\") : path));
  /** The cmd.exe pg_ctl starts the postmaster through on Windows, as pg_ctl writes its command. */
  const launcher = (program: string, folder: string) => `"C:\\Windows\\System32\\cmd.exe" /C ""${program}" -D "${folder}" -p 41659 < "nul" >> "D:\\Tables\\Dm\\RaccoonVTT\\logs\\postgres.log" 2>&1"`;
  const line = (commandLine: string, exe: string | null = null): ListedProcess => ({ pid: 7, commandLine, exe });
  const args = (argv: string[], exe: string | null): ListedProcess => ({ pid: 7, commandLine: argv.join(" "), argv, exe });
  const exec = (program: string, folder: string) => `exec "${program}" -D "${folder}" -p 41659 < "/dev/null" >> "${folder}.log" 2>&1`;

  test("is exact only as pg_ctl starts it, run by the bundled program, on each system", async () => {
    const data = ["/data/Tést Жук/postgres"];
    const cases: [string, ListedProcess, Platform][] = [
      ["macOS: the whole line", line("/opt/r/postgres/bin/postgres -D /data/Tést Жук/postgres -p 41659"), "darwin"],
      ["macOS: the shell pg_ctl execs it from", line(`/bin/sh -c ${exec("/opt/r/postgres/bin/postgres", "/data/Tést Жук/postgres")}`), "darwin"],
      ["Linux: its arguments, and its exe link on the bundled program", args(["/opt/r/postgres/bin/postgres", "-D", "/data/Tést Жук/postgres", "-p", "41659"], unix.postgres), "linux"],
      ["Linux: the shell pg_ctl execs it from", args(["/bin/sh", "-c", exec("/opt/r/postgres/bin/postgres", "/data/Tést Жук/postgres")], unix.shell), "linux"],
    ];
    for (const [what, p, on] of cases) assert.equal(await kind(p, data, on), "exact", what);
    const folders = ["D:\\Tables\\Dm\\RaccoonVTT\\postgres", "C:\\ProgramData\\RaccoonVTT\\a1b2\\data\\postgres"];
    // cmd.exe gives postgres.exe the command without its redirections, and the spaces before them stay.
    const exe = "C:\\PROGRAM FILES\\RaccoonVTT\\resources\\postgres\\bin\\postgres.exe";
    assert.equal(await kind(line('"C:/Program Files/RaccoonVTT/resources/postgres/bin/postgres.exe" -D "D:/Tables/dm/RaccoonVTT/postgres" -p 41659   ', exe), folders, "win32"), "exact", "Windows: forward slashes, and case ignored");
    assert.equal(await kind(line('"C:/PROGRA~1/RaccoonVTT/resources/postgres/bin/postgres.exe" -D "C:/ProgramData/RaccoonVTT/a1b2/data/postgres" -p 41659', exe), folders, "win32"), "exact", "Windows: the junction PostgreSQL was given");
    // The line a Windows runner's real cluster gave (desktop.yml, run 43819273555), its temp folder here under the runner's work folder: cmd.exe joins the program and its arguments with a space of its own.
    const runner = { postgres: "D:\\a\\raccoon-vtt\\raccoon-vtt\\desktop\\.runtime\\postgres\\bin\\postgres.exe", shell: windows.shell, pgCtl: null };
    const seen = line('"D:/a/raccoon-vtt/raccoon-vtt/desktop/.runtime/postgres/bin/postgres.exe"  -D "D:/a/_temp/RUNNER~1/rvtt-pg-cluster-eGhFsG/postgres" -p 62353 ', runner.postgres);
    const temp = ["D:\\a\\_temp\\RUNNER~1\\rvtt-pg-cluster-eGhFsG\\postgres"];
    assert.equal(await postmasterKind(seen, temp, "win32", runner, async (path) => path.replaceAll("/", "\\")), "exact", "Windows: the runner's postmaster");
    const program = "C:/Program Files/RaccoonVTT/resources/postgres/bin/postgres.exe";
    assert.equal(await kind(line(launcher(program, "D:/Tables/Dm/RaccoonVTT/postgres"), "C:\\WINDOWS\\system32\\cmd.exe"), folders, "win32"), "exact", "Windows: the launcher, run by Windows' own cmd.exe");
  });

  test("anything else that names the folder after postgres and -D is loose, so it counts as running and is never signalled", async () => {
    const data = ["/data/postgres"];
    const cases: [string, ListedProcess, Platform][] = [
      ["another cluster, in a folder whose name starts with this one's", line("postgres -D /data/postgres other -p 5"), "darwin"],
      ["the same with every argument kept apart", args(["/opt/r/postgres/bin/postgres", "-D", "/data/postgres other", "-p", "5"], unix.postgres), "linux"],
      ["a tool that names the folder", line("node /x/tool.js postgres -D /data/postgres"), "darwin"],
      ["the tool on Linux", args(["node", "/x/tool.js", "postgres", "-D", "/data/postgres"], "/usr/bin/node"), "linux"],
      ["a search", line("grep -r postgres -D /data/postgres"), "darwin"],
      ["a search on Linux", args(["grep", "-r", "postgres", "-D", "/data/postgres"], "/usr/bin/grep"), "linux"],
      ["macOS: pg_ctl's form at the end, another program first", line("node /x/tool.js postgres -D /data/postgres -p 5"), "darwin"],
      ["macOS: pg_ctl's form naming another postgres", line("/usr/local/bin/postgres -D /data/postgres -p 5"), "darwin"],
      ["macOS: an argument pg_ctl never adds", line("/opt/r/postgres/bin/postgres -D /data/postgres -p 5 -c fsync=off"), "darwin"],
      ["Linux: pg_ctl's arguments, run by another program", args(["/opt/r/postgres/bin/postgres", "-D", "/data/postgres", "-p", "5"], "/usr/bin/node"), "linux"],
      ["Linux: pg_ctl's arguments, the exe link unreadable", args(["/opt/r/postgres/bin/postgres", "-D", "/data/postgres", "-p", "5"], null), "linux"],
      ["Linux: the launcher's command, run by another program", args(["/bin/sh", "-c", exec("/opt/r/postgres/bin/postgres", "/data/postgres")], "/usr/bin/node"), "linux"],
      ["the launcher exec'ing another program", line(`/bin/sh -c ${exec("/usr/local/bin/postgres", "/data/postgres")}`), "darwin"],
    ];
    for (const [what, p, on] of cases) assert.equal(await kind(p, data, on), "loose", what);
    const spaced = args([unix.postgres!, "-D", "/data/Tést", "Жук/postgres", "-p", "5"], unix.postgres);
    assert.equal(await kind(spaced, ["/data/Tést Жук/postgres"], "linux"), "loose", "Linux: the folder's name split across two arguments, which a joined line can't tell apart");
    const folders = ["C:\\data\\postgres"];
    const winCases: [string, ListedProcess][] = [
      ["another cluster, in a folder whose name starts with this one's", line('"C:/pg/postgres.exe" -D "C:/data/postgres other" -p 5', windows.postgres)],
      ["pg_ctl's form, run by another postgres.exe", line('"C:/pg/postgres.exe" -D "C:/data/postgres" -p 5', "C:\\pg\\postgres.exe")],
      ["pg_ctl's form, its program unreadable", line('"C:/pg/postgres.exe" -D "C:/data/postgres" -p 5', null)],
      ["an argument pg_ctl never adds", line('"C:/pg/postgres.exe" -D "C:/data/postgres" -p 5 -c fsync=off', windows.postgres)],
      ["the launcher's command, run by another program than Windows' cmd.exe", line(launcher("C:/Program Files/RaccoonVTT/resources/postgres/bin/postgres.exe", "C:/data/postgres"), "C:\\tools\\cmd.exe")],
      ["the launcher starting another postgres.exe", line(launcher("C:/pg/postgres.exe", "C:/data/postgres"), windows.shell)],
      ["the launcher's command with more after it", line(`${launcher("C:/Program Files/RaccoonVTT/resources/postgres/bin/postgres.exe", "C:/data/postgres")} & echo`, windows.shell)],
    ];
    for (const [what, p] of winCases) assert.equal(await kind(p, folders, "win32"), "loose", `Windows: ${what}`);
  });

  test("the bundled pg_ctl starting this folder is pg_ctl, which may yet start one: before its fork execs the shell, or on Windows as a pg_ctl start not this process's own", async () => {
    const data = ["/data/Tést Жук/postgres"];
    const argv = ["/opt/r/postgres/bin/pg_ctl", "start", "-D", "/data/Tést Жук/postgres", "-l", "/data/Tést Жук/logs/postgres.log", "-w", "-t", "1800", "-o", "-p 41659"];
    assert.equal(await kind(args(argv, unix.pgCtl), data, "linux"), "pgctl", "Linux: its arguments, and its exe link on the bundled pg_ctl");
    assert.equal(await kind(args(argv, "/usr/lib/postgresql/17/bin/pg_ctl"), data, "linux"), "loose", "Linux: another pg_ctl counts, but is no stage of this app's");
    assert.equal(await kind(args(argv, null), data, "linux"), "loose", "Linux: an exe link that can't be read");
    assert.equal(await kind(line(argv.join(" ")), data, "darwin"), "pgctl", "macOS: the line names the bundled pg_ctl");
    assert.equal(await kind(line(["/usr/local/bin/pg_ctl", ...argv.slice(1)].join(" ")), data, "darwin"), "loose", "macOS: another pg_ctl");
    assert.equal(await kind(line("/opt/r/postgres/bin/pg_ctl stop -D /data/Tést Жук/postgres -m fast -w -t 60"), data, "darwin"), null, "pg_ctl stop starts nothing");
    assert.equal(await kind(line("/opt/r/postgres/bin/pg_ctl start -D /data/Tést Жук/postgres.incomplete-17 -l log"), data, "darwin"), null, "a folder beside it");
    assert.equal(await kind(args(["/opt/r/postgres/bin/pg_ctl", "stop", "-D", "/data/Tést Жук/postgres"], unix.pgCtl), data, "linux"), null);
    const folders = ["C:\\Users\\Dm\\AppData\\Local\\RaccoonVTT\\data\\postgres"];
    // As Node writes the command line: an argument quoted only when it holds a space.
    const win = '"C:\\Program Files\\RaccoonVTT\\resources\\postgres\\bin\\pg_ctl.exe" start -D C:\\Users\\Dm\\AppData\\Local\\RaccoonVTT\\data\\postgres -l C:\\Users\\Dm\\AppData\\Local\\RaccoonVTT\\data\\logs\\postgres.log -w -t 1800 -o "-p 41659"';
    assert.equal(await kind(line(win, "C:\\PROGRAM FILES\\RaccoonVTT\\resources\\postgres\\bin\\pg_ctl.exe"), folders, "win32"), "pgctl", "Windows: its program, case ignored");
    assert.equal(await kind(line(win.replace("-D C:", '-D "C:').replace("\\postgres -l", '\\postgres" -l'), windows.pgCtl), folders, "win32"), "pgctl", "Windows: the folder quoted");
    assert.equal(await kind(line(win, "C:\\pg\\pg_ctl.exe"), folders, "win32"), "loose", "Windows: another pg_ctl.exe");
  });

  test("is no postmaster at all for a folder beside it, another case off Windows, or a child that renamed itself", async () => {
    const data = ["/data/Tést Жук/postgres"];
    assert.equal(await kind(line("/opt/r/postgres/bin/postgres -D /data/Tést Жук/postgres.incomplete-17 -p 5"), data, "darwin"), null, "a folder beside it");
    assert.equal(await kind(line("/opt/r/postgres/bin/postgres -D /DATA/Tést Жук/postgres -p 5"), data, "darwin"), null, "another case is another folder off Windows");
    assert.equal(await kind(args(["postgres: checkpointer "], unix.postgres), data, "linux"), null, "a child, which renames itself");
    const folders = ["C:\\ProgramData\\RaccoonVTT\\a1b2\\data\\postgres"];
    assert.equal(await kind(line('"C:\\pg\\pg_ctl.exe" stop -D "C:/ProgramData/RaccoonVTT/a1b2/data/postgres" -m fast', windows.pgCtl), folders, "win32"), null);
    assert.equal(await kind(line('"C:\\pg\\postgres.exe" --forkchild="checkpointer" 3', windows.postgres), folders, "win32"), null);
  });
});

describe("the environment PostgreSQL's programs get", () => {
  test("has no PG variable, and on Windows COMSPEC names Windows' own cmd.exe, in one spelling, whatever the caller's said", () => {
    const comspec = Object.keys(process.env).find((key) => /^comspec$/i.test(key)) ?? "ComSpec";
    const saved = process.env[comspec];
    try {
      Object.assign(process.env, { PGHOST: "elsewhere", pgpassfile: "elsewhere", [comspec]: "C:\\tools\\other.exe" });
      const win = pgEnv({ LC_ALL: "C" }, "win32");
      assert.deepEqual(Object.entries(win).filter(([key]) => /^comspec$/i.test(key)), [["COMSPEC", systemShell()]]);
      assert.deepEqual(Object.keys(win).filter((key) => /^PG/i.test(key)), []);
      assert.equal(win.LC_ALL, "C");
      const mac = pgEnv({}, "darwin");
      assert.deepEqual(Object.entries(mac).filter(([key]) => /^comspec$/i.test(key)), [[comspec, "C:\\tools\\other.exe"]], "off Windows it is left as it was");
      assert.deepEqual(Object.keys(mac).filter((key) => /^PG/i.test(key)), []);
    } finally {
      delete process.env.PGHOST;
      delete process.env.pgpassfile;
      if (saved === undefined) delete process.env[comspec];
      else process.env[comspec] = saved;
    }
  });
});

describe("the data folder's postgres/", () => {
  test("a postgres/ folder is a cluster, so one that is there is never made again, whatever it holds", async () => {
    const dir = await folder();
    const c = cluster(dir, "/none", lookup());
    assert.equal(c.needsInit(), true);
    await mkdir(join(dir, "postgres"));
    await writeFile(join(dir, "postgres", "postgresql.conf"), "# not PostgreSQL's own folder\n");
    assert.equal(c.needsInit(), false, "the start then fails with the log's words, and nothing is moved or made");
  });
});

describe("initdb", { skip: posixOnly }, () => {
  test("an init cut off after PG_VERSION and before the app's settings leaves no postgres/, and the next one makes it whole", async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    const cut = cluster(dir, bin, lookup(), {
      afterInitdb: async () => {
        throw new Error("killed");
      },
    });
    assert.equal(cut.needsInit(), true);
    await assert.rejects(cut.init(), /killed/);
    assert.equal(existsSync(join(dir, "postgres")), false, "no folder passes for a cluster");
    const staging = (await readdir(dir)).filter((n) => n.startsWith("postgres.init-"));
    assert.equal(staging.length, 1);
    assert.ok(existsSync(join(dir, staging[0]!, "PG_VERSION")), "initdb had written PG_VERSION");
    assert.equal(cut.needsInit(), true, "the next start makes the cluster again");

    const whole = cluster(dir, bin, lookup());
    await whole.init();
    assert.equal(whole.needsInit(), false);
    assert.match(await readFile(join(dir, "postgres", "pg_hba.conf"), "utf8"), /^# Written by RaccoonVTT\./);
    assert.match(await readFile(join(dir, "postgres", "postgresql.conf"), "utf8"), /listen_addresses = '127\.0\.0\.1'\nunix_socket_directories = ''/);
    const names = await readdir(dir);
    assert.deepEqual(names.filter((n) => n.startsWith("postgres.init-")), [], "the cut-off staging folder was moved aside");
    assert.equal(names.filter((n) => n.startsWith("postgres.incomplete-")).length, 1, "and never deleted");
  });

  test("on Windows the staging folder's rename waits out a file another program holds open, and so does moving a cut-off one aside", async () => {
    const dir = await folder();
    const { bin } = await programs(dir);
    // The stand-in initdb under Windows' name for it.
    await writeFile(join(bin, "initdb.exe"), await readFile(join(bin, "initdb"), "utf8"), { mode: 0o755 });
    await mkdir(join(dir, "postgres.init-left"));
    let refusals = 0;
    const renames: string[] = [];
    const c = cluster(dir, bin, lookup(), {
      platform: "win32",
      renameDir: async (from, to) => {
        renames.push(basename(from));
        // Each folder's first two renames are refused, as while an antivirus scan holds a file in it.
        if (renames.filter((n) => n === basename(from)).length <= 2) {
          refusals++;
          throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
        }
        await rename(from, to);
      },
    });
    await c.init();
    assert.equal(refusals, 4, "two for the cut-off folder moved aside, two for the staging folder");
    assert.ok(existsSync(join(dir, "postgres", "PG_VERSION")));
    assert.match(await readFile(join(dir, "postgres", "pg_hba.conf"), "utf8"), /^# Written by RaccoonVTT\./);
    assert.equal((await readdir(dir)).filter((n) => n.startsWith("postgres.init-")).length, 0);
  });
});

