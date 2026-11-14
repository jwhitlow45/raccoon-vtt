import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { Platform } from "../contract.ts";
import { type ProcessIdentity, stillRunning } from "./processInfo.ts";

/**
 * One supervisor per data folder (docs/design/design-v1-local-app.md 8.1,
 * D-261113-084, 092, 101, 105, 106).
 *
 * The lock is a socket named by the folder's identity: a named pipe on
 * Windows, which Windows removes when its owner ends, and a Unix socket
 * elsewhere, in a per-user folder no caller's environment can move. A Unix
 * socket outlives a killed owner as a file, so a socket that refuses
 * connections is stale and is replaced, but only by whoever holds the
 * recovery guard: a folder made whole with its owner's record by one
 * rename, which fails while another guard is there. No one but its owner
 * ever renames or removes a guard, so a contender acting on a record it read
 * earlier can never remove a newer owner's guard. A guard whose owner died
 * in the few milliseconds it holds one stays until the DM deletes it.
 */

export type LockFailure =
  | { kind: "alreadyRunning" }
  | { kind: "pathTooLong" }
  | { kind: "guardLeft"; path: string }
  | { kind: "guardUnreadable"; path: string };

export type LockOutcome = { ok: true; lock: HeldLock } | { ok: false; error: LockFailure };

/** Points a test can pause at, to hold the guard or a stale read across another contender's moves. */
export type LockPausePoint = "refused" | "guardTaken" | "guardRead" | "listening";

export type LockOptions = {
  platform: Platform;
  self: ProcessIdentity;
  /** How long a busy guard is waited on before the start gives up as already running. */
  waitMs?: number;
  pause?: (point: LockPausePoint) => Promise<void>;
  /**
   * Runs once the socket is ours and answers with our nonce, before the
   * guard goes: the owner record is read and written here (design 8.1).
   * Returning false gives the lock up as already running.
   */
  claim?: () => Promise<boolean>;
};

// The longest socket path each system takes (sun_path less its terminator).
const SOCKET_PATH_LIMIT: Partial<Record<Platform, number>> = { linux: 107, darwin: 103 };

export type LocationDeps = {
  platform: Platform;
  uid: number;
  home: string;
  /**
   * The per-user folder the lock prefers: /run/user/<uid> on Linux, and on
   * macOS the per-user temp folder, read without trusting $TMPDIR. Tests
   * name another.
   */
  runtimeDir?: () => string | null;
  /** Whether a folder exists, belongs to this user and only they can enter it. */
  ownPrivateDir?: (dir: string) => boolean;
  makeFallbackDir?: (dir: string) => void;
};

function ownPrivateDir(dir: string, uid: number): boolean {
  try {
    const s = lstatSync(dir);
    return s.isDirectory() && s.uid === uid && (s.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function darwinUserTempDir(): string | null {
  try {
    const out = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
    return out.length > 0 ? out.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Where the lock lives. Linux: /run/user/<uid>, the folder logind makes
 * and $XDG_RUNTIME_DIR names, used by its fixed name. macOS: the per-user
 * temp folder a GUI app gets as $TMPDIR. Where neither works, or the path
 * would pass the system's limit, ~/.cache/RaccoonVTT. Never the shared /tmp.
 */
export function lockLocation(hash: string, deps: LocationDeps): { path: string } | { error: "pathTooLong" } {
  const name = `raccoonvtt-${hash}`;
  if (deps.platform === "win32") return { path: `\\\\.\\pipe\\${name}` };
  const limit = SOCKET_PATH_LIMIT[deps.platform] ?? 103;
  const isPrivate = deps.ownPrivateDir ?? ((dir: string) => ownPrivateDir(dir, deps.uid));
  const fits = (dir: string): string | null => {
    const path = join(dir, `${name}.sock`);
    return Buffer.byteLength(path) <= limit ? path : null;
  };
  const preferred = deps.runtimeDir ? deps.runtimeDir() : deps.platform === "linux" ? `/run/user/${deps.uid}` : darwinUserTempDir();
  if (preferred && isPrivate(preferred)) {
    const path = fits(preferred);
    if (path) return { path };
  }
  const fallback = join(deps.home, ".cache", "RaccoonVTT");
  const path = fits(fallback);
  if (!path) return { error: "pathTooLong" };
  (deps.makeFallbackDir ?? ((dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 })))(fallback);
  if (!isPrivate(fallback)) throw new Error(`${fallback} must belong to this user, with no access for others`);
  return { path };
}

export function guardPath(socketPath: string): string {
  return `${socketPath}.recover`;
}

const GuardRecord = z.object({ pid: z.number().int().positive(), start: z.number().int().nonnegative(), boot: z.string() });

/** The socket we listen on. Each connection gets our nonce, so we can tell our socket from another. */
export class HeldLock {
  readonly path: string;
  private readonly server: net.Server;

  constructor(path: string, server: net.Server) {
    this.path = path;
    this.server = server;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function listen(path: string, nonce: string): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end(`${nonce}\n`);
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      // macOS answers EEXIST, not EADDRINUSE, for a bind that races another
      // contender's unlink and bind of the same path. Either way the path is taken.
      if (err.code === "EADDRINUSE" || err.code === "EEXIST") resolve(null);
      else reject(err);
    });
    server.listen(path, () => resolve(server));
  });
}

/** What answers at the path: the line it sends, "refused" for a stale socket, or "gone". */
function probe(path: string): Promise<{ answer: string } | "refused" | "gone"> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let data = "";
    let settled = false;
    const done = (value: { answer: string } | "refused" | "gone"): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => done({ answer: data }));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) done({ answer: data.trim() });
    });
    socket.on("end", () => done({ answer: data.trim() }));
    socket.on("connect", () => undefined);
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === "ECONNREFUSED") done("refused");
      else if (err.code === "ENOENT") done("gone");
      // Anything else (a socket that answered and then broke) is someone there.
      else done({ answer: data.trim() });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeGuard(guard: string, self: ProcessIdentity): Promise<boolean> {
  const staging = `${guard}.${randomBytes(6).toString("hex")}`;
  await mkdir(staging, { mode: 0o700 });
  await writeFile(join(staging, "owner.json"), JSON.stringify({ pid: self.pid, start: self.start, boot: self.boot }));
  try {
    // A rename onto a folder that exists and is not empty fails, so only one contender gets it.
    await rename(staging, guard);
    return true;
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES") return false;
    throw err;
  }
}

