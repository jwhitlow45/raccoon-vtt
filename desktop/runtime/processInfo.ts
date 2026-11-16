import { execFile } from "node:child_process";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
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

/** PowerShell's cold start on a busy computer takes seconds, so a reading still running after this has hung, and is ended. */
const POWERSHELL_LIMIT_MS = 60_000;

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

/** Windows' own cmd.exe, which the cluster has pg_ctl start the postmaster through (pgEnv's COMSPEC). */
export function systemShell(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
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
      { windowsHide: true, timeout: POWERSHELL_LIMIT_MS },
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

/**
 * The program /proc/<pid>/exe links to. A program replaced while it runs, as
 * an update does, reads as "<path> (deleted)", and is still that program.
 */
export function linkedProgram(link: string): string {
  return link.replace(/ \(deleted\)$/, "");
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
    const exe = await maybe(async () => linkedProgram(await readlink(`/proc/${pid}/exe`)));
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
  const out = await maybe(async () => (await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: POWERSHELL_LIMIT_MS })).stdout);
  return { ...(out ? parseWindowsProcess(out) : { exe: null, start: null }), cwd: null, uid: null };
}

let cachedBoot: string | null = null;

/**
 * This boot, so a start time from a boot before never matches one now:
 * Linux's boot_id or macOS's kern.bootsessionuuid, which no clock change
 * moves. Windows has none and needs none (below).
 */
export async function bootId(platform: Platform = process.platform as Platform): Promise<string> {
  if (cachedBoot !== null) return cachedBoot;
  try {
    if (platform === "linux") cachedBoot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    else if (platform === "darwin") cachedBoot = (await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).stdout.trim();
    else {
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

/**
 * A process as a listing shows it: its pid, and its command line with the
 * arguments joined by spaces. Linux also gives the arguments themselves,
 * so where one ends is never a guess, and the program it runs
 * (/proc/<pid>/exe). Windows gives the program too (ExecutablePath). Each
 * is null where the system won't say.
 */
export type ListedProcess = { pid: number; commandLine: string; argv?: string[]; exe?: string | null };

/** `ps -o pid=,command=` lines. */
export function parsePsList(stdout: string): ListedProcess[] {
  const out: ListedProcess[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), commandLine: m[2] as string });
  }
  return out;
}

/**
 * The Windows listing: each postgres.exe, each cmd.exe, which pg_ctl
 * starts the postmaster through, and each pg_ctl.exe, whose restricted
 * copy may yet start one, with its command line, program and session, and
 * the session this runs in, as one JSON object.
 */
export const WINDOWS_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$rows = @(Get-CimInstance Win32_Process -Filter \"Name = 'postgres.exe' OR Name = 'cmd.exe' OR Name = 'pg_ctl.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; line = $_.CommandLine; exe = $_.ExecutablePath; session = [int]$_.SessionId } })",
  "ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; rows = $rows })",
].join("; ");

/**
 * WINDOWS_LIST_SCRIPT's JSON. Anything else is a listing that failed. A
 * process whose command line Windows won't give is another user's, or runs
 * with more rights than this one. A postgres.exe like that in this
 * session may still be this user's, so the listing fails, which holds the
 * proof that PostgreSQL ended while it runs, and the log names its pid.
 * One in another session is skipped, and so is one in session 0, where
 * services run. A cmd.exe or pg_ctl.exe like that is skipped too: pg_ctl
 * runs its copy and its launcher with this user's rights or fewer, so
 * their lines can be read.
 */
