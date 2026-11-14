import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR_ENV, DATA_LAYOUT, type Platform } from "../contract.ts";
import { writeDurable } from "./durable.ts";
import { DatabaseFailed } from "./postgres.ts";

/**
 * PostgreSQL's programs on Windows open every path through the ANSI code
 * page, the system's language for non-Unicode programs, so a folder whose
 * path has a letter outside it, as under a profile named in Cyrillic on a
 * Western system, can't be opened at all (D-261113-219). PostgreSQL also
 * names its shared memory after the data folder's path, case and all, and
 * that name is how it finds a dead postmaster's processes still attached
 * before it starts another. So the path it is given for the data folder
 * depends on the folder alone, the same at every start, whatever path,
 * alias or case the start was handed:
 * - The folder is its canonical path, as the lock takes it
 *   (realpathSync.native: junctions, symlinks, 8.3 names and case resolved).
 * - The data folder's record for that canonical path (DATA_LAYOUT.pgLink)
 *   wins, and its path is handed on exactly.
 * - Else an ASCII canonical path is given as it is.
 * - Else a junction, `%ProgramData%\RaccoonVTT\<hash>\data`, where the hash
 *   is of this user's SID and the canonical path, so a lost record finds the
 *   same one. The installer makes RaccoonVTT's folder, and the app makes the
 *   hash's folder this user's alone in one call.
 * A database whose path can't be had again stops the start with words, and
 * is never given a new one. The program folder is given by its path or its
 * 8.3 short path.
 */

const run = promisify(execFile);

/** What Windows says of a folder: whether the ANSI code page holds its path, and its 8.3 short path. */
export type FolderReading = { fits: boolean; short: string | null; shortFits: boolean };

/** One ACL entry as Get-Acl reads it, rights, InheritanceFlags and PropagationFlags as numbers. */
export type AclRule = { sid: string; rights: number; inherit: number; propagate: number; allow: boolean; inherited: boolean };

/** A folder's owner and ACL as Get-Acl reads them. */
export type AclFacts = { exists: boolean; directory: boolean; reparse: boolean; owner: string | null; protected: boolean; rules: AclRule[] };

export type PgPathDeps = {
  /** Reads the program folder's path against the code page. Tests stand in a code page here. */
  read(folder: string): Promise<FolderReading>;
  /** Reads a folder's owner and ACL, and this user's SID. */
  inspect(folder: string): Promise<{ user: string; facts: AclFacts }>;
  /** Makes a folder with this user's own security descriptor in one call, and reads what it got. */
  make(folder: string): Promise<{ user: string; facts: AclFacts }>;
  /** ProgramData, where the installer makes RaccoonVTT's folder. */
  programData: string | undefined;
  /** Tests only: in place of realpathSync.native. */
  canonical?: (path: string) => string;
  /** Tests only: runs between the junction and the last look at the key. */
  linked?: (folder: string) => Promise<void>;
};

export type PgPaths = {
  /** The path PostgreSQL's programs are given for a path in one of the folders. */
  map(path: string): string;
  /** Each folder that is given another way, and how, for the log. */
  notes: string[];
};

/** How the data folder is given to PostgreSQL. Short is only ever read from an earlier build's record. */
type Spelling = { how: "direct" } | { how: "short"; path: string } | { how: "junction"; folder: string; key: string };

/** The spelling a start chose, and the canonical path of the data folder it was chosen for. */
type LinkRecord = { data: string } & Spelling;

/** RaccoonVTT's folder in ProgramData (desktop/build/programdata.ps1). */
export const PROGRAMDATA_FOLDER = "RaccoonVTT";

const KEY_FILE = "key";
const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const CREATOR_OWNER = "S-1-3-0";
/** FileSystemRights.FullControl. */
const FULL_CONTROL = 0x1f01ff;
/** What a user may do in RaccoonVTT's folder: list it, make folders, read their extended attributes, traverse, read attributes and the ACL, wait on it. */
const USERS_MAY = 0x1 | 0x4 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000;
const CONTAINER_AND_OBJECT_INHERIT = 3;
const INHERIT_ONLY = 2;

