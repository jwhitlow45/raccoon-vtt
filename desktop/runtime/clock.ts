/**
 * Time, as the supervisor sees it. Every wait and timer goes through here,
 * so the randomized test (supervisor.random.test.ts) can run many event
 * orders in fake time.
 */
export type Timer = { cancel(): void };

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  sleep(ms: number): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
