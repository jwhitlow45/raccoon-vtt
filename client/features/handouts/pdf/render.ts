import { AnnotationMode, getDocument, InvalidPDFException, PasswordException, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { isFromReader, PDF_OPTIONS, type FromReader, type ToReader } from "./options.ts";
import { renderSize } from "./encode.ts";
import { DrawCancelled, isDynamicXfa, PageDrawFailure, ReaderRefusal, WORKER_READY_MS, type PdfDocument } from "./reader.ts";

/**
 * pdf.js for the upload job (docs/design-v1-pdf-handouts.md 4.2): the job's
 * own worker, the document pdf.js opens in it, and one page at a time drawn
 * onto the job's canvas. This module and pdf.js load together by `import()`
 * when a DM picks a PDF, in chunks players and displays never download.
 */

/** Starts the job's worker and waits until it says its decoders and pdf.js are loaded. */
function startWorker(timeoutMs: number): Promise<Worker> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "pdf-reader" });
  return new Promise((resolve, reject) => {
    const done = (err: ReaderRefusal | null) => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (!err) return resolve(worker);
      worker.terminate();
      reject(err);
    };
    const onMessage = (e: MessageEvent<unknown>) => {
      if (!isFromReader(e.data)) return;
      const message: FromReader = e.data;
      if (message.rvtt === "ready") done(null);
      else if (message.rvtt === "failed") done(new ReaderRefusal("reader", `${message.step}: ${message.detail}`));
    };
    const onError = () => done(new ReaderRefusal("reader", "the worker did not start"));
    const timer = setTimeout(() => done(new ReaderRefusal("reader", "the worker did not answer")), timeoutMs);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Opens a PDF's bytes in a fresh worker of the job's own (4.2.1). Every way
 * it can fail is a ReaderRefusal of one kind, and none uploads anything.
 */
export async function openPdf(data: ArrayBuffer, timeoutMs: number = WORKER_READY_MS): Promise<PdfDocument> {
  const worker = await startWorker(timeoutMs);
  let doc: PDFDocumentProxy;
  let pdfWorker: PDFWorker;
  let task: PDFDocumentLoadingTask;
  try {
    // pdf.js runs in this worker as its port, so it never starts one of its own nor falls back to this thread.
    pdfWorker = PDFWorker.create({ port: worker, verbosity: PDF_OPTIONS.verbosity });
    task = getDocument({ ...PDF_OPTIONS, data: new Uint8Array(data), worker: pdfWorker });
    try {
      doc = await task.promise;
    } catch (err) {
      await task.destroy().catch(() => undefined);
      if (err instanceof PasswordException) throw new ReaderRefusal("password", err.message);
      throw new ReaderRefusal("invalid", err instanceof Error ? err.message : String(err));
    }
  } catch (err) {
    worker.terminate();
    throw err instanceof ReaderRefusal ? err : new ReaderRefusal(err instanceof InvalidPDFException ? "invalid" : "reader", String(err));
  }
  const end = async () => {
    await task.destroy().catch(() => undefined);
    pdfWorker.destroy();
    worker.terminate();
  };
  let title: PdfDocument["title"];
  try {
    const { info, metadata } = await doc.getMetadata();
    const fields = info as Record<string, unknown>;
    if (isDynamicXfa(fields)) throw new ReaderRefusal("xfa", "a dynamic XFA form");
    title = { xmp: text(metadata?.get("dc:title")), info: text(fields.Title) };
  } catch (err) {
    await end();
    throw err instanceof ReaderRefusal ? err : new ReaderRefusal("invalid", String(err));
  }

  let failure: string | null = null;
  let drawing: RenderTask | null = null;
  const onMessage = (e: MessageEvent<unknown>) => {
    if (isFromReader(e.data) && e.data.rvtt === "imageFailure") failure ??= e.data.line;
  };
  worker.addEventListener("message", onMessage);
  const tell = (message: ToReader) => worker.postMessage(message);

  return {
    numPages: doc.numPages,
    title,
    async drawPage(pageNumber, canvas) {
      const page = await doc.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const size = renderSize(natural.width, natural.height);
      const viewport = page.getViewport({ scale: size.scale });
      canvas.width = size.width;
      canvas.height = size.height;
      failure = null;
      tell({ rvtt: "drawing", on: true });
      try {
        // White behind a page with no background of its own, and form fields and stamps as a reader draws them. No text or annotation layer.
        drawing = page.render({ canvas, viewport, background: "white", annotationMode: AnnotationMode.ENABLE });
        await drawing.promise;
      } catch (err) {
        if (err instanceof Error && err.name === "RenderingCancelledException") throw new DrawCancelled();
        throw new PageDrawFailure(pageNumber, err instanceof Error ? err.message : String(err));
      } finally {
        drawing = null;
        tell({ rvtt: "drawing", on: false });
        page.cleanup();
      }
      // The worker's line about a failed image arrives before the drawing it belongs to finishes.
      if (failure !== null) throw new PageDrawFailure(pageNumber, failure);
    },
    cancelDraw() {
      drawing?.cancel();
    },
    async cleanup() {
      await doc.cleanup();
    },
    destroy: end,
  };
}

