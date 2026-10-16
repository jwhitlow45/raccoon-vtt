import { createStore, type StoreApi } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import { ApiError } from "../../../lib/api.ts";
import { pageCountText } from "../handouts.ts";
import { scopeSlot } from "../../../state/scope.ts";
import type { Ledger, UncertainPage } from "./ledger.ts";
import { PDF_MAX_BYTES } from "./options.ts";
import type { RefusalKind } from "./reader.ts";

/**
 * A PDF upload (docs/design-v1-pdf-handouts.md 4.1): its state, the rules
 * that need no browser, and its words. One job per device, in the room's
 * scope, so it outlives the DM panel and the form, and the room page can
 * badge it. run.ts drives it.
 */

/** A page uploaded: its PDF page number, its image and size, and whether this upload made the image (3.9). */
export type JobPage = { page: number; assetId: string; width: number; height: number; created: boolean };

/** Why the job waits on the DM partway (4.1.6). */
export type Stop =
  | { k: "offline" }
  | { k: "busy" }
  | { k: "rateLimited"; minutes: number }
  | { k: "quota" }
  | { k: "drawFailed" }
  | { k: "tooLarge" }
  | { k: "notDm" }
  | { k: "failed"; words: string };

export type Phase =
  /** Loading the reader and opening the file. */
  | { k: "loading" }
  /** The file could not be opened (4.1.3). Nothing was uploaded. */
  | { k: "refused"; kind: RefusalKind }
  /** Open: the range and the title, before anything uploads. */
  | { k: "range" }
  | { k: "preparing"; waiting: boolean }
  | { k: "paused"; page: number; stop: Stop }
  | { k: "titleInvalid" }
  /** The create sent and its answer awaited. The block says when it waits for the connection. */
  | { k: "saving" }
  /** An `unknown` answer, waiting on the snapshot that settles it (4.1.5). */
  | { k: "checking"; what: "save" | "delete" }
  | { k: "saveFailed"; words: string; gone: boolean }
  | { k: "saved" }
  | { k: "cancelling" }
  | { k: "cancelled"; removed: number; failed: boolean; stillSaved: boolean }
  /** Every page of the range left out: no create is sent (4.1.6). */
  | { k: "empty" }
  /** A ledger this device found from an upload that did not finish (4.1.2). */
  | { k: "recovery"; ledger: Ledger }
  /** Remove them pressed: the recovery's pages being deleted. Nothing is uploading, so there is nothing to cancel. */
  | { k: "removing" }
  | { k: "recovered"; removed: number | null; failed: boolean };

export type PdfJob = {
  /** The file's name, or the ledger's title in a recovery, which has no file. */
  fileName: string;
  /** The document's id, chosen before anything uploads (4.1.5). */
  docId: string;
  /** The block's Title field. */
  title: string;
  numPages: number;
  /** The range fields as typed. */
  from: string;
  to: string;
  /** The range being uploaded, once Upload is pressed. */
  range: { from: number; to: number } | null;
  /** The pages uploaded so far, in page order. */
  pages: JobPage[];
  /** Pages the DM left out, by PDF page number. */
  leftOut: number[];
  phase: Phase;
  /** A page whose upload never answered, named in the summary and the recovery (4.1.6). */
  uncertain: UncertainPage | null;
  /** What the block's polite status line says: the start, each pause or stop, and the end, never every page (4.1.4). */
  announce: string;
  /** Bumped with each announcement, so the same words said twice are heard twice. */
  announced: number;
};

export type JobSlotState = { job: PdfJob | null; blockShown: boolean };

/** What a running job does, as the slot keeps it: run.ts's runner. */
export type JobControl = { dispose(): void };

/**
 * The room's one job (4.1.1). The runner lives beside the state, so the job
 * goes on with the DM panel closed, and stops with the room.
 */
export const pdfJobSlot = scopeSlot(
  (): { store: StoreApi<JobSlotState>; runner: JobControl | null } => ({
    store: createStore<JobSlotState>(() => ({ job: null, blockShown: false })),
    runner: null,
  }),
  (slot) => slot.runner?.dispose(),
);

/** How long Cancel gives an upload already sending to answer before it aborts it (4.1.6). */
export const CANCEL_GRACE_MS = 10_000;

/**
 * The pause a job takes for other devices on the room's one upload slot
 * (4.1.4): a little longer than their 503 retries, so the next one finds the
 * slot free. It comes once SHARE_EVERY_MS have passed since the last, not
 * after a count of pages: on a slow link a few pages already take longer
 * than another device's minute of retries, and time bounds its wait there.
 * On a fast link it costs an eighth of the time, about 40 s over a 100-page
 * PDF that takes five minutes.
 */