export function parseWindowsList(stdout: string): ListedProcess[] {
  const listing: unknown = JSON.parse(stdout.trim());
  const { session, rows } = (listing ?? {}) as { session?: unknown; rows?: unknown };
  if (typeof session !== "number" || !Array.isArray(rows)) throw new Error(`the process listing was not a list: ${stdout.trim().slice(0, 200)}`);
  const out: ListedProcess[] = [];
  for (const row of rows as { pid?: unknown; name?: unknown; line?: unknown; exe?: unknown; session?: unknown }[]) {
    if (typeof row?.pid !== "number" || typeof row.name !== "string" || typeof row.session !== "number" || (row.line != null && typeof row.line !== "string") || (row.exe != null && typeof row.exe !== "string")) {
      throw new Error(`the process listing had a row it can't read: ${JSON.stringify(row)}`);
    }
    if (typeof row.line === "string" && row.line !== "") {
      out.push({ pid: row.pid, commandLine: row.line, exe: typeof row.exe === "string" ? row.exe : null });
    } else if (/^postgres\.exe$/i.test(row.name) && row.session === session && row.session !== 0) {
      throw new Error(`postgres.exe (pid ${row.pid}) runs in this session and its command line can't be read`);
    }
  }
  return out;
}

/** The /proc reads the Linux listing makes, which tests replace to give the errors a system can. */
export type ProcFiles = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  stat(path: string): Promise<{ uid: number }>;
  /** This process's user. */
  uid: number | null;
};

const procFiles: ProcFiles = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
  readlink: (path) => readlink(path),
  stat: (path) => stat(path),
  uid: process.getuid?.() ?? null,
};

/** Whether a read failed because the process ended between the folder's listing and the read. */
function gone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

/**
 * Whether a process whose command line can't be read may be this user's,
 * so a listing without it would prove nothing. Any error but its end, such
 * as EACCES under hidepid=1 or for a process that can't be dumped, is
 * settled by who owns /proc/<pid>, which hidepid=1 still lets anyone stat:
 * another user's or root's is skipped, since PostgreSQL never runs as root,
 * and a process that can't be dumped shows as root's. /proc/<pid>/status is
 * never read for this, since hidepid=1 hides it for every other user's
 * process, so every listing would fail.
 */
async function mayBeOurs(pid: string, err: unknown, files: ProcFiles): Promise<boolean> {
  if (gone(err)) return false;
  try {
    const { uid } = await files.stat(`/proc/${pid}`);
    return files.uid === null || uid === files.uid;
  } catch (statErr) {
    return !gone(statErr);
  }
}

/**
 * The processes running now, with their command lines, to tell a process
 * by what it is rather than by a pid a file names. Linux reads each
 * /proc/<pid>/cmdline, exact bytes split at its NULs, and the program its
 * exe link names. macOS reads ps in a UTF-8 locale: in the C locale ps
 * escapes every other byte, so a data folder named "Tést" would never
 * match. Windows asks Win32_Process for postgres.exe, the cmd.exe pg_ctl
 * starts it through and pg_ctl.exe, with their programs (parseWindowsList). A
 * listing that fails throws, since it proves nothing either way, and so
 * does one with a process that may be this user's whose command line it
 * can't read (mayBeOurs, parseWindowsList).
 */
export async function listProcesses(platform: Platform = process.platform as Platform, files: ProcFiles = procFiles): Promise<ListedProcess[]> {
  if (platform === "linux") {
    const out: ListedProcess[] = [];
    for (const name of await files.readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let raw: Buffer;
      try {
        raw = await files.readFile(`/proc/${name}/cmdline`);
      } catch (err) {
        if (await mayBeOurs(name, err, files)) throw new Error(`process ${name} runs as this user and its command line can't be read: ${(err as Error).message}`);
        continue;
      }
      const args = raw.toString("utf8").replace(/\0+$/, "");
      if (args === "") continue;
      const argv = args.split("\0");
      // Another user's exe link can't be read, which only means it is no program of this user's.
      const exe = await maybe(async () => linkedProgram(await files.readlink(`/proc/${name}/exe`)));
      out.push({ pid: Number(name), commandLine: argv.join(" "), argv, exe });
    }
    return out;
  }
  if (platform === "darwin") {
    const { stdout } = await run("/bin/ps", ["-ww", "-axo", "pid=,command="], { env: { ...process.env, LC_ALL: "en_US.UTF-8" }, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return parsePsList(stdout);
  }
  const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST_SCRIPT], { windowsHide: true, timeout: POWERSHELL_LIMIT_MS, maxBuffer: 16 * 1024 * 1024 });
  return parseWindowsList(stdout);
}