/** The owner's own removal: moved aside in one step first, so the path is never an empty folder another rename could take. */
async function releaseGuard(guard: string): Promise<void> {
  const aside = `${guard}.done.${randomBytes(6).toString("hex")}`;
  await rename(guard, aside);
  await rm(aside, { recursive: true, force: true });
}

async function readGuard(guard: string): Promise<z.infer<typeof GuardRecord> | "unreadable" | "gone"> {
  let text: string;
  try {
    text = await readFile(join(guard, "owner.json"), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // The guard went between our look and our read, or holds no record.
      try {
        statSync(guard);
        return "unreadable";
      } catch {
        return "gone";
      }
    }
    return "unreadable";
  }
  try {
    const parsed = GuardRecord.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
}

export async function acquireLock(path: string, opts: LockOptions): Promise<LockOutcome> {
  const nonce = randomBytes(16).toString("hex");
  const pause = opts.pause ?? (async () => undefined);
  const claim = opts.claim ?? (async () => true);

  // After listening: the socket must answer with our own nonce, then the
  // owner record decides, and only then does the guard go.
  const own = async (server: net.Server, holdingGuard: boolean): Promise<LockOutcome> => {
    await pause("listening");
    const answer = await probe(path);
    const lock = new HeldLock(path, server);
    const ours = typeof answer === "object" && answer.answer === nonce;
    const claimed = ours && (await claim());
    if (holdingGuard) await releaseGuard(guardPath(path));
    if (!claimed) {
      await lock.close();
      return { ok: false, error: { kind: "alreadyRunning" } };
    }
    return { ok: true, lock };
  };

  if (opts.platform === "win32") {
    // A pipe vanishes with its owner, so a name in use always has one.
    const server = await listen(path, nonce);
    return server ? own(server, false) : { ok: false, error: { kind: "alreadyRunning" } };
  }

  const guard = guardPath(path);
  const deadline = Date.now() + (opts.waitMs ?? 5000);
  for (;;) {
    const server = await listen(path, nonce);
    if (server) return own(server, false);
    const first = await probe(path);
    if (first === "gone") continue;
    if (first !== "refused") return { ok: false, error: { kind: "alreadyRunning" } };
    await pause("refused");

    if (await takeGuard(guard, opts.self)) {
      await pause("guardTaken");
      const again = await probe(path);
      if (typeof again === "object") {
        await releaseGuard(guard);
        return { ok: false, error: { kind: "alreadyRunning" } };
      }
      await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      const mine = await listen(path, nonce);
      if (mine) return own(mine, true);
      // A contender that found no file listened first. It owns the lock now.
      await releaseGuard(guard);
      continue;
    }

    const record = await readGuard(guard);
    await pause("guardRead");
    if (record === "gone") continue;
    if (record === "unreadable") return { ok: false, error: { kind: "guardUnreadable", path: guard } };
    if (!(await stillRunning(record, opts.platform))) return { ok: false, error: { kind: "guardLeft", path: guard } };
    if (Date.now() > deadline) return { ok: false, error: { kind: "alreadyRunning" } };
    // Its owner is recovering the socket. Age never frees a guard, so wait for it.
    await sleep(100 + Math.floor(Math.random() * 200));
  }
}

/** The DM's own choice, behind a confirmation that no other copy is open (D-261113-106). */
export async function deleteGuardFolder(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
