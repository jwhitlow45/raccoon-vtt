import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { dataIdentity, defaultDataDir, ensureDataDir, resolveDataDir } from "./dataDir.ts";

/** Where the data lives on each system, and the identity that names its lock (docs/design/design-v1-local-app.md 8.1). */

test("Windows keeps data in the local profile, not the roaming one", () => {
  assert.equal(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\dm\\AppData\\Local", APPDATA: "C:\\Users\\dm\\AppData\\Roaming" }, "C:\\Users\\dm"), "C:\\Users\\dm\\AppData\\Local\\RaccoonVTT\\data");
  // With no LOCALAPPDATA, the local profile's usual place under the home folder.
  assert.equal(defaultDataDir("win32", { APPDATA: "C:\\Users\\dm\\AppData\\Roaming" }, "C:\\Users\\dm"), "C:\\Users\\dm\\AppData\\Local\\RaccoonVTT\\data");
});

test("macOS keeps data in Application Support", () => {
  assert.equal(defaultDataDir("darwin", { XDG_DATA_HOME: "/Volumes/home/dm/xdg" }, "/Volumes/home/dm"), "/Volumes/home/dm/Library/Application Support/RaccoonVTT/data");
});

test("Linux follows an absolute XDG_DATA_HOME and ignores a relative one", () => {
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "/data/xdg" }, "/home/dm"), "/data/xdg/RaccoonVTT");
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "relative/xdg" }, "/home/dm"), "/home/dm/.local/share/RaccoonVTT");
  assert.equal(defaultDataDir("linux", {}, "/home/dm"), "/home/dm/.local/share/RaccoonVTT");
});

test("--data comes before RACCOON_DATA_DIR, which comes before the system's folder", () => {
  const env = { RACCOON_DATA_DIR: "/srv/env-data" };
  assert.equal(resolveDataDir("/srv/arg-data", "linux", env, "/home/dm"), "/srv/arg-data");
  assert.equal(resolveDataDir(undefined, "linux", env, "/home/dm"), "/srv/env-data");
  assert.equal(resolveDataDir(undefined, "linux", { RACCOON_DATA_DIR: "" }, "/home/dm"), "/home/dm/.local/share/RaccoonVTT");
  assert.equal(resolveDataDir(undefined, "win32", { RACCOON_DATA_DIR: "D:\\RVTT" }, "C:\\Users\\dm"), "D:\\RVTT");
});

let dir: string;
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "rvtt-datadir-")));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a symlink to the data folder has the folder's identity", async () => {
  const real = join(dir, "Data");
  await mkdir(real);
  // A junction needs no privilege on Windows, where a folder symlink does.
  await symlink(real, join(dir, "alias"), process.platform === "win32" ? "junction" : "dir");
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  assert.equal(dataIdentity(join(dir, "alias"), platform).hash, dataIdentity(real, platform).hash);
  assert.match(dataIdentity(real, platform).hash, /^[0-9a-f]{16}$/);
});

test("macOS and Windows fold case, Linux keeps it", () => {
  // A fake realpath, so this holds on any machine: two spellings of one folder.
  const realpath = (p: string) => p;
  assert.equal(dataIdentity("/Volumes/Home/DM/Data", "darwin", realpath).hash, dataIdentity("/volumes/home/dm/data", "darwin", realpath).hash);
  assert.equal(dataIdentity("C:\\Users\\DM\\Data", "win32", realpath).hash, dataIdentity("c:\\users\\dm\\data", "win32", realpath).hash);
  assert.notEqual(dataIdentity("/home/DM/data", "linux", realpath).hash, dataIdentity("/home/dm/data", "linux", realpath).hash);
});

test("the data folder is made with no access for others", { skip: process.platform === "win32" && "Windows keeps the profile's ACL" }, async () => {
  const target = join(dir, "made", "data");
  await ensureDataDir(target, process.platform === "darwin" ? "darwin" : "linux");
  assert.ok(existsSync(target));
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});
