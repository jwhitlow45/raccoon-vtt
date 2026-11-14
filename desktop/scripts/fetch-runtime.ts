import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Fills `desktop/.runtime/` with the bundled Node and PostgreSQL for one
 * target (docs/design/design-v1-local-app.md, sections 3 and 11.2):
 *
 *   node desktop/scripts/fetch-runtime.ts [--target <platform>-<arch>] [--out <dir>] [--no-attestation]
 *
 * It runs in CI before any package is installed, with a GitHub token in its
 * environment that no package script may see, so it uses Node's built-ins
 * alone: no zod, no contract.ts, no packages. The names it shares with
 * desktop/contract.ts are copied below, and fetch-runtime.test.ts checks
 * that they still match.
 *
 * Every archive is pinned in desktop/pins.json by URL and SHA-256, under a
 * target key made of `process.platform` and `process.arch`:
 *
 *   node.version, node.targets[<key>] = { url, sha256 }
 *   postgres.version, postgres.major, postgres.attestationRepo,
 *   postgres.targets[<key>] = { url, sha256, vcRuntimeMin? }   (vcRuntimeMin on win32-x64 only)
 *   floors = { macos, glibc }
 *
 * A hash mismatch stops the build. PostgreSQL's provenance is checked with
 * `gh attestation verify`. `--no-attestation` skips that check for working
 * offline on a development machine, and CI never passes it. What is left
 * after pruning is then held to the floors and, on Windows, to the import
 * and Visual C++ runtime checks, and any failure stops the build.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PINS_FILE = fileURLToPath(new URL("../pins.json", import.meta.url));

// Copies of desktop/contract.ts's names (RUNTIME_DIR, RESOURCES.node,
// RESOURCES.postgres, serverBinaryName), which this script cannot import.
export const RUNTIME_DIR = "desktop/.runtime";
export const NODE_DIR = "node";
export const POSTGRES_DIR = "postgres";
export function serverBinaryName(platform: string): string {
  return platform === "win32" ? "raccoonvtt-server.exe" : "raccoonvtt-server";
}

/** The programs the supervisor runs. Every other program in bin/ is pruned. */
export const KEPT_PROGRAMS = ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore"] as const;

/** The Visual C++ runtime DLLs PostgreSQL's Windows build imports and does not carry (D-261113-075, 098). */
export const VC_RUNTIME_DLLS = ["MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"] as const;

// ---------------------------------------------------------------------------
// Pins

export type Pin = { url: string; sha256: string };
export type PostgresPin = Pin & { vcRuntimeMin?: string };
export type Pins = {
  node: { version: string; targets: Record<string, Pin> };
  postgres: { version: string; major: number; attestationRepo: string; targets: Record<string, PostgresPin> };
  floors: { macos: string; glibc: string };
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION = /^\d+(\.\d+)*$/;

function isPin(value: unknown): value is Pin {
  const v = value as Pin;
  return typeof v === "object" && v !== null && typeof v.url === "string" && v.url.startsWith("https://") && SHA256_HEX.test(v.sha256);
}

/** Reads pins.json and refuses a file whose shape would let an unchecked download through. */
export function parsePins(text: string): Pins {
  const pins = JSON.parse(text) as Pins;
  const fail = (what: string): never => {
    throw new Error(`desktop/pins.json: ${what}`);
  };
  if (!VERSION.test(pins.node?.version ?? "")) fail("node.version must be a version");
  if (!VERSION.test(pins.postgres?.version ?? "")) fail("postgres.version must be a version");
  if (!Number.isInteger(pins.postgres.major)) fail("postgres.major must be a number");
  if (typeof pins.postgres.attestationRepo !== "string") fail("postgres.attestationRepo must name a repository");
  for (const [key, pin] of Object.entries(pins.node.targets ?? {})) if (!isPin(pin)) fail(`node.targets.${key} needs an https url and a sha256`);
  for (const [key, pin] of Object.entries(pins.postgres.targets ?? {})) {
    if (!isPin(pin)) fail(`postgres.targets.${key} needs an https url and a sha256`);
    if (pin.vcRuntimeMin !== undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(pin.vcRuntimeMin)) fail(`postgres.targets.${key}.vcRuntimeMin must have four parts`);
  }
  if (!VERSION.test(pins.floors?.macos ?? "") || !VERSION.test(pins.floors?.glibc ?? "")) fail("floors.macos and floors.glibc must be versions");
  return pins;
}

// ---------------------------------------------------------------------------
// Versions

export function parseVersion(text: string): number[] {
  return text.split(".").map((part) => Number(part));
}

/** Compares dotted versions part by part, a missing part counting as 0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Downloads

export async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Fetches `url` into `dest`. Injected in tests, which run without a network. */
export type Downloader = (url: string, dest: string) => Promise<void>;

export const httpsDownload: Downloader = async (url, dest) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
};