export const SHARE_PAUSE_MS = 2_500;
export const SHARE_EVERY_MS = 20_000;

/** The document's caches are cleaned every few pages, and after a page that took long to draw (4.2.3). */
export const CLEANUP_EVERY_PAGES = 5;
export const SLOW_DRAW_MS = 3_000;

/** Whether the job pauses for other devices before its next upload, `sinceMs` after its last pause or its start. */
export function sharePause(sinceMs: number, othersOnline: boolean, remaining: number): boolean {
  return othersOnline && remaining > 0 && sinceMs >= SHARE_EVERY_MS;
}

/** The range's PDF page numbers still to upload, in order: not left out, not uploaded. */
export function pagesToDo(job: Pick<PdfJob, "range" | "pages" | "leftOut">): number[] {
  if (!job.range) return [];
  const done = new Set(job.pages.map((p) => p.page));
  const out: number[] = [];
  for (let page = job.range.from; page <= job.range.to; page++) if (!done.has(page) && !job.leftOut.includes(page)) out.push(page);
  return out;
}

/** The pages of the range the job will upload, left-out ones not counted. */
export function rangeTotal(job: Pick<PdfJob, "range" | "leftOut">): number {
  if (!job.range) return 0;
  return job.range.to - job.range.from + 1 - job.leftOut.filter((p) => p >= job.range!.from && p <= job.range!.to).length;
}

/** A page's place in the upload, for "Preparing page 3 of 12…": its count among the pages uploaded or to upload. */
export function pagePosition(job: Pick<PdfJob, "range" | "leftOut">, page: number): number {
  if (!job.range) return 0;
  let at = 0;
  for (let p = job.range.from; p <= page; p++) if (!job.leftOut.includes(p)) at++;
  return at;
}

const n = (value: number) => value.toLocaleString("en-US");
const pagesWord = pageCountText;

/**
 * The fields' rules (4.1.3). A broken rule is said on the field that
 * breaks it, which marks that field invalid and points it at the words: a
 * rule of the range as a whole (its order, its size, the room's pages) on
 * To page, the end that sets the count.
 */
export type RangeCheck = { ok: true; from: number; to: number; count: number } | { ok: false; from: string | null; to: string | null };

export function checkRange(fromText: string, toText: string, numPages: number, roomPages: number): RangeCheck {
  const whole = (text: string) => (/^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null);
  const from = whole(fromText);
  const to = whole(toText);
  const fieldProblem = (name: string, value: number | null) =>
    value === null ? `${name} takes a whole number.` : value < 1 ? `${name} is at least 1.` : value > numPages ? `${name} is at most ${n(numPages)}.` : null;
  const fromProblem = fieldProblem("From page", from);
  const toProblem = fieldProblem("To page", to);
  if (fromProblem || toProblem || from === null || to === null) return { ok: false, from: fromProblem, to: toProblem };
  const range = (words: string): RangeCheck => ({ ok: false, from: null, to: words });
  if (from > to) return range("From page comes before To page.");
  const count = to - from + 1;
  if (count > LIMITS.handoutPages) return range(`A handout holds up to ${LIMITS.handoutPages} pages. Choose at most ${LIMITS.handoutPages}.`);
  const room = LIMITS.handoutPagesPerRoom - roomPages;
  if (count > room) {
    const held = `The room holds ${n(roomPages)} of its ${n(LIMITS.handoutPagesPerRoom)} handout pages.`;
    return range(room > 0 ? `${held} Choose at most ${n(room)}, or delete a document.` : `${held} Delete a document or close a handout first.`);
  }
  return { ok: true, from, to, count };
}

/** Where the fields start: every page, or the first 100 of a longer PDF. */
export function defaultRange(numPages: number): { from: string; to: string } {
  return { from: "1", to: String(Math.min(numPages, LIMITS.handoutPages)) };
}

/** Why an upload stopped, from its error: a pause the DM can resume, or a stop (4.1.6). Null for an abort. */
export function stopFor(err: unknown): Stop | null {
  if (err instanceof DOMException && err.name === "AbortError") return null;
  if (!(err instanceof ApiError)) return err instanceof Error && err.name === "AbortError" ? null : { k: "failed", words: "The page could not be uploaded." };
  if (err.status === 0) return { k: "offline" };
  if (err.status === 503) return { k: "busy" };
  if (err.status === 429) return { k: "rateLimited", minutes: Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 60_000)) };
  if (err.code === "quota_exceeded" || err.code === "read_only" || err.code === "disk_full") return { k: "quota" };
  if (err.status === 413) return { k: "tooLarge" };
  if (err.status === 401 || err.status === 403) return { k: "notDm" };
  return { k: "failed", words: err.message };
}

