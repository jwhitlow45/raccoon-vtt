/**
 * The open PDF as the upload job uses it, and the ways opening or drawing
 * fails (docs/design-v1-pdf-handouts.md 4.1.3 and 4.2.1). The job imports
 * this freely. pdf.js itself loads only with render.ts, which the job
 * imports when a DM picks a PDF.
 */

/** Why a PDF could not be opened, each said in words by the job (4.1.3). */
export type RefusalKind = "reader" | "password" | "invalid" | "xfa";

export class ReaderRefusal extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, detail: string) {
    super(detail);
    this.name = "ReaderRefusal";
    this.kind = kind;
  }
}

/** A page that could not be drawn, or whose image could not be decoded (4.2.1). It is never uploaded. */
export class PageDrawFailure extends Error {
  readonly page: number;
  constructor(page: number, detail: string) {
    super(detail);
    this.name = "PageDrawFailure";
    this.page = page;
  }
}

/** A draw stopped by Cancel upload. */
export class DrawCancelled extends Error {
  constructor() {
    super("The page's drawing was cancelled.");
    this.name = "DrawCancelled";
  }
}

/** An open PDF, as the job uses it. A test hands the job one of its own. */
export type PdfDocument = {
  readonly numPages: number;
  /** The PDF's own title: its XMP `dc:title` and its Info `Title`, as found. */
  readonly title: { xmp: string | null; info: string | null };
  /** Draws a page onto the canvas, its long side PAGE_LONG_SIDE. Throws PageDrawFailure or DrawCancelled. */
  drawPage(pageNumber: number, canvas: HTMLCanvasElement): Promise<void>;
  /** Cancels a draw under way. */
  cancelDraw(): void;
  /** Frees the document's shared caches: fonts and images several pages use (4.2.3). Never while a page draws. */
  cleanup(): Promise<void>;
  /** Ends the document and its worker. */
  destroy(): Promise<void>;
};

/** How long the worker has to load its decoders and pdf.js and say it is ready (4.2.1). */
export const WORKER_READY_MS = 15_000;

/**
 * A dynamic XFA form, which with XFA off draws only a "Please wait" notice
 * on each page, so it is refused (4.1.3). A hybrid form also holds an
 * AcroForm, which draws, so it opens. `info` is pdf.js's metadata.
 */
export function isDynamicXfa(info: Readonly<Record<string, unknown>>): boolean {
  return info.IsXFAPresent === true && info.IsAcroFormPresent !== true;
}
