import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Platform } from "../contract.ts";
import { Cluster, DatabaseFailed, uncertainWords, type ProcessLookup } from "./postgres.ts";

/**
 * The cluster's own rules, with stand-ins for PostgreSQL's programs and for
 * the process readings (postgres.itest.ts runs the real ones): which
 * postmaster.pid may go, a stepped clock, the postmaster this process
 * started, and an init cut off before the app's settings.
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
  await writeFile(
    join(bin, "pg_ctl"),
    `#!/bin/sh\necho "pg_ctl $1" >> '${log}'\nif [ "$1" = start ]; then printf '%s\\n%s\\n%s\\n5999\\n' "$RVTT_FAKE_PID" "$3" "$(date +%s)" > "$3/postmaster.pid"; fi\nif [ "$1" = stop ]; then rm -f "$3/postmaster.pid"; fi\n`,
    { mode: 0o755 },
  );
  // initdb makes PG_VERSION first, as the real one does, then its own postgresql.conf.
  await writeFile(
    join(bin, "initdb"),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --pgdata=*) d="\${a#--pgdata=}";; esac; done\nmkdir -p "$d"\necho 17 > "$d/PG_VERSION"\necho "# initdb's defaults" > "$d/postgresql.conf"\necho "local all all trust" > "$d/pg_hba.conf"\necho "initdb $d" >> '${log}'\n`,
    { mode: 0o755 },
  );
  return { bin, calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean) };
}

/**
 * What the system says about the pid: by default this computer's own
 * postgres, run as this user, started when postmaster.pid says, an hour into
 * this boot. `offsetMs` moves its start reading, as a clock step since does.
 */
type Look = { exe?: string | null; cwd?: string | null; uid?: number | null; offsetMs?: number; boot?: number | null; stamp?: () => Promise<number | null>; facts?: ProcessLookup["facts"] };
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
    bootTime: async () => (o.boot === undefined ? Date.now() - 3_600_000 : o.boot),
    uid: 501,
  };
}

function cluster(dir: string, bin: string, proc: ProcessLookup, extra: { afterInitdb?: () => Promise<void>; platform?: Platform } = {}): Cluster {
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

  test("a postmaster.pid from before this boot is stale, but this folder's live postmaster never is, whatever the clock says", async () => {
    const dir = await folder();
    const boot = Date.now() - 600_000;
    const kind = async (look: Look, on: Platform) => (await cluster(dir, "/none", lookup({ boot, ...look }), { platform: on }).leftover()).kind;
    await pidFile(dir, process.pid, Math.floor((boot - 2 * 3_600_000) / 1000));
    assert.equal(await kind({ exe: null, uid: null }, "win32"), "stale", "its pid is someone else's now");
    assert.equal(await kind({ offsetMs: -300_000 }, "darwin"), "stale", "another postgres, started in this boot");
    assert.equal(await kind({ cwd: join(dir, "postgres") }, "linux"), "running", "Linux: this folder's postgres, the file written before a clock step");
    await pidFile(dir, process.pid, Math.floor((boot - 30_000) / 1000));
    assert.equal(await kind({ exe: null, uid: null }, "win32"), "uncertain", "within a minute of the boot is no evidence");
    assert.equal(await kind({ exe: null, uid: null, boot: null }, "win32"), "uncertain", "no boot time read is no evidence");
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
});
