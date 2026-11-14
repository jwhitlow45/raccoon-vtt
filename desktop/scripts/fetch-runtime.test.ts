import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { RESOURCES, RUNTIME_DIR as CONTRACT_RUNTIME_DIR, serverBinaryName as contractServerBinaryName } from "../contract.ts";
import {
  LICENSES_DIR,
  NODE_DIR,
  POSTGRES_DIR,
  RUNTIME_DIR,
  checkGlibcFloor,
  checkImports,
  checkMacosFloor,
  checkVcRuntime,
  compareVersions,
  denied,
  obtainArchive,
  parseElfVersionNeeds,
  parseMachoMinos,
  parsePe,
  parsePins,
  pickCrtFolder,
  pickRedistVersion,
  pruneTree,
  serverBinaryName,
  writeLicenses,
  type PeInfo,
  type Scanned,
  type VcRuntimeDll,
} from "./fetch-runtime.ts";

// ---------------------------------------------------------------------------
// Small synthetic binaries, built here so the parsers are tested on every
// system CI runs, with no archive and no network.

/** A PE32+ image with one section holding its import and export tables. */
function buildPe(opts: { linker?: [number, number]; imports?: Record<string, string[]>; exports?: string[]; delayImports?: Record<string, string[]> }): Buffer {
  const SECTION_RVA = 0x1000;
  const RAW = 0x200;
  const data = Buffer.alloc(0x8000);
  let used = 0;
  const alloc = (n: number): number => {
    const at = (used + 7) & ~7;
    used = at + n;
    return at;
  };
  const rva = (offset: number) => SECTION_RVA + offset;
  const str = (s: string): number => {
    const at = alloc(s.length + 1);
    data.write(s, at, "latin1");
    return at;
  };
  const thunks = (fns: string[]): number => {
    const at = alloc((fns.length + 1) * 8);
    fns.forEach((fn, i) => {
      if (fn.startsWith("#")) {
        data.writeBigUInt64LE((1n << 63n) | BigInt(Number(fn.slice(1))), at + i * 8);
      } else {
        const hint = alloc(2 + fn.length + 1);
        data.write(fn, hint + 2, "latin1");
        data.writeBigUInt64LE(BigInt(rva(hint)), at + i * 8);
      }
    });
    return at;
  };

  let importDir = { rva: 0, size: 0 };
  const imports = Object.entries(opts.imports ?? {});
  if (imports.length) {
    const desc = alloc((imports.length + 1) * 20);
    imports.forEach(([dll, fns], i) => {
      const lookup = thunks(fns);
      const iat = thunks(fns);
      data.writeUInt32LE(rva(lookup), desc + i * 20);
      data.writeUInt32LE(rva(str(dll)), desc + i * 20 + 12);
      data.writeUInt32LE(rva(iat), desc + i * 20 + 16);
    });
    importDir = { rva: rva(desc), size: (imports.length + 1) * 20 };
  }
  let delayDir = { rva: 0, size: 0 };
  const delays = Object.entries(opts.delayImports ?? {});
  if (delays.length) {
    const desc = alloc((delays.length + 1) * 32);
    delays.forEach(([dll, fns], i) => {
      data.writeUInt32LE(1, desc + i * 32);
      data.writeUInt32LE(rva(str(dll)), desc + i * 32 + 4);
      data.writeUInt32LE(rva(thunks(fns)), desc + i * 32 + 16);
    });
    delayDir = { rva: rva(desc), size: (delays.length + 1) * 32 };
  }
  let exportDir = { rva: 0, size: 0 };
  const exports = opts.exports ?? [];
  if (exports.length) {
    const dir = alloc(40);
    const functions = alloc(exports.length * 4);
    const names = alloc(exports.length * 4);
    const ordinals = alloc(exports.length * 2);
    const sorted = [...exports].sort();
    sorted.forEach((name, i) => {
      data.writeUInt32LE(rva(functions), functions + i * 4);
      data.writeUInt32LE(rva(str(name)), names + i * 4);
      data.writeUInt16LE(i, ordinals + i * 2);
    });
    data.writeUInt32LE(rva(str("test.dll")), dir + 12);
    data.writeUInt32LE(1, dir + 16);
    data.writeUInt32LE(exports.length, dir + 20);
    data.writeUInt32LE(exports.length, dir + 24);
    data.writeUInt32LE(rva(functions), dir + 28);
    data.writeUInt32LE(rva(names), dir + 32);
    data.writeUInt32LE(rva(ordinals), dir + 36);
    exportDir = { rva: rva(dir), size: 40 };
  }

  const size = (used + 0x1ff) & ~0x1ff;
  const out = Buffer.alloc(RAW + size);
  out.write("MZ", 0, "latin1");
  out.writeUInt32LE(0x40, 0x3c);
  const pe = 0x40;
  out.writeUInt32LE(0x00004550, pe);
  out.writeUInt16LE(0x8664, pe + 4);
  out.writeUInt16LE(1, pe + 6);
  out.writeUInt16LE(240, pe + 20);
  const opt = pe + 24;
  out.writeUInt16LE(0x20b, opt);
  const [major, minor] = opts.linker ?? [14, 51];
  out.writeUInt8(major, opt + 2);
  out.writeUInt8(minor, opt + 3);
  out.writeBigUInt64LE(0x180000000n, opt + 24);
  out.writeUInt32LE(16, opt + 108);
  const dirs = opt + 112;
  for (const [i, d] of [
    [0, exportDir],
    [1, importDir],
    [13, delayDir],
  ] as const) {
    out.writeUInt32LE(d.rva, dirs + i * 8);
    out.writeUInt32LE(d.size, dirs + i * 8 + 4);
  }
  const section = opt + 240;
  out.write(".rdata", section, "latin1");
  out.writeUInt32LE(size, section + 8);
  out.writeUInt32LE(SECTION_RVA, section + 12);
  out.writeUInt32LE(size, section + 16);
  out.writeUInt32LE(RAW, section + 20);
  data.copy(out, RAW, 0, size);
  return out;
}

