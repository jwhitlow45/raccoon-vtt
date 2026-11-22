/**
 * Local mode's log output: this process's stdout, which the desktop app's
 * supervisor reads into server.log (docs/design/design-v1-local-app.md 4).
 *
 * The supervisor can die first, a crash or a kill, and the stdout pipe then
 * has no reader. pino's own stdout destination (sonic-boom 4.2.1) queues a
 * line and writes it later, and at the process's exit it writes what is
 * still queued in a loop that retries any failed write, EPIPE included,
 * every 100 ms forever. A stop that logged its last steps just before its
 * exit then never exited, and its event loop was blocked, so no deadline
 * could end it. Node's own stdout writes each line as it comes and never
 * blocks the exit, and a write that fails because the supervisor has gone
 * is dropped: a log line is never worth a crash or a hang. It can still
 * hold lines a full pipe has not taken, which `exitAfterLogs` waits for.
 */
export function localLogOutput(out: NodeJS.WriteStream = process.stdout): NodeJS.WriteStream {
  out.on("error", () => undefined);
  return out;
}

/**
 * The longest local mode's exit waits for its last log lines. The stop's
 * own deadline is 25 s (server/shutdown.ts), and the supervisor kills the
 * server 30 s after asking it to stop (desktop/runtime/appServer.ts), so the
 * wait ends inside that.
 */
export const LOG_FLUSH_MS = 2_000;

/**
 * Local mode's exit, once the log lines before it are out. Node's stdout to
 * a pipe holds a write the pipe has no room for yet (it does on macOS), and
 * `process.exit` drops it, so with a reader slow to read, the stop's last
 * lines ("shut down", or "shutdown failed" naming the rooms not saved)
 * never reached server.log. An empty write calls back once every write
 * before it has finished, or failed because the reader is gone. A reader
 * still there that never reads gets `flushMs`, then the lines are lost.
 */
export function exitAfterLogs(code: number, flushMs = LOG_FLUSH_MS): void {
  const end = (): never => process.exit(code);
  setTimeout(end, flushMs).unref();
  process.stdout.write("", end);
}
