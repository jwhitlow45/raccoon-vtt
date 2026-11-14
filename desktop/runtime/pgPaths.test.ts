import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { DATA_DIR_ENV, Platform } from "../contract.ts";
import { folderProblem, parentProblem, parseAclFacts, parseFolderReading, pgPaths, type AclFacts, type AclRule, type FolderReading, type PgPathDeps } from "./pgPaths.ts";
import { Cluster, DatabaseFailed } from "./postgres.ts";

/**
 * Which path PostgreSQL's programs get for a folder on Windows, with
 * stand-ins for Windows' answers: a code page that holds Latin-1, as cp1252
 * does, so é fits and Ж doesn't, short names as given, and the ACLs Get-Acl
 * would read. Junctions are symlinks here, which read back the same way.
 * desktop.yml's Windows smoke test and postgres.itest.ts run the real ones.
 */

const platform = Platform.parse(process.platform);
const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function folder(name = "rvtt-pgpaths-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), name)));
  temps.push(dir);
  return dir;
}

const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const CREATOR_OWNER = "S-1-3-0";
const ME = "S-1-5-21-1-2-3-1001";
const FULL = 0x1f01ff;
const rule = (sid: string, rights: number, inherit: number, propagate = 0, more: Partial<AclRule> = {}): AclRule => ({ sid, rights, inherit, propagate, allow: true, inherited: false, ...more });

/** RaccoonVTT's folder in ProgramData as desktop/build/programdata.ps1 makes it. */
function installers(): AclFacts {
  return {
    exists: true,
    directory: true,
    reparse: false,
    owner: ADMINS,
    protected: true,
    rules: [rule(SYSTEM, FULL, 3), rule(ADMINS, FULL, 3), rule(USERS, 0x1 | 0x4 | 0x20 | 0x80 | 0x20000 | 0x100000, 0), rule(CREATOR_OWNER, FULL, 3, 2)],
  };
}

/** A folder made with this user's own security descriptor, as the app asks. */
function mine(user = ME): AclFacts {
  return { exists: true, directory: true, reparse: false, owner: user, protected: true, rules: [rule(user, FULL, 3), rule(SYSTEM, FULL, 3), rule(ADMINS, FULL, 3)] };
}

const latin1 = (path: string) => [...path].every((c) => c.codePointAt(0)! <= 0xff);

type Windows = PgPathDeps & { reads: string[]; made: string[]; inspected: string[] };

/**
 * A Windows with a Latin-1 code page, the short names given, and
 * RaccoonVTT's folder in ProgramData as its installer makes it. Each
 * reading, folder made and look at the ACL is counted. `made` is the ACL a
 * folder gets, `meanwhile` what happens to it before it is read.
 */
function windows(
  programData: string | undefined,
  o: {
    short?: Record<string, string>;
    read?: (path: string) => FolderReading;
    parent?: AclFacts | Error;
    made?: AclFacts | Error;
    meanwhile?: (folder: string) => Promise<void>;
    linked?: (folder: string) => Promise<void>;
  } = {},
): Windows {
  const reads: string[] = [];
  const made: string[] = [];
  const inspected: string[] = [];
  return {
    reads,
    made,
    inspected,
    programData,
    read: async (path) => {
      reads.push(path);
      if (o.read) return o.read(path);
      const short = o.short?.[path] ?? null;
      return { fits: latin1(path), short, shortFits: short !== null && latin1(short) };
    },
    inspect: async (path) => {
      inspected.push(path);
      if (o.parent instanceof Error) throw o.parent;
      return o.parent ?? installers();
    },
    make: async (path) => {
      made.push(path);
      if (o.made instanceof Error) throw o.made;
      await mkdir(path);
      await o.meanwhile?.(path);
      return { user: ME, facts: o.made ?? mine() };
    },
    ...(o.linked ? { linked: o.linked } : {}),
  };
}

/** A data folder under a name with é and Ж, a program folder whose path is ASCII, and ProgramData with RaccoonVTT's folder. */
async function setup(): Promise<{ root: string; data: string; program: string; record: string; programData: string; parent: string }> {
  const root = await folder();
  const data = join(root, "RaccoonVTT Tést Жук", "data");
  const program = join(root, "Program Files", "RaccoonVTT", "resources", "postgres");
  const programData = join(root, "ProgramData");
  const parent = join(programData, "RaccoonVTT");
  for (const dir of [data, program, parent]) await mkdir(dir, { recursive: true });
  return { root, data, program, record: join(data, "postgres-link.json"), programData, parent };
}

