import { parentPort } from "node:worker_threads";

/**
 * A stand-in for the walk's worker (check.test.ts) that holds its thread in
 * a loop that never reaches a tick, as a walk its budget cannot see would,
 * until the main thread ends it.
 */
parentPort?.once("message", () => {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    // Spins on purpose: the thread must stay busy, not wait.
  }
});
