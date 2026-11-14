import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import pg from "pg";
import { Platform } from "../contract.ts";
import { dataIdentity } from "./dataDir.ts";
import { guardPath, lockLocation } from "./lock.ts";
import { ROOT } from "./testing/cluster.ts";
import { startSupervisor } from "./testing/supervisorProcess.ts";

/**
 * One supervisor per data folder, with real processes
 * (docs/design/design-v1-local-app.md 8.1 and 10, D-261113-092, 101, 105,
 * 106). Each contender is testing/lockChild.ts, which takes the lock as the
 * supervisor does and can pause at a point of the stale-socket recovery.
 * The last case runs two whole supervisors on one folder while the first
 * one's database answers queries.
 */

const platform = Platform.parse(process.platform);
const LOCK_CHILD = join(ROOT, "desktop", "runtime", "testing", "lockChild.ts");
const unix = platform !== "win32";

type Outcome = { ok: boolean; error?: { kind: string; path?: string }; path?: string; pid: number };
type Event = { event: string; point?: string } & Partial<Outcome>;

type Contender = {
  proc: ChildProcess;
  events: Event[];
  waitEvent(test: (e: Event) => boolean, timeoutMs?: number): Promise<Event>;
  result(timeoutMs?: number): Promise<Outcome>;
  alive(): boolean;
  /** An owner lets go: its stdin closes and it closes the lock. */
  release(): Promise<void>;
  kill(): Promise<void>;
};

const running = new Set<ChildProcess>();

function contender(data: string, opts: { pauses?: string[]; home?: string; runtimeDir?: string; env?: Record<string, string> } = {}): Contender {
  const args = [LOCK_CHILD, "--data", data];
  for (const p of opts.pauses ?? []) args.push("--pause", p);
  if (opts.home) args.push("--home", opts.home);
  if (opts.runtimeDir) args.push("--runtime-dir", opts.runtimeDir);
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
  running.add(proc);
  const events: Event[] = [];
  const wakers = new Set<() => void>();
  let buffer = "";
  let stderr = "";
  let alive = true;
  proc.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      events.push(JSON.parse(buffer.slice(0, nl)) as Event);
      buffer = buffer.slice(nl + 1);
      for (const wake of [...wakers]) wake();
    }
  });
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exited = new Promise<void>((resolve) =>
    proc.once("exit", () => {
      alive = false;
      running.delete(proc);
      for (const wake of [...wakers]) wake();
      resolve();
    }),
  );
  const waitEvent = (test: (e: Event) => boolean, timeoutMs = 60_000): Promise<Event> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = events.find(test);
        if (hit) {
          done();
          resolve(hit);
        } else if (!alive) {
          done();
          reject(new Error(`the contender exited without the event: ${JSON.stringify(events)} ${stderr}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no event within ${timeoutMs} ms: ${JSON.stringify(events)} ${stderr}`));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        wakers.delete(check);
      };
      wakers.add(check);
      check();
    });
  return {
    proc,
    events,
    waitEvent,
    result: async (timeoutMs) => (await waitEvent((e) => e.event === "result", timeoutMs)) as Outcome,
    alive: () => alive,
    async release() {
      proc.stdin?.end();
      await exited;
    },
    async kill() {
      proc.kill("SIGKILL");
      await exited;
    },
  };
}

/** The lock's own path for a data folder, as the supervisor works it out on this machine. */
function lockPathOf(data: string): string {
  const at = lockLocation(dataIdentity(data, platform).hash, { platform, uid: process.getuid?.() ?? 0, home: os.homedir() });
  if ("error" in at) throw new Error("this machine's lock path is too long");
  return at.path;
}

/** Removes the socket, its guard and any staging folder a test left in the shared runtime folder. */
async function clearLock(path: string): Promise<void> {
  if (!unix) return;
  for (const name of await readdir(dirname(path)).catch(() => [] as string[])) {
    if (name.startsWith(basename(path))) await rm(join(dirname(path), name), { recursive: true, force: true });
  }
}