/** An ELF64 shared library whose dynamic section needs the given versions of libc.so.6. */
function buildElf(versions: string[]): Buffer {
  const strings = ["", "libc.so.6", ...versions];
  const offsets = new Map<string, number>();
  let strSize = 0;
  for (const s of strings) {
    offsets.set(s, strSize);
    strSize += s.length + 1;
  }
  const phoff = 64;
  const dyn = phoff + 2 * 56;
  const dynSize = 4 * 16;
  const strtab = dyn + dynSize;
  const verneed = (strtab + strSize + 7) & ~7;
  const total = verneed + 16 + versions.length * 16;
  const b = Buffer.alloc(total);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b[6] = 1;
  b.writeUInt16LE(3, 0x10);
  b.writeUInt16LE(0x3e, 0x12);
  b.writeUInt32LE(1, 0x14);
  b.writeBigUInt64LE(BigInt(phoff), 0x20);
  b.writeUInt16LE(64, 0x34);
  b.writeUInt16LE(56, 0x36);
  b.writeUInt16LE(2, 0x38);
  const ph = (i: number, type: number, offset: number, size: number) => {
    const p = phoff + i * 56;
    b.writeUInt32LE(type, p);
    b.writeBigUInt64LE(BigInt(offset), p + 8);
    b.writeBigUInt64LE(BigInt(offset), p + 16);
    b.writeBigUInt64LE(BigInt(offset), p + 24);
    b.writeBigUInt64LE(BigInt(size), p + 32);
    b.writeBigUInt64LE(BigInt(size), p + 40);
  };
  ph(0, 1, 0, total);
  ph(1, 2, dyn, dynSize);
  const dynEntry = (i: number, tag: number, value: number) => {
    b.writeBigUInt64LE(BigInt(tag), dyn + i * 16);
    b.writeBigUInt64LE(BigInt(value), dyn + i * 16 + 8);
  };
  dynEntry(0, 5, strtab);
  dynEntry(1, 0x6ffffffe, verneed);
  dynEntry(2, 0x6fffffff, 1);
  dynEntry(3, 0, 0);
  for (const s of strings) b.write(s, strtab + (offsets.get(s) ?? 0), "latin1");
  b.writeUInt16LE(1, verneed);
  b.writeUInt16LE(versions.length, verneed + 2);
  b.writeUInt32LE(offsets.get("libc.so.6") ?? 0, verneed + 4);
  b.writeUInt32LE(16, verneed + 8);
  versions.forEach((v, i) => {
    const aux = verneed + 16 + i * 16;
    b.writeUInt32LE(offsets.get(v) ?? 0, aux + 8);
    b.writeUInt32LE(i === versions.length - 1 ? 0 : 16, aux + 12);
  });
  return b;
}

