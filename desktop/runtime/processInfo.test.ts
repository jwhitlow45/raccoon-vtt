import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { bootId, isAlive, processProgram, processStamp, processStart, selfIdentity, stillRunning } from "./processInfo.ts";

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
  assert.equal(await processStamp(await exitedPid(), platform), null);
  const program = await processProgram(process.pid, platform);
  assert.match(basename((program.exe ?? "").replaceAll("\\", "/")).toLowerCase(), /^node(\.exe)?$/);
  assert.equal(program.foreign, false);
  // Only Linux says where a process works, which for a postmaster is its data folder.
  if (platform === "linux") assert.equal(program.cwd, realpathSync(process.cwd()));
  else assert.equal(program.cwd, null);
});