const temps: string[] = [];
async function dataDir(prefix = "rvtt-lock-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A socket file whose owner was killed: it refuses connections, as after a crash. */
async function staleSocket(data: string): Promise<string> {
  const owner = contender(data);
  const result = await owner.result();
  assert.equal(result.ok, true, JSON.stringify(result));
  await owner.kill();
  const path = result.path as string;
  assert.ok((await stat(path)).isSocket(), "the killed owner's socket file stays behind");
  return path;
}

function owners(outcomes: readonly Outcome[]): Outcome[] {
  return outcomes.filter((o) => o.ok);
}

after(async () => {
  for (const proc of running) proc.kill("SIGKILL");
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe("the lock, with real processes", { skip: !unix && "Windows uses a named pipe, which has no stale socket to recover" }, () => {
  test("ten contenders at once on one folder leave exactly one owner", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    try {
      const all = Array.from({ length: 10 }, () => contender(data));
      const outcomes = await Promise.all(all.map((c) => c.result()));
      assert.equal(owners(outcomes).length, 1, JSON.stringify(outcomes));
      for (const o of outcomes.filter((o) => !o.ok)) assert.deepEqual(o.error, { kind: "alreadyRunning" });
      await Promise.all(all.map((c) => c.release()));
    } finally {
      await clearLock(path);
    }
  });

  test("two, then ten, contenders recovering one stale socket leave exactly one owner, round after round", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    try {
      // Many rounds, since the races between an unlink and a bind show only now and then.
      for (const n of Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 2 : 10))) {
        await staleSocket(data);
        const all = Array.from({ length: n }, () => contender(data));
        const outcomes = await Promise.all(all.map((c) => c.result()));
        assert.equal(owners(outcomes).length, 1, JSON.stringify(outcomes));
        for (const o of outcomes.filter((o) => !o.ok)) assert.deepEqual(o.error, { kind: "alreadyRunning" });
        assert.equal(existsSync(guardPath(path)), false, "the owner removed its guard");
        await Promise.all(all.map((c) => c.release()));
      }
    } finally {
      await clearLock(path);
    }
  });

  test("a contender that saw the stale socket before another recovered it checks again under the guard, and ends as already running", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    try {
      await staleSocket(data);
      // It saw "refused", then waits while another contender recovers the socket and lets the guard go.
      const late = contender(data, { pauses: ["refused=3000"] });
      await late.waitEvent((e) => e.event === "paused");
      const quick = contender(data);
      assert.equal((await quick.result()).ok, true);
      const outcome = await late.result();
      assert.deepEqual(outcome.error, { kind: "alreadyRunning" }, "the guard's second look found the new owner");
      const probe = contender(data);
      assert.deepEqual((await probe.result()).error, { kind: "alreadyRunning" }, "the first owner still answers at the path");
      await quick.release();
    } finally {
      await clearLock(path);
    }
  });

  test("a guard holder paused 30 s between its last connect and its unlink keeps the guard, and no second owner appears", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    try {
      await staleSocket(data);
      const holder = contender(data, { pauses: ["guardTaken=30000"] });
      await holder.waitEvent((e) => e.event === "paused");
      const guard = JSON.parse(await readFile(join(guardPath(path), "owner.json"), "utf8")) as { pid: number };
      assert.equal(guard.pid, holder.proc.pid);
      // Contenders through the pause each wait 5 s on the busy guard, then give up. Age never frees a guard.
      for (let round = 0; round < 3; round++) {
        const others = [contender(data), contender(data)];
        for (const o of await Promise.all(others.map((c) => c.result()))) assert.deepEqual(o.error, { kind: "alreadyRunning" });
        assert.equal(holder.events.some((e) => e.event === "result"), false, "the holder is still paused");
        const still = JSON.parse(await readFile(join(guardPath(path), "owner.json"), "utf8")) as { pid: number };
        assert.equal(still.pid, holder.proc.pid, "no contender took the guard");
        await new Promise((r) => setTimeout(r, 5_000));
      }
      const outcome = await holder.result(40_000);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(existsSync(guardPath(path)), false);
      const late = contender(data);
      assert.deepEqual((await late.result()).error, { kind: "alreadyRunning" });
      await holder.release();
    } finally {
      await clearLock(path);
    }
  });

  test("a guard whose owner died stops every contender with words naming it, and no contender removes it", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    const guard = guardPath(path);
    try {
      await staleSocket(data);
      const holder = contender(data, { pauses: ["guardTaken=600000"] });
      await holder.waitEvent((e) => e.event === "paused");
      await holder.kill();
      const record = await readFile(join(guard, "owner.json"), "utf8");

      const ten = Array.from({ length: 10 }, () => contender(data));
      for (const o of await Promise.all(ten.map((c) => c.result()))) assert.deepEqual(o.error, { kind: "guardLeft", path: guard });
      assert.equal(await readFile(join(guard, "owner.json"), "utf8"), record, "the guard is untouched");

      // One contender paused 30 s after reading the dead owner's record while another reads it too.
      const slow = contender(data, { pauses: ["guardRead=30000"] });
      await slow.waitEvent((e) => e.event === "paused");
      const quick = contender(data);
      assert.deepEqual((await quick.result()).error, { kind: "guardLeft", path: guard });
      assert.deepEqual((await slow.result(40_000)).error, { kind: "guardLeft", path: guard });
      assert.equal(await readFile(join(guard, "owner.json"), "utf8"), record, "the guard is untouched");

      // The DM deletes the folder, and the next start takes the lock.
      await rm(guard, { recursive: true });
      const next = contender(data);
      assert.equal((await next.result()).ok, true);
      await next.release();
    } finally {
      await clearLock(path);
    }
  });

  test("a damaged guard record stops the start with words naming the folder", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    const guard = guardPath(path);
    try {
      await staleSocket(data);
      await mkdir(guard);
      await writeFile(join(guard, "owner.json"), "{ not json");
      assert.deepEqual((await contender(data).result()).error, { kind: "guardUnreadable", path: guard });
      await rm(join(guard, "owner.json"));
      await writeFile(join(guard, "other"), "a guard with no record");
      assert.deepEqual((await contender(data).result()).error, { kind: "guardUnreadable", path: guard });
      assert.ok(existsSync(join(guard, "other")), "the guard is untouched");
    } finally {
      await clearLock(path);
    }
  });

  test("a socket path past the system's limit falls back to ~/.cache/RaccoonVTT", async () => {
    const data = await dataDir();
    // A short home, so the fallback itself fits under the limit wherever the temp folder is.
    const base = join(tmpdir(), "h-xxxxxx", ".cache", "RaccoonVTT", "raccoonvtt-0123456789abcdef.sock").length <= 103 ? tmpdir() : "/tmp";
    const home = await mkdtemp(join(base, "h-"));
    temps.push(home);
    const long = join(home, "r".repeat(100));
    await mkdir(long, { mode: 0o700 });
    const first = contender(data, { home, runtimeDir: long });
    const outcome = await first.result();
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(dirname(outcome.path as string), join(home, ".cache", "RaccoonVTT"));
    assert.equal((await stat(join(home, ".cache", "RaccoonVTT"))).mode & 0o777, 0o700);
    assert.deepEqual((await contender(data, { home, runtimeDir: long }).result()).error, { kind: "alreadyRunning" });
    await first.release();
  });

  test("paths that alias one folder, and other TMPDIR and XDG_RUNTIME_DIR values, leave one owner", async () => {
    const data = await dataDir();
    const path = lockPathOf(data);
    try {
      const alias = join(dirname(data), `${basename(data)}-alias`);
      await symlink(data, alias);
      temps.push(alias);
      const spellings = [data, alias];
      // On a file system that ignores case (macOS's usual one), another spelling is the same folder.
      const upper = join(dirname(data), basename(data).toUpperCase());
      if (platform !== "linux" && existsSync(upper)) spellings.push(upper);
      const all = [
        ...spellings.map((d) => contender(d)),
        contender(data, { env: { TMPDIR: await dataDir("rvtt-tmpdir-") } }),
        contender(alias, { env: { XDG_RUNTIME_DIR: await dataDir("rvtt-xdg-"), TMPDIR: await dataDir("rvtt-tmpdir-") } }),
      ];
      const outcomes = await Promise.all(all.map((c) => c.result()));
      assert.equal(owners(outcomes).length, 1, JSON.stringify(outcomes));
      assert.equal(new Set(outcomes.map((o) => o.path)).size, 1, "every spelling names one lock");
      await Promise.all(all.map((c) => c.release()));
    } finally {
      await clearLock(path);
    }
  });
});

