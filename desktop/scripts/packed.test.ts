import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { filesMissing, packedResources, stagedResources } from "./packed.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tree(files: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoonvtt-packed-test-"));
  made.push(dir);
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), rel);
  }
  return dir;
}

describe("the packed app's resources", () => {
  test("the staged server's node_modules is an entry of its own, so electron-builder never drops it", () => {
    const stage = path.join("stage", "app-server");
    assert.deepEqual(stagedResources(stage), [
      { from: stage, to: "app-server" },
      { from: path.join(stage, "node_modules"), to: "app-server/node_modules" },
    ]);
  });

  test("names electron-builder's unpacked folder for each target", () => {
    const dist = path.join("out", "dist");
    assert.equal(packedResources(dist, "darwin", "arm64"), path.join(dist, "mac-arm64", "RaccoonVTT.app", "Contents", "Resources"));
    assert.equal(packedResources(dist, "darwin", "x64"), path.join(dist, "mac", "RaccoonVTT.app", "Contents", "Resources"));
    assert.equal(packedResources(dist, "win32", "x64"), path.join(dist, "win-unpacked", "resources"));
    assert.equal(packedResources(dist, "linux", "x64"), path.join(dist, "linux-unpacked", "resources"));
    assert.equal(packedResources(dist, "linux", "arm64"), path.join(dist, "linux-arm64-unpacked", "resources"));
  });

  test("finds a staged file the pack left out, nested node_modules included", () => {
    const stage = tree(["server/main.ts", "node_modules/pg/package.json", "node_modules/a/node_modules/b/index.js"]);
    const packed = tree(["server/main.ts", "node_modules/pg/package.json"]);
    assert.deepEqual(filesMissing(stage, packed), ["node_modules/a/node_modules/b/index.js"]);
  });

  test("a top-level node_modules the pack dropped is every one of its files", () => {
    const stage = tree(["server/main.ts", "node_modules/pg/package.json", "node_modules/zod/index.js"]);
    const packed = tree(["server/main.ts"]);
    assert.deepEqual(filesMissing(stage, packed), ["node_modules/pg/package.json", "node_modules/zod/index.js"]);
  });

  test("git's placeholders, which electron-builder never copies, are not missed", () => {
    const stage = tree(["node_modules/a/test/.gitkeep", "node_modules/a/index.js"]);
    assert.deepEqual(filesMissing(stage, tree(["node_modules/a/index.js"])), []);
  });

  test("a folder never packed misses every file, and a whole copy misses none", () => {
    const from = tree(["LICENSE", "postgresql/COPYRIGHT"]);
    assert.deepEqual(filesMissing(from, path.join(from, "not-there")), ["LICENSE", "postgresql/COPYRIGHT"]);
    assert.deepEqual(filesMissing(from, tree(["LICENSE", "postgresql/COPYRIGHT", "extra.txt"])), []);
  });
});