/** Whether a stop is one the job resumes with Try again, rather than one it can only be cancelled from. */
export function canTryAgain(stop: Stop): boolean {
  return stop.k !== "tooLarge" && stop.k !== "notDm";
}

/** Whether a stop offers Leave this page out. */
export function canLeaveOut(stop: Stop): boolean {
  return stop.k === "drawFailed" || stop.k === "tooLarge";
}

/**
 * Whether a picked file starts a PDF upload (4.1.3): a PDF's type, or no
 * type or a generic one with a `.pdf` name, as some Android pickers send.
 * A file with an image type takes the image path whatever its name.
 */
export function isPdfFile(file: { type: string; name: string }): boolean {
  if (file.type === "application/pdf") return true;
  return (file.type === "" || file.type === "application/octet-stream") && /\.pdf$/i.test(file.name);
}

/**
 * The job waits on the DM: what badges the DM panel and toasts while the
 * block is out of sight (4.1.1). A refusal and a PDF opened to its range
 * wait too, since a DM may close the panel while the reader loads.
 */
export function waitsOnDm(job: PdfJob | null): boolean {
  const k = job?.phase.k;
  return k === "paused" || k === "titleInvalid" || k === "saveFailed" || k === "empty" || k === "recovery" || k === "refused" || k === "range";
}

/**
 * A job that leaving the page would cut short: one with work under way or
 * pages in the library. A summary, a refusal or a range with nothing
 * uploaded loses nothing.
 */
export function jobActive(job: PdfJob | null): boolean {
  if (!job) return false;
  switch (job.phase.k) {
    case "refused":
    case "saved":
    case "cancelled":
    case "recovery":
    case "recovered":
      return false;
    case "range":
    case "empty":
      return job.pages.length > 0;
    default:
      return true;
  }
}

/** A job still holding the upload slot of "One PDF at a time": anything but a finished summary or a refusal. */
export function jobHolds(job: PdfJob | null): boolean {
  if (!job) return false;
  const k = job.phase.k;
  return k !== "saved" && k !== "cancelled" && k !== "recovered" && k !== "refused";
}

/** The images a running job made or reused, which are not loose on this device (4.1.2): the Library tags them, and Clean up and From the library leave them out. */
export function jobPageIds(job: PdfJob | null): ReadonlySet<string> {
  if (!job || job.phase.k === "saved" || job.phase.k === "cancelled" || job.phase.k === "recovered") return EMPTY;
  return new Set(job.pages.map((p) => p.assetId));
}

const EMPTY: ReadonlySet<string> = new Set();

// Words (4.1.3 to 4.1.6).

export const REFUSALS: Record<RefusalKind, string> = {
  reader: "The PDF reader could not start here. Check your connection, then try again. If it keeps failing, update the browser or use a computer.",
  password: "This PDF has a password. Save a copy without one, then upload that.",
  invalid: "This PDF could not be read. It may be damaged.",
  xfa: "This PDF is an XFA form, which cannot be shown here. Print it to a new PDF, then upload that.",
};

export const PDF_TOO_LARGE = "PDFs up to 100 MB can be used.";

export function onePdfAtATime(job: PdfJob): string {
  if (job.phase.k === "recovery") return `One PDF at a time. Remove or keep the pages of ${job.fileName} first.`;
  if (job.phase.k === "removing") return `One PDF at a time. Wait until the pages of ${job.fileName} are removed.`;
  return `One PDF at a time. Cancel ${job.fileName}, or wait for it.`;
}

/** Why a picked PDF does not start a job, before a byte of it is read, or null when it does (4.1.1, 4.1.3). */
export function pdfPickRefusal(file: { size: number }, job: PdfJob | null): string | null {
  if (file.size > PDF_MAX_BYTES) return PDF_TOO_LARGE;
  return job && jobHolds(job) ? onePdfAtATime(job) : null;
}

/** "Strange letter.pdf, 12 pages." and, past 100, the sentence that asks for a range. */
export function openedWords(job: Pick<PdfJob, "fileName" | "numPages">): string[] {
  const out = [`${job.fileName}, ${pagesWord(job.numPages)}.`];
  if (job.numPages > LIMITS.handoutPages) out.push(`This PDF has ${n(job.numPages)} pages. A handout holds up to ${LIMITS.handoutPages}, so choose which.`);
  return out;
}

/** The range's button: its count of pages, or "Upload pages" while the range breaks a rule and has none. */
export function uploadLabel(count: number | null): string {
  return count === null ? "Upload pages" : `Upload ${pagesWord(count)}`;
}

