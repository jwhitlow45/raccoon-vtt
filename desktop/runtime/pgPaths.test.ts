import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { Platform } from "../contract.ts";
import { folderProblem, junctionName, parentProblem, parseAclFacts, parseFolderReading, pgPaths, type AclFacts, type AclRule, type FolderReading, type PgPathDeps } from "./pgPaths.ts";
import { Cluster, DatabaseFailed } from "./postgres.ts";

/**
 * Which path PostgreSQL's programs get for a folder on Windows, with
 * stand-ins for Windows' answers: a code page that holds Latin-1, as cp1252
 * does, short names as given, the ACLs Get-Acl would read, and the
 * canonical path realpathSync.native would give for the aliases a test
 * names. Junctions are symlinks here, which read back the same way.
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
const MISSING: AclFacts = { exists: false, directory: false, reparse: false, owner: null, protected: false, rules: [] };

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
 * A Windows with a Latin-1 code page and RaccoonVTT's folder in ProgramData
 * as its installer makes it. Each reading, folder made and look at an ACL is
 * counted. A folder on disk reads as this user's own unless `there` says
 * otherwise. `aliases` maps a path to the canonical path Windows would give.
 */
function windows(
  programData: string | undefined,
  o: {
    short?: Record<string, string>;
    read?: (path: string) => FolderReading;
    parent?: AclFacts | Error;
    there?: AclFacts | Error;
    made?: AclFacts | Error;
    meanwhile?: (folder: string) => Promise<void>;
    linked?: (folder: string) => Promise<void>;
    aliases?: Record<string, string>;
  } = {},
): Windows {
  const reads: string[] = [];
  const made: string[] = [];
  const inspected: string[] = [];
  const parent = programData ? join(programData, "RaccoonVTT") : null;
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
      if (path === parent) {
        if (o.parent instanceof Error) throw o.parent;
        return { user: ME, facts: o.parent ?? installers() };
      }
      if (o.there instanceof Error) throw o.there;
      return { user: ME, facts: existsSync(path) ? (o.there ?? mine()) : MISSING };
    },
    make: async (path) => {
      made.push(path);
      if (o.made instanceof Error) throw o.made;
      await mkdir(path);
      await o.meanwhile?.(path);
      return { user: ME, facts: o.made ?? mine() };
    },
    canonical: (path) => o.aliases?.[path] ?? realpathSync.native(path),
    ...(o.linked ? { linked: o.linked } : {}),
  };
}

type Setup = { root: string; data: string; program: string; record: string; programData: string; parent: string; link: string };

/** A data folder under a name with é and Ж, a program folder whose path is ASCII, and ProgramData with RaccoonVTT's folder. `link` is the junction the data folder gets. */
async function setup(): Promise<Setup> {
  const root = await folder();
  const data = join(root, "RaccoonVTT Tést Жук", "data");
  const program = join(root, "Program Files", "RaccoonVTT", "resources", "postgres");
  const programData = join(root, "ProgramData");
  const parent = join(programData, "RaccoonVTT");
  for (const dir of [data, program, parent]) await mkdir(dir, { recursive: true });
  return { root, data, program, record: join(data, "postgres-link.json"), programData, parent, link: join(parent, junctionName(ME, data), "data") };
}

const record = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
const given = (s: { program: string; record: string }, data: string, deps: PgPathDeps) => pgPaths({ data, program: s.program }, s.record, "win32", deps);
const paths = (s: Setup, deps: PgPathDeps) => given(s, s.data, deps);

const refusal = (why: RegExp, also: RegExp | null = null) => (err: unknown) => {
  assert.ok(err instanceof DatabaseFailed, String(err));
  assert.match(err.logLine, why);
  if (also) assert.match(err.logLine, also);
  assert.doesNotMatch(err.logLine, /[\u2014;]/);
  return true;
};