/**
 * The archive at its pinned hash, from the cache under `downloads/` when a
 * copy there still matches. A download that does not match is deleted
 * before the error, so nothing unpinned is ever unpacked or kept.
 */
export async function obtainArchive(pin: Pin, downloads: string, download: Downloader = httpsDownload): Promise<string> {
  await mkdir(downloads, { recursive: true });
  const name = basename(new URL(pin.url).pathname);
  const path = join(downloads, `${pin.sha256.slice(0, 16)}-${name}`);
  if (existsSync(path) && (await sha256OfFile(path)) === pin.sha256) return path;
  const part = `${path}.part`;
  await rm(part, { force: true });
  await download(pin.url, part);
  const actual = await sha256OfFile(part);
  if (actual !== pin.sha256) {
    await rm(part, { force: true });
    throw new Error(`${name}: its SHA-256 is ${actual}, but desktop/pins.json pins ${pin.sha256}. Nothing was unpacked.`);
  }
  await rename(part, path);
  return path;
}

// ---------------------------------------------------------------------------
// Pruning (design section 3)

/**
 * Whether a path in PostgreSQL's tree is left out of the app: everything a
 * running server never loads, and what would pull in programs or libraries
 * the app does not ship (LLVM for JIT, which the supervisor turns off,
 * Python, Tcl and Perl). `rel` uses forward slashes.
 */
export function denied(rel: string, platform: string): boolean {
  const path = platform === "win32" ? rel.toLowerCase() : rel;
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  const lower = name.toLowerCase();
  const top = parts[0];
  if (top === "include") return true;
  if (parts.includes("pgxs")) return true;
  if (lower.endsWith(".a")) return true;
  if (lower.startsWith("libllvm") || lower.startsWith("llvmjit")) return true;
  if (top === "lib" && parts[1] === "bitcode") return true;
  if (lower.includes("plpython") || lower.startsWith("pltcl") || lower.startsWith("plperl")) return true;
  if (lower.startsWith("libpython")) return true;
  if (top === "lib" && parts.length === 2 && lower.startsWith("python")) return true;
  if (top === "lib" && parts[1]?.toLowerCase() === "python") return true;
  if (top === "bin") {
    if (platform === "win32") {
      // Python's own folders beside python.exe.
      if (parts[1] === "dlls" || parts[1] === "lib") return true;
      if (parts.length === 2 && lower.startsWith("python") && (lower.endsWith(".dll") || lower.endsWith(".exe"))) return true;
      if (parts.length === 2 && lower.endsWith(".exe")) return !KEPT_PROGRAMS.some((p) => lower === `${p}.exe`);
      return false;
    }
    if (parts.length === 2) return !(KEPT_PROGRAMS as readonly string[]).includes(name);
  }
  return false;
}