/** Windows' own readings, ProgramData from the environment. */
export function windowsDeps(): PgPathDeps {
  return { read: readFolder, inspect: inspectFolder, make: makeFolder, programData: process.env.ProgramData };
}

/** Plain ASCII, which every ANSI code page holds as it is. */
function ascii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/** The junction's folder's name for this user and data folder: 16 hex digits of a SHA-256, the path case-folded as the lock folds it. */
export function junctionName(user: string, canonical: string): string {
  return createHash("sha256").update(`${user}\n${canonical.toLowerCase()}`, "utf8").digest("hex").slice(0, 16);
}

export async function pgPaths(
  folders: { data: string; program: string },
  record: string,
  platform: Platform,
  deps: PgPathDeps = windowsDeps(),
): Promise<PgPaths> {
  if (platform !== "win32") return { map: (path) => path, notes: [] };
  const aliases: [string, string][] = [];
  const notes: string[] = [];
  const program = await programSpelling(folders.program, deps);
  if (program !== folders.program) {
    aliases.push([folders.program, program]);
    notes.push(`${folders.program} by its short path, ${program}`);
  }
  const data = await dataSpelling(folders.data, record, deps);
  if (data !== folders.data) {
    aliases.push([folders.data, data]);
    notes.push(`${folders.data} as ${data}`);
  }
  return { map: (path) => mapPath(path, aliases), notes };
}

async function programSpelling(program: string, deps: PgPathDeps): Promise<string> {
  if (ascii(program)) return program;
  const reading = await deps.read(program);
  if (reading.fits) return program;
  if (reading.short !== null && reading.shortFits) return reading.short;
  throw new DatabaseFailed(
    `PostgreSQL can't open its own programs in ${program}, whose path has letters outside this computer's language for non-Unicode programs, and the folder has no short name that fits. Install RaccoonVTT in a folder whose path has none of those letters.`,
  );
}

/** Windows' \\?\ prefix, which names the same path. */
function plain(path: string): string {
  return path.replace(/^\\\\\?\\(?!UNC\\)/, "");
}

/** The path PostgreSQL is given for the data folder (see the top of this file). */
async function dataSpelling(data: string, recordFile: string, deps: PgPathDeps): Promise<string> {
  const canonicalOf = (path: string) => plain((deps.canonical ?? realpathSync.native)(path));
  const canonical = canonicalOf(data);
  const cluster = existsSync(join(data, DATA_LAYOUT.postgres));
  const recorded = await readRecord(recordFile);
  const ours = recorded !== null && recorded !== "unreadable" && samePath(recorded.data, canonical) ? recorded : null;
  if (ours !== null) {
    const kept = await recordedSpelling(ours, canonical, cluster, recordFile, deps, canonicalOf);
    if (kept !== null) return kept;
  }
  if (ascii(canonical)) return canonical;
  // A record for another folder means this one was moved or copied. Windows
  // moves no folder a process works in, and a copy is another folder, so its
  // database may have a path of its own. With no record that reads, only a
  // junction already there is the database's own.
  const elsewhere = recorded !== null && recorded !== "unreadable" && ours === null;
  return junctionSpelling(canonical, recordFile, deps, { mayMake: !cluster || elsewhere || ours !== null });
}

/** The recorded spelling while it leads to the folder. Else null with no database, so a new one is chosen, and words with one. */
async function recordedSpelling(
  rec: LinkRecord,
  canonical: string,
  cluster: boolean,
  recordFile: string,
  deps: PgPathDeps,
  canonicalOf: (path: string) => string,
): Promise<string | null> {
  if (rec.how === "direct") return rec.data;
  if (rec.how === "short") {
    let why: string | null;
    try {
      why = samePath(canonicalOf(rec.path), canonical) ? null : "leads elsewhere now";
    } catch {
      why = "is gone";
    }
    if (why === null) return rec.path;
    if (cluster) throw lost(rec.path, `the short name ${why}`);
    return null;
  }
  const link = join(rec.folder, "data");
  if ((await holdsKey(rec.folder, rec.key)) && (await leadsTo(link, canonical))) return link;
  return junctionSpelling(canonical, recordFile, deps, { mayMake: true, recorded: rec.folder, cluster });
}

