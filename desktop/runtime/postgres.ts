import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Platform } from "../contract.ts";
import { rotateIfLarge } from "./logs.ts";
import { loopbackPort } from "./ports.ts";
import { isAlive, processStart } from "./processInfo.ts";

/**
 * The bundled PostgreSQL (docs/design/design-v1-local-app.md 2, 6 and 8.1,
 * D-261113-084, 093): a cluster in the data folder, made once by initdb,
 * started and stopped with pg_ctl, listening on 127.0.0.1 only, on a free
 * loopback port picked at each start, so a PostgreSQL already on 5432
 * never matters. No Unix socket, scram-sha-256, one user, `raccoon`.
 */

const run = promisify(execFile);

export const DATABASE = "raccoon";
export const USER = "raccoon";

export class DatabaseFailed extends Error {
  readonly logLine: string;
  constructor(logLine: string) {
    super(`the database did not start: ${logLine}`);
    this.logLine = logLine;
  }
}

/** The environment PostgreSQL's programs get: the caller's, without any PG* variable that could point them elsewhere. */
export function pgEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^PG/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** What initdb leaves in pg_hba.conf, replaced: the one user, from loopback, by password. */
const HBA = "# Written by RaccoonVTT. Only its own user, from this computer, with a password.\nhost all raccoon 127.0.0.1/32 scram-sha-256\n";

/** Appended to postgresql.conf after initdb. The port is passed at each start instead. */
const CONF = [
  "",
  "# Written by RaccoonVTT (docs/design/design-v1-local-app.md 6).",
  "listen_addresses = '127.0.0.1'",
  "unix_socket_directories = ''",
  "password_encryption = 'scram-sha-256'",
  // llvmjit is pruned from the bundle.
  "jit = off",
  // Sessions' times as the hosted image keeps them. In a zone with summer
  // time, now() plus 180 days would land an hour off a session's 180 days.
  "timezone = 'UTC'",
  "",
].join("\n");

export type ClusterOptions = {
  binDir: string;
  pgData: string;
  logFile: string;
  password: string;
  platform: Platform;
  /** Tests only: the port each start tries, in place of a free one the system picks. */
  pickPort?: () => Promise<number>;
};

export type Leftover = { kind: "none" } | { kind: "stale" } | { kind: "running"; pid: number };

export class Cluster {
  readonly opts: ClusterOptions;
  port: number | null = null;

  constructor(opts: ClusterOptions) {
    this.opts = opts;
  }

  program(name: string): string {
    return join(this.opts.binDir, this.opts.platform === "win32" ? `${name}.exe` : name);
  }

  /** The major version of the bundled programs, from `postgres --version`. */
  async bundledMajor(): Promise<number> {
    const { stdout } = await run(this.program("postgres"), ["--version"], { env: pgEnv(), windowsHide: true });
    const major = Number(/\(PostgreSQL\) (\d+)/.exec(stdout)?.[1]);
    if (!Number.isInteger(major)) throw new Error(`postgres --version said: ${stdout.trim()}`);
    return major;
  }

