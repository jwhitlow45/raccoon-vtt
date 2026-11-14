import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ClientConfig } from "pg";
import type { Platform } from "../contract.ts";
import { renameRetrying, syncDir, syncFile, writeDurable } from "./durable.ts";
import { rotateIfLarge } from "./logs.ts";
import { loopbackPort } from "./ports.ts";
import { bootId, isAlive, processFacts, processStamp, type ProcessFacts } from "./processInfo.ts";

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

/** How long one statement of the supervisor's may run: its own are a few rows each. */
export const DB_STATEMENT_MS = 60_000;
/** A restore's statements: dropping or copying a whole database takes as long as the database is big. */
export const RESTORE_STATEMENT_MS = 600_000;

/**
 * Every connection the supervisor opens to its cluster. A connection
 * PostgreSQL has not finished in 30 s fails, and so does a statement it has
 * not answered in `statementMs`: the server ends it (statement_timeout), and
 * should the server not answer at all, the client gives up 10 s later
 * (query_timeout). So no part of a start, and no Quit queued behind one,
 * waits on the database for ever.
 */
export function dbConfig(connectionString: string, statementMs = DB_STATEMENT_MS): ClientConfig {
  return { connectionString, connectionTimeoutMillis: 30_000, statement_timeout: statementMs, query_timeout: statementMs + 10_000 };
}

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

/** How the cluster tells its postmaster from a process that reused its pid (processInfo.ts). Tests stand in for the system here. */
export type ProcessLookup = {
  stamp(pid: number): Promise<number | null>;
  facts(pid: number): Promise<ProcessFacts>;
  /** This boot's id, or "" where the system has none (Windows) or won't say. */
  bootId(): Promise<string>;
  /** This process's user, which a postmaster it may stop runs as too. Null on Windows. */
  uid: number | null;
};

/**
 * Beside postmaster.pid, the boot the last postmaster this app started ran
 * in, written before it starts. A boot id never moves with the clock, where
 * a boot time does when the clock is stepped.
 */
export const BOOT_RECORD = "raccoonvtt.boot";

export type ClusterOptions = {
  binDir: string;
  pgData: string;
  logFile: string;
  password: string;
  platform: Platform;
  /** Tests only: the port each start tries, in place of a free one the system picks. */
  pickPort?: () => Promise<number>;
  /** Tests only: in place of processInfo.ts's readings. */
  proc?: ProcessLookup;
  /** Tests only: runs between initdb and the app's own settings, where a test cuts the init off. */
  afterInitdb?: () => Promise<void>;
  /** Tests only: the folder renames, where a test stands in for a file another program holds open. */
  renameDir?: (from: string, to: string) => Promise<void>;
  /** Tests only: how long one pg_ctl start may run before it is ended. PG_CTL_START_LIMIT_MS by default. */
  startLimitMs?: number;
  /** Tests only: the signal that ends initdb and pg_ctl, for a stand-in that still acts after it is told to end, as a Windows process can. SIGKILL by default. */
  killSignal?: NodeJS.Signals;
  /** Where a program that will not end is reported. */
  log?: (msg: string) => void;
  /** The path PostgreSQL's programs are given for one of these paths (pgPaths.ts). The path itself by default. */
  pgPath?: (path: string) => string;
};

/**
 * A postmaster.pid found at a start. `stale`: the evidence says nothing of
 * this folder's runs as its pid, so the file can go. `running`: this
 * folder's postmaster. `uncertain`: something runs as its pid that may be
 * this folder's postmaster, so the file stays and the start stops.
 */
export type Leftover = { kind: "none" } | { kind: "stale" } | { kind: "running"; pid: number } | { kind: "uncertain"; pid: number };

/** The words a start stops with when postmaster.pid names a process that may still be this folder's PostgreSQL. */
export function uncertainWords(pid: number): string {
  return `postmaster.pid names process ${pid}, which still runs, and RaccoonVTT can't tell whether it is this folder's PostgreSQL. Restart the computer, then open RaccoonVTT again.`;
}

