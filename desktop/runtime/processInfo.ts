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
 * When a Linux process started, in ms since boot, from its /proc/<pid>/stat.
 * Field 22 counts clock ticks since boot, at USER_HZ, 100 on every platform
 * the app ships for. The name in field 2 may hold spaces and parentheses, so
 * fields are counted from its last ")". The listing reads it with the same
 * parser, so its readings and processStamp's are one quantity.
 */
export function parseProcStat(stat: string): number | null {
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  return Number.isFinite(ticks) ? ticks * 10 : null;
}

async function linuxSinceBoot(pid: number): Promise<number | null> {
  return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
}

/**
 * The environment ps runs in: UTF-8, since in the C locale ps escapes every
 * other byte, so a data folder named "Tést" would never match, and UTC, so
 * the start it prints, with no zone name, is read as UTC whatever the zone.
 */
const PS_ENV = { LC_ALL: "en_US.UTF-8", TZ: "UTC" };

/** ps's lstart as it prints it in PS_ENV, in ms since the epoch, for processStart and the listing alike. */
export function parsePsStart(text: string): number | null {
  const t = Date.parse(`${text.trim()} UTC`);
  return Number.isNaN(t) ? null : t;
}

/** PowerShell that prints a Win32_Process's CreationDate in UTC, or "" when it has none. */
function createdOf(row: string): string {
  return `$(if (${row}.CreationDate) { ${row}.CreationDate.ToUniversalTime().ToString('o') } else { '' })`;
}

/** A CreationDate as createdOf prints it, in ms since the epoch, for processStart and the listing alike. */
export function parseCreated(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : t;
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
      const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, ...PS_ENV } });
      return parsePsStart(stdout);
    }
    // Win32_Process's CreationDate, as the listing reads it, and which it gives for every process without elevation.
    const { stdout } = await run(
      powershell(),
      ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { ${createdOf("$p")} }`],
      { windowsHide: true, timeout: POWERSHELL_LIMIT_MS },
    );
    return parseCreated(stdout);
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
 * - `stamp`: its start reading, the quantity processStamp gives.
 * The facts come from one read of one process, so the start and the stamp
 * describe the very process the program and user are of: macOS and Windows
 * read them in one query, and Linux reads /proc/<pid>/stat before and after
 * the rest, and a process that changed between says nothing.
 */
export type ProcessFacts = { exe: string | null; cwd: string | null; uid: number | null; start: number | null; stamp: number | null };

/** What a process that is gone, or changed while it was read, says. */
const NO_FACTS: ProcessFacts = { exe: null, cwd: null, uid: null, start: null, stamp: null };

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

/** What `Get-CimInstance Win32_Process` said about one process, as the script below prints it. Its CreationDate is both its start and its stamp. */
export function parseWindowsProcess(stdout: string): Pick<ProcessFacts, "exe" | "start" | "stamp"> {
  try {
    const row = JSON.parse(stdout.trim()) as { name?: unknown; created?: unknown };
    const start = parseCreated(row.created);
    return { exe: typeof row.name === "string" && row.name !== "" ? row.name : null, start, stamp: start };
  } catch {
    return { exe: null, start: null, stamp: null };
  }
}

/** `ps -o uid,lstart,comm` for one process in PS_ENV: its user, its start, which is its stamp too, and its program. */
export function parsePsFacts(stdout: string): Pick<ProcessFacts, "exe" | "uid" | "start" | "stamp"> {
  const row = psRows(stdout, "COMM")[0];
  if (!row) return { exe: null, uid: null, start: null, stamp: null };
  return { exe: row.rest === "" ? null : row.rest, uid: row.n, start: row.start, stamp: row.start };
}

/** Reads one fact, null when it can't be read for any reason, denied included. */
async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function processFacts(pid: number, platform: Platform = process.platform as Platform, files: ProcFiles = procFiles): Promise<ProcessFacts> {
  if (platform === "linux") {
    const stamp = async (): Promise<number | null> => maybe(async () => parseProcStat((await files.readFile(`/proc/${pid}/stat`)).toString("utf8")));
    // Its start is read before and after the rest, and only the same reading both times shows they are one process's: a pid reused in between gets another start.
    const before = await stamp();
    const exe = await maybe(async () => linkedProgram(await files.readlink(`/proc/${pid}/exe`)));
    const cwd = await maybe(() => files.readlink(`/proc/${pid}/cwd`));
    const uid = await maybe(async () => parseStatusUid((await files.readFile(`/proc/${pid}/status`)).toString("utf8")));
    const after = await stamp();
    if (before === null || after !== before) return NO_FACTS;
    const btime = await maybe(async () => Number(/^btime (\d+)$/m.exec((await files.readFile("/proc/stat")).toString("utf8"))?.[1]));
    return { exe, cwd, uid, start: btime !== null && Number.isFinite(btime) ? btime * 1000 + before : null, stamp: before };
  }
  if (platform === "darwin") {
    const out = await maybe(async () => parsePsFacts((await run("/bin/ps", ["-o", "uid,lstart,comm", "-p", String(pid)], { env: { ...process.env, ...PS_ENV } })).stdout));
    return { ...(out ?? { exe: null, uid: null, start: null, stamp: null }), cwd: null };
  }
  // Win32_Process answers for every process without elevation, where Get-Process hides another user's path and start.
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ name = [string]$p.Name; created = ${createdOf("$p")} } | ConvertTo-Json -Compress }`;
  const out = await maybe(async () => (await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: POWERSHELL_LIMIT_MS })).stdout);
  return { ...(out ? parseWindowsProcess(out) : { exe: null, start: null, stamp: null }), cwd: null, uid: null };
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
 * (/proc/<pid>/exe). Windows gives the program too (ExecutablePath).
 * `stamp` is its start reading, the very quantity processStamp gives, read
 * in the same listing, so nothing need be read again between the listing
 * and acting on it. Each is null where the system won't say.
 */
