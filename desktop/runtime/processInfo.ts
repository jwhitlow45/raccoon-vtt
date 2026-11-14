import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Platform } from "../contract.ts";

/**
 * Who a process is, beyond its pid (docs/design/design-v1-local-app.md 8.1):
 * a pid is reused, so the lock's guard and the owner record also keep the
 * start time the system reports for it and the boot it started in. A
 * record whose pid is alive with another start time is someone else. That
 * start is read so no clock change moves it (processStamp), since a record
 * outlives a stepped clock or a new time zone.
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

/**
 * When a Linux process started, in ms since boot. Field 22 counts clock
 * ticks since boot, at USER_HZ, 100 on every platform the app ships for. The
 * name in field 2 may hold spaces and parentheses, so fields are counted from
 * its last ")".
 */
async function linuxSinceBoot(pid: number): Promise<number | null> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  return Number.isFinite(ticks) ? ticks * 10 : null;
}

/**
 * When the process started, in ms since the epoch, or null when it is gone,
 * to hold against a time another program wrote down (postmaster.pid's). On
 * Linux it is reckoned from the boot time, which moves when the wall clock
 * is stepped, so it can drift from what the process wrote at its start.
 */
export async function processStart(pid: number, platform: Platform = process.platform as Platform): Promise<number | null> {
  if (!isAlive(pid)) return null;
  try {
    if (platform === "linux") {
      const since = await linuxSinceBoot(pid);
      const btime = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
      if (since === null || !Number.isFinite(btime)) return null;
      return btime * 1000 + since;
    }
    if (platform === "darwin") {
      // ps prints the start in its own time zone and no zone name, so it is
      // asked for UTC and read as UTC, and a zone change never moves it.
      const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      const t = Date.parse(`${stdout.trim()} UTC`);
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

/**
 * A start reading for telling a process from a later one with its pid, which
 * no clock change moves: on Linux the time since boot itself, elsewhere the
 * start the system recorded, read in UTC. Null when the process is gone.
 */
export async function processStamp(pid: number, platform: Platform = process.platform as Platform): Promise<number | null> {
  if (platform !== "linux") return processStart(pid, platform);
  if (!isAlive(pid)) return null;
  try {
    return await linuxSinceBoot(pid);
  } catch {
    return null;
  }
}

/**
 * What can be read about the process running as a pid without special
 * rights, to tell PostgreSQL from a program that reused its pid. Each field
 * is null when the system will not say, which is never taken as an answer.
 * - `exe`: the program's path (Linux, macOS) or name (Windows).
 * - `cwd`: Linux only, its working folder, which for a postmaster is its
 *   data folder.
 * - `uid`: macOS and Linux, the user it runs as.
 * - `start`: when it started, in ms since the epoch, as processStart reads it.
 */
export type ProcessFacts = { exe: string | null; cwd: string | null; uid: number | null; start: number | null };

/** The Uid line's real uid from /proc/<pid>/status, which any user may read. */
export function parseStatusUid(status: string): number | null {
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? Number.NaN);
  return Number.isInteger(uid) ? uid : null;
}

/** What `Get-CimInstance Win32_Process` said about one process, as the script below prints it. */
export function parseWindowsProcess(stdout: string): Pick<ProcessFacts, "exe" | "start"> {
  try {
    const row = JSON.parse(stdout.trim()) as { name?: unknown; created?: unknown };
    const start = typeof row.created === "string" ? Date.parse(row.created) : Number.NaN;
    return { exe: typeof row.name === "string" && row.name !== "" ? row.name : null, start: Number.isNaN(start) ? null : start };
  } catch {
    return { exe: null, start: null };
  }
}

/** Reads one fact, null when it can't be read for any reason, denied included. */
async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function processFacts(pid: number, platform: Platform = process.platform as Platform): Promise<ProcessFacts> {
  if (platform === "linux") {
    // A program replaced while it runs, as an update does, reads as "<path> (deleted)".
    const exe = await maybe(async () => (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ""));
    const cwd = await maybe(() => readlink(`/proc/${pid}/cwd`));
    const uid = await maybe(async () => parseStatusUid(await readFile(`/proc/${pid}/status`, "utf8")));
    return { exe, cwd, uid, start: await processStart(pid, platform) };
  }
  if (platform === "darwin") {
    const ps = await maybe(async () => (await run("/bin/ps", ["-o", "uid=,comm=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } })).stdout.trim());
    const m = ps ? /^(\d+)\s+(.+)$/.exec(ps) : null;
    return { exe: m?.[2] ?? null, cwd: null, uid: m ? Number(m[1]) : null, start: await processStart(pid, platform) };
  }
  // Win32_Process answers for every process without elevation, where Get-Process hides another user's path and start.
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ name = [string]$p.Name; created = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } | ConvertTo-Json -Compress }`;
  const out = await maybe(async () => (await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true })).stdout);
  return { ...(out ? parseWindowsProcess(out) : { exe: null, start: null }), cwd: null, uid: null };
}

let cachedBootTime: number | null = null;

/**
 * When this boot began, in ms since the epoch, or null when it can't be
 * read: /proc/stat's btime, kern.boottime, or Windows' LastBootUpTime. Each
 * is reckoned from the wall clock, so a caller allows a margin.
 */
export async function bootTime(platform: Platform = process.platform as Platform): Promise<number | null> {
  if (cachedBootTime !== null) return cachedBootTime;
  const read = await maybe(async () => {
    if (platform === "linux") return Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]) * 1000;
    if (platform === "darwin") return Number(/sec = (\d+)/.exec((await run("/usr/sbin/sysctl", ["-n", "kern.boottime"])).stdout)?.[1]) * 1000;
    const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], { windowsHide: true });
    return Date.parse(stdout.trim());
  });
  if (read !== null && Number.isFinite(read) && read > 0) cachedBootTime = read;
  return cachedBootTime;
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
  const start = await processStamp(process.pid, platform);
  if (start === null) throw new Error("this process's start time can't be read");
  return { pid: process.pid, start, boot: await bootId(platform) };
}

/** Whether the process a record names still runs: the same pid, start time and boot. */
export async function stillRunning(id: ProcessIdentity, platform: Platform = process.platform as Platform): Promise<boolean> {
  if ((await bootId(platform)) !== id.boot) return false;
  const start = await processStamp(id.pid, platform);
  return start !== null && start === id.start;
}