const record = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
const paths = (s: { data: string; program: string; record: string }, deps: PgPathDeps) => pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps);

describe("the paths PostgreSQL's programs are given", () => {
  test("on macOS and Linux each is the path itself, and nothing is read or recorded", async () => {
    const s = await setup();
    const deps = windows(s.programData);
    for (const on of ["darwin", "linux"] satisfies Platform[]) {
      const p = await pgPaths({ data: s.data, program: s.program }, s.record, on, deps);
      assert.equal(p.map(join(s.data, "postgres")), join(s.data, "postgres"));
    }
    assert.deepEqual(deps.reads, []);
    assert.equal(existsSync(s.record), false);
  });

  test("on Windows an ASCII path is given as it is, without asking Windows or recording anything", async () => {
    const s = await setup();
    const data = join(s.root, "data");
    const deps = windows(s.programData);
    const p = await pgPaths({ data, program: s.program }, join(data, "postgres-link.json"), "win32", deps);
    assert.equal(p.map(join(data, "postgres")), join(data, "postgres"));
    assert.deepEqual([deps.reads, deps.made, p.notes], [[], [], []]);
    assert.equal(existsSync(join(data, "postgres-link.json")), false);
  });

  test("a path the code page holds is given as it is, and that is recorded, so no later start asks again", async () => {
    const s = await setup();
    const data = join(s.root, "Données de José");
    await mkdir(data);
    const file = join(data, "postgres-link.json");
    const deps = windows(s.programData);
    const first = await pgPaths({ data, program: s.program }, file, "win32", deps);
    assert.equal(first.map(join(data, "postgres")), join(data, "postgres"));
    assert.deepEqual(deps.reads, [data], "the ASCII program folder is never read");
    assert.deepEqual(await record(file), { data, how: "direct" });
    await pgPaths({ data, program: s.program }, file, "win32", windows(s.programData, { read: () => assert.fail("asked again") }));
    assert.deepEqual(await readdir(s.parent), [], "no junction");
  });

  test("a path with a letter outside the code page is given by its 8.3 short path when that fits, recorded and kept", async () => {
    const s = await setup();
    const short = join(s.root, "RACCOO~1");
    await symlink(dirname(s.data), short);
    const shortData = join(short, "data");
    const p = await paths(s, windows(s.programData, { short: { [s.data]: shortData } }));
    assert.equal(p.map(s.data), shortData);
    assert.equal(p.map(join(s.data, "postgres")), join(shortData, "postgres"));
    assert.equal(p.map(join(s.data, "logs", "postgres.log")), join(shortData, "logs", "postgres.log"));
    assert.equal(p.map(join(s.program, "bin")), join(s.program, "bin"), "the program folder fits as it is");
    assert.equal(p.map(join(s.root, "elsewhere")), join(s.root, "elsewhere"), "a path in neither folder is left alone");
    assert.deepEqual(await record(s.record), { data: s.data, how: "short", path: shortData });
    const again = await paths(s, windows(s.programData, { read: () => assert.fail("asked again") }));
    assert.equal(again.map(s.data), shortData);
    assert.deepEqual(await readdir(s.parent), []);
  });

  test("with no short name that fits, a junction in this user's own folder in RaccoonVTT's folder in ProgramData, kept from start to start", async () => {
    const s = await setup();
    // A short name with a letter the code page lacks, as when 8.3 names are off and Windows hands back the long one.
    const deps = windows(s.programData, { short: { [s.data]: s.data } });
    const first = await paths(s, deps);
    assert.deepEqual(deps.inspected, [s.parent], "the installer's folder is read before anything is made in it");
    const [made] = await readdir(s.parent);
    assert.match(made ?? "", /^[0-9a-f]{16}$/);
    const own = join(s.parent, made!);
    assert.deepEqual(deps.made, [own], "made by Windows with its security descriptor, never by mkdir");
    const link = join(own, "data");
    assert.equal(first.map(join(s.data, "postgres")), join(link, "postgres"));
    assert.equal(await readlink(link), s.data);
    await writeFile(join(s.data, "probe"), "through the junction");
    assert.equal(await readFile(join(link, "probe"), "utf8"), "through the junction");
    const r = await record(s.record);
    assert.deepEqual([r.data, r.how, r.folder], [s.data, "junction", own]);
    assert.equal(await readFile(join(own, "key"), "utf8"), r.key);
    assert.match(r.key ?? "", /^[0-9a-f]{32}$/);
    assert.match(first.notes.join("\n"), /as .*data$/m);

    const later = windows(s.programData, { read: () => assert.fail("asked again") });
    const again = await paths(s, later);
    assert.equal(again.map(join(s.data, "postgres")), join(link, "postgres"), "the same path, so PostgreSQL's shared memory keeps its name");
    assert.deepEqual([later.inspected, later.made], [[], []]);
  });

  test("a junction chosen once is kept, though the reading that chose it failed and a later one would fit", async () => {
    const s = await setup();
    const data = join(s.root, "Données", "data");
    await mkdir(data, { recursive: true });
    const file = join(data, "postgres-link.json");
    const failed = windows(s.programData, { read: () => ({ fits: false, short: null, shortFits: false }) });
    const first = await pgPaths({ data, program: s.program }, file, "win32", failed);
    assert.equal((await record(file)).how, "junction");
    await mkdir(join(data, "postgres"));
    const good = windows(s.programData);
    const again = await pgPaths({ data, program: s.program }, file, "win32", good);
    assert.equal(again.map(data), first.map(data));
    assert.deepEqual(good.reads, [], "the record comes before any reading");
  });

  test("while the folder holds a database, a recorded way that no longer leads to it stops the start, and no other is chosen", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    const before = await readFile(s.record, "utf8");
    const own = (await record(s.record)).folder!;
    await mkdir(join(s.data, "postgres"));
    const stops = async (what: string, change: () => Promise<void>, why: RegExp) => {
      await change();
      const kept = await readFile(s.record, "utf8");
      const deps = windows(s.programData);
      await assert.rejects(paths(s, deps), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed, what);
        assert.match(err.logLine, why, what);
        assert.match(err.logLine, /Restart the computer, then delete postgres-link\.json/, what);
        assert.doesNotMatch(err.logLine, /[\u2014;]/);
        return true;
      });
      assert.deepEqual([deps.reads, deps.made], [[], []], `${what}: nothing else was tried`);
      assert.equal(await readFile(s.record, "utf8"), kept, `${what}: the record stays`);
    };
    await stops("the junction gone", () => rm(join(own, "data")), /the junction .* is gone/);
    await symlink(s.root, join(own, "data"));
    await stops("the junction leading elsewhere", async () => {}, /leads elsewhere/);
    await stops("the key changed", () => writeFile(join(own, "key"), "f".repeat(32)), /no longer holds its key/);
    await stops("the folder gone", () => rm(own, { recursive: true }), /is gone or no longer holds its key/);
    const elsewhere = { ...JSON.parse(before), folder: join(s.root, "0123456789abcdef") };
    await stops("a folder outside RaccoonVTT's", () => writeFile(s.record, JSON.stringify(elsewhere)), /is not a folder of this user's/);
  });

  test("a short name that is gone, or a record that doesn't read, stops a start whose folder holds a database", async () => {
    const s = await setup();
    const short = join(s.root, "RACCOO~1");
    await symlink(dirname(s.data), short);
    await paths(s, windows(s.programData, { short: { [s.data]: join(short, "data") } }));
    await mkdir(join(s.data, "postgres"));
    await rm(short);
    await assert.rejects(paths(s, windows(s.programData)), /its short name .* is gone/);
    await writeFile(s.record, "not json");
    await assert.rejects(paths(s, windows(s.programData)), /postgres-link\.json in the data folder, .* doesn't read/);
  });

  test("with no database yet, a record that doesn't lead anywhere or doesn't read, or one made for another folder, is chosen again", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    const own = (await record(s.record)).folder!;
    await rm(own, { recursive: true });
    const again = await paths(s, windows(s.programData));
    assert.notEqual((await record(s.record)).folder, own);
    assert.equal(await readlink(again.map(s.data)), s.data);
    await writeFile(s.record, "{");
    await paths(s, windows(s.programData));
    assert.equal((await record(s.record)).how, "junction");
    await mkdir(join(s.data, "postgres"));
    await writeFile(s.record, JSON.stringify({ data: join(s.root, "moved from here"), how: "short", path: join(s.root, "GONE~1") }));
    const moved = windows(s.programData);
    await paths(s, moved);
    assert.deepEqual(moved.reads, [s.data], "a record for another folder, as after a move, says nothing of this one");
  });

  test("RaccoonVTT's folder in ProgramData not as its installer makes it stops the start with words to reinstall, and nothing is made in it", async () => {
    const s = await setup();
    const base = installers();
    const without = (sid: string) => base.rules.filter((r) => r.sid !== sid);
    const cases: [string, AclFacts | Error, RegExp][] = [
      ["missing", { ...base, exists: false }, /is missing/],
      ["a link", { ...base, reparse: true }, /is not a plain folder/],
      ["owned by a user", { ...base, owner: "S-1-5-21-9-9-9-1002" }, /is owned by S-1-5-21-9-9-9-1002, not Administrators/],
      ["taking ProgramData's ACL", { ...base, protected: false }, /takes its ACL from ProgramData/],
      ["Everyone may write", { ...base, rules: [...base.rules, rule("S-1-1-0", FULL, 3)] }, /lets S-1-1-0 do more/],
      ["Users may write files", { ...base, rules: [...without(USERS), rule(USERS, 0x1 | 0x2 | 0x4, 0)] }, /lets S-1-5-32-545 do more/],
      ["Users' entry inherited by what is made", { ...base, rules: [...without(USERS), rule(USERS, 0x1 | 0x4, 3)] }, /lets S-1-5-32-545 do more/],
      ["Users may delete", { ...base, rules: [...without(USERS), rule(USERS, 0x1 | 0x4 | 0x10000, 0)] }, /lets S-1-5-32-545 do more/],
      ["CREATOR OWNER on the folder itself", { ...base, rules: [...without(CREATOR_OWNER), rule(CREATOR_OWNER, FULL, 3, 0)] }, /lets S-1-3-0 do more/],
      ["a deny entry", { ...base, rules: [...base.rules, rule(USERS, 0x4, 0, 0, { allow: false })] }, /denies S-1-5-32-545/],
      ["an inherited entry", { ...base, rules: [...base.rules, rule(SYSTEM, FULL, 3, 0, { inherited: true })] }, /inherits an entry for S-1-5-18/],
      ["a generic right", { ...base, rules: [...without(USERS), rule(USERS, -0x80000000, 0)] }, /lets S-1-5-32-545 do more/],
      ["unreadable", new Error("Access is denied"), /could not be read \(Access is denied\)/],
    ];
    for (const [what, parent, why] of cases) {
      const deps = windows(s.programData, { parent });
      await assert.rejects(paths(s, deps), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed, what);
        assert.match(err.logLine, why, what);
        assert.match(err.logLine, /Reinstall RaccoonVTT, or set RACCOON_DATA_DIR/, what);
        assert.ok(err.logLine.includes(s.data), what);
        assert.doesNotMatch(err.logLine, /[\u2014;]/);
        return true;
      });
      assert.deepEqual(deps.made, [], `${what}: nothing made in it`);
      assert.equal(existsSync(s.record), false, what);
    }
    for (const programData of [undefined, "ProgramData", join(s.root, "Данные")]) {
      const deps = windows(programData);
      await assert.rejects(paths(s, deps), /has no plain path on this computer/);
      assert.deepEqual(deps.inspected, []);
    }
    assert.equal(parentProblem(base), null, "the installer's own is fine");
    assert.equal(parentProblem({ ...base, owner: SYSTEM }), null);
  });

  test("a folder made that is not this user's alone is never used, and the words name why", async () => {
    const s = await setup();
    const own = mine();
    const cases: [string, Partial<Parameters<typeof windows>[1]>, RegExp][] = [
      ["owned by another", { made: { ...own, owner: "S-1-5-21-9-9-9-1002" } }, /is owned by S-1-5-21-9-9-9-1002, not by this user, S-1-5-21-1-2-3-1001/],
      ["inheriting", { made: { ...own, protected: false } }, /takes its ACL from RaccoonVTT's folder/],
      ["Users too", { made: { ...own, rules: [...own.rules, rule(USERS, 0x1, 3)] } }, /has entries for .*S-1-5-32-545, not only full control/],
      ["no SYSTEM", { made: { ...own, rules: [own.rules[0]!, own.rules[2]!, rule(USERS, FULL, 3)] } }, /not only full control/],
      ["less than full control", { made: { ...own, rules: [rule(ME, 0x1f01bf, 3), own.rules[1]!, own.rules[2]!] } }, /not only full control/],
      ["not inherited by what is made in it", { made: { ...own, rules: [rule(ME, FULL, 0), own.rules[1]!, own.rules[2]!] } }, /not only full control/],
      ["a link", { made: { ...own, reparse: true } }, /is not a plain folder/],
      ["not made", { made: new Error("Access to the path is denied") }, /could not be made \(Access to the path is denied\)/],
      ["something already in it", { meanwhile: (f) => writeFile(join(f, "planted"), "x") }, /was not empty/],
      ["its key changed before the record named it", { linked: (f) => writeFile(join(f, "key"), "0".repeat(32)) }, /no longer holds its key/],
    ];
    for (const [what, o, why] of cases) {
      const deps = windows(s.programData, o);
      await assert.rejects(paths(s, deps), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed, what);
        assert.match(err.logLine, why, what);
        assert.ok(err.logLine.includes(deps.made[0]!), `${what}: names the folder`);
        assert.doesNotMatch(err.logLine, /[\u2014;]/);
        return true;
      });
      assert.equal(existsSync(s.record), false, `${what}: no record names it`);
    }
    assert.equal(folderProblem(own, ME), null, "this user's own is fine");
  });

  test("the program folder is given by its path or its short path, never a junction", async () => {
    const s = await setup();
    const latin = join(s.root, "Programmes à moi", "postgres");
    const cyrillic = join(s.root, "Программы", "postgres");
    for (const dir of [latin, cyrillic]) await mkdir(dir, { recursive: true });
    const data = join(s.root, "data");
    assert.equal((await pgPaths({ data, program: latin }, join(data, "x.json"), "win32", windows(s.programData))).map(join(latin, "bin")), join(latin, "bin"));
    const short = join(s.root, "PROGRA~1", "postgres");
    assert.equal((await pgPaths({ data, program: cyrillic }, join(data, "x.json"), "win32", windows(s.programData, { short: { [cyrillic]: short } }))).map(join(cyrillic, "bin")), join(short, "bin"));
    const deps = windows(s.programData);
    await assert.rejects(pgPaths({ data, program: cyrillic }, join(data, "x.json"), "win32", deps), /Install RaccoonVTT in a folder whose path has none of those letters/);
    assert.deepEqual(deps.made, []);
  });

  test("a name under a folder that isn't ASCII is a bug, never handed on", async () => {
    const s = await setup();
    const short = join(s.root, "SHORT");
    await symlink(dirname(s.data), short);
    const p = await paths(s, windows(s.programData, { short: { [s.data]: join(short, "data") } }));
    assert.throws(() => p.map(join(s.data, "Жук.log")), /not ASCII/);
  });
});

