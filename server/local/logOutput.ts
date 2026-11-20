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
 * could end it. Node's own stdout writes each line as it comes and leaves
 * nothing to finish at exit, and a write that fails because the supervisor
 * has gone is dropped: a log line is never worth a crash or a hang.
 */
export function localLogOutput(out: NodeJS.WriteStream = process.stdout): NodeJS.WriteStream {
  out.on("error", () => undefined);
  return out;
}