export class Cluster {
  readonly opts: ClusterOptions;
  port: number | null = null;
  private readonly proc: ProcessLookup;
  /** The postmaster this process started, by pid and a start reading no clock change moves. */
  private started: { pid: number; stamp: number } | null = null;

  constructor(opts: ClusterOptions) {
    this.opts = opts;
    this.proc = opts.proc ?? {
      stamp: (pid) => processStamp(pid, opts.platform),
      facts: (pid) => processFacts(pid, opts.platform),
      bootId: () => bootId(opts.platform),
      uid: process.getuid?.() ?? null,
    };
  }

  program(name: string): string {
    return join(this.pgPath(this.opts.binDir), this.opts.platform === "win32" ? `${name}.exe` : name);
  }

  /** The path PostgreSQL's programs are given for a path in the data folder or their own. */
  pgPath(path: string): string {
    return this.opts.pgPath?.(path) ?? path;
  }

  /** The major version of the bundled programs, from `postgres --version`. */
  async bundledMajor(): Promise<number> {
    const { stdout } = await run(this.program("postgres"), ["--version"], { env: pgEnv(), windowsHide: true, timeout: 30_000 });
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

  /** postgres/ appears only whole, so a folder without one has no cluster yet. */
  needsInit(): boolean {
    return !existsSync(this.opts.pgData);
  }

  /** A folder an earlier start left, renamed beside it, never deleted. */
  private async moveAside(path: string): Promise<void> {
    let aside = `${this.opts.pgData}.incomplete-${Date.now()}`;
    while (existsSync(aside)) aside = `${this.opts.pgData}.incomplete-${Date.now()}-${randomBytes(3).toString("hex")}`;
    await renameRetrying(path, aside, { platform: this.opts.platform, ...(this.opts.renameDir ? { rename: this.opts.renameDir } : {}) });
  }

  /**
   * initdb with the C locale and the builtin C.UTF-8 provider, so neither
   * text order nor messages depend on the computer's locale or ICU. It runs
   * in a staging folder (postgres.init-<random>), which gets the app's own
   * pg_hba.conf and settings, is flushed, and only then is renamed to
   * postgres/: initdb writes PG_VERSION first, so a cut-off init or one cut
   * off before the app's settings would otherwise pass for a cluster, and
   * one on initdb's defaults would listen on a socket and ::1. Folders a
   * cut-off init left are moved aside, never deleted.
   */
  async init(signal?: AbortSignal): Promise<void> {
    const parent = dirname(this.opts.pgData);
    const stagingPrefix = `${basename(this.opts.pgData)}.init-`;
    for (const name of await readdir(parent)) if (name.startsWith(stagingPrefix)) await this.moveAside(join(parent, name));
    if (existsSync(this.opts.pgData)) await this.moveAside(this.opts.pgData);
    const staging = join(parent, `${stagingPrefix}${randomBytes(6).toString("hex")}`);
    // Made here, empty, so initdb makes no folder itself. On Windows it would
    // check each parent first, and its check of a junction (pgPaths.ts) reads
    // the target back in the ANSI code page, which fails for the folders a
    // junction stands in for.
    await mkdir(staging, { mode: 0o700 });
    const pwfile = `${this.opts.pgData}-pw-${randomBytes(6).toString("hex")}`;
    await writeFile(pwfile, `${this.opts.password}\n`, { mode: 0o600 });
    try {
      await runToExit(
        this.program("initdb"),
        [
          `--pgdata=${this.pgPath(staging)}`,
          `--username=${USER}`,
          `--pwfile=${this.pgPath(pwfile)}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
          "--locale-provider=builtin",
          "--builtin-locale=C.UTF-8",
        ],
        // A cancelled init ends initdb and waits for its exit. The staging folder it leaves is moved aside by the next one.
        { env: pgEnv({ LC_ALL: "C" }), ...(signal ? { signal } : {}), ...(this.opts.killSignal ? { killSignal: this.opts.killSignal } : {}), ...(this.opts.log ? { log: this.opts.log } : {}) },
      );
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const line = (e.stderr || e.message).trim().split(/\r?\n/).at(-1) || e.message;
      throw new DatabaseFailed(line);
    } finally {
      await rm(pwfile, { force: true });
    }
    await this.opts.afterInitdb?.();
    await writeFile(join(staging, "pg_hba.conf"), HBA);
    await appendFile(join(staging, "postgresql.conf"), CONF);
    await syncFile(join(staging, "pg_hba.conf"));
    await syncFile(join(staging, "postgresql.conf"));
    await syncDir(staging);
    await renameRetrying(staging, this.opts.pgData, { platform: this.opts.platform, ...(this.opts.renameDir ? { rename: this.opts.renameDir } : {}) });
    await syncDir(parent);
  }

  /**
   * A postmaster.pid left behind, and what runs as its pid. A reused pid is
   * someone else's process and must never be signalled, and the file of a
   * postmaster still running must never go, or a second one could open the
   * same folder. So each answer needs evidence, in this order:
   * - `running`: the program is postgres and it is this folder's: on Linux
   *   its working folder is this one, elsewhere it started when the file says.
   * - `stale`: the boot recorded beside it is not this one, the program is
   *   known and is not postgres, or it runs as another user.
   * - `uncertain`: anything else, a system that refused to say included.
   * Running comes first, so this folder's live postmaster is never taken for
   * a stale one, whatever else is read.
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
    let facts: ProcessFacts;
    try {
      facts = await this.proc.facts(pid);
    } catch {
      facts = { exe: null, cwd: null, uid: null, start: null };
    }
    const postgres = facts.exe !== null && /^postgres(\.exe)?$/i.test(basename(facts.exe.replaceAll("\\", "/")));
    if (postgres) {
      if (this.opts.platform === "linux") {
        if (facts.cwd !== null && facts.cwd === (await realpath(this.opts.pgData))) return { kind: "running", pid };
      } else if (facts.start !== null && Number.isFinite(startedSec) && Math.abs(facts.start / 1000 - startedSec) <= 5) {
        // The file's time is the postmaster's own clock reading as it started, a moment after the system's.
        return { kind: "running", pid };
      }
    }
    if (await this.fromEarlierBoot()) return { kind: "stale" };
    if (facts.exe !== null && !postgres) return { kind: "stale" };
    if (facts.uid !== null && this.proc.uid !== null && facts.uid !== this.proc.uid) return { kind: "stale" };
    return isAlive(pid) ? { kind: "uncertain", pid } : { kind: "stale" };
  }

  /**
   * Whether postmaster.pid is from an earlier boot: a boot is recorded beside
   * it and this boot is another. Windows has no boot id, so there the
   * program's name is the evidence.
   */
  private async fromEarlierBoot(): Promise<boolean> {
    let recorded: string;
    try {
      recorded = (await readFile(join(this.opts.pgData, BOOT_RECORD), "utf8")).trim();
    } catch {
      return false;
    }
    let current = "";
    try {
      current = await this.proc.bootId();
    } catch {
      // Unknown: no evidence either way.
    }
    return recorded !== "" && current !== "" && recorded !== current;
  }

  /**
   * Records this boot beside the postmaster about to start. Any postmaster.pid
   * is gone by now, so the next one the folder holds is from the boot
   * recorded. With no id to write, the record goes, since an older one would
   * name a boot this postmaster never ran in.
   */
  private async recordBoot(): Promise<void> {
    let boot = "";
    try {
      boot = await this.proc.bootId();
    } catch {
      // No id: the record goes.
    }
    const file = join(this.opts.pgData, BOOT_RECORD);
    if (boot !== "") {
      await writeDurable(file, `${boot}\n`, { platform: this.opts.platform });
    } else {
      await rm(file, { force: true });
      await syncDir(this.opts.pgData, { platform: this.opts.platform });
    }
  }

  /** Only the lock holder calls this, and only when the supervisor that started it is gone (D-261113-093). */
  async clearLeftover(found: Leftover): Promise<void> {
    if (found.kind === "running") await this.stop();
    else if (found.kind === "stale") await rm(join(this.opts.pgData, "postmaster.pid"), { force: true });
    else if (found.kind === "uncertain") throw new DatabaseFailed(uncertainWords(found.pid));
  }

  /** The pid postmaster.pid names, or null with no file. */
  private async pidFilePid(): Promise<number | null> {
    try {
      const pid = Number((await readFile(join(this.opts.pgData, "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * pg_ctl start on a free loopback port, three tries, so another program
   * taking the port in between is no failure. A failure reports what this
   * start wrote to the log, never an older run's last line.
   *
   * The postmaster an attempt launches is this start's until its end is
   * seen (D-261114-029, 030). pg_ctl -w answers only once its postmaster is
   * ready, has died, or its own wait ran out. So a cancel never ends
   * pg_ctl: the postmaster is stopped as soon as postmaster.pid names it,
   * and pg_ctl answers when it sees that. A postmaster still alive after
   * pg_ctl gave up is waited for until it accepts connections or dies,
   * however long its crash replay takes. Only a pg_ctl past its own wait by
   * 30 s is ended, and then waited for.
   */
  async start(signal?: AbortSignal): Promise<number> {
    rotateIfLarge(this.opts.logFile);
    await this.recordBoot();
    let lastError: DatabaseFailed | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) break;
      const port = await (this.opts.pickPort ?? loopbackPort)();
      const offset = await sizeOf(this.opts.logFile);
      const pgCtl = runToExit(
        this.program("pg_ctl"),
        ["start", "-D", this.pgPath(this.opts.pgData), "-l", this.pgPath(this.opts.logFile), "-w", "-t", String(PG_CTL_WAIT_S), "-o", `-p ${port}`],
        {
          env: pgEnv(),
          limitMs: this.opts.startLimitMs ?? PG_CTL_START_LIMIT_MS,
          ...(this.opts.killSignal ? { killSignal: this.opts.killSignal } : {}),
          ...(this.opts.log ? { log: this.opts.log } : {}),
        },
      );
      const answered = pgCtl.then(
        () => null,
        (err: unknown) => err,
      );
      const stopping = signal ? this.stopOnCancel(signal, answered) : Promise.resolve();
      const failure = await answered;
      await stopping;
      if (signal?.aborted) break;
      if (failure === null || (await this.becameReady(signal))) {
        this.port = port;
        const pid = await this.pidFilePid();
        const stamp = pid === null ? null : await this.proc.stamp(pid);
        this.started = pid !== null && stamp !== null ? { pid, stamp } : null;
        return port;
      }
      if (signal?.aborted) break;
      await this.stopLaunched();
      const lines = await linesSince(this.opts.logFile, offset);
      if (failure instanceof Ended) {
        lastError = new DatabaseFailed(failure.message);
        break;
      }
      const e = failure as { stderr?: string; message?: string };
      const said = (e.stderr ?? "").trim().split(/\r?\n/).at(-1) || (e.message ?? "").split(/\r?\n/)[0] || "pg_ctl start failed";
      lastError = new DatabaseFailed(lines.at(-1) ?? said);
      // PostgreSQL's last words for a taken port are "could not create any TCP/IP sockets", so every line counts.
      if (!lines.some((line) => /could not bind|address already in use/i.test(line))) break;
    }
    if (signal?.aborted) {
      await this.stopLaunched();
      throw new DatabaseFailed("pg_ctl start was cancelled");
    }
    throw lastError ?? new DatabaseFailed("pg_ctl start failed");
  }

  /**
   * On a cancel, stops the postmaster as soon as postmaster.pid names it,
   * and keeps looking until pg_ctl has answered, which it does once it sees
   * its postmaster end.
   */
  private async stopOnCancel(signal: AbortSignal, answered: Promise<unknown>): Promise<void> {
    if (!signal.aborted) await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      void answered.then(() => resolve());
    });
    let done = false;
    void answered.then(() => (done = true));
    while (signal.aborted && !done) {
      if (existsSync(join(this.opts.pgData, "postmaster.pid"))) await this.stopLaunched();
      await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
  }

  /**
   * After pg_ctl gave up, the postmaster it launched, if one still runs: its
   * crash replay can outlast any wait. It is waited for until postmaster.pid
   * says it accepts connections (true) or it dies (false). A cancel stops it.
   */
  private async becameReady(signal: AbortSignal | undefined): Promise<boolean> {
    const pidFile = join(this.opts.pgData, "postmaster.pid");
    for (const until = Date.now() + LAUNCH_WAIT_MS; !existsSync(pidFile) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 100));
    const found = await this.leftover().catch((): Leftover => ({ kind: "none" }));
    if (found.kind !== "running") return false;
    this.opts.log?.(`PostgreSQL (pid ${found.pid}) still starts after pg_ctl stopped waiting, so the start waits for it`);
    for (;;) {
      if (signal?.aborted) return false;
      if (!isAlive(found.pid)) return false;
      const lines = await readFile(pidFile, "utf8").then((text) => text.split(/\r?\n/), () => [] as string[]);
      if (Number(lines[0]) !== found.pid) return false;
      // Line 8 of postmaster.pid is its state, "ready" once it accepts connections (PostgreSQL's LOCK_FILE_LINE_PM_STATUS).
      if (lines[7]?.trim() === "ready") return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * After a start that failed or was cancelled, the postmaster it launched,
   * if one still runs: one a cancel left, or one that wrote postmaster.pid
   * only after pg_ctl's exit. It is stopped only once leftover() confirms it
   * is this folder's postgres, and the start's own failure is what the
   * caller hears, whatever this finds.
   */
  private async stopLaunched(): Promise<void> {
    // pg_ctl can be gone before the postmaster it launched has written
    // postmaster.pid, so the file's absence is believed only after a moment.
    const pidFile = join(this.opts.pgData, "postmaster.pid");
    for (const until = Date.now() + LAUNCH_WAIT_MS; !existsSync(pidFile) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 100));
    let found: Leftover;
    try {
      found = await this.leftover();
    } catch {
      return;
    }
    if (found.kind !== "running") return;
    try {
      await run(this.program("pg_ctl"), ["stop", "-D", this.pgPath(this.opts.pgData), "-m", "fast", "-w", "-t", "60"], { env: pgEnv(), windowsHide: true, timeout: 90_000 });
    } catch {
      // The next start finds it, as leftover() reads it then.
    }
  }

  /**
   * A clean, fast shutdown: sessions are ended, and the log closes with a
   * checkpoint. pg_ctl signals whatever pid postmaster.pid names, so it runs
   * only for a postmaster this has checked is one: the one this process
   * started, still running with the start it had then, or one leftover()
   * finds running. A reused pid is never signalled, and nothing running is
   * already the goal.
   */
  async stop(): Promise<void> {
    const pid = await this.pidFilePid();
    const mine = pid !== null && this.started?.pid === pid && (await this.proc.stamp(pid)) === this.started.stamp;
    if (mine || (await this.leftover()).kind === "running") {
      await run(this.program("pg_ctl"), ["stop", "-D", this.pgPath(this.opts.pgData), "-m", "fast", "-w", "-t", "60"], { env: pgEnv(), windowsHide: true });
    }
    this.started = null;
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

/**
 * pg_ctl start's own wait for the postmaster to be ready (-t), in seconds.
 * Crash replay can take that long on a slow disk: max_wal_size is a soft
 * limit, so it caps nothing. pg_ctl answers at once when the postmaster
 * dies, so a long wait only waits on one that is alive and replaying, and
 * the window says so meanwhile (a `stalled` part). A short one would stop
 * the replay, and every Try again would replay from the same checkpoint.
 */
export const PG_CTL_WAIT_S = 1800;
/** A pg_ctl start still running this long after its own wait has ended is ended. */
export const PG_CTL_START_LIMIT_MS = (PG_CTL_WAIT_S + 30) * 1000;
/** After a failed run's exit, how long its stderr's last words are waited for. */
const STDERR_DRAIN_MS = 1_000;
/** How long a run that was ended is given to report its exit before that is logged, and how often again after. */
const KILL_WAIT_MS = 10_000;
const KILL_WAIT_AGAIN_MS = 60_000;
/** After a pg_ctl start that failed, how long a postmaster it launched is given to write postmaster.pid. */
const LAUNCH_WAIT_MS = 3_000;

/** A run this ended: it took longer than its limit, or its caller cancelled it. */
export class Ended extends Error {}

/**
 * Runs a program to its exit, not to the close of its pipes, failing as
 * execFile does with `stderr` and `code`. On Windows, pg_ctl starts the
 * postmaster through cmd.exe with handle inheritance on
 * (CreateProcessAsUser's bInheritHandles), so the postmaster holds pg_ctl's
 * stdout and stderr pipes for as long as it runs, and execFile, which
 * answers only once every pipe has closed, would wait until PostgreSQL
 * stops. So stdout gets no pipe at all, and stderr is read for a moment
 * after a failed exit and then let go. A run still going after `limitMs`,
 * or when `signal` aborts, is ended, and answers only once its exit is
 * seen, however long that takes, so its caller never looks for what it
 * launched, or lets the data folder go, while it could still act. Windows'
 * TerminateProcess only begins the end. An end not seen in 10 s is logged,
 * and again each minute. This is the one way the cluster runs a program
 * that changes the data folder (initdb and pg_ctl start).
 */
export function runToExit(
  program: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; limitMs?: number; signal?: AbortSignal; killSignal?: NodeJS.Signals; log?: (msg: string) => void; endWaitMs?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: opts.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let closed = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stderr.once("close", () => (closed = true));
    let settled = false;
    let ended: Ended | null = null;
    let killWait: NodeJS.Timeout | undefined;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearInterval(killWait);
      opts.signal?.removeEventListener("abort", cancel);
      child.stderr.destroy();
      if (err) reject(err);
      else resolve();
    };
    const end = (why: string): void => {
      if (settled || ended) return;
      ended = new Ended(why);
      clearTimeout(limit);
      child.kill(opts.killSignal ?? "SIGKILL");
      const endedAt = Date.now();
      const report = (): void => opts.log?.(`${what} (pid ${child.pid}) has not ended ${Math.round((Date.now() - endedAt) / 1000)} s after it was ended, so the data folder stays locked until it does`);
      killWait = setTimeout(() => {
        report();
        killWait = setInterval(report, KILL_WAIT_AGAIN_MS);
      }, opts.endWaitMs ?? KILL_WAIT_MS);
    };
    const what = `${basename(program)} ${args[0]?.startsWith("-") ? "" : (args[0] ?? "")}`.trim();
    const limitMs = opts.limitMs;
    const limit = limitMs === undefined ? undefined : setTimeout(() => end(`${what} did not finish in ${Math.round(limitMs / 1000)} s`), limitMs);
    const cancel = (): void => end(`${what} was cancelled`);
    if (opts.signal?.aborted) cancel();
    else opts.signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (err) => settle(ended ?? err));
    child.once("exit", (code, signal) => {
      // An exit before the limit is the run's own answer, so the limit can no longer replace its words.
      clearTimeout(limit);
      if (ended) return settle(ended);
      if (code === 0) return settle(null);
      const fail = (): void => settle(Object.assign(new Error(`${basename(program)} ended with ${code ?? signal}`), { stderr, code }));
      if (closed) return fail();
      // A postmaster still holding the pipe would keep it open, so the wait for its close is short.
      const drain = setTimeout(fail, STDERR_DRAIN_MS);
      child.stderr.once("close", () => {
        clearTimeout(drain);
        fail();
      });
    });
  });
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
