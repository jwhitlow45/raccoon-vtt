import type { StoreApi } from "zustand/vanilla";
import { roomHandoutPages } from "#shared/handouts.ts";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp, OpOf } from "#shared/protocol.ts";
import type { AssetRow, UploadOptions } from "../../../lib/api.ts";
import type { OnAnswer, OpAnswer, OpRefusal, RoomView, UnknownCause } from "../../../state/types.ts";
import type { Encoded } from "./encode.ts";
import {
  CANCEL_GRACE_MS,
  CLEANUP_EVERY_PAGES,
  SHARE_PAUSE_MS,
  SLOW_DRAW_MS,
  REFUSALS,
  cancelledWords,
  checkRange,
  defaultRange,
  openedWords,
  pagesToDo,
  recoveredWords,
  recoveryWords,
  savedToast,
  savedWords,
  sharePause,
  stopFor,
  stopToast,
  stopWords,
  type JobControl,
  type JobPage,
  type JobSlotState,
  type PdfJob,
  type Phase,
  type Stop,
} from "./job.ts";
import { clearLedger, ledgerKey, writeLedger, type Ledger, type LedgerStorage, type UncertainPage } from "./ledger.ts";
import { DrawCancelled, ReaderRefusal, type PdfDocument } from "./reader.ts";
import { pdfTitle, titleProblem } from "./title.ts";

/**
 * Drives a PDF upload (docs/design-v1-pdf-handouts.md 4.1): opening the
 * file, drawing and uploading each page of the range, saving the document
 * under the id chosen first, and every way to pause, stop, cancel and go
 * on. It writes the job's state into the room's job store, which the block
 * draws, and lives in the room's scope beside it, so closing the DM panel
 * keeps it running. Everything it touches outside comes in through JobDeps,
 * so a test drives it with fakes.
 */

/**
 * The room as the job reads it. `view` is optimistic, with this device's
 * pending ops applied, which is right for the limits a new upload checks.
 * `savedDocs` is the confirmed state's documents, what the server is known
 * to hold, which is what decides whether a save happened (4.1.5): a pending
 * Library delete hides a saved document from the view, not from the server.
 */
export type RoomRead = {
  view: RoomState | null;
  savedDocs: Readonly<Record<string, unknown>> | null;
  online: readonly string[];
  connection: string;
  snapshots: number;
};

/** The job's read of the room's store state. A view with no confirmed state, a player preview's, has only its view to go by. */
export function roomReadOf(s: Pick<RoomView, "view" | "confirmed" | "online" | "connection" | "snapshots">): RoomRead {
  const saved = s.confirmed === undefined ? s.view : s.confirmed;
  return { view: s.view, savedDocs: saved ? (saved.handoutDocs ?? {}) : null, online: s.online, connection: s.connection, snapshots: s.snapshots ?? 0 };
}

/** The image delete's answer (images/library.ts deleteImages). */
export type Deleted = { deleted: number; inUse: boolean; error: unknown };

export type JobDeps = {
  roomId: string;
  memberId: string;
  newId(): string;
  /**
   * Opens the file in a fresh worker of the job's own. Throws ReaderRefusal,
   * or OpenCancelled once `signal` aborts, by which time the worker is ended.
   */
  open(file: Blob, signal: AbortSignal): Promise<PdfDocument>;
  /** The job's one canvas. */
  canvas(): HTMLCanvasElement;
  /** The drawn page encoded under the upload cap, or null when it cannot fit (encode.ts). */
  encode(canvas: HTMLCanvasElement): Promise<Encoded | null>;
  /** A few KB picture of the drawn page, kept in case its upload never answers. */
  thumb(canvas: HTMLCanvasElement): string | null;
  upload(blob: Blob, options: UploadOptions): Promise<AssetRow>;
  /** Tells the room's library about an image this job uploaded. */
  remember(row: AssetRow): void;
  deleteImages(ids: readonly string[]): Promise<Deleted>;
  listAssets(): Promise<readonly AssetRow[]>;
  dispatch(op: ClientOp, opts: { quiet: true; onAnswer: OnAnswer }): number | null;
  room(): RoomRead;
  subscribe(listener: () => void): () => void;
  storage: LedgerStorage | null;
  /** A toast, for a pause, a stop or the end while the job's block is out of sight. */
  notify(text: string): void;
  hidden(): boolean;
  onVisibility(listener: () => void): () => void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
};

