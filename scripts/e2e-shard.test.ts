import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("a shard of --only", () => {
  let dir = "";
  before(() => {
    // The script in a folder of its own, with one e2e file that macos-only.json leaves alone.
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-shard-only-"));
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "e2e"));
    mkdirSync(path.join(dir, "dist"));
    for (const f of ["e2e-shard.ts", "e2e-shard-plan.ts", "e2e-join-counts.ts"]) copyFileSync(path.join(ROOT, "scripts", f), path.join(dir, "scripts", f));
    copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
    symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "dist/index.html"), "<!doctype html>\n");
    writeFileSync(path.join(dir, "e2e/macos-only.json"), JSON.stringify({ rule: "none", files: {} }));
    writeFileSync(path.join(dir, "e2e/durations.json"), JSON.stringify({ defaultSeconds: 5, seconds: {} }));
    writeFileSync(path.join(dir, "e2e/quick.e2e.ts"), 'import { test } from "node:test";\ntest("passes", () => {});\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** The shard script's exit code and output, with a database nothing listens on, since these runs end before any file starts. */
  function shard(...args: string[]): { code: number | null; output: string } {
    const r = spawnSync(process.execPath, ["scripts/e2e-shard.ts", ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, DATABASE_URL: "postgres://raccoon:raccoon@127.0.0.1:1/raccoon", E2E_SCREENSHOT_DIR: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { code: r.status, output: r.stdout + r.stderr };
  }

  test("fails when what it names leaves the shard nothing to run, as a file dropped for macOS would", () => {
    const r = shard("1", "1", "--macos-only", "--only", "quick");
    assert.equal(r.code, 2, r.output);
    assert.match(r.output, /--only quick leaves shard 1 of 1 no files to run/);
  });

  test("fails on a shard its files do not reach", () => {
    const r = shard("2", "2", "--only", "quick");
    assert.equal(r.code, 2, r.output);
    assert.match(r.output, /leaves shard 2 of 2 no files to run/);
  });

  test("fails when it names a file that does not exist", () => {
    const r = shard("1", "1", "--only", "missing");
    assert.equal(r.code, 2, r.output);
    assert.match(r.output, /--only names missing, which is not an e2e file/);
  });

  test("lists an empty shard without failing, since a list runs nothing", () => {
    assert.equal(shard("1", "1", "--macos-only", "--only", "quick", "--list").code, 0);
  });
});
