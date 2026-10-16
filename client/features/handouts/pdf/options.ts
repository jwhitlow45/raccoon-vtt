/**
 * How pdf.js runs for a PDF handout (docs/design-v1-pdf-handouts.md 4.2), in
 * one place, so a test pins every value. Nothing here loads pdf.js: the
 * job's worker imports this file too, and the reader itself loads only when
 * a DM picks a PDF (render.ts).
 */

/** The pinned pdf.js. Its decoders ship in a folder named by it, so a new pin is a new URL (vite.config.ts). */
export const PDFJS_VERSION = "6.3.289";

/** Where the app serves the two plain JavaScript image decoders, from its own origin (4.2.4). */
export const PDFJS_FOLDER = `/pdfjs/${PDFJS_VERSION}/`;

/** The decoders scanned PDFs need: JBIG2 and CCITT fax, and JPEG 2000. */
export const DECODERS = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"] as const;

/** Every page is drawn with its long side this long, as a handout image is stored (4.2.2). */
export const PAGE_LONG_SIDE = 2048;

/**
 * The largest image pdf.js decodes inside a page, in pixels: a 600 dpi scan
 * of a Letter or A4 page (about 35 million) fits, and about 150 MiB as
 * pixels is the most one image holds (4.2.3).
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** A PDF larger than this is refused before it is read. It bounds the input, not the tab (3.7). */
export const PDF_MAX_BYTES = 100 * 1024 * 1024;

/** pdf.js's `VerbosityLevel.WARNINGS`, the level at which its `warn()` writes the lines IMAGE_FAILURES reads. */
const WARNINGS = 1;

/**
 * Every option given to `getDocument` beside the file's bytes and the
 * worker (4.2.4):
 *
 * - no WebAssembly, so no code compiled from a PDF's functions runs;
 * - no XFA, and so no scripting either, since the app never imports pdf.js's sandbox;
 * - warnings on, which is how a page learns that one of its images failed;
 * - the decoders from the app's own folder, and nothing else fetched:
 *   `cMapUrl`, `standardFontDataUrl` and `iccUrl` stay unset;
 * - decoded images bounded, and shrunk in the worker to the canvas's own
 *   area before they reach the page.
 *
 * `stopAtErrors` stays false, so a damaged page draws what it can.
 */
export const PDF_OPTIONS = {
  useWasm: false,
  enableXfa: false,
  verbosity: WARNINGS,
  wasmUrl: PDFJS_FOLDER,
  maxImageSize: MAX_IMAGE_PIXELS,
  canvasMaxAreaInBytes: PAGE_LONG_SIDE * PAGE_LONG_SIDE * 4,
  stopAtErrors: false,
} as const;

/**
 * The warnings that mean a page's image is missing from its drawing
 * (4.2.1): an image whose data could not be decoded, a decoder that failed
 * to load or build, and an image dropped for its size. pdf.js draws the page
 * without the image and only warns, through `console.warn` with this
 * prefix, so the job's worker listens there. A test checks each text against
 * the pinned pdf.js (options.test.ts).
 */
export const IMAGE_FAILURES: readonly RegExp[] = [
  /^Warning: Unable to decode (inline )?image\b/,
  /^Warning: #getJsModule: /,
  /^Warning: #instantiateWasm: /,
  /^Warning: Image exceeded maximum allowed size and was removed\./,
];

/**
 * The line to tell the job, from one `console.warn` call in the worker, or
 * null. Only while a page draws: a warning while the file opens, or between
 * pages, belongs to no page.
 */
export function imageFailure(args: readonly unknown[], drawing: boolean): string | null {
  if (!drawing || typeof args[0] !== "string") return null;
  const line = args[0];
  return IMAGE_FAILURES.some((pattern) => pattern.test(line)) ? line : null;
}

/** What the job's worker tells the page (worker.ts), beside pdf.js's own messages, which carry a `targetName`. */
export type FromReader = { rvtt: "ready" } | { rvtt: "failed"; step: "decoder" | "reader"; detail: string } | { rvtt: "imageFailure"; line: string };

/** What the page tells the job's worker: a page starts or stops drawing. */
export type ToReader = { rvtt: "drawing"; on: boolean };

export function isFromReader(data: unknown): data is FromReader {
  return typeof data === "object" && data !== null && "rvtt" in data;
}

export function isToReader(data: unknown): data is ToReader {
  return typeof data === "object" && data !== null && (data as { rvtt?: unknown }).rvtt === "drawing";
}
