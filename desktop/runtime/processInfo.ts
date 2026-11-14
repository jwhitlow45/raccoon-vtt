import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Platform } from "../contract.ts";

/**
 * Who a process is, beyond its pid (docs/design/design-v1-local-app.md 8.1):
 * a pid is reused, so the lock's guard and the owner record also keep the
 * start time the system reports for it and the boot it started in. A
 * record whose pid is alive with another start time is someone else.
 */

const run = promisify(execFile);

export type ProcessIdentity = { pid: number; start: number; boot: string };

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function powershell(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\${POWERSHELL}`;
}

/** When the process started, in ms since the epoch, or null when it is gone. */
export async function processStart(pid: number, platform: Platform = process.platform as Platform): Promise<number | null> {
  if (!isAlive(pid)) return null;
  try {
    if (platform === "linux") {
      // Field 22 counts clock ticks since boot. The name in field 2 may hold
      // spaces and parentheses, so fields are counted from its last ")".
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      const btime = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
      // Linux reports ticks at USER_HZ, 100 on every platform the app ships for.
      return btime * 1000 + ticks * 10;
    }
    if (platform === "darwin") {
      const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } });
      const t = Date.parse(stdout.trim());
      return Number.isNaN(t) ? null : t;
    }
    const { stdout } = await run(
      powershell(),
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
      { windowsHide: true },
    );
    const t = Date.parse(stdout.trim());
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

let cachedBoot: string | null = null;

/** This boot, so a start time from a boot before never matches one now. */
export async function bootId(platform: Platform = process.platform as Platform): Promise<string> {
  if (cachedBoot !== null) return cachedBoot;
  try {
    if (platform === "linux") cachedBoot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    else if (platform === "darwin") {
      const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
      cachedBoot = /sec = (\d+)/.exec(stdout)?.[1] ?? "";
    } else {
      // Windows reports start times as absolute moments, so no boot is needed to tell two apart.
      cachedBoot = "";
    }
  } catch {
    cachedBoot = "";
  }
  return cachedBoot;
}

export async function selfIdentity(platform: Platform = process.platform as Platform): Promise<ProcessIdentity> {
  const start = await processStart(process.pid, platform);
  if (start === null) throw new Error("this process's start time can't be read");
  return { pid: process.pid, start, boot: await bootId(platform) };
}

/** Whether the process a record names still runs: the same pid, start time and boot. */
export async function stillRunning(id: ProcessIdentity, platform: Platform = process.platform as Platform): Promise<boolean> {
  if ((await bootId(platform)) !== id.boot) return false;
  const start = await processStart(id.pid, platform);
  return start !== null && start === id.start;
}