describe("two supervisors on one folder", { skip: !unix && "symlinked data folders need privileges on Windows, and the smoke test covers it there" }, () => {
  test("a second supervisor on an aliased path ends as already running while the first one's database answers throughout", async () => {
    const data = await dataDir("rvtt-lock-sup-");
    const alias = join(dirname(data), `${basename(data)}-alias`);
    await symlink(data, alias);
    temps.push(alias);
    const first = startSupervisor({ data, port: 40410 });
    let second: ReturnType<typeof startSupervisor> | null = null;
    let client: pg.Client | null = null;
    try {
      await first.waitFor("running", (s) => s.state === "running", 120_000);
      const password = (JSON.parse(await readFile(join(data, "secrets.json"), "utf8")) as { databasePassword: string }).databasePassword;
      const pgPort = (await readFile(join(data, "postgres", "postmaster.pid"), "utf8")).split("\n")[3]?.trim();
      client = new pg.Client({ connectionString: `postgres://raccoon:${password}@127.0.0.1:${pgPort}/raccoon` });
      await client.connect();
      let queries = 0;
      let failures = 0;
      let querying = true;
      const loop = (async () => {
        while (querying) {
          try {
            await (client as pg.Client).query("select 1");
            queries++;
          } catch {
            failures++;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      })();

      second = startSupervisor({ data, dataArg: alias, port: 40411 });
      const refused = await second.waitFor("an error", (s) => s.state === "error", 120_000);
      assert.deepEqual(refused.error, { kind: "alreadyRunning" });
      await new Promise((r) => setTimeout(r, 1_000));
      querying = false;
      await loop;
      assert.equal(failures, 0, "the first database answered every query");
      assert.ok(queries > 10, `queries ran throughout (${queries})`);
      assert.equal(first.latest()?.state, "running");
      await second.stop();
      second = null;
      // The refused supervisor touched nothing: the first's database still answers.
      await client.query("select 1");
    } finally {
      await client?.end().catch(() => undefined);
      await second?.stop();
      await first.stop();
    }
  });
});
