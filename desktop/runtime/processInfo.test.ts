import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { realpathSync } from "node:fs";
import { uptime } from "node:os";
import { basename } from "node:path";
import { bootId, isAlive, linkedProgram, listProcesses, parseCreated, parseProcStat, parsePsFacts, parsePsList, parsePsStart, parseStatusUid, parseWindowsList, parseWindowsProcess, processFacts, processStamp, procHidesPids, processStart, selfIdentity, stillRunning, systemShell, WINDOWS_LIST_SCRIPT, type ListedProcess, type ProcFiles } from "./processInfo.ts";

/**
 * A process is its pid, its start time and its boot (docs/design/design-v1-local-app.md
 * 8.1), so a reused pid never passes for the supervisor a record names.
 */

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

function exitedPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid as number));
  });
}

test("a live process is alive, one that exited is not, and nor is a pid that can't be one", async () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(await exitedPid()), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
});

test("a process of another user still counts as alive", { skip: platform === "win32" && "pid 1 is no one's on Windows" }, () => {
  // pid 1 belongs to root, so a signal check is refused with EPERM, which means it exists.
  assert.equal(isAlive(1), true);
});

test("this process's start time is the system's, and only the same pid, start and boot is still running", async () => {
  const start = await processStart(process.pid, platform);
  assert.ok(start !== null);
  const uptimeMs = process.uptime() * 1000;
  // The system's reading has a resolution of 1 s on macOS and 10 ms on Linux.
  assert.ok(Math.abs(Date.now() - uptimeMs - start) < 2_500, `started ${Date.now() - start} ms ago, uptime ${uptimeMs} ms`);
  const self = await selfIdentity(platform);
  assert.equal(self.pid, process.pid);
  assert.equal(await stillRunning(self, platform), true);
  assert.equal(await stillRunning({ ...self, start: self.start - 1000 }, platform), false, "a reused pid has another start time");
  if (platform !== "win32") assert.equal(await stillRunning({ ...self, boot: `${await bootId(platform)}-before` }, platform), false, "a start in another boot");
  assert.equal(await stillRunning({ ...self, pid: await exitedPid() }, platform), false);
  assert.equal(await processStart(await exitedPid(), platform), null);
});

test("a process's stamp is steady while it runs, and gone with it, and its program names what runs", async () => {
  const first = await processStamp(process.pid, platform);
  assert.ok(first !== null);
  assert.equal(await processStamp(process.pid, platform), first);
  assert.equal((await selfIdentity(platform)).start, first, "records keep the stamp");
  // Linux counts it from boot, which no clock step moves, so it is less than the system's uptime.
  if (platform === "linux") assert.ok(first <= uptime() * 1000 + 1_000, `${first} ms`);
  assert.equal(await processStamp(await exitedPid(), platform), null);
  const facts = await processFacts(process.pid, platform);
  assert.match(basename((facts.exe ?? "").replaceAll("\\", "/")).toLowerCase(), /^node(\.exe)?$/);
  if (platform !== "win32") assert.equal(facts.uid, process.getuid?.());
  else assert.equal(facts.uid, null);
  assert.ok(facts.start !== null && Math.abs(facts.start - (await processStart(process.pid, platform))!) < 2_000);
  assert.equal(facts.stamp, first, "its stamp is processStamp's, from the same read as its program");
  // Only Linux says where a process works, which for a postmaster is its data folder.
  if (platform === "linux") assert.equal(facts.cwd, realpathSync(process.cwd()));
  else assert.equal(facts.cwd, null);
  assert.deepEqual(await processFacts(await exitedPid(), platform).then((f) => [f.exe, f.uid, f.start]), [null, null, null], "a process that is gone says nothing");
});

test("this boot has an id that no clock moves, on Linux and macOS, and none on Windows", async () => {
  const id = await bootId(platform);
  if (platform === "win32") assert.equal(id, "");
  else assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "boot_id or kern.bootsessionuuid, a UUID");
});