/** "Preparing page 3 of 12…", 3 being the first page not yet uploaded, counted within the upload. */
export function progressWords(job: PdfJob): string {
  const next = pagesToDo(job)[0];
  const total = rangeTotal(job);
  const at = next === undefined ? total : pagePosition(job, next);
  return `Preparing page ${n(at)} of ${n(total)}…`;
}

/**
 * What a pause or stop says. Pages are named by their number in the PDF,
 * so the DM can find them there, in the block and in the toast alike.
 */
export function stopWords(job: PdfJob, page: number, stop: Stop): string {
  const total = rangeTotal(job);
  switch (stop.k) {
    case "offline":
      return `The upload stopped at page ${n(page)}. Check your connection.`;
    case "busy":
      return "The server is busy.";
    case "rateLimited":
      return `Too many uploads this hour. Try again in ${stop.minutes === 1 ? "1 minute" : `${n(stop.minutes)} minutes`}.`;
    case "quota":
      return `The room's storage is full, after ${n(job.pages.length)} of ${n(total)} pages. Free space in the Library, then try again.`;
    case "drawFailed":
      return `Page ${n(page)} could not be drawn.`;
    case "tooLarge":
      return `Page ${n(page)} is too large to upload.`;
    case "notDm":
      return "You are no longer a DM here.";
    case "failed":
      return stop.words;
  }
}

/** What the toast says for a pause or stop, which also tells the DM where to go on. */
export function stopToast(job: PdfJob, page: number, stop: Stop): string {
  if (stop.k === "notDm") return "The PDF upload stopped: you are no longer a DM here.";
  return `The PDF upload paused at page ${n(page)}. Open Handouts in the DM panel to go on.`;
}

/**
 * The line while the save is sent or checked (4.1.5). A check waits for the
 * connection's next snapshot, so while there is no connection it says that,
 * rather than seeming to check forever.
 */
export function savingWords(phase: "saving" | "checking", connected: boolean): string {
  if (phase === "checking") return connected ? "Checking whether the handout saved…" : "Waiting for the connection to check whether the handout saved.";
  return connected ? "Saving the handout…" : "Waiting for the connection to save.";
}

export function savedWords(job: PdfJob): string[] {
  const out = [`Saved as ${job.title.trim()}, ${pagesWord(job.pages.length)}.`];
  const left = job.leftOut.filter((p) => job.range && p >= job.range.from && p <= job.range.to);
  if (left.length === 1) out.push(`Page ${n(left[0]!)} was left out.`);
  else if (left.length > 1) out.push(`Pages ${left.map(n).join(", ")} were left out.`);
  return out;
}

/** "Page 7 was uploading and may remain in the library as a loose handout image, 1583 × 2048 px." */
export function uncertainWords(u: UncertainPage, recovery = false): string {
  return recovery
    ? `Page ${n(u.page)} may also be there, a loose handout image of ${u.width} × ${u.height} px.`
    : `Page ${n(u.page)} was uploading and may remain in the library as a loose handout image, ${u.width} × ${u.height} px.`;
}

export function cancelledWords(job: PdfJob, phase: Extract<Phase, { k: "cancelled" }>): string[] {
  const out: string[] = [];
  if (phase.stillSaved) out.push(`${job.title.trim()} was saved and could not be deleted. Delete it in the Library.`);
  else if (phase.failed) out.push("The pages could not be removed. Check your connection. This device offers to remove them next time.");
  // Reused images stay in the library, so a Cancel with none of its own to remove says that, not that nothing is left.
  else out.push(phase.removed === 0 ? "Nothing needed removing." : `Removed ${pagesWord(phase.removed)}.`);
  if (job.uncertain) out.push(uncertainWords(job.uncertain));
  return out;
}

export function recoveryWords(ledger: Ledger): string[] {
  const out = [ledger.ids.length > 0 ? `A PDF upload did not finish: ${ledger.title}, ${pagesWord(ledger.ids.length)} ${ledger.ids.length === 1 ? "is" : "are"} in the library.` : `A PDF upload did not finish: ${ledger.title}.`];
  if (ledger.uncertain) out.push(uncertainWords(ledger.uncertain, true));
  return out;
}

export function recoveredWords(phase: Extract<Phase, { k: "recovered" }>): string {
  if (phase.failed) return "The pages could not be removed. Check your connection, then try again next time.";
  if (phase.removed === null) return "The pages stay in the library as loose images.";
  return phase.removed === 0 ? "Nothing needed removing." : `Removed ${pagesWord(phase.removed)}.`;
}

export function savedToast(job: PdfJob): string {
  return `${job.title.trim()} is saved, ${pagesWord(job.pages.length)}.`;
}