/** Deletes every denied path under `root`, and answers what it deleted, relative and with forward slashes. */
export async function pruneTree(root: string, platform: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (denied(rel, platform)) {
        await rm(full, { recursive: true, force: true });
        removed.push(rel);
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(root);
  return removed.sort();
}

// ---------------------------------------------------------------------------
// Binary formats: just enough of PE, ELF and Mach-O to read imports,
// exports, version needs and minimum OS versions.

export type PeInfo = {
  linker: { major: number; minor: number };
  /** Each imported DLL with the functions taken from it, `#<n>` for one taken by ordinal. Delay-loaded imports included. */
  imports: { dll: string; functions: string[] }[];
  /** Exported names, and `#<n>` for every exported ordinal. */
  exports: string[];
};

function cString(buf: Buffer, offset: number): string {
  if (offset < 0 || offset >= buf.length) throw new Error("string outside the file");
  const end = buf.indexOf(0, offset);
  return buf.toString("latin1", offset, end === -1 ? buf.length : end);
}

/** A PE file's imports, exports and linker version, or null for any other file. */
export function parsePe(buf: Buffer): PeInfo | null {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const plus = magic === 0x20b;
  if (!plus && magic !== 0x10b) return null;
  const linker = { major: buf.readUInt8(opt + 2), minor: buf.readUInt8(opt + 3) };
  const imageBase = plus ? Number(buf.readBigUInt64LE(opt + 24)) : buf.readUInt32LE(opt + 28);
  const dirCount = buf.readUInt32LE(opt + (plus ? 108 : 92));
  const dirs = opt + (plus ? 112 : 96);
  const dir = (i: number): { rva: number; size: number } =>
    i < dirCount ? { rva: buf.readUInt32LE(dirs + i * 8), size: buf.readUInt32LE(dirs + i * 8 + 4) } : { rva: 0, size: 0 };
  const table = opt + optSize;
  const sectionList = Array.from({ length: sections }, (_, i) => {
    const s = table + i * 40;
    return {
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      raw: buf.readUInt32LE(s + 20),
    };
  });
  const at = (rva: number): number => {
    for (const s of sectionList) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    }
    throw new Error(`RVA ${rva} is in no section`);
  };
  const thunkSize = plus ? 8 : 4;
  const readThunks = (rva: number): string[] => {
    const out: string[] = [];
    for (let p = at(rva); ; p += thunkSize) {
      const value = plus ? buf.readBigUInt64LE(p) : BigInt(buf.readUInt32LE(p));
      if (value === 0n) break;
      const ordinalFlag = plus ? 1n << 63n : 1n << 31n;
      if (value & ordinalFlag) out.push(`#${Number(value & 0xffffn)}`);
      else out.push(cString(buf, at(Number(value & 0x7fffffffn)) + 2));
    }
    return out;
  };

  const imports: PeInfo["imports"] = [];
  const imp = dir(1);
  if (imp.rva) {
    for (let p = at(imp.rva); ; p += 20) {
      const lookup = buf.readUInt32LE(p);
      const nameRva = buf.readUInt32LE(p + 12);
      const first = buf.readUInt32LE(p + 16);
      if (nameRva === 0 && first === 0 && lookup === 0) break;
      imports.push({ dll: cString(buf, at(nameRva)), functions: readThunks(lookup || first) });
    }
  }
  const delay = dir(13);
  if (delay.rva) {
    for (let p = at(delay.rva); ; p += 32) {
      const attributes = buf.readUInt32LE(p);
      const nameValue = buf.readUInt32LE(p + 4);
      const namesValue = buf.readUInt32LE(p + 16);
      if (nameValue === 0) break;
      // An old-style descriptor (attribute bit 0 clear) holds addresses, not RVAs.
      const toRva = (v: number): number => ((attributes & 1) === 1 ? v : v - imageBase);
      imports.push({ dll: cString(buf, at(toRva(nameValue))), functions: namesValue ? readThunks(toRva(namesValue)) : [] });
    }
  }

  const exports: string[] = [];
  const exp = dir(0);
  if (exp.rva) {
    const e = at(exp.rva);
    const base = buf.readUInt32LE(e + 16);
    const functionCount = buf.readUInt32LE(e + 20);
    const nameCount = buf.readUInt32LE(e + 24);
    const names = buf.readUInt32LE(e + 32);
    for (let i = 0; i < nameCount; i++) exports.push(cString(buf, at(buf.readUInt32LE(at(names) + i * 4))));
    for (let i = 0; i < functionCount; i++) exports.push(`#${base + i}`);
  }
  return { linker, imports, exports };
}

