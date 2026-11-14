import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DATA_DIR_ENV, Platform } from "../contract.ts";
import { parseFolderReading, parseWhoamiSid, pgPaths, type FolderReading, type PgPathDeps } from "./pgPaths.ts";
import { Cluster, DatabaseFailed } from "./postgres.ts";

/**
 * Which path PostgreSQL's programs get for a folder on Windows, with a
 * stand-in code page in place of Windows' own: Latin-1, as cp1252 holds,
 * so é fits and Ж doesn't. Junctions are symlinks here, which read back the
 * same way. desktop.yml's Windows smoke test runs the real ones.
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

const latin1 = (path: string) => [...path].every((c) => c.codePointAt(0)! <= 0xff);

/**
 * A Windows with a Latin-1 code page and the short names given. Each reading
 * and each folder restricted is counted. `meanwhile` is what another user
 * does to a new folder before its ACL shuts them out.
 */
function windows(
  programData: string | undefined,
  shortNames: Record<string, string> = {},
  meanwhile: (folder: string) => Promise<void> = async () => {},
): PgPathDeps & { reads: string[]; restricted: string[] } {
  const reads: string[] = [];
  const restricted: string[] = [];
  return {
    reads,
    restricted,
    programData,
    restrict: async (folder) => {
      await meanwhile(folder);
      restricted.push(folder);
    },
    read: async (path): Promise<FolderReading> => {
      reads.push(path);
      const short = shortNames[path] ?? null;
      return { fits: latin1(path), short, shortFits: short !== null && latin1(short) };
    },
  };
}

/** A data folder under a name with é and Ж, and a program folder whose path is ASCII. */
async function setup(): Promise<{ root: string; data: string; program: string; record: string; programData: string }> {
  const root = await folder();
  const data = join(root, "RaccoonVTT Tést Жук", "data");
  const program = join(root, "Program Files", "RaccoonVTT", "resources", "postgres");
  const programData = join(root, "ProgramData");
  for (const dir of [data, program, programData]) await mkdir(dir, { recursive: true });
  return { root, data, program, record: join(data, "postgres-link.json"), programData };
}