test("a listing's start reading is the one processStamp gives for the same live process, so a remembered postmaster is known again", { timeout: 120_000 }, async () => {
  // Windows lists only PostgreSQL's programs and cmd.exe, so there the process is a cmd.exe, which waits on its input.
  const child =
    platform === "win32"
      ? spawn(systemShell(), ["/d", "/k"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
      : spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" });
  try {
    const pid = child.pid as number;
    let listed: ListedProcess | undefined;
    // A process just started may not be listed yet.
    for (let tries = 0; listed === undefined && tries < 20; tries++) {
      listed = (await listProcesses(platform)).find((p) => p.pid === pid);
      if (listed === undefined) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(listed, "the child is listed");
    const stamp = await processStamp(pid, platform);
    assert.notEqual(stamp, null);
    assert.equal(listed.stamp, stamp);
  } finally {
    child.kill("SIGKILL");
  }
});

test("each start reading has one parser, for the listing and processStamp alike", () => {
  // Field 22 after the name, which may hold spaces and parentheses, in ticks of 10 ms.
  assert.equal(parseProcStat(`41 (post gres) (x)) S ${Array(18).fill("0").join(" ")} 12345 0 0`), 123450);
  assert.equal(parseProcStat("41 (sh) S"), null);
  assert.equal(parsePsStart("Mon Nov  2 05:12:03 2026    "), Date.UTC(2026, 10, 2, 5, 12, 3));
  assert.equal(parsePsStart(""), null);
  assert.equal(parseCreated("2026-11-14T07:13:25.1234560Z"), Date.parse("2026-11-14T07:13:25.123Z"));
  assert.equal(parseCreated(""), null);
  assert.equal(parseCreated(undefined), null);
});

test("the readings that need no special rights parse: /proc's Uid line and Windows' CIM row", () => {
  assert.equal(parseStatusUid("Name:\tpostgres\nUmask:\t0077\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1001\t1001\t1001\t1001\n"), 1000);
  assert.equal(parseStatusUid("Name:\tx\n"), null);
  assert.equal(linkedProgram("/usr/lib/postgresql/17/bin/postgres (deleted)"), "/usr/lib/postgresql/17/bin/postgres");
  assert.equal(linkedProgram("/opt/raccoonvtt/postgres/bin/postgres"), "/opt/raccoonvtt/postgres/bin/postgres");
  assert.equal(linkedProgram("/opt/my (deleted) things/postgres"), "/opt/my (deleted) things/postgres");
  const created = Date.parse("2026-11-14T07:13:25.120Z");
  assert.deepEqual(parseWindowsProcess('{"name":"svchost.exe","created":"2026-11-14T07:13:25.1200000Z"}'), { exe: "svchost.exe", start: created, stamp: created });
  assert.deepEqual(parseWindowsProcess('{"name":"postgres.exe","created":""}'), { exe: "postgres.exe", start: null, stamp: null });
  assert.deepEqual(parseWindowsProcess(""), { exe: null, start: null, stamp: null });
  assert.deepEqual(parseWindowsProcess("Get-CimInstance : Access denied"), { exe: null, start: null, stamp: null });
  // macOS: one ps call gives its user, its start, which is its stamp too, and its program.
  const lstart = Date.UTC(2026, 10, 2, 5, 12, 3);
  assert.deepEqual(parsePsFacts("  UID STARTED                      COMM\n  501 Mon Nov  2 05:12:03 2026     /opt/r/postgres/bin/postgres\n"), { exe: "/opt/r/postgres/bin/postgres", uid: 501, start: lstart, stamp: lstart });
  assert.deepEqual(parsePsFacts("  UID STARTED                      COMM\n"), { exe: null, uid: null, start: null, stamp: null }, "a process that is gone");
});

test("the process listing shows a process's whole command line, a folder named in any script included", { skip: platform === "win32" && "Windows lists postgres.exe alone" }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 5000)", "--", "-D", "/data/Tést Жук/postgres"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const listed = (await listProcesses(platform)).find((p) => p.pid === child.pid);
    assert.ok(listed, "the child is listed");
    assert.ok(listed.commandLine.endsWith(" -D /data/Tést Жук/postgres"), listed.commandLine);
    if (platform === "linux") {
      // Linux keeps each argument whole, spaces and all, and names the program.
      assert.deepEqual(listed.argv?.slice(-2), ["-D", "/data/Tést Жук/postgres"]);
      assert.equal(listed.exe, realpathSync(process.execPath));
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("a listing reads ps's lines, and Windows' JSON list, and refuses anything else as a failed listing", () => {
  // ps pads the start to its column, so each command is read from where its header starts, its own leading spaces kept.
  const ps = ["  PID STARTED                      COMMAND", "   12 Mon Nov  2 05:12:03 2026     /opt/pg/bin/postgres -D /d/postgres -p 5", "  345 Tue Nov 10 08:54:48 2026      sh -c x", ""].join("\n");
  assert.deepEqual(parsePsList(ps), [
    { pid: 12, commandLine: "/opt/pg/bin/postgres -D /d/postgres -p 5", stamp: Date.UTC(2026, 10, 2, 5, 12, 3) },
    { pid: 345, commandLine: " sh -c x", stamp: Date.UTC(2026, 10, 10, 8, 54, 48) },
  ]);
  assert.throws(() => parsePsList("12 sh\n"), /no COMMAND column/);
  // WINDOWS_LIST_SCRIPT's object: this session, and each postgres.exe and cmd.exe with its session.
  const listing = (session: number, rows: object[]) => JSON.stringify({ session, rows });
  const row = (pid: number, name: string, line: string | null, session = 1, exe: string | null = `C:\\pg\\${name}`) => ({ pid, name, line, exe, created: "2026-11-14T07:13:25.1234560Z", session });
  const created = Date.parse("2026-11-14T07:13:25.123Z");
  assert.deepEqual(parseWindowsList(`${listing(1, [])}\r\n`), []);
  assert.deepEqual(parseWindowsList(listing(1, [row(7, "postgres.exe", '"C:/pg/postgres.exe" -D "C:/d/postgres" -p 5  ')])), [{ pid: 7, commandLine: '"C:/pg/postgres.exe" -D "C:/d/postgres" -p 5  ', exe: "C:\\pg\\postgres.exe", stamp: created }]);
  assert.deepEqual(parseWindowsList(listing(1, [{ ...row(7, "postgres.exe", "x", 1, null), created: "" }])), [{ pid: 7, commandLine: "x", exe: null, stamp: null }], "a program and a start Windows won't give");
  const launcher = '"C:\\Windows\\System32\\cmd.exe" /C ""C:/pg/postgres.exe" -D "C:/d/postgres" -p 5 < "nul" >> "C:\\d\\logs\\postgres.log" 2>&1"';
  assert.deepEqual(parseWindowsList(listing(1, [row(8, "cmd.exe", launcher)])), [{ pid: 8, commandLine: launcher, exe: "C:\\pg\\cmd.exe", stamp: created }], "the launcher is listed");
  // A command line Windows won't give: a postgres.exe in this session may be this user's, so the listing fails and names it.
  assert.throws(() => parseWindowsList(listing(1, [row(9, "postgres.exe", null)])), /^Error: postgres\.exe \(pid 9\) runs in this session and its command line can't be read$/);
  assert.throws(() => parseWindowsList(listing(1, [row(9, "POSTGRES.EXE", "")])), /pid 9/, "an empty one too, and the name in any case");
  // Services in session 0, another user's session, and a cmd.exe with more rights than this user's are skipped.
  assert.deepEqual(parseWindowsList(listing(1, [row(10, "postgres.exe", null, 0), row(11, "postgres.exe", null, 2), row(12, "cmd.exe", null, 1), row(13, "pg_ctl.exe", null, 1)])), []);
  assert.deepEqual(parseWindowsList(listing(0, [row(10, "postgres.exe", null, 0)])), [], "session 0 is skipped though this runs in it, as a CI runner's service does");
  assert.throws(() => parseWindowsList(listing(1, [{ ...row(7, "postgres.exe", "x"), exe: 7 }])), /can't read/);
  assert.throws(() => parseWindowsList(listing(1, [{ ...row(7, "postgres.exe", "x"), session: "1" }])), /can't read/);
  assert.throws(() => parseWindowsList(listing(1, [{ ...row(7, "postgres.exe", "x"), created: 7 }])), /can't read/);
  assert.throws(() => parseWindowsList('[{"pid":7,"line":"x"}]'), /not a list/, "the bare array an older script printed");
  assert.throws(() => parseWindowsList('{"rows":[]}'), /not a list/);
  assert.throws(() => parseWindowsList(listing(1, [{ pid: "7", name: "postgres.exe", line: "x", session: 1 }])), /can't read/);
  assert.throws(() => parseWindowsList(""));
  assert.match(WINDOWS_LIST_SCRIPT, /Name = 'postgres\.exe' OR Name = 'cmd\.exe' OR Name = 'pg_ctl\.exe'/, "the launcher and pg_ctl are asked for");
  assert.match(WINDOWS_LIST_SCRIPT, /exe = \$_\.ExecutablePath; created = \$\(if \(\$_\.CreationDate\) \{ \$_\.CreationDate\.ToUniversalTime\(\)\.ToString\('o'\) \} else \{ '' \}\); session = \[int\]\$_\.SessionId/);
  assert.match(WINDOWS_LIST_SCRIPT, /session = \[System\.Diagnostics\.Process\]::GetCurrentProcess\(\)\.SessionId/);
});

test("Linux: a command line that can't be read is a process gone only when the error says so, and fails the listing when /proc says it is this user's", async () => {
  const fail = (code: string): Error => Object.assign(new Error(`${code}: the read failed`), { code });
  const statted: string[] = [];
  /** /proc with each pid's command line or the error reading it gives, and the owner stat gives its folder. */
  const list = (cmdlines: Record<string, string | Error>, owners: Record<string, number | Error> = {}, mountinfo: string | Error = fail("ENOENT")) => {
    const files: ProcFiles = {
      readdir: async () => ["self", "stat", ...Object.keys(cmdlines)],
      readFile: async (path) => {
        if (path === "/proc/self/mountinfo") {
          if (mountinfo instanceof Error) throw mountinfo;
          return Buffer.from(mountinfo);
        }
        const pid = path.split("/")[2] ?? "";
        const read = cmdlines[pid];
        if (read === undefined || read instanceof Error) throw read ?? fail("ENOENT");
        // Its start, field 22, in ticks: the pid itself.
        if (path.endsWith("/stat")) return Buffer.from(`${pid} (x) S ${Array(18).fill("0").join(" ")} ${pid} 0 0`);
        return Buffer.from(`${read.split(" ").join("\0")}\0`);
      },
      readlink: async () => Promise.reject(fail("EACCES")),
      stat: async (path) => {
        statted.push(path);
        const owner = owners[path.split("/")[2] ?? ""] ?? fail("ENOENT");
        if (owner instanceof Error) throw owner;
        return { uid: owner };
      },
      uid: 1000,
    };
    return listProcesses("linux", files);
  };
  // Gone: never asked about, though its pid would be this user's now.
  assert.deepEqual(await list({ 10: fail("ENOENT"), 11: fail("ESRCH"), 12: "sh -c x" }, { 10: 1000, 11: 1000 }), [{ pid: 12, commandLine: "sh -c x", argv: ["sh", "-c", "x"], exe: null, stamp: 120 }]);
  assert.deepEqual(statted, [], "an ended process is never looked up");
  // Another user's, or root's, as hidepid=1 or a process that can't be dumped refuse them: skipped.
  assert.deepEqual(await list({ 20: fail("EACCES"), 21: fail("EPERM"), 22: fail("EACCES") }, { 20: 1001, 21: 0, 22: fail("ESRCH") }), []);
  assert.deepEqual(statted, ["/proc/20", "/proc/21", "/proc/22"], "/proc/<pid> itself, never its status file");
  // This user's: without it the listing proves nothing.
  await assert.rejects(list({ 30: fail("EACCES") }, { 30: 1000 }), /^Error: process 30 runs as this user and its command line can't be read: EACCES/);
  await assert.rejects(list({ 31: fail("EIO") }, { 31: 1000 }), /process 31/);
  // Who owns it can't be read either: no answer, so no proof.
  await assert.rejects(list({ 40: fail("EACCES") }, { 40: fail("EACCES") }), /process 40/);

  // Under hidepid this user's own processes that can't be dumped refuse with EPERM or EACCES, and PostgreSQL is never one.
  const hidden = "22 28 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw,hidepid=invisible\n";
  assert.deepEqual(await list({ 50: fail("EPERM"), 51: fail("EACCES"), 52: "sh" }, { 50: 1000, 51: 1000 }, hidden), [{ pid: 52, commandLine: "sh", argv: ["sh"], exe: null, stamp: 520 }]);
  await assert.rejects(list({ 53: fail("EIO") }, { 53: 1000 }, hidden), /process 53/, "any other error still fails it");
  await assert.rejects(list({ 54: fail("EPERM") }, { 54: 1000 }), /process 54/, "and without hidepid, so does EPERM");
  await assert.rejects(list({ 55: fail("EPERM") }, { 55: 1000 }, fail("EACCES")), /process 55/, "and when mountinfo can't be read");
});

test("Linux: a process's facts and its start come from one process, and one that changed while it was read says nothing", async () => {
  const stat = (ticks: number) => Buffer.from(`41 (postgres) S ${Array(18).fill("0").join(" ")} ${ticks} 0 0`);
  /** /proc for pid 41, whose start reads as each of `starts` in turn. */
  const files = (starts: number[]): ProcFiles => {
    let read = 0;
    return {
      readdir: async () => [],
      readFile: async (path) => {
        if (path === "/proc/41/stat") return stat(starts[Math.min(read++, starts.length - 1)] as number);
        if (path === "/proc/41/status") return Buffer.from("Name:\tpostgres\nUid:\t1000\t1000\t1000\t1000\n");
        if (path === "/proc/stat") return Buffer.from("cpu 0\nbtime 1700000000\n");
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      readlink: async (path) => (path.endsWith("/exe") ? "/opt/r/postgres/bin/postgres" : "/data/postgres"),
      stat: async () => ({ uid: 1000 }),
      uid: 1000,
    };
  };
  assert.deepEqual(await processFacts(41, "linux", files([500])), { exe: "/opt/r/postgres/bin/postgres", cwd: "/data/postgres", uid: 1000, start: 1700000000_000 + 5000, stamp: 5000 });
  // The pid was reused between the reads, so the program and folder may be either process's.
  assert.deepEqual(await processFacts(41, "linux", files([500, 600])), { exe: null, cwd: null, uid: null, start: null, stamp: null });
});

test("Linux: /proc's hidepid, read from mountinfo", () => {
  const proc = (options: string, at = "/proc") => `22 28 0:21 / ${at} rw,nosuid,nodev,noexec,relatime shared:13 - proc proc ${options}`;
  assert.equal(procHidesPids(`${proc("rw,hidepid=2")}\n`), true);
  assert.equal(procHidesPids(proc("rw,hidepid=noaccess,gid=4")), true);
  assert.equal(procHidesPids(proc("rw,hidepid=invisible")), true);
  assert.equal(procHidesPids(proc("rw")), false);
  assert.equal(procHidesPids(proc("rw,hidepid=0")), false);
  assert.equal(procHidesPids(proc("rw,hidepid=off")), false);
  assert.equal(procHidesPids(proc("rw,hidepid=2", "/srv/proc")), false, "another mount of proc");
  assert.equal(procHidesPids(`${proc("rw,hidepid=2")}\n${proc("rw")}`), false, "the later mount over /proc is in force");
  assert.equal(procHidesPids("25 28 0:22 / /sys rw - sysfs sysfs rw,hidepid=2"), false);
  assert.equal(procHidesPids(""), false);
});
