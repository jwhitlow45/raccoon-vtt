import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { DM as DM_VIEWER, room as testRoom } from "#shared/testutil.ts";
import { ApiError, type AssetRow, type UploadOptions } from "../../../lib/api.ts";
import type { OnAnswer, OpRefusal } from "../../../state/types.ts";
import {
  CANCEL_GRACE_MS,
  SHARE_EVERY_MS,
  SHARE_PAUSE_MS,
  checkRange,
  isPdfFile,
  jobActive,
  jobHolds,
  jobPageIds,
  pagesToDo,
  pdfPickRefusal,
  progressWords,
  savingWords,
  stopFor,
  uploadLabel,
  waitsOnDm,
  type JobSlotState,
  type PdfJob,
} from "./job.ts";
import { ledgerKey, readLedger, recoveryOf, writeLedger, type LedgerStorage } from "./ledger.ts";
import { DrawCancelled, endWithin, OpenCancelled, PageDrawFailure, ReaderRefusal, type PdfDocument } from "./reader.ts";
import { JobRunner, roomReadOf, type JobDeps } from "./run.ts";
import { LocalServer } from "../../../dev/localServer.ts";
import { createRoomStore } from "../../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../../state/testing.ts";

const ROOM = "ABCD2345";
const ME = "dm1";

/** Lets every promise chain that can run, run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

type Upload = { page: number; options: UploadOptions; resolve(row: Partial<AssetRow>): void; reject(err: unknown): void; settled: boolean };
type Sent = { op: ClientOp; onAnswer: OnAnswer };

/**
 * A room, a PDF and a server for one job: every upload, op and wait is the
 * test's to answer, unless it says to answer them as they come.
 */