describe("the paths PostgreSQL's programs are given", () => {
  test("on macOS and Linux each is the path itself, and nothing is read", async () => {
    const s = await setup();
    const deps = windows(s.programData);
    for (const on of ["darwin", "linux"] satisfies Platform[]) {
      const paths = await pgPaths({ data: s.data, program: s.program }, s.record, on, deps);
      assert.equal(paths.map(join(s.data, "postgres")), join(s.data, "postgres"));
    }
    assert.deepEqual(deps.reads, []);
  });

  test("on Windows a path the code page holds is given as it is: ASCII without asking, é once Windows says it fits", async () => {
    const s = await setup();
    const deps = windows(s.programData);
    const data = join(s.root, "Données de José");
    const paths = await pgPaths({ data, program: s.program }, s.record, "win32", deps);
    assert.deepEqual(deps.reads, [data], "the ASCII program folder is never read");
    assert.equal(paths.map(join(data, "postgres")), join(data, "postgres"));
    assert.deepEqual(paths.notes, []);
    assert.deepEqual(await readdir(s.programData), [], "no junction");
  });

  test("a path with a letter outside the code page is given by its 8.3 short path, when that fits", async () => {
    const s = await setup();
    const short = join(s.root, "RACCOO~1", "data");
    const paths = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", windows(s.programData, { [s.data]: short }));
    assert.equal(paths.map(s.data), short);
    assert.equal(paths.map(join(s.data, "postgres")), join(short, "postgres"));
    assert.equal(paths.map(join(s.data, "logs", "postgres.log")), join(short, "logs", "postgres.log"));
    assert.equal(paths.map(join(s.program, "bin")), join(s.program, "bin"), "the program folder fits as it is");
    assert.equal(paths.map(join(s.root, "elsewhere")), join(s.root, "elsewhere"), "a path in neither folder is left alone");
    assert.match(paths.notes.join("\n"), /by its short path/);
    assert.deepEqual(await readdir(s.programData), []);
  });

  test("with no short name that fits, a junction in a folder of its own in ProgramData, the same one from start to start", async () => {
    const s = await setup();
    // A short name with a letter the code page lacks, as when 8.3 names are off and Windows hands back the long one.
    const deps = windows(s.programData, { [s.data]: s.data });
    const first = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps);
    const [made] = await readdir(s.programData);
    assert.match(made ?? "", /^RaccoonVTT-[0-9a-f]{16}$/);
    const folderMade = join(s.programData, made!);
    assert.deepEqual(deps.restricted, [folderMade], "its ACL shut other users out");
    const link = join(folderMade, "data");
    assert.equal(first.map(join(s.data, "postgres")), join(link, "postgres"));
    assert.equal(await readlink(link), s.data);
    await writeFile(join(s.data, "probe"), "through the junction");
    assert.equal(await readFile(join(link, "probe"), "utf8"), "through the junction");
    const recorded = JSON.parse(await readFile(s.record, "utf8")) as { folder: string; key: string };
    assert.equal(recorded.folder, folderMade);
    assert.equal(await readFile(join(folderMade, "key"), "utf8"), recorded.key);
    assert.match(recorded.key, /^[0-9a-f]{32}$/);
    assert.match(first.notes.join("\n"), /through the junction/);

    const again = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps);
    assert.equal(again.map(join(s.data, "postgres")), join(link, "postgres"), "the same path, so PostgreSQL's shared memory keeps its name");
    assert.deepEqual(await readdir(s.programData), [made]);
    assert.equal(deps.restricted.length, 1, "a folder reused is not made again");

    await rm(folderMade, { recursive: true });
    const remade = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps);
    assert.notEqual(remade.map(s.data), link, "a recorded folder that is gone is never made again by its name, which another user could have taken");
    assert.equal(await readlink(remade.map(s.data)), s.data);
  });

  test("a program folder PostgreSQL can't open gets its junction in the same folder", async () => {
    const s = await setup();
    const program = join(s.root, "Программы", "RaccoonVTT", "resources", "postgres");
    await mkdir(program, { recursive: true });
    const paths = await pgPaths({ data: s.data, program }, s.record, "win32", windows(s.programData));
    const [made] = await readdir(s.programData);
    assert.equal(paths.map(join(program, "bin")), join(s.programData, made!, "postgres", "bin"));
    assert.equal(paths.map(join(s.data, "postgres")), join(s.programData, made!, "data", "postgres"));
  });

  test("a new folder another user added to, or made a link, before its ACL shut them out is never used", async () => {
    const s = await setup();
    const theirs = await folder();
    let turn = 0;
    const deps = windows(s.programData, {}, async (made) => {
      turn++;
      if (turn === 1) await mkdir(join(made, "data"));
      if (turn === 2) {
        await rm(made, { recursive: true });
        await symlink(theirs, made);
      }
    });
    const paths = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps);
    assert.equal(deps.restricted.length, 3, "a third folder");
    assert.equal(paths.map(s.data), join(deps.restricted[2]!, "data"));
    assert.equal(await readlink(paths.map(s.data)), s.data);
    assert.deepEqual(await readdir(theirs), [], "nothing was written through the other user's link");
    assert.equal((JSON.parse(await readFile(s.record, "utf8")) as { folder: string }).folder, deps.restricted[2]);

    const shut = windows(s.programData, {}, async () => {
      throw new Error("icacls failed");
    });
    await rm(s.record);
    await assert.rejects(pgPaths({ data: s.data, program: s.program }, s.record, "win32", shut), (err: unknown) => err instanceof DatabaseFailed && /icacls failed/.test(err.logLine));
  });

  test("a recorded folder is used only in ProgramData, by the app's name, as a plain folder holding the record's key, with junctions that lead to the folders", async () => {
    const s = await setup();
    const deps = windows(s.programData);
    const elsewhere = await folder();
    const key = "0123456789abcdef0123456789abcdef";
    const make = async (dir: string, data: (link: string) => Promise<void>, withKey = key) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "key"), withKey);
      await data(join(dir, "data"));
      return dir;
    };
    const right = (link: string) => symlink(s.data, link);
    const cases: [string, string][] = [
      ["its junction leads elsewhere", await make(join(s.programData, "RaccoonVTT-00000000000000aa"), (l) => symlink(elsewhere, l))],
      ["a plain folder where the junction should be", await make(join(s.programData, "RaccoonVTT-00000000000000bb"), (l) => mkdir(l).then(() => {}))],
      ["outside ProgramData", await make(join(elsewhere, "RaccoonVTT-00000000000000cc"), right)],
      ["not the app's name", await make(join(s.programData, "Something-else"), right)],
      ["another key, as in a folder someone else made by that name", await make(join(s.programData, "RaccoonVTT-00000000000000dd"), right, "ffffffffffffffffffffffffffffffff")],
    ];
    const linkTo = await make(join(elsewhere, "keyed"), right);
    const asLink = join(s.programData, "RaccoonVTT-00000000000000ee");
    await symlink(linkTo, asLink);
    cases.push(["a link to a folder that holds the key", asLink]);
    for (const [what, recorded] of cases) {
      await writeFile(s.record, `${JSON.stringify({ folder: recorded, key })}\n`);
      const used = (await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps)).map(s.data);
      assert.notEqual(used, join(recorded, "data"), what);
      assert.equal(await readlink(used), s.data, `${what}: a new folder of its own`);
      assert.notEqual((JSON.parse(await readFile(s.record, "utf8")) as { folder: string }).folder, recorded, what);
    }
    assert.equal(await readlink(join(cases[0]![1], "data")), elsewhere, "and the one that led elsewhere is left as it was");
    const good = await make(join(s.programData, "RaccoonVTT-00000000000000ff"), right);
    await writeFile(s.record, `${JSON.stringify({ folder: good, key })}\n`);
    assert.equal((await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps)).map(s.data), join(good, "data"), "one that passes is used");
    for (const text of ["not json", JSON.stringify({ folder: good }), JSON.stringify({ folder: good, key: "short" })]) {
      await writeFile(s.record, text);
      assert.notEqual((await pgPaths({ data: s.data, program: s.program }, s.record, "win32", deps)).map(s.data), join(good, "data"), `a record that does not read: ${text}`);
    }
  });

  test("with no ProgramData to use, the start stops with words that name the folder and what to do", async () => {
    const s = await setup();
    const named = join(s.root, "Данные");
    await mkdir(named);
    for (const programData of [undefined, "ProgramData", named]) {
      await assert.rejects(pgPaths({ data: s.data, program: s.program }, s.record, "win32", windows(programData)), (err: unknown) => {
        assert.ok(err instanceof DatabaseFailed);
        assert.ok(err.logLine.includes(s.data));
        assert.ok(err.logLine.includes(DATA_DIR_ENV));
        assert.doesNotMatch(err.logLine, /[\u2014;]/);
        return true;
      });
    }
    assert.deepEqual(await readdir(named), [], "nothing made in a ProgramData PostgreSQL couldn't open either");
    const program = join(s.root, "Программы");
    await mkdir(program);
    await assert.rejects(pgPaths({ data: join(s.root, "data"), program }, s.record, "win32", windows(undefined)), /Install RaccoonVTT in a folder/);
  });

  test("a name under a folder that isn't ASCII is a bug, never handed on", async () => {
    const s = await setup();
    const paths = await pgPaths({ data: s.data, program: s.program }, s.record, "win32", windows(s.programData, { [s.data]: join(s.root, "SHORT") }));
    assert.throws(() => paths.map(join(s.data, "Жук.log")), /not ASCII/);
  });
});

