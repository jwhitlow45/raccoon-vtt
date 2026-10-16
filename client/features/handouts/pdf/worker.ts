import { DECODERS, PDFJS_FOLDER, imageFailure, isToReader, type FromReader } from "./options.ts";

/**
 * The PDF upload job's own worker (docs/design-v1-pdf-handouts.md 4.2.1),
 * which pdf.js runs in as its port. The job starts it and ends it, and
 * hands it to pdf.js only after it says it is ready, so pdf.js never starts
 * a worker of its own and its main-thread fallback never runs.
 *
 * Before pdf.js runs here, each image decoder is loaded and built once from
 * the app's own folder, then let go: a decoder that cannot load or start
 * stops the job when the file opens, not on page 40. pdf.js later imports
 * each by the same URL, which this worker's module map already holds.
 */

const scope = self as unknown as {
  postMessage(message: FromReader): void;
  addEventListener(type: "message", listener: (e: MessageEvent<unknown>) => void): void;
};

let drawing = false;
scope.addEventListener("message", (e) => {
  // pdf.js's own messages carry a target name and are its business.
  if (isToReader(e.data)) drawing = e.data.on;
});

/*
 * pdf.js reports an image it could not decode only through `warn()`, which
 * writes to `console.warn` and offers no event. So the console is wrapped
 * before pdf.js loads, and each line that means a missing image is told to
 * the job while a page draws, which fails that page rather than uploading
 * it without the image.
 */
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const line = imageFailure(args, drawing);
  if (line !== null) scope.postMessage({ rvtt: "imageFailure", line });
  warn(...args);
};

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function start(): Promise<void> {
  for (const name of DECODERS) {
    try {
      const module = (await import(/* @vite-ignore */ `${PDFJS_FOLDER}${name}`)) as { default: () => unknown };
      await module.default();
    } catch (err) {
      scope.postMessage({ rvtt: "failed", step: "decoder", detail: `${name}: ${detail(err)}` });
      return;
    }
  }
  try {
    // Loading it sets pdf.js up on this worker's port.
    await import("pdfjs-dist/build/pdf.worker.mjs");
  } catch (err) {
    scope.postMessage({ rvtt: "failed", step: "reader", detail: detail(err) });
    return;
  }
  scope.postMessage({ rvtt: "ready" });
}

void start();