describe("Windows' readings", () => {
  test("a folder's reading parses, and anything it can't read says nothing fits", () => {
    assert.deepEqual(parseFolderReading('\uFEFF{"fits":false,"short":"C:\\\\Users\\\\8B4A~1\\\\AppData","shortFits":true}\r\n'), {
      fits: false,
      short: "C:\\Users\\8B4A~1\\AppData",
      shortFits: true,
    });
    assert.deepEqual(parseFolderReading('{"fits":true,"short":"","shortFits":false}'), { fits: true, short: null, shortFits: false });
    assert.deepEqual(parseFolderReading('{"fits":false,"short":"","shortFits":true}'), { fits: false, short: null, shortFits: false }, "no short path never fits");
    assert.deepEqual(parseFolderReading(""), { fits: false, short: null, shortFits: false });
  });

  test("Get-Acl's facts parse, a list of one included, and whatever is missing reads as the safe answer", () => {
    const one = parseAclFacts({ exists: true, directory: true, reparse: false, owner: ADMINS, protected: true, rules: { sid: SYSTEM, rights: FULL, inherit: 3, propagate: 0, allow: true, inherited: false } });
    assert.deepEqual(one.rules, [rule(SYSTEM, FULL, 3)]);
    assert.deepEqual(parseAclFacts({}), { exists: false, directory: false, reparse: true, owner: null, protected: false, rules: [] });
    assert.deepEqual(parseAclFacts({ exists: true, rules: [{ sid: USERS }] }).rules, [{ sid: USERS, rights: 0, inherit: 0, propagate: 0, allow: false, inherited: true }]);
    assert.deepEqual(parseAclFacts(null).exists, false);
  });
});

