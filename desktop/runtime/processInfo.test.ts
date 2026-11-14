import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { realpathSync } from "node:fs";
import { uptime } from "node:os";
import { basename } from "node:path";
import { bootId, bootTime, isAlive, parseStatusUid, parseWindowsProcess, processFacts, processStamp, processStart, selfIdentity, stillRunning } from "./processInfo.ts";

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

test("this boot began before this process, by less than the system's uptime", async () => {
  const boot = await bootTime(platform);
  assert.ok(boot !== null);
  const started = (await processStart(process.pid, platform))!;
  assert.ok(boot <= started + 2_000, `boot ${boot}, process ${started}`);
  assert.ok(Math.abs(Date.now() - uptime() * 1000 - boot) < 120_000, "about now less the uptime");
});

test("the readings that need no special rights parse: /proc's Uid line and Windows' CIM row", () => {
  assert.equal(parseStatusUid("Name:\tpostgres\nUmask:\t0077\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n"), 1000);
  assert.equal(parseStatusUid("Name:\tx\n"), null);
  assert.deepEqual(parseWindowsProcess('{"name":"svchost.exe","created":"2026-11-14T07:13:25.1200000Z"}'), { exe: "svchost.exe", start: Date.parse("2026-11-14T07:13:25.120Z") });
  assert.deepEqual(parseWindowsProcess('{"name":"postgres.exe","created":""}'), { exe: "postgres.exe", start: null });
  assert.deepEqual(parseWindowsProcess(""), { exe: null, start: null });
  assert.deepEqual(parseWindowsProcess("Get-CimInstance : Access denied"), { exe: null, start: null });
});