/** Every symbol version an ELF file needs, such as `GLIBC_2.34`, read the way the loader reads it, or null for any other file. */
export function parseElfVersionNeeds(buf: Buffer): string[] | null {
  if (buf.length < 0x34 || buf.readUInt32BE(0) !== 0x7f454c46) return null;
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const word = (o: number) => (is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o));
  const phoff = word(is64 ? 0x20 : 0x1c);
  const phentsize = u16(is64 ? 0x36 : 0x2a);
  const phnum = u16(is64 ? 0x38 : 0x2c);
  const loads: { vaddr: number; offset: number; size: number }[] = [];
  let dynamic: { offset: number; size: number } | null = null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const type = u32(p);
    const offset = word(p + (is64 ? 8 : 4));
    const vaddr = word(p + (is64 ? 16 : 8));
    const filesz = word(p + (is64 ? 32 : 16));
    if (type === 1) loads.push({ vaddr, offset, size: filesz });
    if (type === 2) dynamic = { offset, size: filesz };
  }
  if (!dynamic) return [];
  const at = (vaddr: number): number => {
    const load = loads.find((l) => vaddr >= l.vaddr && vaddr < l.vaddr + l.size);
    if (!load) throw new Error(`address ${vaddr} is in no loaded segment`);
    return vaddr - load.vaddr + load.offset;
  };
  const entry = is64 ? 16 : 8;
  let strtab = -1;
  let verneed = -1;
  let verneedNum = 0;
  for (let p = dynamic.offset; p + entry <= dynamic.offset + dynamic.size; p += entry) {
    const tag = word(p);
    const value = word(p + entry / 2);
    if (tag === 0) break;
    if (tag === 5) strtab = value;
    if (tag === 0x6ffffffe) verneed = value;
    if (tag === 0x6fffffff) verneedNum = value;
  }
  if (verneed < 0 || verneedNum === 0) return [];
  if (strtab < 0) throw new Error("version needs without a string table");
  const strings = at(strtab);
  const needs: string[] = [];
  let need = at(verneed);
  for (let i = 0; i < verneedNum; i++) {
    const count = u16(need + 2);
    let aux = need + u32(need + 8);
    for (let j = 0; j < count; j++) {
      needs.push(cString(buf, strings + u32(aux + 8)));
      const next = u32(aux + 12);
      if (next === 0) break;
      aux += next;
    }
    const nextNeed = u32(need + 12);
    if (nextNeed === 0) break;
    need += nextNeed;
  }
  return needs;
}

const MACOS_PLATFORM = 1;

function decodeMachoVersion(v: number): string {
  return `${v >>> 16}.${(v >>> 8) & 0xff}${v & 0xff ? `.${v & 0xff}` : ""}`;
}

function machoSliceMinos(buf: Buffer, start: number): string[] {
  const magicLE = buf.readUInt32LE(start);
  const le = magicLE === 0xfeedfacf || magicLE === 0xfeedface;
  const magic = le ? magicLE : buf.readUInt32BE(start);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) throw new Error("not a Mach-O slice");
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ncmds = u32(start + 16);
  let p = start + (magic === 0xfeedfacf ? 32 : 28);
  const found: string[] = [];
  for (let i = 0; i < ncmds; i++) {
    const cmd = u32(p);
    const size = u32(p + 4);
    if (cmd === 0x32 && u32(p + 8) === MACOS_PLATFORM) found.push(decodeMachoVersion(u32(p + 12)));
    if (cmd === 0x24) found.push(decodeMachoVersion(u32(p + 8)));
    if (size < 8) throw new Error("a load command too short to step over");
    p += size;
  }
  return found;
}

/**
 * The macOS minimum versions a Mach-O file states, one per slice that
 * states one (a universal file has a slice per architecture), or null for
 * any other file.
 */
export function parseMachoMinos(buf: Buffer): string[] | null {
  if (buf.length < 32) return null;
  const be = buf.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const count = buf.readUInt32BE(4);
    // Java class files share 0xcafebabe, with a version where the count would be.
    if (count === 0 || count > 32) return null;
    const wide = be === 0xcafebabf;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const arch = 8 + i * (wide ? 32 : 20);
      const offset = wide ? Number(buf.readBigUInt64BE(arch + 8)) : buf.readUInt32BE(arch + 8);
      out.push(...machoSliceMinos(buf, offset));
    }
    return out;
  }
  const le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface || be === 0xfeedfacf || be === 0xfeedface) return machoSliceMinos(buf, 0);
  return null;
}

// ---------------------------------------------------------------------------
// Checks, as pure functions over what the parsers found, so they run on any
// system. Each answers its problems, one sentence each, and none means pass.

export type Scanned<T> = { path: string; facts: T };

/** DLLs Windows itself provides, which the app need not carry. */
export function isSystemDll(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("api-ms-win-")) return true;
  return ["kernel32", "advapi32", "user32", "ws2_32", "secur32", "shell32", "ole32", "crypt32", "bcrypt", "ucrtbase"].some((s) => n === `${s}.dll`);
}

/** Every DLL any file imports must be in the tree or be Windows' own. `treeNames` are file names, lowercase. */
export function checkImports(files: readonly Scanned<PeInfo>[], treeNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const { dll } of file.facts.imports) {
      if (!isSystemDll(dll) && !treeNames.has(dll.toLowerCase())) problems.push(`${file.path} imports ${dll}, which is neither in the tree nor a Windows DLL.`);
    }
  }
  return problems;
}

