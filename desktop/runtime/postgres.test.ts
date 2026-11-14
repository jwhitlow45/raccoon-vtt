import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { Platform } from "../contract.ts";
import { BOOT_RECORD, Cluster, DatabaseFailed, Ended, postmasterOf, runToExit, uncertainWords, type ProcessLookup } from "./postgres.ts";
import { listProcesses } from "./processInfo.ts";

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
  // `postgres -D <folder>` so a process listing knows it as real pg_ctl's,
  // and writes its pid there. The postmaster writes postmaster.pid after
  // RVTT_FAKE_PIDAFTER s, marked starting, then ready after
  // RVTT_FAKE_READYAFTER s (never when unset), naming RVTT_FAKE_TAKENBY's
  // pid then instead of its own when that is set, and lives RVTT_FAKE_LIFE
  // s. It ignores SIGTERM when RVTT_FAKE_STUBBORN is set. pg_ctl stop ends
  // it. RVTT_FAKE_PGCTL says what pg_ctl does meanwhile: "wait" as -w does
  // (exit 0 once ready, 1 once the postmaster is gone), "fail" (exit 1 at
  // once, as when its own wait runs out), "failsoon" (exit 1 after 0.3 s),
  // or "hang".
  await writeFile(
    join(bin, "postgres"),
    [
      "#!/bin/sh",
      `d="$2"`,
      `if [ -n "$RVTT_FAKE_STUBBORN" ]; then trap '' TERM; fi`,
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
      `echo "pg_ctl $1" >> '${log}'`,
      `if [ "$1" = start ] && [ -z "$RVTT_FAKE_CHILD" ]; then printf '%s\\n%s\\n%s\\n5999\\n' "$RVTT_FAKE_PID" "$3" "$(date +%s)" > "$3/postmaster.pid"; fi`,
      `if [ "$1" = stop ] && [ -n "$RVTT_FAKE_CHILD" ]; then kill "$(head -1 "$3/postmaster.pid")"; fi`,
      `if [ "$1" = stop ]; then rm -f "$3/postmaster.pid"; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_HOLD" ]; then sleep 30 & echo $! > "$RVTT_FAKE_HOLD"; fi`,
      `if [ "$1" = start ] && [ -n "$RVTT_FAKE_CHILD" ]; then "$(dirname "$0")/postgres" -D "$3" & c=$!; echo $c > "$RVTT_FAKE_CHILD"; fi`,
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
 * "boot-now". `offsetMs` moves its start reading, as a clock step since does.
 * `boot` is this boot's id, "" for none, or an error for a refused read.
 */
type Look = { exe?: string | null; cwd?: string | null; uid?: number | null; offsetMs?: number; boot?: string | Error; stamp?: () => Promise<number | null>; facts?: ProcessLookup["facts"] };
function lookup(o: Look = {}): ProcessLookup {
  return {
    stamp: o.stamp ?? (async () => 4242),
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
      const c = cluster(dir, bin, lookup(), { platform: "darwin" });
      const abort = new AbortController();
      setTimeout(() => abort.abort(), abortMs);
      const { ms, error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, ...vars }, abort.signal);
      assert.ok(error instanceof DatabaseFailed && error.logLine === "pg_ctl start was cancelled", String(error));
      assert.ok(ms < 8_000, `the start answered after ${ms} ms`);
      // Checked here, before anything of the test's own ends them.
      assert.equal(await ended(await pid(postmaster)), true, "the postmaster it launched was stopped");
      assert.deepEqual(await calls(), expected);
      assert.equal(existsSync(join(dir, "postgres", "postmaster.pid")), false, "stopped by pg_ctl, or killed before it wrote the file");
      assert.equal(c.port, null);
    });
  }

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
        return listProcesses();
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
    // A postmaster of this folder that no kill reaches: the listing names it, and nothing runs as its pid.
    let ghost = true;
    const unconfirmed: boolean[] = [];
    const proc: ProcessLookup = {
      ...lookup(),
      list: async () => [...(await listProcesses()), ...(ghost ? [{ pid: Number(DEAD), commandLine: `/opt/pg/bin/postgres -D ${join(dir, "postgres")} -p 5` }] : [])],
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

  test("a stop after this process launched PostgreSQL ends a postmaster that pg_ctl stop left running, by its identity, before it answers", { timeout: 20_000 }, async () => {
    const dir = await folder();
    const { bin, calls } = await programs(dir);
    await mkdir(join(dir, "postgres"));
    const postmaster = join(dir, "postmaster.child");
    const c = cluster(dir, bin, lookup(), { platform: "darwin" });
    const { error, pid } = await startWith(dir, c, { RVTT_FAKE_CHILD: postmaster, RVTT_FAKE_PGCTL: "wait", RVTT_FAKE_READYAFTER: "0.3" });
    assert.equal(error, null);
    // With RVTT_FAKE_CHILD gone, the stand-in pg_ctl stop removes postmaster.pid and ends nothing.
    await c.stop();
    assert.equal(await ended(await pid(postmaster)), true, "the stop answered only once its postmaster had ended");
    assert.deepEqual(await calls(), STOPPED);
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
  test("is postgres with -D and this folder, as pg_ctl starts it on each system, and never pg_ctl or a folder beside it", () => {
    const unix = ["/data/Tést Жук/postgres"];
    assert.equal(postmasterOf("/opt/r/postgres/bin/postgres -D /data/Tést Жук/postgres -p 41659", unix, "darwin"), true);
    assert.equal(postmasterOf('/bin/sh -c exec "/opt/r/postgres/bin/postgres" -D "/data/Tést Жук/postgres" -p 41659 < "/dev/null" >> "log" 2>&1', unix, "linux"), true, "the shell pg_ctl execs it from");
    assert.equal(postmasterOf("/opt/r/postgres/bin/pg_ctl start -D /data/Tést Жук/postgres -l log -w", unix, "darwin"), false, "pg_ctl itself");
    assert.equal(postmasterOf("/opt/r/postgres/bin/postgres -D /data/Tést Жук/postgres.incomplete-17 -p 5", unix, "darwin"), false, "a folder beside it");
    assert.equal(postmasterOf("/opt/r/postgres/bin/postgres -D /DATA/Tést Жук/postgres -p 5", unix, "darwin"), false, "another case is another folder off Windows");
    assert.equal(postmasterOf("postgres: checkpointer", unix, "linux"), false, "a child, which renames itself");
    const windows = ["D:\\Tables\\Dm\\RaccoonVTT\\postgres", "C:\\ProgramData\\RaccoonVTT\\j\\a1b2"];
    // pg_ctl writes the folder with forward slashes, and Windows paths ignore case.
    assert.equal(postmasterOf('"C:\\Program Files\\RaccoonVTT\\resources\\postgres\\bin\\postgres.exe" -D "D:/Tables/dm/RaccoonVTT/postgres" -p 41659', windows, "win32"), true);
    assert.equal(postmasterOf('"C:\\pg\\postgres.exe" -D "C:/ProgramData/RaccoonVTT/j/a1b2" -p 41659', windows, "win32"), true, "the junction PostgreSQL was given");
    assert.equal(postmasterOf('"C:\\pg\\pg_ctl.exe" start -D "C:/ProgramData/RaccoonVTT/j/a1b2" -l log', windows, "win32"), false);
    assert.equal(postmasterOf('"C:\\pg\\postgres.exe" --forkchild="checkpointer" 3', windows, "win32"), false);
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

