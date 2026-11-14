import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.ts";
import { RotatingLog, lastLogLine, rotatedPath } from "./logs.ts";

/** settings.json (design 8.1) and the rotated logs. */

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rvtt-settings-"));
}

test("no settings.json gives the defaults: network play, update checks, the browser, animated maps and sound all on", async () => {
  const dir = await folder();
  const { settings, replaced } = await loadSettings(join(dir, "settings.json"), join(dir, "settings.json.bad"));
  assert.equal(replaced, false);
  assert.deepEqual(settings, { networkPlay: true, checkUpdates: true, openBrowser: true, animatedMaps: true, roomSound: true });
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  await rm(dir, { recursive: true });
});

test("a settings.json that does not read is kept as settings.json.bad and the defaults written in its place", async () => {
  for (const text of ["{ port: 3170", JSON.stringify({ port: 80 }), JSON.stringify({ networkPlay: "yes" })]) {
    const dir = await folder();
    const file = join(dir, "settings.json");
    await writeFile(file, text);
    const { settings, replaced } = await loadSettings(file, join(dir, "settings.json.bad"));
    assert.equal(replaced, true, text);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.equal(await readFile(join(dir, "settings.json.bad"), "utf8"), text);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), DEFAULT_SETTINGS);
    await rm(dir, { recursive: true });
  }
});

test("keys this build does not know survive a save, so going back and forth loses no setting", async () => {
  const dir = await folder();
  const file = join(dir, "settings.json");
  await writeFile(file, JSON.stringify({ port: 3171, networkPlay: false, futureThing: { a: 1 } }));
  const { settings } = await loadSettings(file, join(dir, "settings.json.bad"));
  assert.equal(settings.port, 3171);
  assert.equal(settings.networkPlay, false);
  await saveSettings(file, { ...settings, openBrowser: false });
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved.futureThing, { a: 1 });
  assert.equal(saved.openBrowser, false);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await rm(dir, { recursive: true });
});

test("a log rotates at its size with 5 kept, and its last line reads as words", async () => {
  const dir = await folder();
  const path = join(dir, "server.log");
  const log = new RotatingLog(path, 100, 5);
  for (let i = 0; i < 40; i++) log.line(`line ${String(i).padStart(3, "0")} ${"x".repeat(20)}`);
  log.line(JSON.stringify({ level: 50, msg: "listen failed", err: { message: "EADDRINUSE" } }));
  log.close();
  for (let n = 0; n < 5; n++) assert.ok((await stat(rotatedPath(path, n))).size <= 100);
  await assert.rejects(stat(rotatedPath(path, 5)));
  assert.equal(await lastLogLine(path), "listen failed: EADDRINUSE");
  assert.equal(await lastLogLine(join(dir, "none.log")), "no log was written");
  await rm(dir, { recursive: true });
});

test("a log line that cannot be written or rotated is dropped, never thrown, and the next one is written once it can be", async () => {
  const dir = await folder();
  // A file where the log's folder should be: the folder can't be made.
  await writeFile(join(dir, "logs"), "not a folder");
  const nowhere = new RotatingLog(join(dir, "logs", "server.log"));
  assert.doesNotThrow(() => nowhere.line("lost"));
  nowhere.close();

  // A folder where the first rotated file goes: the rotation can't rename onto it.
  const path = join(dir, "server.log");
  await mkdir(join(rotatedPath(path, 1), "held"), { recursive: true });
  const log = new RotatingLog(path, 30, 5);
  log.line("first line, long enough");
  assert.doesNotThrow(() => log.line("second line, past the size"));
  await rm(rotatedPath(path, 1), { recursive: true });
  log.line("third line, after the way is clear");
  log.close();
  assert.equal(await lastLogLine(path), "third line, after the way is clear");
  await rm(dir, { recursive: true });
});