export type ListedProcess = { pid: number; commandLine: string; argv?: string[]; exe?: string | null; stamp?: number | null };

/**
 * The rows of a ps call in PS_ENV whose columns are a number, lstart, and
 * a last one named `last`. ps pads the start to its column's width, so the
 * last column is read from where its header starts, never after the run of
 * spaces, which a command may begin with.
 */
function psRows(stdout: string, last: string): { n: number; start: number | null; rest: string }[] {
  const [header = "", ...lines] = stdout.split("\n");
  const at = header.indexOf(last);
  if (at < 0) throw new Error(`ps printed no ${last} column: ${header.slice(0, 200)}`);
  const out: { n: number; start: number | null; rest: string }[] = [];
  for (const line of lines) {
    const m = /^\s*(\d+) (.*)$/.exec(line.slice(0, at));
    if (m) out.push({ n: Number(m[1]), start: parsePsStart(m[2] as string), rest: line.slice(at) });
  }
  return out;
}

/** `ps -ww -axo pid,lstart,command`: each process's pid, start reading and command line. */
export function parsePsList(stdout: string): ListedProcess[] {
  return psRows(stdout, "COMMAND").map((row) => ({ pid: row.n, commandLine: row.rest, stamp: row.start }));
}

/**
 * The Windows listing: each postgres.exe, each cmd.exe, which pg_ctl
 * starts the postmaster through, and each pg_ctl.exe, which may be a
 * pg_ctl start for this folder that is not this process's own, such as one
 * a previous supervisor left, with its command line, program, start
 * (CreationDate) and session, and the session this runs in, as one JSON
 * object.
 */
export const WINDOWS_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  `$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'postgres.exe' OR Name = 'cmd.exe' OR Name = 'pg_ctl.exe'" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; line = $_.CommandLine; exe = $_.ExecutablePath; created = ${createdOf("$_")}; session = [int]$_.SessionId } })`,
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
 * runs as this user, and the cmd.exe it starts the postmaster through runs
 * with this user's rights or fewer (a restricted token), so their lines
 * can be read.
 */
