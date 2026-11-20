import type { FastifyInstance } from "fastify";
import type { UnsavedRoom } from "./rooms/manager.ts";

/** The longest a stop may take before the process exits anyway (design 15.4), inside the container's 30 s. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

/** A step of the stop that failed or ran out of time, as the "shutdown failed" line names it. */
export type StepFailure = { step: "sockets" | "server" | "rooms" | "socket writes" | "pool"; reason: string; rooms?: readonly UnsavedRoom[] };

/** A stop that ran every step it could but lost something on the way, each step's loss in `failures`. */
export class ShutdownFailed extends Error {
  readonly failures: readonly StepFailure[];
  constructor(failures: readonly StepFailure[]) {
    super(`shutdown failed: ${failures.map((f) => `${f.step}: ${f.reason}`).join("; ")}`);
    this.name = "ShutdownFailed";
    this.failures = failures;
  }
}

/**
 * The graceful shutdown (design 15.4), short of the process's exit.
 * `app.close()` closes every socket with 1012, cutting off a client slow to
 * answer (rooms/ws.ts), then every HTTP connection, and once the server has
 * closed lets each room finish its commit and write its snapshot. A socket
 * writes its session's last sight only once its close has finished, so
 * those writes may still be running then. The pool ends after they settle,
 * waiting at most `writesMs` so a slow database cannot hold the deploy.
 *
 * A step that fails or runs out of time never stops the steps after it, so
 * every room still gets its snapshot and the pool still ends. Once all have
 * run, it throws ShutdownFailed naming each loss: a socket still open, a
 * hook that threw, a room not saved, a socket's write left running or
 * failed, the pool.
 *
 * Each step logs when it ends, in ms since `started` (the stop's start), so
 * a stop that hangs shows the step it hangs in.
 */
export async function closeServer(app: FastifyInstance, endPool: () => Promise<void>, opts: { writesMs?: number; started?: number } = {}): Promise<void> {
  const started = opts.started ?? Date.now();
  const step = (msg: string): void => app.log.info({ ms: Date.now() - started }, `shutdown: ${msg}`);
  const failures: StepFailure[] = [];
  app.server.once("close", () => step("server closed"));
  try {
    await app.close();
  } catch (err) {
    failures.push({ step: "server", reason: `a close hook failed: ${String(err)}` });
  }
  // The socket layer cut off every socket that missed its grace, so one still open never reported its close.
  const open = app.websocketServer.clients.size;
  if (open > 0) failures.push({ step: "sockets", reason: `${open} still open after being cut off` });
  const rooms = app.rooms.unsavedAtClose;
  if (rooms === null) failures.push({ step: "rooms", reason: "the rooms never closed" });
  else if (rooms.length > 0) failures.push({ step: "rooms", reason: `${rooms.length} not saved`, rooms });
  step("rooms closed");
  const writes = await app.rooms.closeWrites.close(opts.writesMs ?? 2_000);
  if (writes.left > 0 || writes.failed > 0) failures.push({ step: "socket writes", reason: `${writes.left} left running, ${writes.failed} failed` });
  step("socket writes settled");
  try {
    await endPool();
  } catch (err) {
    failures.push({ step: "pool", reason: String(err) });
  }
  step("pool closed");
  if (failures.length > 0) throw new ShutdownFailed(failures);
}

/**
 * The stop on a signal, ending in the process's exit: 0 once `closeServer`
 * has finished, 1 when it fails or the deadline comes first. A stop that
 * reaches the deadline has not saved every room, so it says so before it
 * exits rather than leaving the log at its last step. The deadline's timer
 * keeps the process alive, so a stop stuck on a promise that nothing will
 * settle still reaches it rather than exiting 0 when nothing is left to run.
 */
export async function shutDown(
  app: FastifyInstance,
  endPool: () => Promise<void>,
  opts: { deadlineMs?: number; exit?: (code: number) => void } = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const started = Date.now();
  const timer = setTimeout(() => {
    app.log.error({ ms: Date.now() - started }, "shutdown did not finish in time: forced exit");
    exit(1);
  }, opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
  try {
    await closeServer(app, endPool, { started });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof ShutdownFailed) app.log.error({ failed: err.failures, ms: Date.now() - started }, "shutdown failed");
    else app.log.error({ err, ms: Date.now() - started }, "shutdown failed");
    exit(1);
    return;
  }
  clearTimeout(timer);
  app.log.info({ ms: Date.now() - started }, "shut down");
  exit(0);
}