describe("the path PostgreSQL is given for the data folder", () => {
  test("on macOS and Linux it is the path itself, and nothing is read or recorded", async () => {
    const s = await setup();
    const deps = windows(s.programData);
    for (const on of ["darwin", "linux"] satisfies Platform[]) {
      const p = await pgPaths({ data: s.data, program: s.program }, s.record, on, deps);
      assert.equal(p.map(join(s.data, "postgres")), join(s.data, "postgres"));
    }
    assert.deepEqual([deps.reads, deps.inspected], [[], []]);
    assert.equal(existsSync(s.record), false);
  });

  test("an ASCII folder is given by its canonical path, never the alias the start was handed, and nothing is recorded", async () => {
    const s = await setup();
    const data = join(s.root, "data");
    await mkdir(data);
    const alias = join(s.root, "alias");
    await symlink(data, alias);
    const deps = windows(s.programData);
    for (const handed of [data, alias]) {
      const p = await pgPaths({ data: handed, program: s.program }, join(handed, "postgres-link.json"), "win32", deps);
      assert.equal(p.map(join(handed, "postgres")), join(data, "postgres"), handed);
    }
    assert.deepEqual([deps.reads, deps.made], [[], []], "Windows is asked nothing");
    assert.equal(existsSync(join(data, "postgres-link.json")), false);
    const prefixed = windows(s.programData, { aliases: { [data]: `\\\\?\\${data}` } });
    assert.equal((await pgPaths({ data, program: s.program }, join(data, "postgres-link.json"), "win32", prefixed)).map(data), data, "without Windows' \\\\?\\ prefix");
  });

  test("any other folder is given a junction named for this user and its canonical path, and the code page is never asked", async () => {
    const s = await setup();
    const deps = windows(s.programData, { read: () => assert.fail("the data folder is never read against the code page") });
    const p = await paths(s, deps);
    assert.equal(p.map(join(s.data, "postgres")), join(s.link, "postgres"));
    assert.equal(await readlink(s.link), s.data);
    const r = await record(s.record);
    assert.deepEqual([r.data, r.how, r.folder], [s.data, "junction", dirname(s.link)]);
    assert.equal(await readFile(join(dirname(s.link), "key"), "utf8"), r.key);
    assert.deepEqual(deps.made, [dirname(s.link)], "made with its security descriptor, never by mkdir");
    assert.deepEqual(deps.inspected, [s.parent, dirname(s.link)], "the installer's folder is read first, then the name is looked for");
    await writeFile(join(s.data, "probe"), "through the junction");
    assert.equal(await readFile(join(s.link, "probe"), "utf8"), "through the junction");
    const latin = join(s.root, "Données de José");
    await mkdir(latin);
    const fits = await given({ program: s.program, record: join(latin, "postgres-link.json") }, latin, windows(s.programData));
    assert.equal(fits.map(latin), join(s.parent, junctionName(ME, latin), "data"), "a path the code page holds gets one too, so no reading decides");
  });

  test("every way a start could be handed the folder, or find its record, gives the same path", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    await mkdir(join(s.data, "postgres"));
    const kept = await readFile(s.record, "utf8");
    const alias = join(s.root, "alias");
    await symlink(s.data, alias);
    const ways: [string, string, NonNullable<Parameters<typeof windows>[1]>, () => Promise<void>][] = [
      ["a symlink or junction to it", alias, {}, async () => {}],
      ["its 8.3 short name", join(s.root, "RACCOO~1", "data"), {}, async () => {}],
      ["a subst drive", "/X:/data", {}, async () => {}],
      ["another case", s.data.toUpperCase(), {}, async () => {}],
      ["a trailing separator", `${s.data}/`, {}, async () => {}],
      ["Windows' \\\\?\\ prefix", s.data, { aliases: { [s.data]: `\\\\?\\${s.data}` } }, async () => {}],
      ["a code page reading that now fits", s.data, { read: () => ({ fits: true, short: null, shortFits: false }) }, async () => {}],
      ["a code page reading that fails", s.data, { read: () => assert.fail("no reading") }, async () => {}],
      ["no record", s.data, {}, () => rm(s.record)],
      ["Windows' \\\\?\\ prefix with no record", s.data, { aliases: { [s.data]: `\\\\?\\${s.data}` } }, () => rm(s.record)],
      ["a record that doesn't read", s.data, {}, () => writeFile(s.record, "{")],
    ];
    for (const [what, handed, o, before] of ways) {
      await before();
      const aliases = { [handed]: s.data, ...o.aliases };
      const deps = windows(s.programData, { ...o, aliases });
      const p = await given(s, handed, deps);
      assert.equal(p.map(join(handed, "postgres")), join(s.link, "postgres"), what);
      assert.deepEqual(deps.made, [], `${what}: nothing new made`);
      assert.equal(await readFile(s.record, "utf8"), kept, `${what}: the record says the same`);
    }
  });

  test("a moved or copied folder, whose record names another, gets its own path, and the old junction is left alone", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    await mkdir(join(s.data, "postgres"));
    const moved = join(s.root, "Перенесено", "data");
    await mkdir(dirname(moved));
    await writeFile(join(s.data, "postgres", "PG_VERSION"), "17\n");
    await rename(s.data, moved);
    const deps = windows(s.programData);
    const p = await given({ program: s.program, record: join(moved, "postgres-link.json") }, moved, deps);
    const link = join(s.parent, junctionName(ME, moved), "data");
    assert.equal(p.map(moved), link);
    assert.equal(await readlink(link), moved);
    assert.equal((await record(join(moved, "postgres-link.json"))).data, moved);
    assert.equal(await readlink(s.link), s.data, "the old junction, which leads nowhere now, is not changed");
  });

  test("an earlier build's record wins: direct gives its path exactly, whatever case the canonical path has now, and short while it leads here", async () => {
    const s = await setup();
    const data = join(s.root, "Données", "data");
    await mkdir(data, { recursive: true });
    const file = join(data, "postgres-link.json");
    const recordedAs = data.replace("Données", "DONNÉES");
    await writeFile(file, JSON.stringify({ data: recordedAs, how: "direct" }));
    const deps = windows(s.programData);
    assert.equal((await given({ program: s.program, record: file }, data, deps)).map(data), recordedAs);
    const ascii = join(s.root, "Plain");
    await mkdir(ascii);
    await writeFile(join(ascii, "postgres-link.json"), JSON.stringify({ data: join(s.root, "PLAIN"), how: "direct" }));
    assert.equal((await given({ program: s.program, record: join(ascii, "postgres-link.json") }, ascii, deps)).map(ascii), join(s.root, "PLAIN"), "ASCII too: the record comes first");
    const short = join(s.root, "DONNEE~1");
    await symlink(dirname(data), short);
    await writeFile(file, JSON.stringify({ data, how: "short", path: join(short, "data") }));
    assert.equal((await given({ program: s.program, record: file }, data, deps)).map(data), join(short, "data"));
    assert.deepEqual([deps.reads, deps.made], [[], []]);
  });

  test("the recorded junction's folder, gone, is made again by the same name, so the database keeps its path", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    await mkdir(join(s.data, "postgres"));
    await rm(dirname(s.link), { recursive: true });
    const deps = windows(s.programData);
    const p = await paths(s, deps);
    assert.equal(p.map(s.data), s.link);
    assert.deepEqual(deps.made, [dirname(s.link)]);
    assert.equal(await readlink(s.link), s.data);
  });

  test("with no record that reads, a database is given only the junction already there, which is recorded again", async () => {
    const s = await setup();
    await paths(s, windows(s.programData));
    await mkdir(join(s.data, "postgres"));
    const key = await readFile(join(dirname(s.link), "key"), "utf8");
    await rm(s.record);
    await rm(join(dirname(s.link), "key"));
    const deps = windows(s.programData);
    assert.equal((await paths(s, deps)).map(s.data), s.link);
    const r = await record(s.record);
    assert.deepEqual([r.data, r.folder], [s.data, dirname(s.link)]);
    assert.notEqual(r.key, key, "a lost key is made again in this user's folder");
    assert.deepEqual(deps.made, []);

    await rm(s.record);
    await rm(s.link);
    const unlinked = windows(s.programData);
    await assert.rejects(paths(s, unlinked), refusal(/is not there either/), "a folder whose junction is gone is no junction that is there");
    assert.equal(existsSync(s.link), false, "and its junction is not made again");
    await rm(dirname(s.link), { recursive: true });
    const none = windows(s.programData);
    await assert.rejects(paths(s, none), refusal(/postgres-link\.json, which says how PostgreSQL was given it, is gone or doesn't read, and the junction it would be given, .* is not there either/, /Put postgres-link\.json back from a copy/));
    assert.deepEqual(none.made, [], "never a new path");
    assert.equal(existsSync(s.record), false);
  });

  test("a folder of that name that is not this user's alone, or whose junction leads elsewhere, stops the start and is never used", async () => {
    const s = await setup();
    const elsewhere = await folder();
    const cases: [string, () => Promise<void>, NonNullable<Parameters<typeof windows>[1]>, RegExp][] = [
      ["another user made it first", () => mkdir(dirname(s.link)).then(() => {}), { there: { ...mine("S-1-5-21-9-9-9-1002") } }, /is there but is owned by S-1-5-21-9-9-9-1002, not by this user/],
      ["its ACL is not only this user's", () => mkdir(dirname(s.link)).then(() => {}), { there: { ...mine(), rules: [...mine().rules, rule(USERS, 0x1, 3)] } }, /is there but has entries for/],
      ["it can't be read", () => mkdir(dirname(s.link)).then(() => {}), { there: new Error("Access is denied") }, /is there but could not be read \(Access is denied\)/],
      ["its junction leads elsewhere", () => mkdir(dirname(s.link)).then(() => symlink(elsewhere, s.link)), {}, /is there but its junction leads to /],
    ];
    for (const [what, plant, o, why] of cases) {
      await rm(dirname(s.link), { recursive: true, force: true });
      await rm(s.record, { force: true });
      await plant();
      const deps = windows(s.programData, o);
      await assert.rejects(paths(s, deps), refusal(why, /an administrator can remove it/));
      assert.deepEqual(deps.made, [], `${what}: never another path`);
      assert.equal(existsSync(s.record), false, what);
    }
    await mkdir(join(s.data, "postgres"));
    await rm(dirname(s.link), { recursive: true, force: true });
    await paths(s, windows(s.programData)).catch(() => undefined);
    assert.equal(existsSync(dirname(s.link)), false, "with a database and no record, a missing folder is not made");
  });

  test("an earlier build's record that no longer leads here stops a start whose folder holds a database", async () => {
    const s = await setup();
    await mkdir(join(s.data, "postgres"));
    await writeFile(s.record, JSON.stringify({ data: s.data, how: "short", path: join(s.root, "GONE~1", "data") }));
    await assert.rejects(paths(s, windows(s.programData)), refusal(/the short name is gone/, /Make .* lead to this folder again/));
    const old = join(s.parent, "0123456789abcdef");
    await writeFile(s.record, JSON.stringify({ data: s.data, how: "junction", folder: old, key: "a".repeat(32) }));
    await assert.rejects(paths(s, windows(s.programData)), refusal(/0123456789abcdef is gone, no longer holds its key, or its junction leads elsewhere/));
    // There, leading here, but with another key: not the folder the record names.
    await mkdir(old);
    await symlink(s.data, join(old, "data"));
    await writeFile(join(old, "key"), "b".repeat(32));
    await assert.rejects(paths(s, windows(s.programData)), refusal(/no longer holds its key/));
    await writeFile(join(old, "key"), "a".repeat(32));
    assert.equal((await paths(s, windows(s.programData))).map(s.data), join(old, "data"), "and with its key it is the database's path");
    await rm(old, { recursive: true });
    await rm(join(s.data, "postgres"), { recursive: true });
    assert.equal((await paths(s, windows(s.programData))).map(s.data), s.link, "with no database yet, the path is chosen again");
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
      await assert.rejects(paths(s, deps), refusal(why, /Reinstall RaccoonVTT, or set RACCOON_DATA_DIR/));
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
    const cases: [string, NonNullable<Parameters<typeof windows>[1]>, RegExp][] = [
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
      await rm(dirname(s.link), { recursive: true, force: true });
      const deps = windows(s.programData, o);
      await assert.rejects(paths(s, deps), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed, what);
        assert.match(err.logLine, why, what);
        assert.ok(err.logLine.includes(dirname(s.link)), `${what}: names the folder`);
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
    await mkdir(data);
    assert.equal((await pgPaths({ data, program: latin }, join(data, "x.json"), "win32", windows(s.programData))).map(join(latin, "bin")), join(latin, "bin"));
    const short = join(s.root, "PROGRA~1", "postgres");
    assert.equal((await pgPaths({ data, program: cyrillic }, join(data, "x.json"), "win32", windows(s.programData, { short: { [cyrillic]: short } }))).map(join(cyrillic, "bin")), join(short, "bin"));
    const deps = windows(s.programData);
    await assert.rejects(pgPaths({ data, program: cyrillic }, join(data, "x.json"), "win32", deps), /Install RaccoonVTT in a folder whose path has none of those letters/);
    assert.deepEqual(deps.made, []);
  });

  test("a name under a folder that isn't ASCII is a bug, never handed on", async () => {
    const s = await setup();
    const p = await paths(s, windows(s.programData));
    assert.throws(() => p.map(join(s.data, "Жук.log")), /not ASCII/);
  });

  test("the junction's folder's name is the same for every case of the path, and another for another user or folder", () => {
    assert.equal(junctionName(ME, "C:\\Users\\Жук\\Data"), junctionName(ME, "c:\\users\\жук\\data"));
    assert.notEqual(junctionName(ME, "C:\\Users\\Жук\\Data"), junctionName("S-1-5-21-9-9-9-1002", "C:\\Users\\Жук\\Data"));
    assert.notEqual(junctionName(ME, "C:\\Users\\Жук\\Data"), junctionName(ME, "C:\\Users\\Жук\\Data2"));
    assert.match(junctionName(ME, "x"), /^[0-9a-f]{16}$/);
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
