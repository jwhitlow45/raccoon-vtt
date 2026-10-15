import type { ImportOptions, ImportPlan } from "./convert.ts";
import type { Device } from "./limits.ts";
import type { FromWorker, PreparedImage, ReadInfo, Stage, ToWorker } from "./messages.ts";
import type { ReadTarget } from "./steps.ts";

/**
 * The page's side of the Universal VTT worker: one request at a time, as a
 * promise, with progress notes passed to `onProgress`. A worker that dies
 * (out of memory on a huge file, say) rejects whatever was waiting with a
 * plain sentence, so no path ends without an answer.
 */

export type Progress = { stage: Stage; done?: number; total?: number };

type Waiting = { resolve(message: FromWorker): void; reject(err: Error): void };

const CRASHED = "The file could not be read. It may be damaged, or too large for this device.";

export class UvttWorker {
  readonly #worker: Worker;
  #waiting: Waiting | null = null;
  #dead = false;

  constructor(onProgress: (p: Progress) => void) {
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "uvtt-import" });
    this.#worker.addEventListener("message", (e: MessageEvent<FromWorker>) => {
      const message = e.data;
      if (message.t === "progress") {
        onProgress({ stage: message.stage, done: message.done, total: message.total });
        return;
      }
      const waiting = this.#waiting;
      this.#waiting = null;
      if (!waiting) return;
      if (message.t === "error") waiting.reject(new Error(message.message));
      else waiting.resolve(message);
    });
    const fail = () => {
      this.#dead = true;
      const waiting = this.#waiting;
      this.#waiting = null;
      waiting?.reject(new Error(CRASHED));
    };
    this.#worker.addEventListener("error", fail);
    this.#worker.addEventListener("messageerror", fail);
  }

  #ask(message: ToWorker): Promise<FromWorker> {
    if (this.#dead) return Promise.reject(new Error(CRASHED));
    if (this.#waiting) return Promise.reject(new Error("The import is still busy. Wait for it to finish."));
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#worker.postMessage(message);
    });
  }

  async read(file: File, device: Device, target: ReadTarget, options: ImportOptions): Promise<{ info: ReadInfo; plan: ImportPlan | null; problem: string | null }> {
    const answer = await this.#ask({ t: "read", file, device, target, options });
    if (answer.t !== "read") throw new Error(CRASHED);
    return { info: answer.info, plan: answer.plan, problem: answer.problem };
  }

  async convert(options: ImportOptions): Promise<{ plan: ImportPlan | null; problem: string | null }> {
    const answer = await this.#ask({ t: "convert", options });
    if (answer.t !== "converted") throw new Error(CRASHED);
    return { plan: answer.plan, problem: answer.problem };
  }

  async image(): Promise<PreparedImage> {
    const answer = await this.#ask({ t: "image" });
    if (answer.t !== "image") throw new Error(CRASHED);
    return answer.image;
  }

  /** Ends the worker and frees the file it holds. Whatever was waiting is told it was cancelled. */
  terminate(): void {
    this.#worker.terminate();
    this.#dead = true;
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.reject(new DOMException("Cancelled", "AbortError"));
  }
}