function machoVersion(v: string): number {
  const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
  return (a << 16) | (b << 8) | c;
}

/** A thin 64-bit Mach-O with LC_BUILD_VERSION for macOS, or the older LC_VERSION_MIN_MACOSX. */
function buildMacho(minos: string, command: "build" | "min" = "build", platform = 1): Buffer {
  const cmdSize = command === "build" ? 24 : 16;
  const b = Buffer.alloc(32 + cmdSize);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(0x0100000c, 4);
  b.writeUInt32LE(6, 12);
  b.writeUInt32LE(1, 16);
  b.writeUInt32LE(cmdSize, 20);
  if (command === "build") {
    b.writeUInt32LE(0x32, 32);
    b.writeUInt32LE(24, 36);
    b.writeUInt32LE(platform, 40);
    b.writeUInt32LE(machoVersion(minos), 44);
    b.writeUInt32LE(machoVersion("15.5"), 48);
  } else {
    b.writeUInt32LE(0x24, 32);
    b.writeUInt32LE(16, 36);
    b.writeUInt32LE(machoVersion(minos), 40);
  }
  return b;
}

/** A universal file of the given slices, each at a 4 KiB boundary as lipo lays them out. */
function buildFat(slices: Buffer[]): Buffer {
  const header = 8 + slices.length * 20;
  const offsets: number[] = [];
  let at = 4096;
  for (const s of slices) {
    offsets.push(at);
    at = (at + s.length + 4095) & ~4095;
  }
  const b = Buffer.alloc(at);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(slices.length, 4);
  slices.forEach((s, i) => {
    const arch = 8 + i * 20;
    b.writeUInt32BE(i === 0 ? 0x0100000c : 0x01000007, arch);
    b.writeUInt32BE(offsets[i] ?? 0, arch + 8);
    b.writeUInt32BE(s.length, arch + 12);
    b.writeUInt32BE(12, arch + 16);
    s.copy(b, offsets[i] ?? 0);
  });
  assert.ok(header < 4096);
  return b;
}

function pe(path: string, info: PeInfo): Scanned<PeInfo> {
  return { path, facts: info };
}

// ---------------------------------------------------------------------------

test("the runtime's names match desktop/contract.ts", () => {
  assert.equal(RUNTIME_DIR, CONTRACT_RUNTIME_DIR);
  assert.equal(NODE_DIR, RESOURCES.node);
  assert.equal(POSTGRES_DIR, RESOURCES.postgres);
  assert.equal(LICENSES_DIR, RESOURCES.licenses);
  for (const platform of ["win32", "darwin", "linux"] as const) assert.equal(serverBinaryName(platform), contractServerBinaryName(platform));
});

