/**
 * The database writes a socket makes as it closes: its session's last
 * sight for the DM devices list, and a table display's renewal. A socket
 * makes no HTTP request in its whole life, so these are the only stamps it
 * leaves, and they run after the socket is gone.
 *
 * At shutdown the pool ends after the sockets close (design 15.4), and a
 * client may take a moment to answer the close. A write that started after
 * the pool ended failed with "Cannot use a pool after calling end on the
 * pool" and lost its stamp. So the writes in flight are kept here, shutdown
 * waits a bounded time for them before it ends the pool (server/shutdown.ts),
 * and once it has stopped waiting a write is skipped, or its failure goes
 * unlogged: the process is leaving with its pool. What the stop lost, a
 * write left running or one of its own that failed, makes it fail too.
 */
export class CloseWrites {
  #pending = new Set<Promise<void>>();
  #closed = false;
  #gaveUp = false;
  #stopping = false;
  #failed = 0;

  /** The stop has begun: a write started from now on that fails counts against it (close()). */
  stopping(): void {
    this.#stopping = true;
  }

  /** Starts `write` now, unless shutdown has closed this already. `onError` hears a failure while anyone still waits for it. */
  run(write: () => Promise<unknown>, onError: (err: unknown) => void): void {
    if (this.#closed) return;
    const ours = this.#stopping;
    const done: Promise<void> = write()
      .then(
        () => undefined,
        (err: unknown) => {
          if (this.#gaveUp) return;
          if (ours) this.#failed++;
          onError(err);
        },
      )
      .finally(() => this.#pending.delete(done));
    this.#pending.add(done);
  }

  /** Takes no more writes and waits up to `ms` for those in flight, with how many it left running and how many of the stop's failed. */
  async close(ms: number): Promise<{ left: number; failed: number }> {
    this.#closed = true;
    if (this.#pending.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.#pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
    }
    this.#gaveUp = true;
    return { left: this.#pending.size, failed: this.#failed };
  }
}