/** The page uploading now, which Cancel waits on or aborts (4.1.6). */
type Inflight = { page: number; width: number; height: number; thumb: string | null; sending: boolean; controller: AbortController; done: Promise<boolean> };

const aborted = () => new DOMException("The upload was cancelled.", "AbortError");

export class JobRunner implements JobControl {
  readonly #deps: JobDeps;
  readonly #store: StoreApi<JobSlotState>;
  readonly #ledgerKey: string;
  #file: Blob | null = null;
  #doc: PdfDocument | null = null;
  #canvas: HTMLCanvasElement | null = null;
  /** Bumped by every new run of the loop, a pause, Cancel and the room going away, so an older run stops where it is. */
  #run = 0;
  /** Aborts the waits of the current run: a share pause, a hidden page. */
  #waits = new AbortController();
  #inflight: Inflight | null = null;
  /** The file opening now, which Cancel, Done and the room going away abort, ending its worker (4.2.1). */
  #opening: AbortController | null = null;
  /**
   * The loop running now, or the last one. A new loop starts only once the
   * last has stopped, so two never draw on the one canvas and reader: a
   * pause stops its draw, and Try again or Leave this page out waits for
   * the draw and the encode to settle first.
   */
  #looping: Promise<void> = Promise.resolve();
  #cancelling = false;
  #disposed = false;
  /** The create sent again once after an `unknown` that never applied (4.1.5). */
  #resent = false;
  /** Pages drawn since the document's caches were last cleaned (4.2.3). */
  #sinceCleanup = 0;

  constructor(deps: JobDeps, store: StoreApi<JobSlotState>) {
    this.#deps = deps;
    this.#store = store;
    this.#ledgerKey = ledgerKey(deps.roomId, deps.memberId);
  }