export function parseWindowsList(stdout: string): ListedProcess[] {
  const listing: unknown = JSON.parse(stdout.trim());
  const { session, rows } = (listing ?? {}) as { session?: unknown; rows?: unknown };
  if (typeof session !== "number" || !Array.isArray(rows)) throw new Error(`the process listing was not a list: ${stdout.trim().slice(0, 200)}`);
  const out: ListedProcess[] = [];
  for (const row of rows as { pid?: unknown; name?: unknown; line?: unknown; exe?: unknown; created?: unknown; session?: unknown }[]) {
    if (typeof row?.pid !== "number" || typeof row.name !== "string" || typeof row.session !== "number" || (row.line != null && typeof row.line !== "string") || (row.exe != null && typeof row.exe !== "string") || (row.created != null && typeof row.created !== "string")) {
      throw new Error(`the process listing had a row it can't read: ${JSON.stringify(row)}`);
    }
    if (typeof row.line === "string" && row.line !== "") {
      out.push({ pid: row.pid, commandLine: row.line, exe: typeof row.exe === "string" ? row.exe : null, stamp: parseCreated(row.created) });
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
 * Whether /proc is mounted with hidepid, from /proc/self/mountinfo: then
 * reading another process's files takes a ptrace check, which this user's
 * own processes that can't be dumped fail too. hidepid=0 or off is none.
 */
export function procHidesPids(mountinfo: string): boolean {
  let hides = false;
  for (const line of mountinfo.split("\n")) {
    const [mount, source] = line.split(" - ");
    if (source === undefined || mount?.split(" ")[4] !== "/proc" || source.split(" ")[0] !== "proc") continue;
    // A later mount over /proc is the one in force.
    const hidepid = /(?:^|[ ,])hidepid=([^ ,]+)/.exec(line)?.[1];
    hides = hidepid !== undefined && hidepid !== "0" && hidepid !== "off";
  }
  return hides;
}

/**
 * Whether a process whose command line can't be read may be this user's,
 * so a listing without it would prove nothing. Any error but its end is
 * settled by who owns /proc/<pid>, which anyone may stat under hidepid=1.
 * /proc/<pid> itself keeps the process's effective uid even when it can't
 * be dumped, where the files inside show as root's (fs/proc/base.c,
 * task_dump_owner), so the stat says whose it is. Another user's or root's
 * is skipped, since PostgreSQL never runs as root. /proc/<pid>/status is
 * never read for this, since hidepid=1 hides it for every other user's
 * process, so every listing would fail.
 *
 * Under hidepid, this user's own processes that can't be dumped, such as
 * ssh-agent and Chromium's sandboxed ones, refuse their command line with
 * EPERM or EACCES, and are skipped too (LA-31): PostgreSQL never makes
 * itself one (its only prctl is PR_SET_PDEATHSIG), so its command line
 * stays readable. Without hidepid, or with any other error, a process of
 * this user's still fails the listing.
 */
async function mayBeOurs(pid: string, err: unknown, files: ProcFiles, hidesPids: () => Promise<boolean>): Promise<boolean> {
  if (gone(err)) return false;
  let uid: number;
  try {
    ({ uid } = await files.stat(`/proc/${pid}`));
  } catch (statErr) {
    return !gone(statErr);
  }
  if (files.uid !== null && uid !== files.uid) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return !((code === "EPERM" || code === "EACCES") && (await hidesPids()));
}

/**
 * The processes running now, with their command lines, to tell a process
 * by what it is rather than by a pid a file names. Linux reads each
 * /proc/<pid>/cmdline, exact bytes split at its NULs, and the program its
 * exe link names. macOS reads ps in a UTF-8 locale: in the C locale ps
 * escapes every other byte, so a data folder named "Tést" would never
 * match. Windows asks Win32_Process for postgres.exe, the cmd.exe pg_ctl
 * starts it through and pg_ctl.exe, with their programs (parseWindowsList).
 * Each row carries its start reading, as processStamp reads it. A
 * listing that fails throws, since it proves nothing either way, and so
 * does one with a process that may be this user's whose command line it
 * can't read (mayBeOurs, parseWindowsList).
 */
export async function listProcesses(platform: Platform = process.platform as Platform, files: ProcFiles = procFiles): Promise<ListedProcess[]> {
  if (platform === "linux") {
    const out: ListedProcess[] = [];
    let hides: Promise<boolean> | null = null;
    // Read once a listing needs it, and taken as no hidepid when it can't be read, which holds rather than skips.
    const hidesPids = (): Promise<boolean> => (hides ??= files.readFile("/proc/self/mountinfo").then((raw) => procHidesPids(raw.toString("utf8")), () => false));
    for (const name of await files.readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      // Its start is read before its command line, so a pid reused between the reads can only pair a later command line with the earlier start, which never matches the later process.
      const stamp = await maybe(async () => parseProcStat((await files.readFile(`/proc/${name}/stat`)).toString("utf8")));
      let raw: Buffer;
      try {
        raw = await files.readFile(`/proc/${name}/cmdline`);
      } catch (err) {
        if (await mayBeOurs(name, err, files, hidesPids)) throw new Error(`process ${name} runs as this user and its command line can't be read: ${(err as Error).message}`);
        continue;
      }
      const args = raw.toString("utf8").replace(/\0+$/, "");
      if (args === "") continue;
      const argv = args.split("\0");
      // Another user's exe link can't be read, which only means it is no program of this user's.
      const exe = await maybe(async () => linkedProgram(await files.readlink(`/proc/${name}/exe`)));
      out.push({ pid: Number(name), commandLine: argv.join(" "), argv, exe, stamp });
    }
    return out;
  }
  if (platform === "darwin") {
    const { stdout } = await run("/bin/ps", ["-ww", "-axo", "pid,lstart,command"], { env: { ...process.env, ...PS_ENV }, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return parsePsList(stdout);
  }
  const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST_SCRIPT], { windowsHide: true, timeout: POWERSHELL_LIMIT_MS, maxBuffer: 16 * 1024 * 1024 });
  return parseWindowsList(stdout);
}