  /** The major version the cluster on disk was made by, or null when there is none yet. */
  async dataMajor(): Promise<number | null> {
    try {
      const major = Number((await readFile(join(this.opts.pgData, "PG_VERSION"), "utf8")).trim());
      return Number.isInteger(major) ? major : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  needsInit(): boolean {
    return !existsSync(join(this.opts.pgData, "PG_VERSION"));
  }

  /**
   * initdb with the C locale and the builtin C.UTF-8 provider, so neither
   * text order nor messages depend on the computer's locale or ICU. A
   * folder left by an initdb that was cut off is moved aside, never
   * deleted, since initdb needs an empty one.
   */
  async init(): Promise<void> {
    if (existsSync(this.opts.pgData)) await rename(this.opts.pgData, `${this.opts.pgData}.incomplete-${Date.now()}`);
    const pwfile = `${this.opts.pgData}-pw-${randomBytes(6).toString("hex")}`;
    await writeFile(pwfile, `${this.opts.password}\n`, { mode: 0o600 });
    try {
      await run(
        this.program("initdb"),
        [
          `--pgdata=${this.opts.pgData}`,
          `--username=${USER}`,
          `--pwfile=${pwfile}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
          "--locale-provider=builtin",
          "--builtin-locale=C.UTF-8",
        ],
        { env: pgEnv({ LC_ALL: "C" }), windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const line = (e.stderr ?? e.message).trim().split(/\r?\n/).at(-1) ?? e.message;
      throw new DatabaseFailed(line);
    } finally {
      await rm(pwfile, { force: true });
    }
    await writeFile(join(this.opts.pgData, "pg_hba.conf"), HBA);
    await appendFile(join(this.opts.pgData, "postgresql.conf"), CONF);
  }

  /**
   * A postmaster.pid left behind. `running` only when its pid is alive and
   * started when the file says, since a reused pid is someone else's
   * process and must never be stopped.
   */
  async leftover(): Promise<Leftover> {
    let lines: string[];
    try {
      lines = (await readFile(join(this.opts.pgData, "postmaster.pid"), "utf8")).split(/\r?\n/);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      throw err;
    }
    const pid = Number(lines[0]);
    const startedSec = Number(lines[2]);
    if (!isAlive(pid)) return { kind: "stale" };
    const start = await processStart(pid, this.opts.platform);
    // The file's time is the postmaster's own clock reading as it started, a moment after the system's.
    if (start === null || !Number.isFinite(startedSec) || Math.abs(start / 1000 - startedSec) > 5) return { kind: "stale" };
    return { kind: "running", pid };
  }

  /** Only the lock holder calls this, and only when the supervisor that started it is gone (D-261113-093). */
  async clearLeftover(found: Leftover): Promise<void> {
    if (found.kind === "running") await this.stop();
    else if (found.kind === "stale") await rm(join(this.opts.pgData, "postmaster.pid"), { force: true });
  }

  /**
   * pg_ctl start on a free loopback port, three tries, so another program
   * taking the port in between is no failure. A failure reports what this
   * start wrote to the log, never an older run's last line.
   */
  async start(): Promise<number> {
    rotateIfLarge(this.opts.logFile);
    let lastError: DatabaseFailed | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await (this.opts.pickPort ?? loopbackPort)();
      const offset = await sizeOf(this.opts.logFile);
      try {
        await run(this.program("pg_ctl"), ["start", "-D", this.opts.pgData, "-l", this.opts.logFile, "-w", "-t", "120", "-o", `-p ${port}`], {
          env: pgEnv(),
          windowsHide: true,
        });
        this.port = port;
        return port;
      } catch (err) {
        const lines = await linesSince(this.opts.logFile, offset);
        const e = err as { stderr?: string; message?: string };
        const said = (e.stderr ?? "").trim().split(/\r?\n/).at(-1) || (e.message ?? "").split(/\r?\n/)[0] || "pg_ctl start failed";
        lastError = new DatabaseFailed(lines.at(-1) ?? said);
        // PostgreSQL's last words for a taken port are "could not create any TCP/IP sockets", so every line counts.
        if (!lines.some((line) => /could not bind|address already in use/i.test(line))) break;
      }
    }
    throw lastError ?? new DatabaseFailed("pg_ctl start failed");
  }

  /**
   * A clean, fast shutdown: sessions are ended, and the log closes with a
   * checkpoint. pg_ctl signals whatever pid postmaster.pid names, so it runs
   * only for a postmaster this has checked is one. A reused pid is never
   * signalled, and nothing running is already the goal.
   */
  async stop(): Promise<void> {
    if ((await this.leftover()).kind === "running") {
      await run(this.program("pg_ctl"), ["stop", "-D", this.opts.pgData, "-m", "fast", "-w", "-t", "60"], { env: pgEnv(), windowsHide: true });
    }
    this.port = null;
  }

  /**
   * Whether the postmaster this supervisor started still runs, for the
   * watch every 5 s. Its pid alone is enough here: the start time check
   * leftover() makes would cost a PowerShell on Windows each time.
   */
  async running(): Promise<boolean> {
    try {
      const pid = Number((await readFile(join(this.opts.pgData, "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
      return isAlive(pid);
    } catch {
      return false;
    }
  }

  /** The postmaster's pid while one runs, else null. */
  async postmasterPid(): Promise<number | null> {
    const found = await this.leftover();
    return found.kind === "running" ? found.pid : null;
  }

  url(database = DATABASE): string {
    if (this.port === null) throw new Error("the database is not running");
    return `postgres://${USER}:${encodeURIComponent(this.opts.password)}@127.0.0.1:${this.port}/${database}`;
  }

  /** Runs one of the bundled client programs against this cluster, the password in its environment, never its arguments. */
  async client(name: "pg_dump" | "pg_restore", args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.port === null) throw new Error("the database is not running");
    return run(this.program(name), ["--host=127.0.0.1", `--port=${this.port}`, `--username=${USER}`, "--no-password", ...args], {
      env: pgEnv({ PGPASSWORD: this.opts.password }),
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  /** pg_restore reading a dump without a server, to check it reads back whole. */
  async readDump(args: string[]): Promise<void> {
    await run(this.program("pg_restore"), args, { env: pgEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** The log's lines from `offset` on: the last 256 KiB of them, or of the whole file when it was rotated in between. */
async function linesSince(file: string, offset: number): Promise<string[]> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const from = size < offset ? 0 : offset;
      const length = Math.min(size - from, 256 * 1024);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/** Spawned for a long command whose output is not wanted in memory. */
export function spawnQuiet(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-8192);
    });
    child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
