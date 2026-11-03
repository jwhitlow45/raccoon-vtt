import { parentPort } from "node:worker_threads";

/** A stand-in for the walk's worker (check.test.ts) that dies on its request, as a worker out of memory would. */
parentPort?.once("message", () => {
  throw new Error("the stand-in worker failed");
});
