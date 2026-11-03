import { parentPort } from "node:worker_threads";

/**
 * A video check that says it started and then never reads its budget,
 * for checkWorker.test.ts: the caller must end it at the deadline.
 */

parentPort!.postMessage({ t: "started" });
for (;;) {
  // Synchronous work that never yields, as a parser loop with no budget read would be.
}
