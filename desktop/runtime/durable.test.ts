import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nodeFs, removeDurable, renameRetrying, writeDurable, type DurableFs } from "./durable.ts";

/**
 * Durable writes (docs/design/design-v1-local-app.md 8.3, D-261113-091): the
 * order of the calls, and what a failed fsync or rename leaves.
 */

function recording(fail?: (call: string) => boolean): { fs: DurableFs; calls: string[] } {
  const calls: string[] = [];
  const name = (p: string) => p.replace(/\.[0-9a-f]{12}\.tmp$/, ".TMP").split(/[\\/]/).slice(-2).join("/");
  const fs: DurableFs = {
    async open(path, flags, mode) {
      const handle = await nodeFs.open(path, flags, mode);
      calls.push(`open ${name(path)} ${flags}`);
      return {
        writeFile: async (data) => {
          calls.push(`write ${name(path)}`);
          await handle.writeFile(data);
        },
        sync: async () => {
          calls.push(`sync ${name(path)}`);
          if (fail?.(`sync ${name(path)}`)) throw Object.assign(new Error("EIO"), { code: "EIO" });
          await handle.sync();
        },
        close: async () => {
          calls.push(`close ${name(path)}`);
          await handle.close();
        },
      };
    },
    async rename(from, to) {
      calls.push(`rename ${name(from)} ${name(to)}`);
      if (fail?.("rename")) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      await nodeFs.rename(from, to);
    },
    async unlink(path) {
      calls.push(`unlink ${name(path)}`);
      await nodeFs.unlink(path);
    },
  };
  return { fs, calls };
}

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rvtt-durable-"));
}

test("a write goes to a temp file, is flushed, renamed over the target, then the folder is flushed", { skip: process.platform === "win32" && "Windows cannot open a folder to flush it, which the next test covers" }, async () => {
  const dir = await folder();
  const { fs, calls } = recording();
  await writeDurable(join(dir, "restore.json"), "{}", { fs, platform: "linux" });
  const base = dir.split(/[\\/]/).at(-1);
  assert.deepEqual(calls, [
    `open ${base}/.restore.json.TMP w`,
    `write ${base}/.restore.json.TMP`,
    `sync ${base}/.restore.json.TMP`,
    `close ${base}/.restore.json.TMP`,
    `rename ${base}/.restore.json.TMP ${base}/restore.json`,
    `open ${dir.split(/[\\/]/).slice(-2).join("/")} r`,
    `sync ${dir.split(/[\\/]/).slice(-2).join("/")}`,
    `close ${dir.split(/[\\/]/).slice(-2).join("/")}`,
  ]);
  assert.equal(await readFile(join(dir, "restore.json"), "utf8"), "{}");
  await rm(dir, { recursive: true });
});

test("on Windows the renamed file is opened again and flushed, since a folder cannot be", async () => {
  const dir = await folder();
  const { fs, calls } = recording();
  await writeDurable(join(dir, "restore.json"), "{}", { fs, platform: "win32" });
  const base = dir.split(/[\\/]/).at(-1);
  assert.deepEqual(calls.slice(4), [`rename ${base}/.restore.json.TMP ${base}/restore.json`, `open ${base}/restore.json r+`, `sync ${base}/restore.json`, `close ${base}/restore.json`]);
  await rm(dir, { recursive: true });
});

test("a failed fsync or rename leaves the old file whole and no temp file", { skip: process.platform === "win32" && "Windows cannot open a folder to flush it, which the next test covers" }, async () => {
  for (const failing of ["sync", "rename"]) {
    const dir = await folder();
    const target = join(dir, "restore.json");
    await writeFile(target, "old");
    const { fs } = recording((call) => call.startsWith(failing) && !call.endsWith(dir.split(/[\\/]/).slice(-2).join("/")));
    await assert.rejects(writeDurable(target, "new", { fs, platform: "linux" }));
    assert.equal(await readFile(target, "utf8"), "old", failing);
    assert.deepEqual(await readdir(dir), ["restore.json"], failing);
    await rm(dir, { recursive: true });
  }
});

test("a removal is flushed in its folder, and a file already gone counts as removed", { skip: process.platform === "win32" && "Windows cannot open a folder to flush it, which the next test covers" }, async () => {
  const dir = await folder();
  const target = join(dir, "restore.json");
  await writeFile(target, "x");
  const { fs, calls } = recording();
  await removeDurable(target, { fs, platform: "linux" });
  await removeDurable(target, { fs, platform: "linux" });
  assert.deepEqual(await readdir(dir), []);
  assert.ok(calls.filter((c) => c.startsWith("sync")).length === 2);
  await rm(dir, { recursive: true });
});

test("on Windows a rename refused while a file is held open is tried again with backoff for up to 30 s, and elsewhere fails at once", async () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  /** A rename refused `times` times with `code`, then done, on a clock only the waits move. */
  const world = (times: number, code = "EPERM") => {
    let t = 0;
    let tries = 0;
    const waits: number[] = [];
    return {
      opts: {
        platform: "win32" as const,
        rename: async () => {
          tries++;
          if (tries <= times) throw busy(code);
        },
        sleep: async (ms: number) => {
          waits.push(ms);
          t += ms;
        },
        now: () => t,
      },
      tries: () => tries,
      waits,
    };
  };
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const w = world(3, code);
    await renameRetrying("a", "b", w.opts);
    assert.equal(w.tries(), 4, code);
    assert.deepEqual(w.waits, [100, 200, 400]);
  }
  const held = world(Infinity);
  await assert.rejects(renameRetrying("a", "b", held.opts), { code: "EPERM" });
  assert.ok(held.waits.reduce((a, b) => a + b, 0) <= 30_000, "gives up within 30 s");
  assert.ok(held.waits.reduce((a, b) => a + b, 0) >= 27_000, "after trying for most of them");
  assert.equal(Math.max(...held.waits), 2_000);

  const other = world(1, "ENOENT");
  await assert.rejects(renameRetrying("a", "b", other.opts), { code: "ENOENT" });
  assert.equal(other.tries(), 1, "another error fails at once");
  const mac = world(1);
  await assert.rejects(renameRetrying("a", "b", { ...mac.opts, platform: "darwin" }), { code: "EPERM" });
  assert.equal(mac.tries(), 1, "only Windows holds a folder's files against a rename");
});

