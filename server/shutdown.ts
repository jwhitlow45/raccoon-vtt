import type { FastifyInstance } from "fastify";

/** The longest a stop may take before the process exits anyway (design 15.4), inside the container's 30 s. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

/**
 * The graceful shutdown (design 15.4), short of the process's exit.
 * `app.close()` closes every socket with 1012, cutting off a client slow to
 * answer, then every HTTP connection (rooms/ws.ts), and once the server has
 * closed lets each room finish its commit and write its snapshot. A socket
 * writes its session's last sight only once its close has finished, so
 * those writes may still be running then. The pool ends after they settle,
 * waiting at most `writesMs` so a slow database cannot hold the deploy, and
 * a write left behind is dropped without a word (rooms/closeWrites.ts).
 *
 * Each step logs when it ends, in ms since the shutdown began, so a stop
 * that hangs shows the step it hangs in.
 */
export async function closeServer(app: FastifyInstance, endPool: () => Promise<void>, opts: { writesMs?: number } = {}): Promise<void> {
  const started = Date.now();
  const step = (msg: string): void => app.log.info({ ms: Date.now() - started }, `shutdown: ${msg}`);
  app.server.once("close", () => step("server closed"));
  await app.close();
  step("rooms closed");
  await app.rooms.closeWrites.close(opts.writesMs ?? 2_000);
  step("socket writes settled");
  await endPool();
  step("pool closed");
}

/**
 * The stop on a signal, ending in the process's exit: 0 once `closeServer`
 * has finished, 1 when it fails or the deadline comes first. A stop that
 * reaches the deadline has not saved every room, so it says so before it
 * exits rather than leaving the log at its last step.
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
  timer.unref();
  try {
    await closeServer(app, endPool);
  } catch (err) {
    clearTimeout(timer);
    app.log.error({ err, ms: Date.now() - started }, "shutdown failed");
    exit(1);
    return;
  }
  clearTimeout(timer);
  app.log.info({ ms: Date.now() - started }, "shut down");
  exit(0);
}