export type Signature = { status: string; subject: string };
export type VcRuntimeDll = { name: string; info: PeInfo; signature: Signature; version: string };

/**
 * The shipped Visual C++ runtime must be Microsoft's, and new enough three
 * ways (D-261113-103): it exports every function the files import from it,
 * its four-part version meets the pinned floor, and, as an extra check, its
 * major.minor meets the highest linker version among the files.
 */
export function checkVcRuntime(files: readonly Scanned<PeInfo>[], dlls: readonly VcRuntimeDll[], vcRuntimeMin: string): string[] {
  const problems: string[] = [];
  const shipped = new Map(dlls.map((d) => [d.name.toLowerCase(), d]));
  const vcNames = new Set(VC_RUNTIME_DLLS.map((n) => n.toLowerCase()));
  let linker = { major: 0, minor: 0 };
  for (const file of files) {
    if (vcNames.has(basename(file.path).toLowerCase())) continue;
    const l = file.facts.linker;
    if (l.major > linker.major || (l.major === linker.major && l.minor > linker.minor)) linker = l;
  }
  for (const name of VC_RUNTIME_DLLS) {
    const dll = shipped.get(name.toLowerCase());
    if (!dll) {
      problems.push(`${name} was not found in the Visual C++ redistributable folder.`);
      continue;
    }
    if (dll.signature.status !== "Valid" || !/(^|,\s*)O=Microsoft Corporation(,|$)/.test(dll.signature.subject)) {
      problems.push(`${name} has no valid signature from Microsoft Corporation (status ${dll.signature.status}, signer ${dll.signature.subject || "none"}).`);
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(dll.version) || compareVersions(dll.version, vcRuntimeMin) < 0) {
      problems.push(`${name} is version ${dll.version}, below the pinned floor ${vcRuntimeMin}.`);
    }
    if (compareVersions(dll.version.split(".").slice(0, 2).join("."), `${linker.major}.${linker.minor}`) < 0) {
      problems.push(`${name} is version ${dll.version}, older than linker ${linker.major}.${linker.minor} that built the files that import it.`);
    }
    const exported = new Set(dll.info.exports);
    for (const file of files) {
      for (const imp of file.facts.imports) {
        if (imp.dll.toLowerCase() !== name.toLowerCase()) continue;
        for (const fn of imp.functions) {
          if (!exported.has(fn)) problems.push(`${file.path} imports ${fn} from ${name}, which the shipped copy does not export.`);
        }
      }
    }
  }
  return problems;
}

/** No Mach-O file may need a newer macOS than the floor the app states. */
export function checkMacosFloor(files: readonly Scanned<string[]>[], floor: string): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const minos of file.facts) {
      if (compareVersions(minos, floor) > 0) problems.push(`${file.path} needs macOS ${minos}, above the floor ${floor}. Raise floors.macos and the docs together.`);
    }
  }
  return problems;
}

/** No ELF file may need a newer glibc than the floor the app states. Other libraries' versions (GLIBCXX_, GCC_) are left alone. */
export function checkGlibcFloor(files: readonly Scanned<string[]>[], floor: string): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const need of file.facts) {
      const m = /^GLIBC_(\d+(?:\.\d+)*)$/.exec(need);
      if (m?.[1] && compareVersions(m[1], floor) > 0) problems.push(`${file.path} needs glibc ${m[1]}, above the floor ${floor}. Raise floors.glibc and the docs together.`);
    }
  }
  return problems;
}

/** The highest version folder of the redistributable, such as `14.44.35112`, ignoring `v143` and other names. */
export function pickRedistVersion(names: readonly string[]): string | null {
  const versions = names.filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort(compareVersions);
  return versions[versions.length - 1] ?? null;
}