  get #job(): PdfJob {
    const job = this.#store.getState().job;
    if (!job) throw new Error("no PDF upload");
    return job;
  }

  #set(patch: Partial<PdfJob>): void {
    const job = this.#store.getState().job;
    if (job && !this.#disposed) this.#store.setState({ job: { ...job, ...patch } });
  }

  /** The status line's words, and a toast when the block is out of sight and the words are a pause, a stop or the end. */
  #say(words: string, toast?: string): void {
    const job = this.#store.getState().job;
    if (!job || this.#disposed) return;
    this.#set({ announce: words, announced: job.announced + 1 });
    if (toast && !this.#store.getState().blockShown) this.#deps.notify(toast);
  }

  // Starting.

  /** Opens a picked PDF: the reader loads, the file opens, and the range and title wait for the DM. */
  async start(file: Blob, fileName: string): Promise<void> {
    this.#file = file;
    this.#store.setState({
      job: {
        fileName,
        docId: this.#deps.newId(),
        title: "",
        numPages: 0,
        from: "",
        to: "",
        range: null,
        pages: [],
        leftOut: [],
        phase: { k: "loading" },
        uncertain: null,
        announce: "",
        announced: 0,
      },
    });
    const run = this.#run;
    let doc: PdfDocument;
    try {
      doc = await this.#openFile(file);
    } catch (err) {
      if (run !== this.#run || this.#disposed) return;
      const kind = err instanceof ReaderRefusal ? err.kind : "reader";
      this.#set({ phase: { k: "refused", kind } });
      this.#say(REFUSALS[kind]);
      return;
    }
    // Cancelled or gone while it opened.
    if (run !== this.#run || this.#disposed) return void doc.destroy();
    this.#doc = doc;
    const range = defaultRange(this.#doc.numPages);
    this.#set({ numPages: this.#doc.numPages, title: pdfTitle(this.#doc.title, fileName), ...range, phase: { k: "range" } });
    this.#say(openedWords(this.#job).join(" "));
  }

  /** A ledger this device found from an upload that did not finish (4.1.2). */
  recover(ledger: Ledger): void {
    this.#store.setState({
      job: {
        fileName: ledger.title,
        docId: ledger.docId,
        title: ledger.title,
        numPages: 0,
        from: "",
        to: "",
        range: null,
        pages: [],
        leftOut: [],
        phase: { k: "recovery", ledger },
        uncertain: ledger.uncertain,
        announce: "",
        announced: 0,
      },
    });
    this.#say(recoveryWords(ledger).join(" "));
  }

  setRange(from: string, to: string): void {
    this.#set({ from, to });
  }

  setTitle(title: string): void {
    this.#set({ title });
  }

  /** Upload N pages: the range fixed, and the pages drawn and uploaded in order. */
  upload(): void {
    const job = this.#job;
    if (job.phase.k !== "range") return;
    const view = this.#deps.room().view;
    const check = checkRange(job.from, job.to, job.numPages, view ? roomHandoutPages(view) : 0);
    if (!check.ok) return;
    this.#set({ range: { from: check.from, to: check.to }, leftOut: [], pages: [] });
    this.#say(`Uploading ${check.count === 1 ? "1 page" : `${check.count} pages`}.`);
    void this.#loop();
  }

  /** Opens the file under a controller that Cancel, Done and the room going away abort, from the worker's start on. */
  async #openFile(file: Blob): Promise<PdfDocument> {
    const opening = new AbortController();
    this.#opening = opening;
    try {
      return await this.#deps.open(file, opening.signal);
    } finally {
      if (this.#opening === opening) this.#opening = null;
    }
  }

  // The pages.

  /** A new run of the pages, once the one before has stopped. */
  #loop(): Promise<void> {
    const before = this.#looping;
    this.#looping = before.then(() => this.#pages());
    return this.#looping;
  }

  /** Stops a draw under way and waits until the loop has stopped, its draw and encode settled. */
  async #quiet(): Promise<void> {
    this.#doc?.cancelDraw();
    await this.#looping;
  }

  async #pages(): Promise<void> {
    // Cancel or Done came while the last loop was stopping.
    if (this.#cancelling || this.#disposed || !this.#store.getState().job) return;
    const run = ++this.#run;
    this.#waits = new AbortController();
    const live = () => run === this.#run && !this.#disposed;
    this.#set({ phase: { k: "preparing", waiting: false } });
    if (!this.#doc) {
      if (!(await this.#reopen(run))) return;
    }
    let pending: Promise<boolean> | null = null;
    for (const page of pagesToDo(this.#job)) {
      if (!(await this.#whenVisible(run))) return;
      let drawn: { encoded: Encoded | null; thumb: string | null; slow: boolean };
      try {
        drawn = await this.#draw(page);
      } catch (err) {
        const failed = !(err instanceof DrawCancelled);
        // A reader whose page failed is never drawn with again, whatever stops the job first (4.2.1).
        if (failed) await this.#closeDoc();
        // The page uploading first is told first: its stop comes before this one.
        if (pending && !(await pending)) return;
        if (!live() || !failed) return;
        this.#pause(run, page, { k: "drawFailed" });
        return;
      }
      if (pending && !(await pending)) return;
      if (!live()) return;
      if (!drawn.encoded) return this.#pause(run, page, { k: "tooLarge" });
      const job = this.#job;
      if (sharePause(job.pages.length, this.#othersOnline(), pagesToDo(job).length)) {
        try {
          await this.#deps.sleep(SHARE_PAUSE_MS, this.#waits.signal);
        } catch {
          return;
        }
        if (!live()) return;
      }
      if (drawn.slow || ++this.#sinceCleanup >= CLEANUP_EVERY_PAGES) {
        this.#sinceCleanup = 0;
        await this.#doc?.cleanup().catch(() => undefined);
      }
      if (!(await this.#whenVisible(run))) return;
      pending = this.#uploadPage(run, page, drawn.encoded, drawn.thumb);
    }
    if (pending && !(await pending)) return;
    if (live()) this.#save();
  }

  async #draw(page: number): Promise<{ encoded: Encoded | null; thumb: string | null; slow: boolean }> {
    const doc = this.#doc;
    if (!doc) throw new DrawCancelled();
    const canvas = (this.#canvas ??= this.#deps.canvas());
    const started = this.#deps.now();
    try {
      await doc.drawPage(page, canvas);
      const slow = this.#deps.now() - started > SLOW_DRAW_MS;
      return { encoded: await this.#deps.encode(canvas), thumb: this.#deps.thumb(canvas), slow };
    } finally {
      // From here on the job holds only the encoded page, and the next page draws on a free canvas (4.1.4).
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** Uploads one page and records it, before the next upload starts. False when the job stopped here or was stopped meanwhile. */
  #uploadPage(run: number, page: number, encoded: Encoded, thumb: string | null): Promise<boolean> {
    const inflight: Inflight = { page, width: encoded.width, height: encoded.height, thumb, sending: false, controller: new AbortController(), done: Promise.resolve(false) };
    const live = () => run === this.#run && !this.#disposed;
    const attempt = () =>
      this.#deps.upload(encoded.blob, {
        background: true,
        signal: inflight.controller.signal,
        onSending: (sending) => (inflight.sending = sending),
        onWaiting: (waiting) => {
          if (live() && this.#job.phase.k === "preparing") this.#set({ phase: { k: "preparing", waiting } });
        },
      });
    inflight.done = (async () => {
      // An upload that failed while the page was hidden is tried once more when it shows, before it counts as offline (4.1.4).
      let hiddenDuring = this.#deps.hidden();
      const off = this.#deps.onVisibility(() => {
        if (this.#deps.hidden()) hiddenDuring = true;
      });
      let row: AssetRow;
      try {
        try {
          row = await attempt();
        } catch (err) {
          if (!(hiddenDuring && stopFor(err)?.k === "offline" && live())) throw err;
          if (!(await this.#whenVisible(run))) throw err;
          row = await attempt();
        }
      } catch (err) {
        if (!live()) return false;
        const stop = stopFor(err);
        if (stop) this.#pause(run, page, stop);
        return false;
      } finally {
        off();
      }
      // Recorded even when Cancel came meanwhile: Cancel removes what the job made.
      this.#record({ page, assetId: row.id, width: row.width, height: row.height, created: row.created === true });
      this.#deps.remember(row);
      return live();
    })();
    this.#inflight = inflight;
    void inflight.done.finally(() => {
      if (this.#inflight === inflight) this.#inflight = null;
    });
    return inflight.done;
  }

  #record(page: JobPage): void {
    const job = this.#job;
    const pages = [...job.pages.filter((p) => p.page !== page.page), page].sort((a, b) => a.page - b.page);
    this.#set({ pages });
    this.#writeLedger();
  }

  /** The job's own pages, written before the next upload starts (4.1.2). */
  #writeLedger(): void {
    const job = this.#job;
    const ids = [...new Set(job.pages.filter((p) => p.created).map((p) => p.assetId))];
    if (ids.length === 0 && !job.uncertain) return clearLedger(this.#deps.storage, this.#ledgerKey);
    writeLedger(this.#deps.storage, this.#ledgerKey, { docId: job.docId, title: job.title.trim() || job.fileName, ids, uncertain: job.uncertain });
  }

  #pause(run: number, page: number, stop: Stop): void {
    if (run !== this.#run || this.#disposed) return;
    this.#run++;
    this.#waits.abort();
    // The next page may be drawing while this one's upload failed: it stops now and draws again on Try again.
    this.#doc?.cancelDraw();
    this.#set({ phase: { k: "paused", page, stop } });
    this.#say(stopWords(this.#job, page, stop), stopToast(this.#job, page, stop));
  }

  /** Waits while the page is hidden: no new draw and no new upload start then (4.1.4). False when the run ended meanwhile. */
  async #whenVisible(run: number): Promise<boolean> {
    const live = () => run === this.#run && !this.#disposed;
    if (this.#deps.hidden()) {
      const signal = this.#waits.signal;
      await new Promise<void>((resolve) => {
        const done = () => {
          off();
          signal.removeEventListener("abort", done);
          resolve();
        };
        const off = this.#deps.onVisibility(() => {
          if (!this.#deps.hidden()) done();
        });
        signal.addEventListener("abort", done, { once: true });
      });
    }
    return live();
  }

  #othersOnline(): boolean {
    return this.#deps.room().online.some((id) => id !== this.#deps.memberId);
  }

  /** A fresh worker and the file opened again: after a page failed, whose decoders' state and caches it would carry (4.2.1). */
  async #reopen(run: number): Promise<boolean> {
    await this.#closeDoc();
    if (!this.#file) return false;
    try {
      const doc = await this.#openFile(this.#file);
      if (run !== this.#run || this.#disposed) {
        void doc.destroy();
        return false;
      }
      this.#doc = doc;
      this.#sinceCleanup = 0;
      return true;
    } catch (err) {
      if (run !== this.#run || this.#disposed) return false;
      const first = pagesToDo(this.#job)[0] ?? this.#job.range?.from ?? 1;
      this.#pause(run, first, { k: "failed", words: err instanceof ReaderRefusal ? REFUSALS[err.kind] : REFUSALS.reader });
      return false;
    }
  }

  async #closeDoc(): Promise<void> {
    const doc = this.#doc;
    this.#doc = null;
    await doc?.destroy().catch(() => undefined);
  }

  // The DM's buttons while paused.

  /** Try again: on from the page it stopped at, or the save again, or back to the range. */
  async tryAgain(): Promise<void> {
    const job = this.#job;
    switch (job.phase.k) {
      case "paused":
        await this.#quiet();
        return this.#loop();
      case "saveFailed":
        if (!job.phase.gone) return this.#save();
        return this.#uploadMissing();
      case "empty":
        this.#set({ phase: { k: "range" }, range: null, pages: [], leftOut: [] });
        return;
      default:
        return;
    }
  }

  /** Leave this page out: on without it (4.1.6). */
  async leaveOut(): Promise<void> {
    const job = this.#job;
    if (job.phase.k !== "paused") return;
    this.#set({ leftOut: [...job.leftOut, job.phase.page] });
    await this.#quiet();
    return this.#loop();
  }

  /** Save, once the title is fixed (4.1.5). */
  save(): void {
    if (this.#job.phase.k === "titleInvalid") this.#save();
  }

  /** The save was refused `gone`: pages were deleted meanwhile. Each the room no longer has uploads again, then the save (4.1.5). */
  async #uploadMissing(): Promise<void> {
    const run = ++this.#run;
    this.#set({ phase: { k: "preparing", waiting: false } });
    let rows: readonly AssetRow[];
    try {
      rows = await this.#deps.listAssets();
    } catch {
      if (run === this.#run) this.#set({ phase: { k: "saveFailed", words: "The library could not be checked. Check your connection.", gone: true } });
      return;
    }
    if (run !== this.#run) return;
    const held = new Set(rows.map((r) => r.id));
    this.#set({ pages: this.#job.pages.filter((p) => held.has(p.assetId)) });
    this.#writeLedger();
    return this.#loop();
  }

  // Saving (4.1.5).

  #save(): void {
    const run = ++this.#run;
    const job = this.#job;
    if (job.pages.length === 0) {
      // A document needs at least one page, so no create is sent (4.1.6).
      this.#set({ phase: { k: "empty" } });
      this.#say("No pages were uploaded.", "The PDF upload ended with no pages. Open Handouts in the DM panel.");
      return;
    }
    if (titleProblem(job.title) !== null) {
      this.#set({ phase: { k: "titleInvalid" } });
      this.#say("Fix the title to save.", "The PDF upload waits for a title. Open Handouts in the DM panel to save it.");
      return;
    }
    const op: OpOf<"handoutDoc.create"> = {
      t: "handoutDoc.create",
      doc: { id: job.docId, title: job.title.trim(), pages: job.pages.map(({ assetId, width, height }) => ({ assetId, width, height })) },
    };
    this.#set({ phase: { k: "saving" } });
    const n = this.#deps.dispatch(op, { quiet: true, onAnswer: this.#answer((answer, refusal, settled) => this.#saveAnswered(run, answer, refusal, settled)) });
    if (n === null) this.#saveFailed(run, "The handout could not be sent.", false);
  }

  /**
   * Hears an op's answer, and for an `unknown` waits by the checking rule
   * (4.1.5) before it says what became of it: at once when a snapshot
   * settled it, and after the current connection's next snapshot when it
   * expired before the hello, since the view may still lack a create that
   * did commit.
   */
  #answer(then: (answer: OpAnswer, refusal: OpRefusal | undefined, settled: Promise<boolean>) => void): OnAnswer {
    return (answer, refusal, cause) => {
      const at = this.#deps.room().snapshots;
      then(answer, refusal, answer === "unknown" ? this.#settled(cause, at) : Promise.resolve(true));
    };
  }

  /** True once the view holds the snapshot that settles an `unknown`, false when the job went away first. */
  #settled(cause: UnknownCause | undefined, at: number): Promise<boolean> {
    if (cause !== "expired") return Promise.resolve(!this.#disposed);
    return new Promise((resolve) => {
      const check = () => {
        if (this.#disposed) return finish(false);
        if (this.#deps.room().snapshots > at) finish(true);
      };
      const finish = (ok: boolean) => {
        off();
        resolve(ok);
      };
      const off = this.#deps.subscribe(check);
      check();
    });
  }

  #docSaved(): boolean {
    return this.#deps.room().savedDocs?.[this.#job.docId] !== undefined;
  }

  async #saveAnswered(run: number, answer: OpAnswer, refusal: OpRefusal | undefined, settled: Promise<boolean>): Promise<void> {
    if (this.#disposed) return;
    if (answer === "taken") return this.#savedOrCancel(true);
    if (answer === "refused") {
      // A create sent again that had applied after all is refused as an id in use: the check finds it.
      if (this.#resent && refusal?.code === "invalid" && this.#docSaved()) return this.#savedOrCancel(true);
      if (this.#cancelling) return this.#finishCancel(false);
      return this.#saveFailed(run, refusal?.text ?? "The handout was not saved.", refusal?.code === "gone");
    }
    if (!this.#cancelling) this.#set({ phase: { k: "checking", what: "save" } });
    if (!(await settled)) return;
    if (this.#docSaved()) return this.#savedOrCancel(true);
    if (this.#cancelling) return this.#finishCancel(false);
    if (this.#resent) return this.#saveFailed(run, "The handout may not have saved. Try again.", false);
    // The create never applied: sent again under the same id, once.
    this.#resent = true;
    this.#save();
  }

  #saveFailed(run: number, words: string, gone: boolean): void {
    if (run !== this.#run || this.#disposed) return;
    this.#set({ phase: { k: "saveFailed", words, gone } });
    this.#say(words, "The PDF upload could not save. Open Handouts in the DM panel to try again.");
  }

  async #savedOrCancel(saved: boolean): Promise<void> {
    if (!this.#cancelling) await this.#closeDoc();
    // Cancel may come while the reader closes, after the answer it would have waited for: the save is known, so Cancel deletes it.
    if (this.#cancelling) return this.#finishCancel(saved);
    clearLedger(this.#deps.storage, this.#ledgerKey);
    this.#set({ phase: { k: "saved" } });
    this.#say(savedWords(this.#job).join(" "), savedToast(this.#job));
  }

  // Cancel upload (4.1.6).

  /** Cancel upload, from every phase: "Cancelling…" from the press until the summary. */
  async cancel(): Promise<void> {
    const job = this.#store.getState().job;
    if (!job || this.#cancelling || this.#disposed) return;
    const from = job.phase.k;
    if (from === "saved" || from === "cancelled" || from === "recovery" || from === "recovered") return;
    // Nothing uploaded and nothing on its way: there is nothing to undo, so the job just ends.
    if ((from === "loading" || from === "range" || from === "refused" || from === "empty") && job.pages.length === 0 && !this.#inflight) return this.end();
    this.#cancelling = true;
    this.#set({ phase: { k: "cancelling" } });
    this.#say("Cancelling…");
    // After the create is sent, its answer decides: the save's handler finishes the cancel.
    if (from === "saving" || from === "checking") return;
    this.#run++;
    this.#waits.abort();
    this.#opening?.abort();
    this.#doc?.cancelDraw();
    const inflight = this.#inflight;
    if (inflight) {
      if (inflight.sending) {
        // An upload already sending gets a short grace to answer, so its page is known (4.1.6).
        const grace = new AbortController();
        const answered = await Promise.race([inflight.done.then(() => true), this.#deps.sleep(CANCEL_GRACE_MS, grace.signal).then(() => false, () => false)]);
        grace.abort();
        if (!answered) {
          inflight.controller.abort(aborted());
          this.#set({ uncertain: { page: inflight.page, width: inflight.width, height: inflight.height, thumb: inflight.thumb } });
        }
      } else {
        // Queued, or waiting out a 503: nothing was made, so it stops at once.
        inflight.controller.abort(aborted());
      }
      await inflight.done;
    }
    await this.#finishCancel(false);
  }

  async #finishCancel(saved: boolean): Promise<void> {
    if (this.#disposed) return;
    await this.#closeDoc();
    if (saved) {
      const deleted = await this.#deleteDoc();
      if (this.#disposed) return;
      if (!deleted) {
        // Saved, and its delete refused or lost: its pages are the document's now.
        clearLedger(this.#deps.storage, this.#ledgerKey);
        return this.#cancelled({ k: "cancelled", removed: 0, failed: false, stillSaved: true });
      }
    }
    const job = this.#job;
    const own = [...new Set(job.pages.filter((p) => p.created).map((p) => p.assetId))];
    let removed = 0;
    let failed = false;
    if (own.length > 0) {
      const result = await this.#deps.deleteImages(own);
      removed = result.deleted;
      failed = result.error !== null && result.error !== undefined;
    }
    if (this.#disposed) return;
    if (failed) this.#writeLedger();
    else this.#set({ pages: [] });
    if (!failed) {
      // Only a page that may be there stays recorded, so a reload before Done still names it.
      if (this.#job.uncertain) writeLedger(this.#deps.storage, this.#ledgerKey, { docId: job.docId, title: job.title.trim() || job.fileName, ids: [], uncertain: this.#job.uncertain });
      else clearLedger(this.#deps.storage, this.#ledgerKey);
    }
    this.#cancelled({ k: "cancelled", removed, failed, stillSaved: false });
  }

  #cancelled(phase: Extract<Phase, { k: "cancelled" }>): void {
    this.#cancelling = false;
    this.#set({ phase });
    this.#say(cancelledWords(this.#job, phase).join(" "), cancelledWords(this.#job, phase)[0]);
  }

  /** The compensating delete of a document saved before Cancel took effect, settled by the checking rule. True when it is gone. */
  #deleteDoc(): Promise<boolean> {
    return new Promise((resolve) => {
      const n = this.#deps.dispatch(
        { t: "handoutDoc.delete", docId: this.#job.docId },
        {
          quiet: true,
          onAnswer: this.#answer(async (answer, refusal, settled) => {
            if (answer === "taken") return resolve(true);
            if (answer === "refused") return resolve(refusal?.code === "gone");
            if (!(await settled)) return resolve(false);
            resolve(!this.#docSaved());
          }),
        },
      );
      if (n === null) resolve(false);
    });
  }

  // The recovery (4.1.2).

  /** Remove them: exactly the ledger's ids. */
  async removeRecovered(): Promise<void> {
    const job = this.#job;
    if (job.phase.k !== "recovery") return;
    const { ledger } = job.phase;
    this.#set({ phase: { k: "cancelling" } });
    this.#say("Removing the pages…");
    const result = ledger.ids.length > 0 ? await this.#deps.deleteImages(ledger.ids) : { deleted: 0, inUse: false, error: null };
    const failed = result.error !== null && result.error !== undefined;
    if (!failed) clearLedger(this.#deps.storage, this.#ledgerKey);
    const phase: Extract<Phase, { k: "recovered" }> = { k: "recovered", removed: result.deleted, failed };
    this.#set({ phase, uncertain: failed ? job.uncertain : null });
    this.#say(recoveredWords(phase));
  }

  /** Keep them: the ledger cleared, the pages left loose. */
  keepRecovered(): void {
    if (this.#job.phase.k !== "recovery") return;
    clearLedger(this.#deps.storage, this.#ledgerKey);
    const phase: Extract<Phase, { k: "recovered" }> = { k: "recovered", removed: null, failed: false };
    this.#set({ phase, uncertain: null });
    this.#say(recoveredWords(phase));
  }

  // Ending.

  /**
   * Done or Dismiss: the job ends. A summary the DM has read leaves nothing
   * to recover, unless its delete failed, which the next visit offers again.
   */
  async end(): Promise<void> {
    const job = this.#store.getState().job;
    if (!job) return;
    const failed = (job.phase.k === "cancelled" || job.phase.k === "recovered") && job.phase.failed;
    if (!failed && job.phase.k !== "recovery" && job.pages.every((p) => !p.created || job.phase.k === "saved")) clearLedger(this.#deps.storage, this.#ledgerKey);
    this.#run++;
    this.#waits.abort();
    this.#opening?.abort();
    await this.#closeDoc();
    if (!this.#disposed) this.#store.setState({ job: null });
  }

  /** The room went away: everything stops, nothing is awaited, and the ledger stays for the recovery (4.1.6). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#run++;
    this.#waits.abort();
    this.#opening?.abort();
    this.#inflight?.controller.abort(aborted());
    this.#doc?.cancelDraw();
    void this.#closeDoc();
  }

  /** The ledger's key, for the room's recovery check. */
  get ledgerKey(): string {
    return this.#ledgerKey;
  }
}
