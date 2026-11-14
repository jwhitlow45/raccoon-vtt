import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR_ENV, type Platform } from "../contract.ts";
import { writeDurable } from "./durable.ts";
import { DatabaseFailed } from "./postgres.ts";

/**
 * PostgreSQL's programs on Windows open every path through the ANSI code
 * page, the system's language for non-Unicode programs. A folder whose path
 * has a letter outside it, as under a profile named in Cyrillic on a Western
 * system, can't be opened at all (D-261113-219). So each folder PostgreSQL
 * works in, the data folder and its own program folder, is handed to it by
 * the first of these the code page holds:
 * 1. its path as it is,
 * 2. its 8.3 short path, which Windows keeps on the system drive unless
 *    turned off there,
 * 3. a junction to it, in a folder of the app's own under ProgramData,
 *    which only this user, SYSTEM and Administrators can open.
 * With none of them the start stops with words. The junction's folder is
 * named in the data folder and kept from start to start, because
 * PostgreSQL on Windows names its shared memory after the data folder's
 * path, and that name is how it finds a dead postmaster's processes still
 * attached before it starts another.
 */

const run = promisify(execFile);

/** What Windows says of a folder: whether the ANSI code page holds its path, and its 8.3 short path. */
export type FolderReading = { fits: boolean; short: string | null; shortFits: boolean };

export type PgPathDeps = {
  /** Reads a folder. Tests stand in a code page here. */
  read(folder: string): Promise<FolderReading>;
  /** Takes every other user off a new folder's ACL. */
  restrict(folder: string): Promise<void>;
  /** ProgramData, where the junctions' folder is made. */
  programData: string | undefined;
};

export type PgPaths = {
  /** The path PostgreSQL's programs are given for a path in one of the folders. */
  map(path: string): string;
  /** Each folder that is given another way, and how, for the log. */
  notes: string[];
};

/** Windows' own readings, ProgramData from the environment. */
export function windowsDeps(): PgPathDeps {
  return { read: readFolder, restrict: restrictFolder, programData: process.env.ProgramData };
}

/** Plain ASCII, which every ANSI code page holds as it is. */
function ascii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/** The junctions' folder's name: the app's, then 16 random hex digits. */
const LINK_FOLDER = /^RaccoonVTT-[0-9a-f]{16}$/;