/** The newest `Microsoft.VC<nnn>.CRT` folder: VC143 for Visual Studio 2022, VC145 for 2026. */
export function pickCrtFolder(names: readonly string[]): string | null {
  const crt = names.filter((n) => /^Microsoft\.VC\d+\.CRT$/i.test(n)).sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
  return crt[crt.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// The run

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${cmd} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${basename(cmd)} ${args.join(" ")} failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** Windows' own tar (bsdtar), which reads zip too. Git's tar earlier on PATH reads neither zip nor drive paths. */
function tarCommand(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

async function extract(archive: string, into: string): Promise<string> {
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  run(tarCommand(), ["-xf", archive, "-C", into]);
  const entries = await readdir(into);
  if (entries.length !== 1 || !entries[0]) throw new Error(`${basename(archive)} does not hold one top folder.`);
  return join(into, entries[0]);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

export type TreeScan = { pe: Scanned<PeInfo>[]; elf: Scanned<string[]>[]; macho: Scanned<string[]>[]; names: Set<string> };

/** Parses every file under each root, keyed by its path relative to `base` with forward slashes. */
export async function scanTree(roots: readonly string[], base: string): Promise<TreeScan> {
  const scan: TreeScan = { pe: [], elf: [], macho: [], names: new Set() };
  for (const root of roots) {
    for (const file of await walkFiles(root)) {
      const path = relative(base, file).split(sep).join("/");
      scan.names.add(basename(file).toLowerCase());
      const buf = await readFile(file);
      const pe = parsePe(buf);
      if (pe) scan.pe.push({ path, facts: pe });
      const elf = parseElfVersionNeeds(buf);
      if (elf) scan.elf.push({ path, facts: elf });
      const macho = parseMachoMinos(buf);
      if (macho) scan.macho.push({ path, facts: macho });
    }
  }
  return scan;
}

const POWERSHELL = (): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Signature and file version of each path, through one PowerShell run. The paths travel in the environment, so no quoting can break the script. */
function readWindowsFileFacts(paths: readonly string[]): Map<string, { signature: Signature; version: string }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$out = @()",
    "foreach ($p in ($env:RVTT_FILES -split \"`n\")) {",
    "  $s = Get-AuthenticodeSignature -LiteralPath $p",
    "  $v = (Get-Item -LiteralPath $p).VersionInfo.FileVersionRaw",
    "  $out += [pscustomobject]@{ path = $p; status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; version = [string]$v }",
    "}",
    "ConvertTo-Json -Compress -InputObject @($out)",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = run(POWERSHELL(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    ...process.env,
    RVTT_FILES: paths.join("\n"),
  });
  const rows = JSON.parse(out) as { path: string; status: string; subject: string; version: string }[];
  return new Map(rows.map((r) => [r.path, { signature: { status: r.status, subject: r.subject }, version: r.version }]));
}

/** The Visual C++ runtime folder of the newest Visual Studio on this machine (the CI runner's), found through vswhere. */
async function findCrtFolder(): Promise<string> {
  const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const install = run(vswhere, ["-latest", "-products", "*", "-property", "installationPath"]).trim().split(/\r?\n/)[0] ?? "";
  if (!install) throw new Error("vswhere found no Visual Studio, so there is no Visual C++ runtime to ship.");
  const msvc = join(install, "VC", "Redist", "MSVC");
  const version = pickRedistVersion(await readdir(msvc));
  if (!version) throw new Error(`No redistributable version folder in ${msvc}.`);
  const x64 = join(msvc, version, "x64");
  const crt = pickCrtFolder(await readdir(x64));
  if (!crt) throw new Error(`No Microsoft.VC*.CRT folder in ${x64}.`);
  return join(x64, crt);
}

function fail(problems: readonly string[], what: string): void {
  if (problems.length === 0) return;
  throw new Error(`${what}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
}

export type FetchOptions = { target: string; out: string; attestation: boolean };

export async function fetchRuntime(opts: FetchOptions): Promise<void> {
  const pins = parsePins(await readFile(PINS_FILE, "utf8"));
  const nodePin = pins.node.targets[opts.target];
  const pgPin = pins.postgres.targets[opts.target];
  if (!nodePin || !pgPin) throw new Error(`desktop/pins.json has no pins for ${opts.target}.`);
  const [platform] = opts.target.split("-");
  if (platform !== process.platform) throw new Error(`${opts.target} must be fetched on its own system, since the checks run its programs.`);
  const out = resolve(opts.out);
  const downloads = join(out, "downloads");
  const staging = join(out, "staging");

  console.log(`Fetching Node ${pins.node.version} and PostgreSQL ${pins.postgres.version} for ${opts.target}`);
  const nodeArchive = await obtainArchive(nodePin, downloads);
  const pgArchive = await obtainArchive(pgPin, downloads);
  if (opts.attestation) {
    run("gh", ["attestation", "verify", pgArchive, "--repo", pins.postgres.attestationRepo]);
    console.log(`PostgreSQL's provenance checked against ${pins.postgres.attestationRepo}`);
  } else {
    console.log("Skipped PostgreSQL's provenance check (--no-attestation, development only)");
  }

  const nodeOut = join(out, NODE_DIR);
  const pgOut = join(out, POSTGRES_DIR);
  await rm(nodeOut, { recursive: true, force: true });
  await rm(pgOut, { recursive: true, force: true });

  const nodeTop = await extract(nodeArchive, join(staging, "node"));
  const binary = join(nodeOut, serverBinaryName(platform));
  await mkdir(nodeOut, { recursive: true });
  await copyFile(platform === "win32" ? join(nodeTop, "node.exe") : join(nodeTop, "bin", "node"), binary);
  await chmod(binary, 0o755);
  await copyFile(join(nodeTop, "LICENSE"), join(nodeOut, "LICENSE"));

  const pgTop = await extract(pgArchive, join(staging, "postgres"));
  await rename(pgTop, pgOut);
  await rm(staging, { recursive: true, force: true });
  const removed = await pruneTree(pgOut, platform);
  console.log(`Pruned ${removed.length} paths from PostgreSQL`);

  let vcRuntime: string | undefined;
  if (platform === "win32") {
    const min = pgPin.vcRuntimeMin;
    if (!min) throw new Error(`desktop/pins.json gives ${opts.target} no vcRuntimeMin.`);
    const crt = await findCrtFolder();
    const shipped = VC_RUNTIME_DLLS.map((name) => join(pgOut, "bin", name));
    for (const name of VC_RUNTIME_DLLS) await copyFile(join(crt, name), join(pgOut, "bin", name));
    const facts = readWindowsFileFacts(shipped);
    const scan = await scanTree([pgOut], out);
    const dlls: VcRuntimeDll[] = [];
    for (const [i, name] of VC_RUNTIME_DLLS.entries()) {
      const path = shipped[i] ?? "";
      const info = parsePe(await readFile(path));
      const fact = facts.get(path);
      if (info && fact) dlls.push({ name, info, ...fact });
    }
    fail(checkImports(scan.pe, scan.names), "PostgreSQL imports DLLs the app does not carry");
    fail(checkVcRuntime(scan.pe, dlls, min), `The Visual C++ runtime from ${crt} cannot be shipped`);
    vcRuntime = dlls[0]?.version;
    console.log(`Shipping the Visual C++ runtime ${dlls.map((d) => `${d.name} ${d.version}`).join(", ")} from ${crt}`);
  }

  const scan = await scanTree([pgOut, nodeOut], out);
  fail(checkMacosFloor(scan.macho, pins.floors.macos), "A file needs a newer macOS than the floor");
  fail(checkGlibcFloor(scan.elf, pins.floors.glibc), "A file needs a newer glibc than the floor");

  const pgVersion = run(join(pgOut, "bin", platform === "win32" ? "postgres.exe" : "postgres"), ["--version"]).trim();
  const wantPg = pins.postgres.version.split(".").slice(0, 2).join(".");
  if (!pgVersion.endsWith(`(PostgreSQL) ${wantPg}`)) throw new Error(`postgres --version says "${pgVersion}", not PostgreSQL ${wantPg}.`);
  const nodeVersion = run(binary, ["--version"]).trim();
  if (nodeVersion !== `v${pins.node.version}`) throw new Error(`The bundled Node says ${nodeVersion}, not v${pins.node.version}.`);

  const runtime = {
    target: opts.target,
    node: pins.node.version,
    postgres: pins.postgres.version,
    pgMajor: pins.postgres.major,
    ...(vcRuntime ? { vcRuntime } : {}),
  };
  await writeFile(join(out, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  const size = await treeBytes(out, [downloads]);
  console.log(`${pgVersion}, Node ${nodeVersion}, ${(size / 1024 / 1024).toFixed(1)} MB unpacked in ${relative(ROOT, out) || out}`);
}

async function treeBytes(root: string, skip: readonly string[]): Promise<number> {
  let total = 0;
  for (const file of await walkFiles(root)) {
    if (skip.some((s) => file.startsWith(s + sep))) continue;
    total += (await stat(file)).size;
  }
  return total;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: `${process.platform}-${process.arch}` },
      out: { type: "string", default: join(ROOT, RUNTIME_DIR) },
      "no-attestation": { type: "boolean", default: false },
    },
  });
  try {
    await fetchRuntime({ target: values.target, out: values.out, attestation: !values["no-attestation"] });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
