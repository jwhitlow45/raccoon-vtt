import { MODEL_LIMITS } from "#shared/limits.ts";
import { MODEL_WORDS, type DrawnSheet, type FromModelWorker, type ModelDevice, type ModelOptions, type ModelStage, type ToModelWorker } from "./mesh.ts";

export type { DrawnSheet, ModelColor, ModelDevice, ModelOptions, ModelStage } from "./mesh.ts";

/**
 * The page's side of the model worker (docs/design/design-v1-token-models.md
 * 5 and 11): `drawModel(file, options)` reads a file and draws its sheet,
 * and the 3D model sheet loads this module by `import()`, so neither the
 * worker nor three.js costs anything until someone adds a model. This is
 * the only module that makes the worker.
 *
 * One worker at a time, one request in it at a time. It keeps the last file
 * it read, so a change of Color, Size or which way is up draws again
 * without reading again. A second request for the same file while one
 * draws waits, and only the newest waits: an older waiting one is
 * cancelled. A request for another file ends the worker at once, as does a
 * request's signal, the 20 s watchdog and `endModelWorker()`. Every
 * request ends in its sheet, a refusal's sentence, or an AbortError.
 */

export type DrawOptions = ModelOptions & {
  /** Cancel ends the worker at once, and the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** "reading", then "drawing": the sheet's "Reading the file…" and "Drawing its 8 views…". */
  onStage?: (stage: ModelStage) => void;
  /** This device, for the GLB caps. By default the sound decode budget's test. */
  device?: ModelDevice;
};

/** A phone or a tablet: a touch screen and no fine pointer, as the sound decode budget tells them. */
export function modelDevice(): ModelDevice {
  const touch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const fine = typeof matchMedia === "function" && matchMedia("(any-pointer: fine)").matches;
  return touch && !fine ? "touch" : "computer";
}

type Request = {
  id: number;
  file: File;
  options: DrawOptions;
  resolve(sheet: DrawnSheet): void;
  reject(err: Error): void;
  /** Takes the request's listener off its signal and clears its watchdog. */
  cleanup(): void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Whether its message carried the file, so a refusal means the worker holds none. */
  sentFile: boolean;
};

let worker: Worker | null = null;
/** The file the live worker has read, or null when it holds none. */
let held: File | null = null;
let running: Request | null = null;
let waiting: Request | null = null;
let nextId = 1;

const aborted = () => new DOMException("Cancelled", "AbortError");

function settle(request: Request, outcome: { sheet: DrawnSheet } | { err: Error }): void {
  request.cleanup();
  if ("sheet" in outcome) request.resolve(outcome.sheet);
  else request.reject(outcome.err);
}

/** Ends the worker. The running request ends with `err`, and the waiting one too when `waitingToo`. */
function end(err: Error, waitingToo: boolean): void {
  worker?.terminate();
  worker = null;
  held = null;
  const was = running;
  running = null;
  if (was) settle(was, { err });
  if (waitingToo && waiting) {
    const w = waiting;
    waiting = null;
    settle(w, { err });
  }
}

function spawn(): Worker {
  const made = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "model-draw" });
  made.addEventListener("message", (e: MessageEvent<FromModelWorker>) => {
    if (made !== worker) return;
    const message = e.data;
    const request = running;
    if (!request || message.id !== request.id) return;
    if (message.t === "stage") {
      request.options.onStage?.(message.stage);
      return;
    }
    running = null;
    if (message.t === "drawn") {
      const { t: _t, id: _id, ...sheet } = message;
      settle(request, { sheet });
    } else {
      if (request.sentFile) held = null;
      settle(request, { err: new Error(message.message) });
    }
    startWaiting();
  });
  // A worker that dies, out of memory on a huge file say, ends what it held.
  const crashed = () => {
    if (made === worker) end(new Error(MODEL_WORDS.crashed), true);
  };
  made.addEventListener("error", crashed);
  made.addEventListener("messageerror", crashed);
  return made;
}

function start(request: Request): void {
  worker ??= spawn();
  running = request;
  request.sentFile = held !== request.file;
  held = request.file;
  request.timer = setTimeout(() => {
    if (running === request) end(new Error(MODEL_WORDS.tooLong), true);
  }, MODEL_LIMITS.drawMs);
  const { color, up, front, size } = request.options;
  const message: ToModelWorker = { t: "draw", id: request.id, file: request.sentFile ? request.file : null, device: request.options.device ?? modelDevice(), options: { color, up, front, size } };
  worker.postMessage(message);
}

function startWaiting(): void {
  if (running || !waiting) return;
  const next = waiting;
  waiting = null;
  start(next);
}

/** Reads `file` (or reuses what the worker read of it) and draws its sheet with `options`. */
export function drawModel(file: File, options: DrawOptions): Promise<DrawnSheet> {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const request: Request = { id: nextId++, file, options, resolve, reject, timer: null, sentFile: false, cleanup: () => {} };
    const onAbort = () => {
      if (running === request) {
        end(aborted(), false);
        startWaiting();
      } else if (waiting === request) {
        waiting = null;
        settle(request, { err: aborted() });
      }
    };
    request.cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (request.timer !== null) clearTimeout(request.timer);
      request.timer = null;
    };
    signal?.addEventListener("abort", onAbort);
    if (running && running.file !== file) end(aborted(), true);
    if (waiting) {
      const older = waiting;
      waiting = null;
      settle(older, { err: aborted() });
    }
    if (running) waiting = request;
    else start(request);
  });
}

/** Ends the worker and frees the file it holds. Whatever was running or waiting rejects with an AbortError. */
export function endModelWorker(): void {
  end(aborted(), true);
}
