import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { realpathSync } from "node:fs";
import { uptime } from "node:os";
import { basename } from "node:path";
import { bootId, isAlive, linkedProgram, listProcesses, parsePsList, parseStatusUid, parseWindowsList, parseWindowsProcess, processFacts, processStamp, processStart, selfIdentity, stillRunning, type ProcFiles } from "./processInfo.ts";

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

test("the readings that need no special rights parse: /proc's Uid line and Windows' CIM row", () => {
  assert.equal(parseStatusUid("Name:\tpostgres\nUmask:\t0077\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1001\t1001\t1001\t1001\n"), 1000);
  assert.equal(parseStatusUid("Name:\tx\n"), null);
  assert.equal(linkedProgram("/usr/lib/postgresql/17/bin/postgres (deleted)"), "/usr/lib/postgresql/17/bin/postgres");
  assert.equal(linkedProgram("/opt/raccoonvtt/postgres/bin/postgres"), "/opt/raccoonvtt/postgres/bin/postgres");
  assert.equal(linkedProgram("/opt/my (deleted) things/postgres"), "/opt/my (deleted) things/postgres");
  assert.deepEqual(parseWindowsProcess('{"name":"svchost.exe","created":"2026-11-14T07:13:25.1200000Z"}'), { exe: "svchost.exe", start: Date.parse("2026-11-14T07:13:25.120Z") });
  assert.deepEqual(parseWindowsProcess('{"name":"postgres.exe","created":""}'), { exe: "postgres.exe", start: null });
  assert.deepEqual(parseWindowsProcess(""), { exe: null, start: null });
  assert.deepEqual(parseWindowsProcess("Get-CimInstance : Access denied"), { exe: null, start: null });
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
  assert.deepEqual(parsePsList("  12 /opt/pg/bin/postgres -D /d/postgres -p 5\n345 sh\n\n"), [
    { pid: 12, commandLine: "/opt/pg/bin/postgres -D /d/postgres -p 5" },
    { pid: 345, commandLine: "sh" },
  ]);
  assert.deepEqual(parseWindowsList("[]\r\n"), []);
  assert.deepEqual(parseWindowsList('[{"pid":7,"line":"\\"C:\\\\pg\\\\postgres.exe\\" -D \\"C:/d/postgres\\"","exe":"C:\\\\pg\\\\postgres.exe"}]'), [{ pid: 7, commandLine: '"C:\\pg\\postgres.exe" -D "C:/d/postgres"', exe: "C:\\pg\\postgres.exe" }]);
  assert.deepEqual(parseWindowsList('[{"pid":7,"line":"x","exe":null}]'), [{ pid: 7, commandLine: "x", exe: null }], "a program Windows won't name");
  assert.throws(() => parseWindowsList('[{"pid":7,"line":"x","exe":7}]'), /can't read/);
  assert.throws(() => parseWindowsList('{"pid":7,"line":"x"}'), /not a list/);
  assert.throws(() => parseWindowsList('[{"pid":"7","line":"x"}]'), /can't read/);
  assert.throws(() => parseWindowsList(""));
});

test("Linux: a command line that can't be read is a process gone only when the error says so, and fails the listing when /proc says it is this user's", async () => {
  const fail = (code: string): Error => Object.assign(new Error(`${code}: the read failed`), { code });
  const statted: string[] = [];
  /** /proc with each pid's command line or the error reading it gives, and the owner stat gives its folder. */
  const list = (cmdlines: Record<string, string | Error>, owners: Record<string, number | Error> = {}) => {
    const files: ProcFiles = {
      readdir: async () => ["self", "stat", ...Object.keys(cmdlines)],
      readFile: async (path) => {
        const read = cmdlines[path.split("/")[2] ?? ""];
        if (read === undefined || read instanceof Error) throw read ?? fail("ENOENT");
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
  assert.deepEqual(await list({ 10: fail("ENOENT"), 11: fail("ESRCH"), 12: "sh -c x" }, { 10: 1000, 11: 1000 }), [{ pid: 12, commandLine: "sh -c x", argv: ["sh", "-c", "x"], exe: null }]);
  assert.deepEqual(statted, [], "an ended process is never looked up");
  // Another user's, or root's, as hidepid=1 or a process that can't be dumped refuse them: skipped.
  assert.deepEqual(await list({ 20: fail("EACCES"), 21: fail("EPERM"), 22: fail("EACCES") }, { 20: 1001, 21: 0, 22: fail("ESRCH") }), []);
  assert.deepEqual(statted, ["/proc/20", "/proc/21", "/proc/22"], "/proc/<pid> itself, never its status file");
  // This user's: without it the listing proves nothing.
  await assert.rejects(list({ 30: fail("EACCES") }, { 30: 1000 }), /^Error: process 30 runs as this user and its command line can't be read: EACCES/);
  await assert.rejects(list({ 31: fail("EIO") }, { 31: 1000 }), /process 31/);
  // Who owns it can't be read either: no answer, so no proof.
  await assert.rejects(list({ 40: fail("EACCES") }, { 40: fail("EACCES") }), /process 40/);
});
