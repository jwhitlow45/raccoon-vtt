/** A step that did not finish within its bound. The work may still finish later, and nobody waits for it. */
export class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}

/** Waits at most `ms` for `work`, so a stalled room actor or pool costs a known refusal rather than an unbounded wait. */
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimedOut()), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
