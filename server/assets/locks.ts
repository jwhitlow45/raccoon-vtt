/**
 * Runs async sections one at a time per key, in arrival order.
 *
 * The server is one process, so an in-memory lock is enough to make a
 * read-check-write sequence on Postgres atomic with respect to every other
 * such sequence on the same key. The map only holds keys with work queued, so
 * it never grows past the number of sections in flight.
 */
export class KeyedMutex {
  #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  get activeKeys(): number {
    return this.#tails.size;
  }
}