describe("the cluster", { skip: platform === "win32" && "the stand-in programs are shell scripts" }, () => {
  test("hands PostgreSQL's programs only the paths it is given for them", async () => {
    const s = await setup();
    const alias = join(s.root, "ALIAS");
    await symlink(s.data, alias);
    const bin = join(s.program, "bin");
    await mkdir(bin);
    const calls = join(s.root, "calls");
    for (const name of ["initdb", "pg_ctl", "pg_dump", "pg_restore"]) {
      // Each stand-in logs its arguments, and initdb and pg_ctl do to the folder what the real ones would.
      await writeFile(
        join(bin, name),
        `#!/bin/sh\necho "${name} $0 $*" >> '${calls}'\nfor a in "$@"; do case "$a" in --pgdata=*) d="\${a#--pgdata=}"; mkdir -p "$d"; echo 17 > "$d/PG_VERSION"; touch "$d/postgresql.conf";; esac; done\nif [ "$1" = start ]; then printf '%s\\n%s\\n%s\\n5999\\n' "$RVTT_FAKE_PID" "$3" "$(date +%s)" > "$3/postmaster.pid"; fi\nif [ "$1" = stop ]; then rm -f "$3/postmaster.pid"; fi\n`,
        { mode: 0o755 },
      );
    }
    const re = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const binAlias = join(s.root, "PGALIAS");
    await symlink(s.program, binAlias);
    const map = (p: string) => p.replace(s.data, alias).replace(s.program, binAlias);
    const c = new Cluster({
      binDir: bin,
      pgData: join(s.data, "postgres"),
      logFile: join(s.data, "logs", "postgres.log"),
      password: "pw",
      platform: "darwin",
      pickPort: async () => 41658,
      pgPath: map,
      proc: { stamp: async () => 1, facts: async () => ({ exe: null, cwd: null, uid: null, start: null }), bootId: async () => "", uid: null },
    });
    await mkdir(join(s.data, "logs"));
    await c.init();
    process.env.RVTT_FAKE_PID = String(process.pid);
    try {
      await c.start();
    } finally {
      delete process.env.RVTT_FAKE_PID;
    }
    await c.client("pg_dump", [`--file=${c.pgPath(join(s.data, "backups", "x.dump.part"))}`]);
    await c.readDump([c.pgPath(join(s.data, "backups", "x.dump.part"))]);
    await c.stop();
    const lines = (await readFile(calls, "utf8")).trim().split("\n");
    assert.deepEqual(
      lines.map((l) => l.split(" ")[0]),
      ["initdb", "pg_ctl", "pg_dump", "pg_restore", "pg_ctl"],
    );
    assert.ok(lines.every((l) => !l.includes("Жук")), lines.join("\n"));
    assert.ok(lines.every((l) => l.split(" ")[1]!.startsWith(join(binAlias, "bin"))), "each program by its given path");
    assert.match(lines[0]!, new RegExp(`--pgdata=${re(alias)}/postgres\\.init-[0-9a-f]+ .*--pwfile=${re(alias)}/postgres-pw-[0-9a-f]+ `));
    assert.match(lines[1]!, new RegExp(`^pg_ctl \\S+ start -D ${re(alias)}/postgres -l ${re(alias)}/logs/postgres\\.log `));
    assert.match(lines[2]!, new RegExp(`--file=${re(alias)}/backups/x\\.dump\\.part`));
    assert.match(lines[4]!, new RegExp(`^pg_ctl \\S+ stop -D ${re(alias)}/postgres `));
    assert.ok(existsSync(join(s.data, "postgres", "PG_VERSION")), "the cluster is made in the data folder itself");
  });
});