test("desktop/pins.json pins every target by an https URL and a SHA-256", async () => {
  const { readFile } = await import("node:fs/promises");
  const pins = parsePins(await readFile(new URL("../pins.json", import.meta.url), "utf8"));
  const targets = ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  assert.deepEqual(Object.keys(pins.node.targets).sort(), [...targets].sort());
  assert.deepEqual(Object.keys(pins.postgres.targets).sort(), [...targets].sort());
  assert.match(pins.postgres.targets["win32-x64"]?.vcRuntimeMin ?? "", /^\d+\.\d+\.\d+\.\d+$/);
  assert.throws(() => parsePins(JSON.stringify({ ...pins, node: { ...pins.node, targets: { "linux-x64": { url: "http://x", sha256: "0".repeat(64) } } } })), /https url/);
});

describe("downloads", () => {
  test("an archive whose SHA-256 differs from its pin stops the build and leaves nothing behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rvtt-fetch-"));
    try {
      const good = Buffer.from("the pinned archive");
      const pin = { url: "https://example.com/files/archive.tar.gz", sha256: createHash("sha256").update(good).digest("hex") };
      await assert.rejects(
        obtainArchive(pin, dir, (_url, dest) => writeFile(dest, "something else")),
        /archive\.tar\.gz: its SHA-256 is [0-9a-f]{64}, but desktop\/pins\.json pins/,
      );
      assert.deepEqual(await readdir(dir), []);

      let downloads = 0;
      const fetchGood = async (_url: string, dest: string) => {
        downloads++;
        await writeFile(dest, good);
      };
      const path = await obtainArchive(pin, dir, fetchGood);
      assert.ok(existsSync(path));
      // A matching copy is reused, and a changed one is fetched again.
      assert.equal(await obtainArchive(pin, dir, fetchGood), path);
      assert.equal(downloads, 1);
      await writeFile(path, "tampered");
      await obtainArchive(pin, dir, fetchGood);
      assert.equal(downloads, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("license notices", () => {
  /** A repository root, Node's LICENSE and an unpacked PostgreSQL tree, as the archives hold them. */
  async function sources(postgresFiles: Record<string, string>): Promise<{ dir: string; root: string; nodeLicense: string; postgres: string }> {
    const dir = await mkdtemp(join(tmpdir(), "rvtt-licenses-"));
    const write = async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    };
    await write(join(dir, "repo", "LICENSE"), "GNU AFFERO GENERAL PUBLIC LICENSE");
    await write(join(dir, "node", "LICENSE"), "Node.js is licensed for use as follows");
    for (const [rel, text] of Object.entries(postgresFiles)) await write(join(dir, "postgres", rel), text);
    return { dir, root: join(dir, "repo"), nodeLicense: join(dir, "node", "LICENSE"), postgres: join(dir, "postgres") };
  }
  const ARCHIVE = {
    COPYRIGHT: "PostgreSQL Database Management System",
    LICENSE: "Copyright (c) 2024, Theseus",
    "dependency-notices/openssl/copyright": "Apache License",
    "dependency-notices/vcpkg/icu/copyright": "UNICODE LICENSE",
    "bin/postgres": "a program, not a notice",
  };

  test("the fetch step writes RaccoonVTT's, Node's and PostgreSQL's notices with its bundled libraries', and nothing else", async () => {
    const src = await sources(ARCHIVE);
    try {
      const out = join(src.dir, "runtime");
      const written = await writeLicenses(out, src);
      assert.deepEqual(written, [
        "node/LICENSE",
        "postgresql/COPYRIGHT",
        "postgresql/LICENSE",
        "postgresql/dependency-notices/openssl/copyright",
        "postgresql/dependency-notices/vcpkg/icu/copyright",
        "raccoonvtt/LICENSE",
      ]);
      assert.equal(await readFile(join(out, LICENSES_DIR, "postgresql", "COPYRIGHT"), "utf8"), ARCHIVE.COPYRIGHT);
      assert.equal(await readFile(join(out, LICENSES_DIR, "node", "LICENSE"), "utf8"), "Node.js is licensed for use as follows");
      assert.equal(await readFile(join(out, LICENSES_DIR, "raccoonvtt", "LICENSE"), "utf8"), "GNU AFFERO GENERAL PUBLIC LICENSE");
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  test("on Windows it adds the Visual C++ runtime's terms with the version shipped, and a second run leaves no stale notice", async () => {
    const { LICENSE: _theseus, ...windowsArchive } = ARCHIVE;
    const src = await sources(windowsArchive);
    try {
      const out = join(src.dir, "runtime");
      await mkdir(join(out, LICENSES_DIR, "old"), { recursive: true });
      await writeFile(join(out, LICENSES_DIR, "old", "NOTICE"), "from a run before");
      const written = await writeLicenses(out, { ...src, vcRuntime: "14.51.36014.0" });
      assert.ok(written.includes("vc-runtime/NOTICE.txt"));
      assert.ok(!written.includes("postgresql/LICENSE"), "the Windows archive has no theseus LICENSE, and none is made up");
      assert.ok(!written.some((f) => f.startsWith("old/")));
      const notice = await readFile(join(out, LICENSES_DIR, "vc-runtime", "NOTICE.txt"), "utf8");
      assert.match(notice, /MSVCP140\.dll, VCRUNTIME140\.dll, VCRUNTIME140_1\.dll in postgres\\bin/);
      assert.match(notice, /version 14\.51\.36014\.0/);
      assert.match(notice, /https:\/\/visualstudio\.microsoft\.com\/license-terms\//);
      assert.doesNotMatch(notice, /[\u2014;]/, "house style: no em dash, no semicolon");
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  for (const missing of ["COPYRIGHT", "dependency-notices"]) {
    test(`an archive without its ${missing} stops the build`, async () => {
      const src = await sources(Object.fromEntries(Object.entries(ARCHIVE).filter(([rel]) => !rel.startsWith(missing))));
      try {
        await assert.rejects(writeLicenses(join(src.dir, "runtime"), src), new RegExp(`no ${missing}, so the app would ship without its license notices`));
      } finally {
        await rm(src.dir, { recursive: true, force: true });
      }
    });
  }
});

describe("pruning", () => {
  async function tree(root: string, files: string[]): Promise<void> {
    for (const f of files) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "x");
    }
  }
  async function listed(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${rel}${e.name}/`);
        else out.push(`${rel}${e.name}`);
      }
    };
    await walk(root, "");
    return out.sort();
  }

  test("macOS and Linux keep the five programs and what the server loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvtt-prune-"));
    try {
      await tree(root, [
        "bin/postgres",
        "bin/initdb",
        "bin/pg_ctl",
        "bin/pg_dump",
        "bin/pg_restore",
        "bin/psql",
        "bin/pgbench",
        "bin/pg_upgrade",
        "lib/libpq.5.dylib",
        "lib/libicuuc.78.dylib",
        "lib/plpgsql.dylib",
        "lib/libLLVM.dylib",
        "lib/llvmjit.dylib",
        "lib/llvmjit_types.bc",
        "lib/bitcode/postgres/x.bc",
        "lib/libpgport.a",
        "lib/plpython3.dylib",
        "lib/hstore_plpython3.dylib",
        "lib/pltcl.so",
        "lib/plperl.so",
        "lib/libpython3.11.so.1.0",
        "lib/python3.13/os.py",
        "lib/Python/Python",
        "lib/pgxs/src/Makefile.global",
        "lib/postgresql/pgxs/config/install-sh",
        "include/libpq-fe.h",
        "share/extension/plpgsql.control",
        "share/extension/plpython3u.control",
        "share/timezone/UTC",
        "LICENSE",
      ]);
      await pruneTree(root, "darwin");
      assert.deepEqual(await listed(root), [
        "LICENSE",
        "bin/initdb",
        "bin/pg_ctl",
        "bin/pg_dump",
        "bin/pg_restore",
        "bin/postgres",
        "lib/libicuuc.78.dylib",
        "lib/libpq.5.dylib",
        "lib/plpgsql.dylib",
        "share/extension/plpgsql.control",
        "share/timezone/UTC",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Windows keeps bin's DLLs and only the five programs, and drops Python", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvtt-prune-"));
    try {
      await tree(root, [
        "bin/postgres.exe",
        "bin/INITDB.EXE",
        "bin/pg_ctl.exe",
        "bin/pg_dump.exe",
        "bin/pg_restore.exe",
        "bin/psql.exe",
        "bin/test_cloexec.exe",
        "bin/python.exe",
        "bin/python3.dll",
        "bin/python314.dll",
        "bin/DLLs/_ssl.pyd",
        "bin/Lib/os.py",
        "bin/libpq.dll",
        "bin/icuuc78.dll",
        "bin/zstd.dll",
        "lib/plpgsql.dll",
        "lib/plpython3.dll",
        "lib/libpq.lib",
      ]);
      await pruneTree(root, "win32");
      assert.deepEqual(await listed(root), [
        "bin/INITDB.EXE",
        "bin/icuuc78.dll",
        "bin/libpq.dll",
        "bin/pg_ctl.exe",
        "bin/pg_dump.exe",
        "bin/pg_restore.exe",
        "bin/postgres.exe",
        "bin/zstd.dll",
        "lib/libpq.lib",
        "lib/plpgsql.dll",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a program's name elsewhere than bin/ is not a program", () => {
    assert.equal(denied("share/psql", "linux"), false);
    assert.equal(denied("bin/psql", "linux"), true);
  });
});

describe("parsers", () => {
  test("PE: imports by name and ordinal, delay imports, exports and the linker version", () => {
    const info = parsePe(
      buildPe({
        linker: [14, 44],
        imports: { "KERNEL32.dll": ["CreateFileW", "#17"], "VCRUNTIME140.dll": ["memcpy"] },
        delayImports: { "USER32.dll": ["MessageBoxW"] },
        exports: ["pq_connect", "pq_finish"],
      }),
    );
    assert.ok(info);
    assert.deepEqual(info.linker, { major: 14, minor: 44 });
    assert.deepEqual(info.imports, [
      { dll: "KERNEL32.dll", functions: ["CreateFileW", "#17"] },
      { dll: "VCRUNTIME140.dll", functions: ["memcpy"] },
      { dll: "USER32.dll", functions: ["MessageBoxW"] },
    ]);
    assert.deepEqual(info.exports, ["pq_connect", "pq_finish", "#1", "#2"]);
    assert.equal(parsePe(Buffer.from("not a program at all, just some text")), null);
  });

  test("ELF: the symbol versions its dynamic section needs", () => {
    assert.deepEqual(parseElfVersionNeeds(buildElf(["GLIBC_2.34", "GLIBC_2.36"])), ["GLIBC_2.34", "GLIBC_2.36"]);
    assert.equal(parseElfVersionNeeds(buildMacho("15.0")), null);
  });

  test("Mach-O: the minimum macOS of a thin file, an older-style one and each slice of a universal one", () => {
    assert.deepEqual(parseMachoMinos(buildMacho("15.0")), ["15.0"]);
    assert.deepEqual(parseMachoMinos(buildMacho("13.5", "min")), ["13.5"]);
    assert.deepEqual(parseMachoMinos(buildFat([buildMacho("15.0"), buildMacho("15.2")])), ["15.0", "15.2"]);
    assert.equal(parseMachoMinos(buildElf([])), null);
    // An iOS build's minimum (platform 2) says nothing about macOS.
    assert.deepEqual(parseMachoMinos(buildMacho("17.0", "build", 2)), []);
  });

  test("versions compare part by part", () => {
    assert.equal(compareVersions("14.51.0.0", "14.44.35211.0"), 1);
    assert.equal(compareVersions("2.36", "2.4"), 1);
    assert.equal(compareVersions("15", "15.0"), 0);
  });
});

describe("Windows imports", () => {
  const tree = new Set(["postgres.exe", "libpq.dll", "icuuc78.dll", "vcruntime140.dll"]);

  test("a DLL in the tree or Windows' own passes", () => {
    const files = [
      pe("postgres/bin/postgres.exe", {
        linker: { major: 14, minor: 51 },
        imports: [
          { dll: "KERNEL32.dll", functions: [] },
          { dll: "Secur32.dll", functions: [] },
          { dll: "api-ms-win-crt-heap-l1-1-0.dll", functions: [] },
          { dll: "ICUUC78.dll", functions: [] },
          { dll: "VCRUNTIME140.dll", functions: [] },
        ],
        exports: [],
      }),
      pe("postgres/lib/plpgsql.dll", { linker: { major: 14, minor: 51 }, imports: [{ dll: "postgres.exe", functions: [] }], exports: [] }),
    ];
    assert.deepEqual(checkImports(files, tree), []);
  });

  test("an unlisted DLL stops the build, named with its importer", () => {
    const files = [pe("postgres/bin/postgres.exe", { linker: { major: 14, minor: 51 }, imports: [{ dll: "python314.dll", functions: [] }], exports: [] })];
    assert.deepEqual(checkImports(files, tree), ["postgres/bin/postgres.exe imports python314.dll, which is neither in the tree nor a Windows DLL."]);
  });
});

describe("the Visual C++ runtime", () => {
  const MIN = "14.51.0.0";
  const program = pe("postgres/bin/postgres.exe", {
    linker: { major: 14, minor: 51 },
    imports: [
      { dll: "VCRUNTIME140.dll", functions: ["memcpy", "__C_specific_handler"] },
      { dll: "MSVCP140.dll", functions: ["?_Xlength_error@std@@YAXPEBD@Z"] },
      { dll: "VCRUNTIME140_1.dll", functions: ["__CxxFrameHandler4"] },
    ],
    exports: [],
  });
  const signed = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" };
  function runtime(over: Partial<Record<string, Partial<VcRuntimeDll>>> = {}): VcRuntimeDll[] {
    const base: VcRuntimeDll[] = [
      { name: "VCRUNTIME140.dll", info: { linker: { major: 14, minor: 51 }, imports: [], exports: ["memcpy", "__C_specific_handler"] }, signature: signed, version: "14.51.36014.0" },
      { name: "MSVCP140.dll", info: { linker: { major: 14, minor: 51 }, imports: [], exports: ["?_Xlength_error@std@@YAXPEBD@Z"] }, signature: signed, version: "14.51.36014.0" },
      { name: "VCRUNTIME140_1.dll", info: { linker: { major: 14, minor: 51 }, imports: [], exports: ["__CxxFrameHandler4"] }, signature: signed, version: "14.51.36014.0" },
    ];
    return base.map((d) => ({ ...d, ...over[d.name] }));
  }

  test("Microsoft's signed copy, new enough, exporting what the files import, passes", () => {
    assert.deepEqual(checkVcRuntime([program], runtime(), MIN), []);
  });

  test("an unsigned copy, or one signed by anyone else, stops the build", () => {
    const unsigned = checkVcRuntime([program], runtime({ "MSVCP140.dll": { signature: { status: "NotSigned", subject: "" } } }), MIN);
    assert.deepEqual(unsigned, ["MSVCP140.dll has no valid signature from Microsoft Corporation (status NotSigned, signer none)."]);
    const other = checkVcRuntime([program], runtime({ "MSVCP140.dll": { signature: { status: "Valid", subject: "CN=Someone, O=Not Microsoft Corporation Ltd" } } }), MIN);
    assert.equal(other.length, 1);
    assert.match(other[0] ?? "", /no valid signature/);
    // Microsoft's name on a signature that does not verify (a changed file) counts for nothing.
    const broken = checkVcRuntime([program], runtime({ "MSVCP140.dll": { signature: { ...signed, status: "HashMismatch" } } }), MIN);
    assert.equal(broken.length, 1);
    assert.match(broken[0] ?? "", /status HashMismatch/);
  });

  test("a copy below the pinned floor stops the build", () => {
    const old = checkVcRuntime([program], runtime({ "VCRUNTIME140.dll": { version: "14.50.35719.0" } }), MIN);
    assert.ok(old.includes("VCRUNTIME140.dll is version 14.50.35719.0, below the pinned floor 14.51.0.0."), old.join("\n"));
  });

  test("a copy missing a function a retained file imports stops the build", () => {
    const missing = checkVcRuntime(
      [program],
      runtime({ "VCRUNTIME140_1.dll": { info: { linker: { major: 14, minor: 51 }, imports: [], exports: [] } } }),
      MIN,
    );
    assert.deepEqual(missing, ["postgres/bin/postgres.exe imports __CxxFrameHandler4 from VCRUNTIME140_1.dll, which the shipped copy does not export."]);
  });

  test("a copy older than the newest linker among the files stops the build, even above the floor", () => {
    const newer = pe("postgres/lib/plpgsql.dll", { linker: { major: 14, minor: 52 }, imports: [], exports: [] });
    const problems = checkVcRuntime([program, newer], runtime(), "14.40.0.0");
    assert.equal(problems.length, 3);
    assert.match(problems[0] ?? "", /older than linker 14\.52/);
  });

  test("a DLL missing from the redistributable folder stops the build", () => {
    const problems = checkVcRuntime([program], runtime().slice(1), MIN);
    assert.ok(problems.includes("VCRUNTIME140.dll was not found in the Visual C++ redistributable folder."));
  });

  test("the newest redistributable folder is picked, VC145 over VC143", () => {
    assert.equal(pickRedistVersion(["v143", "14.44.35112", "14.51.36014", "14.9.1"]), "14.51.36014");
    assert.equal(pickCrtFolder(["Microsoft.VC143.CRT", "Microsoft.VC145.CRT", "Microsoft.VC143.OPENMP"]), "Microsoft.VC145.CRT");
    assert.equal(pickRedistVersion(["v143"]), null);
  });
});

describe("floors", () => {
  test("a Mach-O file above the macOS floor stops the build, naming it", () => {
    const files = [
      { path: "postgres/bin/postgres", facts: ["15.0"] },
      { path: "postgres/lib/libicuuc.78.dylib", facts: ["15.0", "15.1"] },
    ];
    assert.deepEqual(checkMacosFloor(files, "15.0"), [
      "postgres/lib/libicuuc.78.dylib needs macOS 15.1, above the floor 15.0. Raise floors.macos and the docs together.",
    ]);
    assert.deepEqual(checkMacosFloor(files, "15.1"), []);
  });

  test("an ELF file above the glibc floor stops the build, naming it, and other libraries' versions do not count", () => {
    const files = [
      { path: "postgres/lib/libstdc++.so.6", facts: ["GLIBC_2.36", "GLIBCXX_3.4.32", "GCC_7.0.0"] },
      { path: "postgres/bin/postgres", facts: ["GLIBC_2.2.5", "GLIBC_2.38"] },
    ];
    assert.deepEqual(checkGlibcFloor(files, "2.36"), [
      "postgres/bin/postgres needs glibc 2.38, above the floor 2.36. Raise floors.glibc and the docs together.",
    ]);
    assert.deepEqual(checkGlibcFloor(files, "2.38"), []);
  });

  test("the floors read through the parsers", () => {
    const mac = parseMachoMinos(buildFat([buildMacho("15.0"), buildMacho("15.4")])) ?? [];
    assert.equal(checkMacosFloor([{ path: "lib/x.dylib", facts: mac }], "15.0").length, 1);
    const elf = parseElfVersionNeeds(buildElf(["GLIBC_2.17", "GLIBC_2.39"])) ?? [];
    assert.equal(checkGlibcFloor([{ path: "lib/x.so", facts: elf }], "2.36").length, 1);
  });
});
