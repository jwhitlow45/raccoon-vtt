import { spawn, type ChildProcess } from "node:child_process";
import { ServerToSupervisor, WINDOWS_KEPT_ENV, type Platform, type ServerEnv, type SupervisorToServer } from "../contract.ts";
import type { Clock } from "./clock.ts";
import type { RotatingLog } from "./logs.ts";

/**
 * The app server, today's server/main.ts, run by the supervisor with the
 * same Node (docs/design/design-v1-local-app.md 2). Its environment is built
 * from nothing, so no NODE_OPTIONS, proxy or PUBLIC_ORIGIN of the DM's
 * reaches it, while Windows keeps the few variables its system calls need.
 * It stops through its IPC channel, since `kill("SIGTERM")` ends a Windows
 * process at once, before it can close its rooms.
 */

export type ServerExit = { code: number | null; signal: NodeJS.Signals | null };

export type ServerHandle = {
  readonly pid: number | undefined;
  readonly exited: Promise<ServerExit>;
  onStatus(listener: (status: ServerToSupervisor) => void): void;
  /** Asks for the graceful shutdown, and ends the process if it has not exited within the grace. */
  stop(graceMs?: number): Promise<ServerExit>;
};

export type ServerSpawnOptions = {
  node: string;
  entry: string;
  cwd: string;
  env: ServerEnv;
  platform: Platform;
  log: RotatingLog;
  clock: Clock;
};

export function serverEnvironment(env: ServerEnv, platform: Platform, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (platform === "win32") {
    for (const name of WINDOWS_KEPT_ENV) {
      const value = from[name];
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

/** The server's own grace is 25 s (server/main.ts), so 30 s covers a slow room's last write. */
export const STOP_GRACE_MS = 30_000;

export function spawnAppServer(opts: ServerSpawnOptions): ServerHandle {
  const child: ChildProcess = spawn(opts.node, [opts.entry], {
    cwd: opts.cwd,
    env: serverEnvironment(opts.env, opts.platform),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const listeners: Array<(status: ServerToSupervisor) => void> = [];
  child.stdout?.on("data", (chunk: Buffer) => opts.log.write(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => opts.log.write(chunk.toString("utf8")));
  child.on("message", (message: unknown) => {
    const parsed = ServerToSupervisor.safeParse(message);
    if (parsed.success) for (const listener of listeners) listener(parsed.data);
  });
  const exited = new Promise<ServerExit>((resolve) => {
    child.once("error", (err) => {
      opts.log.line(`the app server could not start: ${err.message}`);
      resolve({ code: -1, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let stopping: Promise<ServerExit> | null = null;
  return {
    pid: child.pid,
    exited,
    onStatus(listener) {
      listeners.push(listener);
    },
    stop(graceMs = STOP_GRACE_MS) {
      stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return exited;
        const shutdown: SupervisorToServer = { type: "shutdown" };
        try {
          child.send(shutdown);
        } catch {
          // The channel is closed already, which runs the same shutdown.
        }
        const timer = opts.clock.setTimeout(() => child.kill("SIGKILL"), graceMs);
        const result = await exited;
        timer.cancel();
        return result;
      })();
      return stopping;
    },
  };
}

/** Polls /healthz until the server answers, it exits, or the time runs out. */
export async function waitHealthy(port: number, exited: Promise<ServerExit>, clock: Clock, timeoutMs = 60_000): Promise<boolean> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = clock.now() + timeoutMs;
  while (!gone && clock.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await clock.sleep(150);
  }
  return false;
}
