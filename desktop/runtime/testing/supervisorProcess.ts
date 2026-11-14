import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { SupervisorToShell, type Command, type SupervisorStatus } from "../../contract.ts";
import type { CommandOutcome } from "../supervisor.ts";
import { ROOT, postgresDir } from "./cluster.ts";

/**
 * A real supervisor process for the integration tests: headless, on the
 * fetched PostgreSQL, driven over the same IPC channel the shell uses. The
 * app server is the stand-in testing/fakeServer.ts unless a test asks for
 * the real one. Network play is off, so nothing listens beyond loopback.
 */

export const FAKE_SERVER = join(ROOT, "desktop", "runtime", "testing", "fakeServer.ts");

export type SupervisorRun = {
  child: ChildProcess;
  statuses: SupervisorStatus[];
  latest(): SupervisorStatus | null;
  output(): string;
  waitFor(what: string, test: (s: SupervisorStatus) => boolean, timeoutMs?: number): Promise<SupervisorStatus>;
  command(command: Command, timeoutMs?: number): Promise<CommandOutcome>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Stops it cleanly through the stop command and waits for its exit. */
  stop(): Promise<number | null>;
};

export type SupervisorRunOptions = {
  data: string;
  port: number;
  network?: "on" | "off";
  /** Variables for this run, such as RESTORE_TEST_CRASH_AT. */
  env?: Record<string, string>;
  realServer?: boolean;
  /** A path to give --data, when it differs from `data` (an alias). */
  dataArg?: string;
};

export function startSupervisor(opts: SupervisorRunOptions): SupervisorRun {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (!opts.realServer) env.RACCOONVTT_TEST_SERVER_ENTRY = FAKE_SERVER;
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "desktop", "runtime", "main.ts"),
      "--headless",
      "--data",
      opts.dataArg ?? opts.data,
      "--port",
      String(opts.port),
      "--network",
      opts.network ?? "off",
      "--postgres",
      postgresDir(),
    ],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const statuses: SupervisorStatus[] = [];
  const waiters = new Set<() => void>();
  const results = new Map<number, (outcome: CommandOutcome) => void>();
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out = (out + d.toString("utf8")).slice(-200_000)));
  child.stderr?.on("data", (d: Buffer) => (out = (out + d.toString("utf8")).slice(-200_000)));
  child.on("message", (message: unknown) => {
    const parsed = SupervisorToShell.safeParse(message);
    if (!parsed.success) return;
    if (parsed.data.type === "status") {
      statuses.push(parsed.data.status);
      for (const wake of [...waiters]) wake();
    } else {
      results.get(parsed.data.id)?.(parsed.data.outcome as CommandOutcome);
      results.delete(parsed.data.id);
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      for (const wake of [...waiters]) wake();
      resolve({ code, signal });
    });
  });
  let alive = true;
  void exited.then(() => (alive = false));
  let nextId = 1;

  const run: SupervisorRun = {
    child,
    statuses,
    latest: () => statuses.at(-1) ?? null,
    output: () => out,
    waitFor(what, test, timeoutMs = 60_000) {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const hit = statuses.findLast(test);
          const last = statuses.at(-1);
          if (last && test(last)) {
            finish();
            resolve(last);
          } else if (!alive) {
            finish();
            if (hit) resolve(hit);
            else reject(new Error(`the supervisor exited before ${what}. Last status: ${JSON.stringify(last)}\n${out.slice(-4000)}`));
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`no ${what} within ${timeoutMs} ms. Last status: ${JSON.stringify(statuses.at(-1))}\n${out.slice(-4000)}`));
        }, timeoutMs);
        const finish = (): void => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    command(command, timeoutMs = 120_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${command.type} within ${timeoutMs} ms`)), timeoutMs);
        results.set(id, (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
        child.send({ type: "command", id, command });
      });
    },
    exited,
    async stop() {
      if (!alive) return (await exited).code;
      await run.command({ type: "stop" }).catch(() => undefined);
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const { code } = await exited;
      clearTimeout(timer);
      return code;
    },
  };
  return run;
}

/** Kills it as a power cut or a crash would, leaving PostgreSQL running. */
export async function killSupervisor(run: SupervisorRun): Promise<void> {
  run.child.kill("SIGKILL");
  await run.exited;
}
