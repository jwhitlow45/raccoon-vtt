import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { binFolders, copyStaged, defaultOut, leftOut, outProblem, STAGED, symlinksIn } from "./stage.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoonvtt-stage-test-"));
  made.push(dir);
  return dir;
}

describe("what the stage leaves out", () => {
  for (const rel of ["server/rooms/actor.test.ts", "server/http/rooms.itest.ts", "dist/assets/index-abc.js.map", "server/.env", "server/.env.local", "db/.envrc", "scripts/key.pem", "shared/x.key", "server/node_modules", "dist/.DS_Store", "scripts/run.log"]) {
    test(`leaves out ${rel}`, () => assert.equal(leftOut(rel), true));
  }
  for (const rel of ["server/main.ts", "server/rooms/actor.ts", "dist/assets/index-abc.js", "dist/index.html", "scripts/admin.ts", "db/schema.sql", "desktop/runtime/main.ts", "desktop/contract.ts", "shared/srd/NOTICE.md", "scripts/map.ts", "server/testing.ts"]) {
    test(`keeps ${rel}`, () => assert.equal(leftOut(rel), false));
  }

  test("copies what the image's runtime holds, the lockfile and workspace file for a frozen install, and the supervisor", () => {
    assert.deepEqual([...STAGED], ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "server", "shared", "scripts", "db", "dist", "desktop/runtime", "desktop/contract.ts"]);
  });

  test("copies a tree without its tests or the bundle's maps", () => {
    const root = scratch();
    const out = scratch();
    for (const [rel, text] of Object.entries({ "server/main.ts": "a", "server/main.test.ts": "t", "server/rooms/a.itest.ts": "t", "server/rooms/a.ts": "b", "dist/index.js": "c", "dist/index.js.map": "m" })) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    assert.equal(copyStaged(root, out, "server") + copyStaged(root, out, "dist"), 3);
    const files = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(out, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
      .toSorted();
    assert.deepEqual(files, ["dist/index.js", "server/main.ts", "server/rooms/a.ts"]);
  });

  test("refuses a symlink in the source", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, () => {
    const root = scratch();
    mkdirSync(path.join(root, "server"));
    writeFileSync(path.join(root, "server/main.ts"), "a");
    symlinkSync(path.join(root, "server/main.ts"), path.join(root, "server/link.ts"));
    assert.throws(() => copyStaged(root, scratch(), "server"), /server\/link\.ts is a symlink/);
  });
});

describe("where the stage goes", () => {
  const root = path.resolve("/work/raccoon-vtt");
  const none = () => false;

  test("defaults to the job's temp folder on CI, else the system's", () => {
    assert.equal(defaultOut({ RUNNER_TEMP: path.resolve("/runner/_temp") }), path.join(path.resolve("/runner/_temp"), "raccoonvtt-stage", "app-server"));
    assert.equal(defaultOut({}), path.join(tmpdir(), "raccoonvtt-stage", "app-server"));
  });

  test("refuses a folder inside the repository, the repository itself, or one holding it", () => {
    for (const out of [path.join(root, "desktop/out/app-server"), root, path.dirname(root)]) {
      assert.match(outProblem(root, out, none) ?? "", /inside the repository or holds it/, out);
    }
  });

  test("refuses a folder with a lockfile, workspace, package.json or node_modules above it", () => {
    const out = path.resolve("/home/runner/_temp/raccoonvtt-stage/app-server");
    for (const name of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json", "node_modules"]) {
      const above = path.join(path.resolve("/home/runner"), name);
      assert.match(outProblem(root, out, (p) => p === above) ?? "", new RegExp(`${name.replace(".", "\\.")} is above`), name);
    }
    assert.equal(outProblem(root, out, (p) => p === path.join(out, "package.json")), null, "the stage's own files do not count");
    assert.equal(outProblem(root, out, none), null);
  });
});

describe("after the install", { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false }, () => {
  test("finds every node_modules/.bin folder, nested ones included", () => {
    const out = scratch();
    for (const dir of ["node_modules/.bin", "node_modules/a/node_modules/.bin", "node_modules/b/.bin", "server/.bin"]) mkdirSync(path.join(out, dir), { recursive: true });
    assert.deepEqual(binFolders(out).toSorted(), ["node_modules/.bin", "node_modules/a/node_modules/.bin"]);
  });

  test("finds every symlink left, to a file or a folder, at any depth", () => {
    const out = scratch();
    mkdirSync(path.join(out, "node_modules/a/lib"), { recursive: true });
    writeFileSync(path.join(out, "node_modules/a/lib/x.js"), "x");
    assert.deepEqual(symlinksIn(out), []);
    symlinkSync("lib/x.js", path.join(out, "node_modules/a/x.js"));
    symlinkSync(path.join(out, "node_modules/a"), path.join(out, "node_modules/b"));
    assert.deepEqual(symlinksIn(out).toSorted(), ["node_modules/a/x.js", "node_modules/b"]);
  });
});