export async function pgPaths(
  folders: { data: string; program: string },
  record: string,
  platform: Platform,
  deps: PgPathDeps = windowsDeps(),
): Promise<PgPaths> {
  if (platform !== "win32") return { map: (path) => path, notes: [] };
  const aliases: [string, string][] = [];
  const notes: string[] = [];
  const toLink: { name: string; target: string }[] = [];
  for (const [name, folder] of [
    ["data", folders.data],
    ["postgres", folders.program],
  ] as const) {
    if (ascii(folder)) continue;
    const reading = await deps.read(folder);
    if (reading.fits) continue;
    if (reading.short !== null && reading.shortFits) {
      aliases.push([folder, reading.short]);
      notes.push(`${folder} by its short path, ${reading.short}`);
    } else {
      toLink.push({ name, target: folder });
    }
  }
  if (toLink.length > 0) {
    const linkFolder = await junctions(toLink, record, deps);
    for (const { name, target } of toLink) {
      aliases.push([target, join(linkFolder, name)]);
      notes.push(`${target} through the junction ${join(linkFolder, name)}`);
    }
  }
  return { map: (path) => mapPath(path, aliases), notes };
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
 * The folder holding a junction to each target, reused while the data
 * folder's record names it, it still holds the record's key, and its
 * junctions lead to the folders. Any user may add to a new folder in
 * ProgramData, and with that make an empty one a link, so a folder is
 * kept only when this process made it (mkdir fails on one that is
 * there), took every other user off its ACL, and then found it plain and
 * empty. Only then does it get the key, which no other user can read, and
 * the junctions. A junction opens nothing the target's own ACL refuses.
 */
async function junctions(links: { name: string; target: string }[], record: string, deps: PgPathDeps): Promise<string> {
  const first = links[0]!;
  const failed = (reason: string) =>
    new DatabaseFailed(
      `PostgreSQL can't open ${first.target}, whose path has letters outside this computer's language for non-Unicode programs, and no short name or junction could stand in for it (${reason}). ${
        first.name === "data" ? `Set ${DATA_DIR_ENV} to a folder whose path has none of those letters.` : "Install RaccoonVTT in a folder whose path has none of those letters."
      }`,
    );
  const programData = deps.programData;
  if (!programData || !isAbsolute(programData) || !ascii(programData)) throw failed("ProgramData is not a plain path");
  const previous = await readRecord(record);
  if (
    previous !== null &&
    samePath(dirname(previous.folder), programData) &&
    LINK_FOLDER.test(basename(previous.folder)) &&
    (await holdsKey(previous.folder, previous.key)) &&
    (await linked(previous.folder, links))
  ) {
    return previous.folder;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const folder = join(programData, `RaccoonVTT-${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw failed(`${folder}: ${(err as Error).message}`);
    }
    try {
      await deps.restrict(folder);
    } catch (err) {
      throw failed(`${folder}: ${(err as Error).message}`);
    }
    if (!(await plainAndEmpty(folder))) continue;
    const key = randomBytes(16).toString("hex");
    await writeFile(join(folder, KEY_FILE), key, { flag: "wx" });
    if (!(await linked(folder, links))) continue;
    await writeDurable(record, `${JSON.stringify({ folder, key })}\n`, { platform: "win32" });
    return folder;
  }
  throw failed(`no folder made in ${programData} stayed this user's alone`);
}

/** The key's file in the junctions' folder. */
const KEY_FILE = "key";

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

/** Whether each junction in `folder` leads to its target, made where missing. */
async function linked(folder: string, links: { name: string; target: string }[]): Promise<boolean> {
  for (const { name, target } of links) {
    const link = join(folder, name);
    let to: string;
    try {
      to = await readlink(link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      try {
        await symlink(target, link, "junction");
        to = await readlink(link);
      } catch {
        return false;
      }
    }
    if (!samePath(to, target)) return false;
  }
  return true;
}

async function readRecord(file: string): Promise<{ folder: string; key: string } | null> {
  try {
    const row = JSON.parse(await readFile(file, "utf8")) as { folder?: unknown; key?: unknown };
    return typeof row.folder === "string" && typeof row.key === "string" && /^[0-9a-f]{32}$/.test(row.key) ? { folder: row.folder, key: row.key } : null;
  } catch {
    return null;
  }
}

/** The SID in `whoami /user /fo csv /nh`'s one line: "<domain>\<name>","<SID>". */
export function parseWhoamiSid(stdout: string): string | null {
  return /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(stdout.trim())?.[1] ?? null;
}

/**
 * Leaves a folder to this user, SYSTEM and Administrators, inherited by
 * what is made in it. The user is named by SID, not as the owner: what an
 * administrator makes may be owned by the Administrators group, which
 * PostgreSQL's programs drop from their rights when an administrator runs
 * them. /L acts on the folder itself, should another user have made it a
 * link meanwhile.
 */
async function restrictFolder(folder: string): Promise<void> {
  const system32 = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  const { stdout } = await run(`${system32}\\whoami.exe`, ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const sid = parseWhoamiSid(stdout);
  if (sid === null) throw new Error(`whoami said: ${stdout.trim()}`);
  await run(`${system32}\\icacls.exe`, [folder, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/L", "/Q"], {
    windowsHide: true,
  });
}

/**
 * Windows' own reading of a folder. The encoding refuses any letter it
 * can't map exactly, since a best-fit letter (a for ā) names another file.
 * Output is UTF-8 without a BOM, so a short path in any script comes back
 * whole. The folder comes in the environment, never the command line.
 */
const READ_FOLDER = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$e = [System.Text.Encoding]::GetEncoding([System.Text.Encoding]::Default.CodePage, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)",
  "function Fits([string]$s) { try { [void]$e.GetBytes($s); $true } catch { $false } }",
  "$p = $env:RACCOONVTT_FOLDER",
  "$short = ''",
  "try { $short = [string](New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath } catch { }",
  "[pscustomobject]@{ fits = (Fits $p); short = $short; shortFits = ($short -ne '' -and (Fits $short)) } | ConvertTo-Json -Compress",
].join("; ");

export function parseFolderReading(stdout: string): FolderReading {
  try {
    const row = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as { fits?: unknown; short?: unknown; shortFits?: unknown };
    const short = typeof row.short === "string" && row.short !== "" ? row.short : null;
    return { fits: row.fits === true, short, shortFits: short !== null && row.shortFits === true };
  } catch {
    return { fits: false, short: null, shortFits: false };
  }
}

/** A reading that fails says nothing fits, so the folder gets a junction, whose path is ASCII. */
async function readFolder(folder: string): Promise<FolderReading> {
  try {
    const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", READ_FOLDER], {
      env: { ...process.env, RACCOONVTT_FOLDER: folder },
      windowsHide: true,
    });
    return parseFolderReading(stdout);
  } catch {
    return { fits: false, short: null, shortFits: false };
  }
}
