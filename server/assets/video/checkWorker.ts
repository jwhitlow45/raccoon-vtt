import { parentPort, workerData } from "node:worker_threads";
import { checkVideoHere, failureOf, type CheckMessage } from "./check.ts";
import { Budget } from "./window.ts";

/**
 * The video header check's thread (check.ts checkVideo, D-261102-539). It
 * says when its modules have loaded, so the deadline the caller keeps
 * starts with the budget here, then answers the facts or the refusal.
 */

const { path, budgetMs } = workerData as { path: string; budgetMs: number };
const post = (message: CheckMessage) => parentPort!.postMessage(message);

post({ t: "started" });
try {
  post({ t: "done", facts: await checkVideoHere(path, new Budget(budgetMs)) });
} catch (err) {
  post({ t: "failed", failure: failureOf(err) });
}