function lost(path: string, why: string): DatabaseFailed {
  return new DatabaseFailed(
    `PostgreSQL was given this data folder as ${path}, and ${why}. RaccoonVTT gives a database no new path, since a PostgreSQL still running from the old one could open it twice. Make ${path} lead to this folder again, then open RaccoonVTT again.`,
  );
}

/**
 * The junction for this user and data folder, in RaccoonVTT's folder in
 * ProgramData. A folder of that name already there is used only when this
 * user owns it, its ACL is exactly the one the app gives, and its junction
 * leads here, so another user who made it first can only stop the start. A
 * missing one is made only when `mayMake`: with no database yet, for a moved
 * or copied folder, or when the record names it.
 */
async function junctionSpelling(canonical: string, recordFile: string, deps: PgPathDeps, o: { mayMake: boolean; recorded?: string; cluster?: boolean }): Promise<string> {
  const reinstall = (why: string) =>
    new DatabaseFailed(
      `PostgreSQL on Windows is given the data folder ${canonical}, whose path is not plain ASCII, through a junction in RaccoonVTT's folder in ProgramData, which ${why}. Reinstall RaccoonVTT, or set ${DATA_DIR_ENV} to a folder whose path is plain ASCII.`,
    );
  const programData = deps.programData;
  if (!programData || !isAbsolute(programData) || !ascii(programData)) throw reinstall("has no plain path on this computer");
  const parent = join(programData, PROGRAMDATA_FOLDER);
  let user = "";
  let problem: string | null;
  try {
    const read = await deps.inspect(parent);
    user = read.user;
    problem = parentProblem(read.facts);
  } catch (err) {
    problem = `could not be read (${(err as Error).message})`;
  }
  if (problem !== null) throw reinstall(problem);

  const folder = join(parent, junctionName(user, canonical));
  const link = join(folder, "data");
  // An earlier build's record names a folder of another name, whose path the database had.
  if (o.recorded !== undefined && !samePath(o.recorded, folder) && o.cluster) {
    throw lost(join(o.recorded, "data"), `${o.recorded} is gone, no longer holds its key, or its junction leads elsewhere`);
  }
  const taken = (why: string) =>
    new DatabaseFailed(
      `PostgreSQL on Windows is given the data folder ${canonical} through the junction ${link}, and ${folder} is there but ${why}, so it is not used, and the database is never given another path. If another user made that folder, an administrator can remove it. Then open RaccoonVTT again.`,
    );
  let there: { user: string; facts: AclFacts };
  try {
    there = await deps.inspect(folder);
  } catch (err) {
    throw taken(`could not be read (${(err as Error).message})`);
  }
  if (there.facts.exists) {
    const mine = folderProblem(there.facts, user);
    if (mine !== null) throw taken(mine);
    let to: string | null = null;
    try {
      to = await readlink(link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw taken(`its junction can't be read (${(err as Error).message})`);
    }
    if (to !== null && !samePath(to, canonical)) throw taken(`its junction leads to ${to}`);
    if (to === null) {
      if (!o.mayMake) throw unrecorded(link);
      await symlink(canonical, link, "junction");
      if (!(await leadsTo(link, canonical))) throw taken("its junction leads elsewhere");
    }
    const key = (await readKey(folder)) ?? (await newKey(folder));
    await writeRecord(recordFile, canonical, folder, key);
    return link;
  }
  if (!o.mayMake) throw unrecorded(link);

  const notMine = (why: string) =>
    new DatabaseFailed(
      `PostgreSQL on Windows is given the data folder ${canonical} through a junction in RaccoonVTT's folder in ProgramData. The folder made for it, ${folder}, ${why}, so it is not used. Restart the computer and open RaccoonVTT again.`,
    );
  let made: { user: string; facts: AclFacts };
  try {
    made = await deps.make(folder);
  } catch (err) {
    throw notMine(`could not be made (${(err as Error).message})`);
  }
  const mine = folderProblem(made.facts, user);
  if (mine !== null) throw notMine(mine);
  if (!(await plainAndEmpty(folder))) throw notMine("was not empty");
  const key = await newKey(folder);
  await symlink(canonical, link, "junction");
  if (!(await leadsTo(link, canonical))) throw notMine("has a junction that leads elsewhere");
  await deps.linked?.(folder);
  // Once more, just before the data folder's record names the folder.
  if (!(await holdsKey(folder, key))) throw notMine("no longer holds its key");
  await writeRecord(recordFile, canonical, folder, key);
  return link;
}

function unrecorded(link: string): DatabaseFailed {
  return new DatabaseFailed(
    `This data folder holds a database, and postgres-link.json, which says how PostgreSQL was given it, is gone or doesn't read, and the junction it would be given, ${link}, is not there either. RaccoonVTT gives a database no new path, since a PostgreSQL still running from the old one could open it twice. Put postgres-link.json back from a copy of the data folder, then open RaccoonVTT again.`,
  );
}

async function writeRecord(file: string, canonical: string, folder: string, key: string): Promise<void> {
  await writeDurable(file, `${JSON.stringify({ data: canonical, how: "junction", folder, key })}\n`, { platform: "win32" });
}

async function leadsTo(link: string, canonical: string): Promise<boolean> {
  try {
    return samePath(await readlink(link), canonical);
  } catch {
    return false;
  }
}

async function readKey(folder: string): Promise<string | null> {
  try {
    const key = await readFile(join(folder, KEY_FILE), "utf8");
    return /^[0-9a-f]{32}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** A new key, which no other user can read in this user's folder. */
async function newKey(folder: string): Promise<string> {
  const key = randomBytes(16).toString("hex");
  await writeFile(join(folder, KEY_FILE), key, { flag: "w" });
  return key;
}

function mapPath(path: string, aliases: [string, string][]): string {
  for (const [from, to] of aliases) {
    const rest = relative(from, path);
    if (rest === "") return to;
    if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) continue;
    // Every name the app makes in these folders is ASCII, so this is a bug, never a user's folder.
    if (!ascii(rest)) throw new Error(`PostgreSQL can't be given ${path}, whose name under ${from} is not ASCII`);
    return join(to, rest);
  }
  return path;
}

/** One spelling of a path, for telling whether a junction leads to it. */
function samePath(a: string, b: string): boolean {
  // A junction may read back with Windows' \\?\ or \??\ prefix.
  const norm = (p: string) => resolve(p.replace(/^\\(\\\?|\?\?)\\/, "")).toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Why RaccoonVTT's folder in ProgramData is not as the installer makes it,
 * or null when it is: a plain folder Administrators or SYSTEM own, with an
 * ACL of its own that lets any other user only list it and make folders in
 * it, each folder its maker's.
 */
export function parentProblem(facts: AclFacts): string | null {
  if (!facts.exists) return "is missing";
  if (!facts.directory || facts.reparse) return "is not a plain folder";
  if (facts.owner !== ADMINS && facts.owner !== SYSTEM) return `is owned by ${facts.owner ?? "no one Windows names"}, not Administrators`;
  if (!facts.protected) return "takes its ACL from ProgramData";
  for (const rule of facts.rules) {
    if (!rule.allow) return `denies ${rule.sid} something, which the installer never does`;
    if (rule.inherited) return `inherits an entry for ${rule.sid}`;
    if (rule.sid === SYSTEM || rule.sid === ADMINS) continue;
    if (rule.sid === CREATOR_OWNER && (rule.propagate & INHERIT_ONLY) !== 0) continue;
    if (rule.sid === USERS && rule.inherit === 0 && ((rule.rights >>> 0) & ~USERS_MAY) === 0) continue;
    return `lets ${rule.sid} do more than the installer does`;
  }
  return null;
}

/** Why a folder is not this user's alone, or null when it is: owned by the user, its ACL only theirs, SYSTEM's and Administrators', each full control. */
export function folderProblem(facts: AclFacts, user: string): string | null {
  if (!facts.exists || !facts.directory || facts.reparse) return "is not a plain folder";
  if (facts.owner !== user) return `is owned by ${facts.owner ?? "no one Windows names"}, not by this user, ${user}`;
  if (!facts.protected) return "takes its ACL from RaccoonVTT's folder";
  const full = (sid: string) =>
    facts.rules.some((r) => r.sid === sid && r.allow && !r.inherited && ((r.rights >>> 0) & FULL_CONTROL) === FULL_CONTROL && r.inherit === CONTAINER_AND_OBJECT_INHERIT && r.propagate === 0);
  if (facts.rules.length !== 3 || ![user, SYSTEM, ADMINS].every(full)) {
    return `has entries for ${facts.rules.map((r) => r.sid).join(", ") || "no one"}, not only full control for this user, SYSTEM and Administrators`;
  }
  return null;
}

async function plainAndEmpty(folder: string): Promise<boolean> {
  try {
    // lstat calls a junction or a mount point a link, never a directory.
    return (await lstat(folder)).isDirectory() && (await readdir(folder)).length === 0;
  } catch {
    return false;
  }
}

async function holdsKey(folder: string, key: string): Promise<boolean> {
  try {
    return (await lstat(folder)).isDirectory() && (await readFile(join(folder, KEY_FILE), "utf8")) === key;
  } catch {
    return false;
  }
}

/** The record, null with none, "unreadable" for one that is there and doesn't read. */
async function readRecord(file: string): Promise<LinkRecord | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const row = JSON.parse(text) as { data?: unknown; how?: unknown; path?: unknown; folder?: unknown; key?: unknown };
    if (typeof row.data !== "string") return "unreadable";
    if (row.how === "direct") return { data: row.data, how: "direct" };
    if (row.how === "short" && typeof row.path === "string") return { data: row.data, how: "short", path: row.path };
    if (row.how === "junction" && typeof row.folder === "string" && typeof row.key === "string" && /^[0-9a-f]{32}$/.test(row.key)) {
      return { data: row.data, how: "junction", folder: row.folder, key: row.key };
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
}

// ---------------------------------------------------------------------------
// Windows' readings, through Windows PowerShell 5.1. Each runs by its full
// path, takes its folder from the environment, never the command line, and
// prints one line of UTF-8 JSON without a BOM.

const PREFIX = ["$ErrorActionPreference = 'Stop'", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false"];

/** The encoding refuses any letter it can't map exactly, since a best-fit letter (a for ā) names another file. */
const READ_FOLDER = [
  ...PREFIX,
  "$e = [System.Text.Encoding]::GetEncoding([System.Text.Encoding]::Default.CodePage, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)",
  "function Fits([string]$s) { try { [void]$e.GetBytes($s); $true } catch { $false } }",
  "$p = $env:RACCOONVTT_FOLDER",
  "$short = ''",
  "try { $short = [string](New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath } catch { }",
  "[pscustomobject]@{ fits = (Fits $p); short = $short; shortFits = ($short -ne '' -and (Fits $short)) } | ConvertTo-Json -Compress",
].join("; ");

/** A folder's owner and ACL, its entries by SID. Get-Item sees a link that leads nowhere, where Test-Path would not. */
const FACTS = [
  "function Facts([string]$p) { $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue",
  "if (-not $i) { return [pscustomobject]@{ exists = $false } }",
  "$a = Get-Acl -LiteralPath $p",
  "[pscustomobject]@{ exists = $true; directory = [bool]$i.PSIsContainer; reparse = [bool]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint); owner = $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected = $a.AreAccessRulesProtected; rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inherit = [int]$_.InheritanceFlags; propagate = [int]$_.PropagationFlags; allow = ($_.AccessControlType -eq 'Allow'); inherited = $_.IsInherited } }) } }",
].join("; ");

const INSPECT_FOLDER = [
  ...PREFIX,
  FACTS,
  "[pscustomobject]@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; facts = (Facts $env:RACCOONVTT_FOLDER) } | ConvertTo-Json -Compress -Depth 6",
].join("; ");

/** .NET Framework's CreateDirectory(path, security) hands the security descriptor to Windows' CreateDirectory. It leaves a folder already there as it is, which the reading after it shows. */
const MAKE_FOLDER = [
  ...PREFIX,
  FACTS,
  "$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$all = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$s = New-Object System.Security.AccessControl.DirectorySecurity",
  "$s.SetOwner($u)",
  "$s.SetAccessRuleProtection($true, $false)",
  "foreach ($sid in @($u, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) { $s.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $all, 'None', 'Allow'))) }",
  "[void][System.IO.Directory]::CreateDirectory($env:RACCOONVTT_FOLDER, $s)",
  "[pscustomobject]@{ user = $u.Value; facts = (Facts $env:RACCOONVTT_FOLDER) } | ConvertTo-Json -Compress -Depth 6",
].join("; ");

/** The scripts, for the checks of their shape. */
export const POWERSHELL_SCRIPTS = { READ_FOLDER, INSPECT_FOLDER, MAKE_FOLDER } as const;

function powershellExe(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function powershell(script: string, folder: string): Promise<string> {
  const { stdout } = await run(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, RACCOONVTT_FOLDER: folder }, windowsHide: true, timeout: 60_000 });
  return stdout.replace(/^\uFEFF/, "").trim();
}

export function parseFolderReading(stdout: string): FolderReading {
  try {
    const row = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as { fits?: unknown; short?: unknown; shortFits?: unknown };
    const short = typeof row.short === "string" && row.short !== "" ? row.short : null;
    return { fits: row.fits === true, short, shortFits: short !== null && row.shortFits === true };
  } catch {
    return { fits: false, short: null, shortFits: false };
  }
}

/** Get-Acl's facts as FACTS prints them. Whatever is missing or odd reads as the safe answer: not there, a link, not protected, inherited, denied. */
export function parseAclFacts(raw: unknown): AclFacts {
  const row = (raw ?? {}) as { exists?: unknown; directory?: unknown; reparse?: unknown; owner?: unknown; protected?: unknown; rules?: unknown };
  // ConvertTo-Json writes a list of one as the entry itself.
  const list: unknown[] = Array.isArray(row.rules) ? row.rules : row.rules == null ? [] : [row.rules];
  return {
    exists: row.exists === true,
    directory: row.directory === true,
    reparse: row.reparse !== false,
    owner: typeof row.owner === "string" ? row.owner : null,
    protected: row.protected === true,
    rules: list.map((r) => {
      const e = (r ?? {}) as { sid?: unknown; rights?: unknown; inherit?: unknown; propagate?: unknown; allow?: unknown; inherited?: unknown };
      return {
        sid: typeof e.sid === "string" ? e.sid : "",
        rights: Number(e.rights) || 0,
        inherit: Number(e.inherit) || 0,
        propagate: Number(e.propagate) || 0,
        allow: e.allow === true,
        inherited: e.inherited !== false,
      };
    }),
  };
}

/** A reading that fails says nothing fits, and the program folder is then given by neither way. */
async function readFolder(folder: string): Promise<FolderReading> {
  try {
    return parseFolderReading(await powershell(READ_FOLDER, folder));
  } catch {
    return { fits: false, short: null, shortFits: false };
  }
}

async function inspectFolder(folder: string): Promise<{ user: string; facts: AclFacts }> {
  const row = JSON.parse(await powershell(INSPECT_FOLDER, folder)) as { user?: unknown; facts?: unknown };
  if (typeof row.user !== "string") throw new Error("PowerShell named no user");
  return { user: row.user, facts: parseAclFacts(row.facts) };
}

async function makeFolder(folder: string): Promise<{ user: string; facts: AclFacts }> {
  const row = JSON.parse(await powershell(MAKE_FOLDER, folder)) as { user?: unknown; facts?: unknown };
  if (typeof row.user !== "string") throw new Error("PowerShell named no user");
  return { user: row.user, facts: parseAclFacts(row.facts) };
}