describe("Windows' reading of a folder", () => {
  test("parses, and anything it can't read says nothing fits, so the folder gets a junction", () => {
    assert.deepEqual(parseFolderReading('\uFEFF{"fits":false,"short":"C:\\\\Users\\\\8B4A~1\\\\AppData","shortFits":true}\r\n'), {
      fits: false,
      short: "C:\\Users\\8B4A~1\\AppData",
      shortFits: true,
    });
    assert.deepEqual(parseFolderReading('{"fits":true,"short":"","shortFits":false}'), { fits: true, short: null, shortFits: false });
    assert.deepEqual(parseFolderReading('{"fits":false,"short":"","shortFits":true}'), { fits: false, short: null, shortFits: false }, "no short path never fits");
    assert.deepEqual(parseFolderReading(""), { fits: false, short: null, shortFits: false });
    assert.deepEqual(parseFolderReading("Get-CimInstance : Access denied"), { fits: false, short: null, shortFits: false });
  });

  test("this user's SID comes from whoami's line, whatever its code page did to the name", () => {
    assert.equal(parseWhoamiSid('"desktop-7\\\x8a\x7e\x8d","S-1-5-21-3623811015-3361044348-30300820-1013"\r\n'), "S-1-5-21-3623811015-3361044348-30300820-1013");
    assert.equal(parseWhoamiSid('"ci\\runneradmin","S-1-5-21-1-2-3-500"'), "S-1-5-21-1-2-3-500");
    assert.equal(parseWhoamiSid("ERROR: access denied"), null);
    assert.equal(parseWhoamiSid('"x","S-1-5-21-1-2-3-500" "y"'), null);
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