function world(opts: { pages?: number; title?: string | null; failDraw?: number[]; tooLarge?: number[]; openFails?: ReaderRefusal; autoUpload?: boolean; holdDraw?: number[]; holdOpen?: boolean; holdDestroy?: boolean; pageMs?: number } = {}) {
  const numPages = opts.pages ?? 3;
  const state: { view: RoomState; online: string[]; connection: string; snapshots: number } = { view: testRoom(), online: [ME], connection: "open", snapshots: 1 };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const store = createStore<JobSlotState>(() => ({ job: null, blockShown: true }));
  const uploads: Upload[] = [];
  const sent: Sent[] = [];
  const deleted: string[][] = [];
  const toasts: string[] = [];
  const sleeps: { ms: number; resolve(): void; reject(err: unknown): void }[] = [];
  const opened: string[] = [];
  const destroyed: number[] = [];
  const cleaned: number[] = [];
  const memory = new Map<string, string>();
  const storage: LedgerStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) };
  let hidden = false;
  const visibility = new Set<() => void>();
  let drawn = 0;
  let docs = 0;
  let holdSleeps = false;
  let cancelled: (() => void) | null = null;
  const holdDraw = new Set(opts.holdDraw ?? []);
  const releases = new Map<number, () => void>();
  let drawing = 0;
  let mostDrawing = 0;
  const openSignals: AbortSignal[] = [];
  const destroys: (() => void)[] = [];
  const failDraw = new Set(opts.failDraw ?? []);
  const tooLarge = new Set(opts.tooLarge ?? []);
  let lastPage = 0;
  let ids = 0;
  /** The fake clock, which each upload moves on by `pageMs`, as a link of that speed would. */
  let clock = 0;

  const doc = (): PdfDocument => {
    const id = ++docs;
    return {
      numPages,
      title: { xmp: opts.title === undefined ? "Strange letter" : opts.title, info: null },
      async drawPage(page, canvas) {
        drawn++;
        lastPage = page;
        mostDrawing = Math.max(mostDrawing, ++drawing);
        try {
          canvas.width = 1583;
          canvas.height = 2048;
          if (failDraw.has(page)) throw new PageDrawFailure(page, 'Warning: Unable to decode image "img_p0_1"');
          // A held page stands for the encode after a draw, which no cancel reaches: it ends only when released.
          if (holdDraw.has(page)) await new Promise<void>((resolve) => releases.set(page, resolve));
          else
            await new Promise<void>((resolve, reject) => {
              cancelled = () => reject(new DrawCancelled());
              setTimeout(resolve, 0);
            });
          cancelled = null;
        } finally {
          drawing--;
        }
      },
      cancelDraw: () => cancelled?.(),
      cleanup: async () => void cleaned.push(lastPage),
      destroy: () =>
        opts.holdDestroy
          ? new Promise<void>((resolve) =>
              destroys.push(() => {
                destroyed.push(id);
                resolve();
              }),
            )
          : Promise.resolve(void destroyed.push(id)),
    };
  };

  const deps: JobDeps = {
    roomId: ROOM,
    memberId: ME,
    newId: () => "doc-1",
    async open(_file, signal) {
      opened.push("open");
      openSignals.push(signal);
      if (opts.holdOpen) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new OpenCancelled()), { once: true }));
      if (opts.openFails) throw opts.openFails;
      return doc();
    },
    canvas: () => ({ width: 0, height: 0 }) as HTMLCanvasElement,
    async encode(canvas) {
      if (tooLarge.has(lastPage)) return null;
      return { blob: new Blob([`page ${lastPage}`], { type: "image/webp" }), width: canvas.width, height: canvas.height };
    },
    thumb: () => `data:image/jpeg;base64,page${lastPage}`,
    upload(blob, options) {
      clock += opts.pageMs ?? 0;
      return blob.text().then(
        (text) =>
          new Promise<AssetRow>((resolve, reject) => {
            const page = Number(text.slice(5));
            const upload: Upload = {
              page,
              options,
              settled: false,
              resolve: (row) => {
                upload.settled = true;
                resolve({ id: `img-${page}`, kind: "handout", width: 1583, height: 2048, variants: ["full", "thumb"], created: true, ...row } as AssetRow);
              },
              reject: (err) => {
                upload.settled = true;
                reject(err);
              },
            };
            options.signal?.addEventListener("abort", () => upload.reject(new DOMException("aborted", "AbortError")), { once: true });
            uploads.push(upload);
            if (opts.autoUpload !== false) {
              options.onSending?.(true);
              setTimeout(() => {
                if (!upload.settled) {
                  options.onSending?.(false);
                  upload.resolve({});
                }
              }, 0);
            }
          }),
      );
    },
    remember: () => undefined,
    async deleteImages(list) {
      deleted.push([...list]);
      return { deleted: list.length, inUse: false, error: null };
    },
    listAssets: async () => [],
    dispatch(op, options) {
      sent.push({ op, onAnswer: options.onAnswer });
      return sent.length;
    },
    // The fake's view is its confirmed state: no pending ops here.
    room: () => ({ ...state, savedDocs: state.view.handoutDocs }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    storage,
    notify: (text) => void toasts.push(text),
    hidden: () => hidden,
    onVisibility(listener) {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
    sleep(ms, signal) {
      if (!holdSleeps) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const entry = { ms, resolve, reject };
        sleeps.push(entry);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
    now: () => clock,
  };
  const runner = new JobRunner(deps, store);
  const job = () => store.getState().job as PdfJob;
  return {
    runner,
    deps,
    store,
    state,
    job,
    phase: () => job().phase,
    uploads,
    sent,
    deleted,
    toasts,
    sleeps,
    opened,
    destroyed,
    cleaned,
    storage,
    ledger: () => readLedger(storage, ledgerKey(ROOM, ME)),
    drawn: () => drawn,
    /** The most draws under way at once. */
    mostDrawing: () => mostDrawing,
    /** Lets a held page's draw finish. */
    releaseDraw: (page: number) => releases.get(page)?.(),
    openSignals,
    /** Lets every held destroy finish. */
    finishDestroys: () => destroys.splice(0).forEach((f) => f()),
    setHidden(on: boolean) {
      hidden = on;
      for (const l of [...visibility]) l();
    },
    holdSleeps() {
      holdSleeps = true;
    },
    snapshot(view: RoomState = state.view) {
      state.view = view;
      state.snapshots++;
      changed();
    },
    withDoc() {
      return { ...state.view, handoutDocs: { "doc-1": { id: "doc-1", rev: 1, title: "Strange letter", pages: [], createdAt: "" } } } as RoomState;
    },
    /** The file opened and the range waiting. */
    async open() {
      await runner.start(new Blob(["%PDF-"]), "Strange letter.pdf");
    },
    /** Opened, uploaded and answered through to the create. */
    async throughUpload() {
      await runner.start(new Blob(["%PDF-"]), "Strange letter.pdf");
      runner.upload();
      await settle();
    },
  };
}

const answer = (s: Sent, ...args: Parameters<OnAnswer>) => s.onAnswer(...args);
const refusal = (code: OpRefusal["code"], text: string): OpRefusal => ({ code, message: text, text });

describe("opening a PDF (docs/design-v1-pdf-handouts.md 4.1.3)", () => {
  test("a PDF by its type, or by its name when it has no type or a generic one; an image by its type whatever its name", () => {
    assert.equal(isPdfFile({ type: "application/pdf", name: "x" }), true);
    assert.equal(isPdfFile({ type: "", name: "Letter.PDF" }), true);
    assert.equal(isPdfFile({ type: "application/octet-stream", name: "a.pdf" }), true);
    assert.equal(isPdfFile({ type: "image/png", name: "a.pdf" }), false);
    assert.equal(isPdfFile({ type: "", name: "a.png" }), false);
  });

  test("a PDF over 100 MB is refused before it is read, and one picked while another holds the job is refused in words", async () => {
    assert.equal(pdfPickRefusal({ size: 100 * 1024 * 1024 + 1 }, null), "PDFs up to 100 MB can be used.");
    assert.equal(pdfPickRefusal({ size: 1_000 }, null), null);
    const w = world({ pages: 2 });
    await w.open();
    assert.equal(pdfPickRefusal({ size: 1_000 }, w.job()), "One PDF at a time. Cancel Strange letter.pdf, or wait for it.");
    await w.runner.upload();
    await settle();
    answer(w.sent[0]!, "taken");
    await settle();
    assert.equal(pdfPickRefusal({ size: 1_000 }, w.job()), null, "a saved job leaves the way open");
  });

  test("the reader loads, the file opens, and the range holds every page with the PDF's title", async () => {
    const w = world({ pages: 12 });
    const opening = w.open();
    assert.equal(w.phase().k, "loading");
    await opening;
    assert.deepEqual(w.phase(), { k: "range" });
    assert.deepEqual([w.job().from, w.job().to, w.job().title, w.job().numPages], ["1", "12", "Strange letter", 12]);
    assert.equal(w.job().announce, "Strange letter.pdf, 12 pages.");
  });

  test("past 100 pages the range starts at 1 to 100 and asks which", async () => {
    const w = world({ pages: 140 });
    await w.open();
    assert.deepEqual([w.job().from, w.job().to], ["1", "100"]);
    assert.match(w.job().announce, /This PDF has 140 pages\. A handout holds up to 100, so choose which\./);
  });

  test("each refusal says why, with nothing uploaded", async () => {
    for (const kind of ["reader", "password", "invalid", "xfa"] as const) {
      const w = world({ openFails: new ReaderRefusal(kind, "x") });
      await w.open();
      assert.deepEqual(w.phase(), { k: "refused", kind });
      assert.equal(w.uploads.length, 0);
      assert.equal(jobActive(w.job()), false);
    }
    const w = world({ openFails: new ReaderRefusal("password", "x") });
    await w.open();
    assert.equal(w.job().announce, "This PDF has a password. Save a copy without one, then upload that.");
  });

  test("the range's rules, each said in words, and the room's page limit", () => {
    assert.deepEqual(checkRange("1", "12", 12, 0), { ok: true, from: 1, to: 12, count: 12 });
    assert.deepEqual(checkRange("87", "89", 140, 0), { ok: true, from: 87, to: 89, count: 3 });
    // Each field's words, From page's then To page's.
    const problems = (from: string, to: string, pages = 12, room = 0) => {
      const r = checkRange(from, to, pages, room);
      return r.ok ? [] : [r.from, r.to].filter((p) => p !== null);
    };
    assert.deepEqual(problems("", "x"), ["From page takes a whole number.", "To page takes a whole number."]);
    assert.deepEqual(problems("1.5", "3"), ["From page takes a whole number."]);
    assert.deepEqual(problems("0", "13"), ["From page is at least 1.", "To page is at most 12."]);
    assert.deepEqual(problems("5", "4"), ["From page comes before To page."]);
    assert.deepEqual(checkRange("5", "4", 12, 0), { ok: false, from: null, to: "From page comes before To page." }, "a rule of the whole range is said on To page");
    assert.deepEqual(checkRange("1.5", "3", 12, 0), { ok: false, from: "From page takes a whole number.", to: null });
    assert.deepEqual(problems("1", "101", 140), ["A handout holds up to 100 pages. Choose at most 100."]);
    assert.deepEqual(problems("1", "60", 140, 1_950), ["The room holds 1,950 of its 2,000 handout pages. Choose at most 50, or delete a document."]);
    assert.deepEqual(problems("1", "1", 1, 2_000), ["The room holds 2,000 of its 2,000 handout pages. Delete a document or close a handout first."]);
  });
});

describe("drawing and uploading (docs/design-v1-pdf-handouts.md 4.1.4)", () => {
  test("every page of the range, in order, background uploads, each owned page in the ledger before the next upload, then the create under the id chosen first", async () => {
    const w = world({ pages: 3 });
    await w.open();
    w.runner.upload();
    assert.equal(w.job().announce, "Uploading 3 pages.");
    const ledgers: (string[] | undefined)[] = [];
    const unsubscribe = w.store.subscribe(() => ledgers.push(w.ledger()?.ids));
    await settle();
    unsubscribe();
    assert.deepEqual(w.uploads.map((u) => [u.page, u.options.background]), [[1, true], [2, true], [3, true]]);
    assert.ok(ledgers.some((ids) => ids?.length === 1) && ledgers.some((ids) => ids?.length === 2), "the ledger grows a page at a time");
    assert.equal(w.sent.length, 1);
    assert.deepEqual(w.sent[0]!.op, {
      t: "handoutDoc.create",
      doc: { id: "doc-1", title: "Strange letter", pages: [1, 2, 3].map((p) => ({ assetId: `img-${p}`, width: 1583, height: 2048 })) },
    });
    assert.deepEqual(w.ledger(), { docId: "doc-1", title: "Strange letter", ids: ["img-1", "img-2", "img-3"], uncertain: null });
    answer(w.sent[0]!, "taken");
    await settle();
    assert.deepEqual(w.phase(), { k: "saved" });
    assert.equal(w.job().announce, "Saved as Strange letter, 3 pages.");
    assert.equal(w.ledger(), null, "cleared once the save is confirmed");
    assert.equal(w.destroyed.length, 1, "the worker ends when the job saves");
  });

  test("a range uploads only its pages, and the progress counts within it", async () => {
    const w = world({ pages: 140, autoUpload: false });
    await w.open();
    w.runner.setRange("87", "89");
    w.runner.upload();
    await settle();
    assert.equal(progressWords(w.job()), "Preparing page 1 of 3…");
    w.uploads[0]!.resolve({});
    await settle();
    assert.equal(progressWords(w.job()), "Preparing page 2 of 3…");
    w.uploads[1]!.resolve({});
    await settle();
    w.uploads[2]!.resolve({});
    await settle();
    assert.deepEqual(w.uploads.map((u) => u.page), [87, 88, 89]);
  });

  test("a stop names the page by its number in the PDF, in the block and in the toast alike", async () => {
    const w = world({ pages: 140, autoUpload: false });
    w.store.setState({ blockShown: false });
    await w.open();
    w.runner.setRange("87", "89");
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({});
    await settle();
    w.uploads[1]!.reject(new ApiError(0, "x", "network", null));
    await settle();
    assert.equal(w.job().announce, "The upload stopped at page 88. Check your connection.");
    assert.equal(w.toasts.at(-1), "The PDF upload paused at page 88. Open Handouts in the DM panel to go on.");
  });

  test("a Cancel whose pages were all reused from the library says nothing needed removing", async () => {
    const w = world({ pages: 1, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({ created: false });
    await settle();
    void w.runner.cancel();
    answer(w.sent[0]!, "refused", refusal("quota", "x"));
    await settle();
    assert.deepEqual(w.phase(), { k: "cancelled", removed: 0, failed: false, stillSaved: false });
    assert.equal(w.job().announce, "Nothing needed removing.");
  });

  test("saving and checking say when they wait for the connection", () => {
    assert.equal(savingWords("saving", true), "Saving the handout…");
    assert.equal(savingWords("saving", false), "Waiting for the connection to save.");
    assert.equal(savingWords("checking", true), "Checking whether the handout saved…");
    assert.equal(savingWords("checking", false), "Waiting for the connection to check whether the handout saved.");
  });

  test("the range's button keeps to its count, and says Upload pages while the range breaks a rule", () => {
    assert.equal(uploadLabel(3), "Upload 3 pages");
    assert.equal(uploadLabel(1), "Upload 1 page");
    assert.equal(uploadLabel(null), "Upload pages");
  });

  test("page n + 1 draws while page n uploads, and no second upload starts before the first is recorded", async () => {
    const w = world({ pages: 3, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    assert.equal(w.uploads.length, 1);
    assert.equal(w.drawn(), 2, "page 2 drawn while page 1 uploads");
    w.uploads[0]!.resolve({});
    await settle();
    assert.equal(w.uploads.length, 2);
  });

  test("with another member online, a pause each time about 20 s have passed, so on a slow link too, and none alone", async () => {
    // Before which uploads a pause comes, counted from 1.
    const pausedBefore = async (pageMs: number, pages: number, others = true) => {
      const w = world({ pages, pageMs });
      if (others) w.state.online.push("p1");
      const before: number[] = [];
      const sleep = w.deps.sleep;
      w.deps.sleep = (ms, signal) => {
        assert.equal(ms, SHARE_PAUSE_MS);
        before.push(w.uploads.length + 1);
        return sleep(ms, signal);
      };
      await w.throughUpload();
      for (let i = 0; i < 50 && w.phase().k !== "saving"; i++) await settle();
      assert.equal(w.uploads.length, pages);
      return before;
    };
    assert.deepEqual(await pausedBefore(1_000, 45), [21, 41], "a fast link: a pause about every 20 pages, once 20 s have passed");
    assert.deepEqual(await pausedBefore(10_000, 6), [3, 5], "a slow link: a pause every 2 pages, so another device never waits past its retries");
    assert.deepEqual(await pausedBefore(10_000, 6, false), [], "alone, none");
    assert.ok(SHARE_EVERY_MS < 60_000, "under another device's minute of retries");
  });

  test("the document's caches are cleaned every few pages, between draws", async () => {
    const w = world({ pages: 11 });
    await w.throughUpload();
    assert.deepEqual(w.cleaned, [5, 10]);
  });

  test("while the page is hidden no draw or upload starts, and it goes on when the page shows", async () => {
    const w = world({ pages: 3, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.setHidden(true);
    w.uploads[0]!.resolve({});
    await settle();
    assert.equal(w.uploads.length, 1, "page 2 waits to upload");
    const drawn = w.drawn();
    w.setHidden(false);
    await settle();
    assert.equal(w.uploads.length, 2);
    assert.ok(w.drawn() > drawn);
  });

  test("an upload that failed while the page was hidden is tried once more when it shows, before it counts as offline", async () => {
    const w = world({ pages: 1, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.setHidden(true);
    w.uploads[0]!.reject(new ApiError(0, "offline", "network", null));
    await settle();
    assert.equal(w.uploads.length, 1);
    w.setHidden(false);
    await settle();
    assert.equal(w.uploads.length, 2, "tried again at once");
    w.uploads[1]!.reject(new ApiError(0, "offline", "network", null));
    await settle();
    assert.deepEqual(w.phase(), { k: "paused", page: 1, stop: { k: "offline" } });
  });
});

describe("pausing and stopping (docs/design-v1-pdf-handouts.md 4.1.6)", () => {
  test("each upload failure pauses or stops in its own words, and Try again goes on from that page", async () => {
    const cases: [unknown, string][] = [
      [new ApiError(0, "x", "network", null), "The upload stopped at page 2. Check your connection."],
      [new ApiError(503, "x", "busy", 2000), "The server is busy."],
      [new ApiError(429, "x", "rate_limited", 12 * 60_000), "Too many uploads this hour. Try again in 12 minutes."],
      [new ApiError(413, "x", "quota_exceeded", null), "The room's storage is full, after 1 of 3 pages. Free space in the Library, then try again."],
      [new ApiError(403, "x", "forbidden", null), "You are no longer a DM here."],
    ];
    for (const [err, words] of cases) {
      const w = world({ pages: 3, autoUpload: false });
      await w.open();
      w.runner.upload();
      await settle();
      w.uploads[0]!.resolve({});
      await settle();
      w.uploads[1]!.reject(err);
      await settle();
      assert.equal(w.phase().k, "paused", words);
      assert.equal(w.job().announce, words);
      assert.ok(waitsOnDm(w.job()));
      if (words.includes("no longer a DM")) {
        assert.deepEqual(w.ledger()?.ids, ["img-1"], "the ledger stays, so this device can remove them once it is a DM again");
        continue;
      }
      void w.runner.tryAgain();
      await settle();
      assert.equal(w.uploads.at(-1)!.page, 2, "on from page 2");
    }
    assert.deepEqual(stopFor(new DOMException("x", "AbortError")), null);
  });

  test("an upload that fails while the next page draws: Try again waits for that draw and encode to settle before drawing again", async () => {
    const w = world({ pages: 3, autoUpload: false, holdDraw: [2] });
    await w.open();
    w.runner.upload();
    await settle();
    // Page 1 uploads while page 2 draws, held past any cancel.
    w.uploads[0]!.reject(new ApiError(0, "x", "network", null));
    await settle();
    assert.equal(w.phase().k, "paused");
    void w.runner.tryAgain();
    await settle();
    const drawn = w.drawn();
    assert.equal(w.uploads.length, 1, "nothing new before page 2's draw settles");
    w.releaseDraw(2);
    await settle();
    assert.ok(w.drawn() > drawn, "drawing goes on once it settled");
    assert.equal(w.mostDrawing(), 1, "never two draws at once on the one canvas");
    assert.equal(w.uploads.at(-1)!.page, 1, "on from page 1");
  });

  test("Try again then Cancel while the last draw settles: the Cancel stands, with no new run and no create", async () => {
    const w = world({ pages: 3, autoUpload: false, holdDraw: [2] });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.reject(new ApiError(0, "x", "network", null));
    await settle();
    void w.runner.tryAgain();
    await settle();
    assert.equal(w.phase().k, "preparing", "the press claims the job at once");
    await w.runner.cancel();
    assert.equal(w.phase().k, "cancelled");
    w.releaseDraw(2);
    await settle();
    assert.equal(w.phase().k, "cancelled", "no run restarts after it");
    assert.equal(w.uploads.length, 1);
    assert.equal(w.sent.length, 0, "no create");
    assert.equal(w.opened.length, 1, "no fresh reader");
  });

  test("Try again pressed twice while the last draw settles is one press: one run, one create", async () => {
    const w = world({ pages: 2, holdDraw: [2] });
    const upload = w.deps.upload;
    let calls = 0;
    w.deps.upload = (blob, options) => (++calls === 1 ? Promise.reject(new ApiError(0, "x", "network", null)) : upload(blob, options));
    await w.open();
    w.runner.upload();
    await settle();
    assert.equal(w.phase().k, "paused");
    void w.runner.tryAgain();
    void w.runner.tryAgain();
    void w.runner.leaveOut();
    await settle();
    for (let i = 0; i < 4; i++) {
      w.releaseDraw(2);
      await settle();
    }
    assert.equal(w.sent.filter((x) => x.op.t === "handoutDoc.create").length, 1);
    assert.equal(w.mostDrawing(), 1);
    assert.deepEqual(w.job().leftOut, [], "the later presses did nothing");
  });

  test("a last run that never settles is let go with its reader after the wait, and Try again goes on in a fresh one", async () => {
    const w = world({ pages: 3, autoUpload: false, holdDraw: [2] });
    w.deps.quietMs = 30;
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.reject(new ApiError(0, "x", "network", null));
    await settle();
    const resumed = w.runner.tryAgain();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    assert.deepEqual(w.destroyed, [1], "the stuck reader is ended");
    assert.equal(w.opened.length, 2, "a fresh one opens");
    assert.equal(w.uploads.at(-1)!.page, 1, "on from page 1");
    void resumed;
  });

  test("Leave this page out after a failed draw also waits for the reader to be free", async () => {
    const w = world({ pages: 3, failDraw: [2] });
    await w.throughUpload();
    assert.equal(w.phase().k, "paused");
    await w.runner.leaveOut();
    await settle();
    assert.equal(w.mostDrawing(), 1);
    assert.deepEqual(w.job().leftOut, [2]);
  });

  test("an upload failure and the next page's failed draw at once: the failed reader is closed, and Try again opens a fresh one", async () => {
    const w = world({ pages: 3, autoUpload: false, failDraw: [2] });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.reject(new ApiError(0, "x", "network", null));
    await settle();
    assert.deepEqual(w.phase(), { k: "paused", page: 1, stop: { k: "offline" } }, "the upload's stop is the one said");
    assert.deepEqual(w.destroyed, [1], "the reader whose page failed is closed");
    void w.runner.tryAgain();
    await settle();
    assert.equal(w.opened.length, 2, "a fresh reader");
  });

  test("Cancel while the file opens ends its worker then, not when it has opened", async () => {
    const w = world({ holdOpen: true });
    void w.runner.start(new Blob(["%PDF-"]), "Strange letter.pdf");
    await settle();
    assert.equal(w.phase().k, "loading");
    assert.equal(w.openSignals[0]!.aborted, false);
    await w.runner.cancel();
    await settle();
    assert.equal(w.openSignals[0]!.aborted, true, "the opening was aborted");
    assert.equal(w.store.getState().job, null);
  });

  test("a reader whose worker never answers its end is ended after the grace anyway", async () => {
    let ended = false;
    const started = Date.now();
    await endWithin(() => new Promise(() => {}), () => (ended = true), 30);
    assert.ok(ended && Date.now() - started < 1_000);
    let order: string[] = [];
    await endWithin(async () => void order.push("graceful"), () => void order.push("terminate"), 1_000);
    assert.deepEqual(order, ["graceful", "terminate"], "a prompt end does not wait out the grace");
    order = [];
    await endWithin(() => Promise.reject(new Error("gone")), () => void order.push("terminate"), 1_000);
    assert.deepEqual(order, ["terminate"]);
  });

  test("a page that cannot draw pauses, never uploads, and Try again goes on in a fresh worker; Leave this page out goes on without it", async () => {
    for (const choice of ["tryAgain", "leaveOut"] as const) {
      const w = world({ pages: 3, failDraw: [2] });
      await w.throughUpload();
      assert.deepEqual(w.phase(), { k: "paused", page: 2, stop: { k: "drawFailed" } });
      assert.equal(w.job().announce, "Page 2 could not be drawn.");
      assert.deepEqual(w.uploads.map((u) => u.page), [1]);
      assert.equal(w.destroyed.length, 1, "the worker that failed is ended");
      if (choice === "leaveOut") w.runner.leaveOut();
      else void w.runner.tryAgain();
      await settle();
      assert.equal(w.opened.length, 2, "a fresh worker opens the file again");
      if (choice === "tryAgain") {
        assert.equal(w.phase().k, "paused", "page 2 fails again");
        continue;
      }
      assert.deepEqual(w.uploads.map((u) => u.page), [1, 3]);
      answer(w.sent[0]!, "taken");
      await settle();
      assert.equal(w.job().announce, "Saved as Strange letter, 2 pages. Page 2 was left out.");
    }
  });

  test("a page still too large at the smallest size offers Leave this page out, not Try again", async () => {
    const w = world({ pages: 2, tooLarge: [1] });
    await w.throughUpload();
    assert.deepEqual(w.phase(), { k: "paused", page: 1, stop: { k: "tooLarge" } });
    assert.equal(w.job().announce, "Page 1 is too large to upload.");
  });

  test("every page left out ends with no pages and sends no create; Try again goes back to the range", async () => {
    const w = world({ pages: 1, tooLarge: [1] });
    await w.throughUpload();
    w.runner.leaveOut();
    await settle();
    assert.deepEqual(w.phase(), { k: "empty" });
    assert.equal(w.job().announce, "No pages were uploaded.");
    assert.equal(w.sent.length, 0);
    void w.runner.tryAgain();
    assert.deepEqual(w.phase(), { k: "range" });
  });

  test("a pause is toasted only while the block is out of sight", async () => {
    for (const shown of [true, false]) {
      const w = world({ pages: 2, autoUpload: false });
      w.store.setState({ blockShown: shown });
      await w.open();
      w.runner.upload();
      await settle();
      w.uploads[0]!.reject(new ApiError(0, "x", "network", null));
      await settle();
      assert.deepEqual(w.toasts, shown ? [] : ["The PDF is open. Open Handouts in the DM panel to choose its pages.", "The PDF upload paused at page 1. Open Handouts in the DM panel to go on."]);
    }
  });

  test("a PDF refused or opened while the block is out of sight is toasted and badged, as a pause is", async () => {
    const refused = world({ openFails: new ReaderRefusal("password", "x") });
    refused.store.setState({ blockShown: false });
    await refused.open();
    assert.deepEqual(refused.toasts, ["The PDF could not be opened. Open Handouts in the DM panel."]);
    assert.ok(waitsOnDm(refused.job()), "a refusal badges the DM panel");
    const opened = world({ pages: 2 });
    opened.store.setState({ blockShown: false });
    await opened.open();
    assert.deepEqual(opened.toasts, ["The PDF is open. Open Handouts in the DM panel to choose its pages."]);
    assert.ok(waitsOnDm(opened.job()), "a PDF waiting for its range badges it");
    const seen = world({ pages: 2 });
    await seen.open();
    assert.deepEqual(seen.toasts, [], "in sight, no toast");
  });
});

describe("saving under a stable id (docs/design-v1-pdf-handouts.md 4.1.5)", () => {
  test("an invalid title pauses the save until it is fixed", async () => {
    const w = world({ pages: 1 });
    await w.open();
    w.runner.setTitle("  ");
    w.runner.upload();
    await settle();
    assert.deepEqual(w.phase(), { k: "titleInvalid" });
    assert.equal(w.sent.length, 0);
    w.runner.setTitle("Letter");
    w.runner.save();
    assert.equal(w.sent.length, 1);
  });

  test("a create the client's own check refuses says it could not be sent, with Try again", async () => {
    const w = world({ pages: 1 });
    w.deps.dispatch = () => null;
    await w.throughUpload();
    assert.deepEqual(w.phase(), { k: "saveFailed", words: "The handout could not be sent.", gone: false });
  });

  test("refused: every page kept and the reason said; refused gone uploads the pages the room no longer has, then saves", async () => {
    const w = world({ pages: 3 });
    await w.throughUpload();
    answer(w.sent[0]!, "refused", refusal("quota", "Not saved. The room holds at most 2,000 handout pages."));
    await settle();
    assert.deepEqual(w.phase(), { k: "saveFailed", words: "Not saved. The room holds at most 2,000 handout pages.", gone: false });
    assert.equal(w.job().pages.length, 3);
    void w.runner.tryAgain();
    await settle();
    answer(w.sent[1]!, "refused", refusal("gone", "Not saved. That is not here."));
    await settle();
    assert.equal(w.phase().k, "saveFailed");
    w.deps.listAssets = async () => [{ id: "img-1" }, { id: "img-3" }] as AssetRow[];
    const before = w.uploads.length;
    void w.runner.tryAgain();
    await settle();
    assert.deepEqual(w.uploads.slice(before).map((u) => u.page), [2], "only the page deleted meanwhile");
    assert.deepEqual((w.sent[2]!.op as Extract<ClientOp, { t: "handoutDoc.create" }>).doc.pages.map((p) => p.assetId), ["img-1", "img-2", "img-3"]);
  });

  test("unknown, settled by a snapshot: checked at once, saved when the document is there", async () => {
    const w = world({ pages: 1 });
    await w.throughUpload();
    w.state.view = w.withDoc();
    answer(w.sent[0]!, "unknown", undefined, "snapshot");
    await settle();
    assert.deepEqual(w.phase(), { k: "saved" });
  });

  test("unknown and absent: sent again under the same id, once, before it asks", async () => {
    const w = world({ pages: 1 });
    await w.throughUpload();
    answer(w.sent[0]!, "unknown", undefined, "snapshot");
    await settle();
    assert.equal(w.sent.length, 2);
    assert.deepEqual(w.sent[1]!.op, w.sent[0]!.op);
    answer(w.sent[1]!, "unknown", undefined, "snapshot");
    await settle();
    assert.deepEqual(w.phase(), { k: "saveFailed", words: "The handout may not have saved. Try again.", gone: false });
    assert.equal(w.sent.length, 2);
  });

  test("a create that had applied after all is refused as an id in use, and the job checks again", async () => {
    const w = world({ pages: 1 });
    await w.throughUpload();
    answer(w.sent[0]!, "unknown", undefined, "snapshot");
    await settle();
    w.state.view = w.withDoc();
    answer(w.sent[1]!, "refused", refusal("invalid", "Not saved. That handout is already saved."));
    await settle();
    assert.deepEqual(w.phase(), { k: "saved" });
  });

  test("unknown and expired: nothing is decided from the view before the connection's next snapshot, both ways", async () => {
    for (const committed of [true, false]) {
      const w = world({ pages: 1 });
      await w.throughUpload();
      answer(w.sent[0]!, "unknown", undefined, "expired");
      await settle();
      assert.deepEqual(w.phase(), { k: "checking", what: "save" });
      assert.equal(w.sent.length, 1, "no retry before the snapshot");
      w.snapshot(committed ? w.withDoc() : w.state.view);
      await settle();
      if (committed) assert.deepEqual(w.phase(), { k: "saved" });
      else assert.equal(w.sent.length, 2, "never applied: sent again");
    }
  });
});

describe("what the server holds decides a save (docs/design-v1-pdf-handouts.md 4.1.5)", () => {
  test("an unknown create that committed is saved even while a Library delete of it is pending, read from the room's real store", async () => {
    const withDoc = { ...testRoom(), handoutDocs: { "doc-1": { id: "doc-1", rev: 1, title: "Strange letter", pages: [{ assetId: "img-1", width: 1583, height: 2048 }], createdAt: "2026-10-16T00:00:00.000Z" } } } as RoomState;
    const server = new LocalServer(structuredClone(withDoc), DM_VIEWER, "s1");
    const roomStore = createRoomStore({ roomId: "R1", you: DM_VIEWER, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
    roomStore.setOutbox(new FakeOutbox());
    roomStore.applySnapshot(server.hello({ resumeFrom: roomStore.prepareHello().resumeFrom, sceneId: "s1" }));
    // The DM deletes it in the Library on this device, and the op is still pending: the view no longer has it.
    roomStore.dispatch({ t: "handoutDoc.delete", docId: "doc-1" });
    assert.equal(roomStore.store.getState().view?.handoutDocs["doc-1"], undefined);

    const w = world({ pages: 1 });
    w.deps.room = () => roomReadOf(roomStore.store.getState());
    w.deps.subscribe = (listener) => roomStore.store.subscribe(listener);
    await w.throughUpload();
    answer(w.sent[0]!, "unknown", undefined, "snapshot");
    await settle();
    assert.equal(w.phase().k, "saved", "the server holds it, so it saved");
    assert.equal(w.sent.filter((x) => x.op.t === "handoutDoc.create").length, 1, "no second create to bring back what the DM deleted");
  });
});

describe("Cancel upload (docs/design-v1-pdf-handouts.md 4.1.6)", () => {
  test("before the create: Cancelling… until the summary, its own pages deleted and a reused one never, the ledger cleared", async () => {
    const w = world({ pages: 3, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({ created: true });
    await settle();
    w.uploads[1]!.resolve({ id: "kept-loose-image", created: false });
    await settle();
    // Page 3 is waiting in the device's queue, never sent.
    const cancelling = w.runner.cancel();
    assert.deepEqual(w.phase(), { k: "cancelling" });
    assert.equal(w.job().announce, "Cancelling…");
    await cancelling;
    assert.deepEqual(w.deleted, [["img-1"]]);
    assert.deepEqual(w.phase(), { k: "cancelled", removed: 1, failed: false, stillSaved: false });
    assert.equal(w.job().announce, "Removed 1 page.");
    assert.equal(w.job().uncertain, null, "the queued page was never sent");
    assert.equal(w.ledger(), null);
    assert.equal(w.sent.length, 0);
  });

  test("an upload sending gets the grace to answer, and a page that answers in it is removed", async () => {
    const w = world({ pages: 2, autoUpload: false });
    w.holdSleeps();
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.options.onSending?.(true);
    const cancelling = w.runner.cancel();
    await settle();
    assert.deepEqual(w.sleeps.map((s) => s.ms), [CANCEL_GRACE_MS]);
    w.uploads[0]!.resolve({});
    await cancelling;
    assert.deepEqual(w.deleted, [["img-1"]]);
    assert.equal(w.job().uncertain, null);
  });

  test("an upload whose answer never settles: aborted after the grace, its page named with its size and picture, and kept in the ledger alone", async () => {
    const w = world({ pages: 2, autoUpload: false });
    w.holdSleeps();
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({});
    await settle();
    w.uploads[1]!.options.onSending?.(true);
    const cancelling = w.runner.cancel();
    await settle();
    w.sleeps[0]!.resolve();
    await cancelling;
    assert.equal(w.uploads[1]!.settled, true, "aborted");
    assert.deepEqual(w.job().uncertain, { page: 2, width: 1583, height: 2048, thumb: "data:image/jpeg;base64,page2" });
    assert.deepEqual(w.deleted, [["img-1"]]);
    assert.equal(w.job().announce, "Removed 1 page. Page 2 was uploading and may remain in the library as a loose handout image, 1583 × 2048 px.");
    assert.deepEqual(w.ledger(), { docId: "doc-1", title: "Strange letter", ids: [], uncertain: w.job().uncertain });
    await w.runner.end();
    assert.equal(w.ledger(), null, "Done: the DM has read it");
  });

  test("a page that never answered, then the page left before Done: the next visit names it once, and a new PDF opens", async () => {
    const w = world({ pages: 2, autoUpload: false });
    w.holdSleeps();
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({});
    await settle();
    w.uploads[1]!.options.onSending?.(true);
    const cancelling = w.runner.cancel();
    await settle();
    w.sleeps[0]!.resolve();
    await cancelling;
    assert.deepEqual(w.ledger()?.ids, [], "only the uncertain page is left");
    // The page goes before Done: the runner ends with the room, and the ledger stays.
    w.runner.dispose();
    w.store.setState({ job: null });
    const ledger = w.ledger()!;
    assert.ok(ledger.uncertain);

    // The next visit: the room offers it, with only Done, and it holds nothing.
    const back = new JobRunner(w.deps, w.store);
    assert.equal(recoveryOf(ledger, {}), "offer");
    back.recover(ledger);
    assert.equal(jobHolds(w.job()), false, "nothing to remove or keep, so nothing to wait on");
    assert.equal(pdfPickRefusal({ size: 1_000 }, w.job()), null);
    // A new PDF opens, and the old line goes.
    await new JobRunner(w.deps, w.store).start(new Blob(["%PDF-"]), "Second.pdf");
    assert.equal(w.phase().k, "range");
    assert.equal(w.ledger(), null);

    // Done on such a recovery clears it too.
    writeLedger(w.storage, ledgerKey(ROOM, ME), ledger);
    const again = new JobRunner(w.deps, w.store);
    again.recover(ledger);
    await again.end();
    assert.equal(w.ledger(), null, "read, so not offered again");
  });

  test("a waiting retry or a share pause stops at once", async () => {
    const w = world({ pages: 8, pageMs: 10_000 });
    w.state.online.push("p1");
    w.holdSleeps();
    await w.open();
    w.runner.upload();
    await settle();
    assert.equal(w.sleeps.length, 1, "the share pause once 20 s have passed");
    const sent = w.uploads.length;
    await w.runner.cancel();
    assert.equal(w.phase().k, "cancelled");
    assert.equal(w.uploads.length, sent, "nothing more sent");
  });

  test("cancelling offline keeps the ledger for the recovery", async () => {
    const w = world({ pages: 1, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({});
    await settle();
    w.deps.deleteImages = async () => ({ deleted: 0, inUse: false, error: new ApiError(0, "x", "network", null) });
    answer(w.sent[0]!, "refused", refusal("quota", "x"));
    await settle();
    await w.runner.cancel();
    assert.deepEqual(w.phase(), { k: "cancelled", removed: 0, failed: true, stillSaved: false });
    assert.deepEqual(w.ledger()?.ids, ["img-1"]);
    await w.runner.end();
    assert.deepEqual(w.ledger()?.ids, ["img-1"], "still there for next time");
  });

  test("while the create is queued or after it is taken: the document is deleted, then the job's own pages", async () => {
    const w = world({ pages: 2 });
    await w.throughUpload();
    void w.runner.cancel();
    assert.deepEqual(w.phase(), { k: "cancelling" });
    answer(w.sent[0]!, "taken");
    await settle();
    assert.deepEqual(w.sent[1]!.op, { t: "handoutDoc.delete", docId: "doc-1" });
    assert.deepEqual(w.deleted, [], "no page deleted before the document is gone");
    answer(w.sent[1]!, "taken");
    await settle();
    assert.deepEqual(w.deleted, [["img-1", "img-2"]]);
    assert.equal(w.phase().k, "cancelled");
  });

  test("after it is refused: only the pages", async () => {
    const w = world({ pages: 1 });
    await w.throughUpload();
    void w.runner.cancel();
    answer(w.sent[0]!, "refused", refusal("quota", "x"));
    await settle();
    assert.equal(w.sent.length, 1);
    assert.deepEqual(w.deleted, [["img-1"]]);
  });

  test("after an unknown that expired, with and without the commit: the check finishes first, then the document if there, then the pages", async () => {
    for (const committed of [true, false]) {
      const w = world({ pages: 1 });
      await w.throughUpload();
      answer(w.sent[0]!, "unknown", undefined, "expired");
      await settle();
      void w.runner.cancel();
      await settle();
      assert.equal(w.sent.length, 1, "nothing decided from the stale view");
      assert.deepEqual(w.deleted, []);
      w.snapshot(committed ? w.withDoc() : w.state.view);
      await settle();
      if (committed) {
        assert.deepEqual(w.sent[1]!.op, { t: "handoutDoc.delete", docId: "doc-1" });
        // The delete's own answer lost too, then the snapshot without the document.
        answer(w.sent[1]!, "unknown", undefined, "expired");
        await settle();
        assert.deepEqual(w.deleted, []);
        w.state.view = testRoom();
        w.snapshot();
        await settle();
      }
      assert.deepEqual(w.deleted, [["img-1"]]);
      assert.equal(w.phase().k, "cancelled");
    }
  });

  test("Cancel pressed after the create is taken but while the reader still closes deletes the saved document", async () => {
    const w = world({ pages: 2, holdDestroy: true });
    await w.throughUpload();
    answer(w.sent[0]!, "taken");
    await settle();
    assert.equal(w.phase().k, "saving", "still closing the reader");
    void w.runner.cancel();
    await settle();
    w.finishDestroys();
    await settle();
    const del = w.sent.find((x) => x.op.t === "handoutDoc.delete");
    assert.ok(del, "the saved document is deleted");
    answer(del, "taken");
    await settle();
    assert.equal(w.phase().k, "cancelled");
    assert.deepEqual(w.deleted, [["img-1", "img-2"]]);
  });

  test("a saved document whose delete stays undone leaves the pages to it, and says so", async () => {
    const w = world({ pages: 1 });
    await w.throughUpload();
    void w.runner.cancel();
    answer(w.sent[0]!, "taken");
    await settle();
    w.state.view = w.withDoc();
    answer(w.sent[1]!, "unknown", undefined, "snapshot");
    await settle();
    assert.deepEqual(w.phase(), { k: "cancelled", removed: 0, failed: false, stillSaved: true });
    assert.deepEqual(w.deleted, []);
  });
});

describe("Cancel upload with nothing to undo", () => {
  test("before anything uploads, Cancel ends the job, and a file still opening is closed when it opens", async () => {
    const w = world({ pages: 2 });
    await w.open();
    await w.runner.cancel();
    assert.equal(w.store.getState().job, null);
    assert.equal(w.destroyed.length, 1);
    const v = world({ pages: 2 });
    const opening = v.open();
    await v.runner.cancel();
    await opening;
    assert.equal(v.store.getState().job, null);
    assert.equal(v.destroyed.length, 1, "the worker that finished opening is ended");
  });
});

describe("the ledger and its recovery (docs/design-v1-pdf-handouts.md 4.1.2)", () => {
  test("found with its document saved, it is cleared quietly; otherwise offered", () => {
    const ledger = { docId: "doc-1", title: "Strange letter", ids: ["a", "b"], uncertain: null };
    assert.equal(recoveryOf(null, {}), "none");
    assert.equal(recoveryOf(ledger, { "doc-1": {} }), "saved");
    assert.equal(recoveryOf(ledger, {}), "offer");
    assert.equal(recoveryOf({ ...ledger, ids: [] }, {}), "saved");
    assert.equal(recoveryOf({ ...ledger, ids: [], uncertain: { page: 7, width: 1, height: 1, thumb: null } }, {}), "offer");
  });

  test("Remove them deletes exactly the ledger's ids; Keep them leaves them loose", async () => {
    const ledger = { docId: "doc-9", title: "Strange letter", ids: ["a", "b"], uncertain: { page: 7, width: 1583, height: 2048, thumb: "data:image/jpeg;base64,x" } };
    for (const choice of ["remove", "keep"] as const) {
      const w = world();
      writeLedger(w.storage, ledgerKey(ROOM, ME), ledger);
      w.runner.recover(ledger);
      assert.equal(w.job().announce, "A PDF upload did not finish: Strange letter, 2 pages are in the library. Page 7 may also be there, a loose handout image of 1583 × 2048 px.");
      assert.ok(waitsOnDm(w.job()));
      if (choice === "remove") {
        const removing = w.runner.removeRecovered();
        assert.deepEqual(w.phase(), { k: "removing" }, "its own phase, with no upload to cancel");
        assert.equal(jobActive(w.job()), true);
        await removing;
      } else w.runner.keepRecovered();
      assert.deepEqual(w.deleted, choice === "remove" ? [["a", "b"]] : []);
      assert.equal(w.ledger(), null);
      assert.equal(w.phase().k, "recovered");
    }
  });

  test("pages whose cleanup failed are never overwritten: the next PDF brings their recovery back first, after a failed Cancel and after a failed Remove them", async () => {
    const offline = async () => ({ deleted: 0, inUse: false, error: new ApiError(0, "x", "network", null) });
    // A Cancel whose delete failed, then Done.
    const w = world({ pages: 1 });
    await w.throughUpload();
    w.deps.deleteImages = offline;
    answer(w.sent[0]!, "refused", refusal("quota", "x"));
    await settle();
    await w.runner.cancel();
    await w.runner.end();
    assert.deepEqual(w.ledger()?.ids, ["img-1"]);
    await w.runner.start(new Blob(["%PDF-"]), "Second.pdf");
    assert.equal(w.phase().k, "recovery", "the earlier pages first");
    assert.equal(w.job().fileName, "Strange letter");
    assert.equal(w.opened.length, 1, "the second PDF is not opened");
    assert.deepEqual(w.ledger()?.ids, ["img-1"], "kept whole");

    // Remove them fails too, then Done: the next PDF still meets them.
    await w.runner.removeRecovered();
    assert.deepEqual(w.phase(), { k: "recovered", removed: 0, failed: true });
    await w.runner.end();
    await w.runner.start(new Blob(["%PDF-"]), "Third.pdf");
    assert.equal(w.phase().k, "recovery");
    assert.deepEqual(w.ledger()?.ids, ["img-1"]);

    // Once removed, the next PDF opens.
    w.deps.deleteImages = async (ids) => ({ deleted: ids.length, inUse: false, error: null });
    await w.runner.removeRecovered();
    await w.runner.end();
    await w.runner.start(new Blob(["%PDF-"]), "Fourth.pdf");
    assert.equal(w.phase().k, "range");
    assert.equal(w.ledger(), null);
  });

  test("a storage that refuses writes costs only the recovery", async () => {
    const w = world({ pages: 1 });
    w.storage.setItem = () => {
      throw new Error("quota");
    };
    await w.throughUpload();
    answer(w.sent[0]!, "taken");
    await settle();
    assert.equal(w.phase().k, "saved");
  });
});

describe("the job's pages and its holds (docs/design-v1-pdf-handouts.md 4.1.2)", () => {
  test("a running job's pages, owned and reused alike, are not loose; a finished one's are", async () => {
    const w = world({ pages: 2, autoUpload: false });
    await w.open();
    w.runner.upload();
    await settle();
    w.uploads[0]!.resolve({ id: "reused", created: false });
    await settle();
    assert.deepEqual([...jobPageIds(w.job())], ["reused"]);
    assert.ok(jobActive(w.job()));
    assert.deepEqual(pagesToDo(w.job()), [2]);
    w.uploads[1]!.resolve({});
    await settle();
    answer(w.sent[0]!, "taken");
    await settle();
    assert.deepEqual([...jobPageIds(w.job())], []);
    assert.equal(jobActive(w.job()), false);
  });
});
