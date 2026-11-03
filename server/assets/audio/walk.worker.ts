import { parentPort } from "node:worker_threads";
import { walkMp3 } from "#shared/audio/mp3.ts";
import type { WalkAnswer, WalkRequest } from "./check.ts";

/**
 * The frame walk off the main thread (server/assets/audio/check.ts,
 * D-261102-539): one walk a worker, over bytes the main thread transferred,
 * with its own clock checked inside the walk. The main thread also ends the
 * worker at its deadline, so a walk that never reaches a tick still ends.
 */

class OverBudget extends Error {}

const port = parentPort;
if (!port) throw new Error("the walk worker runs only as a worker");

port.once("message", (request: WalkRequest) => {
  const deadline = performance.now() + request.budgetMs;
  let answer: WalkAnswer;
  try {
    const walk = walkMp3(request.bytes, {
      tick: () => {
        if (performance.now() >= deadline) throw new OverBudget();
      },
    });
    // The offsets stay here: the server stores none of them, and they would be copied back for nothing.
    answer = walk.ok
      ? { kind: "walked", walk: { ok: true, facts: { rateHz: walk.facts.rateHz, kbps: walk.facts.kbps, channels: walk.facts.channels, frames: walk.facts.frames, ms: walk.facts.ms } } }
      : { kind: "walked", walk: { ok: false, code: walk.code, why: walk.why } };
  } catch (err) {
    if (!(err instanceof OverBudget)) throw err;
    answer = { kind: "budget" };
  }
  port.postMessage(answer);
});
