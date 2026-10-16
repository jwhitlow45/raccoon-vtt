import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { api } from "../../../lib/api.ts";
import { useRoomScope, useScoped } from "../../../state/scope.ts";
import type { RoomActions, RoomUi, RoomViewStore } from "../../../state/view.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { deleteImages, rememberAsset, uploadingSlot } from "../../images/library.ts";
import { canvasSource, encodeWithin, pageThumb } from "./encode.ts";
import { jobActive, jobPageIds, pdfJobSlot, waitsOnDm } from "./job.ts";
import { clearLedger, ledgerKey, localLedgerStorage, readLedger, recoveryOf } from "./ledger.ts";
import { JobRunner, roomReadOf, type JobDeps } from "./run.ts";

/**
 * The PDF upload job in the page (docs/design-v1-pdf-handouts.md 4.1): its
 * runner wired to the room, the browser and the server, and the room
 * page's part in it, the badge, the warning before the page goes, and the
 * recovery of an upload that did not finish.
 */

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The runner's world in a browser: this room's store, ops and library, this page's visibility, the server's upload route. */
function liveDeps(roomId: string, memberId: string, store: RoomViewStore, actions: RoomActions, ui: RoomUi): JobDeps {
  return {
    roomId,
    memberId,
    newId: () => actions.newId(),
    // The reader and pdf.js load only here, when a DM picks a PDF (4.2.5).
    open: async (file, signal) => (await import("./render.ts")).openPdf(await file.arrayBuffer(), signal),
    canvas: () => document.createElement("canvas"),
    encode: (canvas) => encodeWithin(canvasSource(canvas)),
    thumb: (canvas) => pageThumb(canvas),
    upload: (blob, options) => api.uploadAsset(roomId, "handout", blob, options),
    remember: (row) => rememberAsset(roomId, row),
    deleteImages: (ids) => deleteImages(roomId, ids),
    listAssets: async () => (await api.listAssets(roomId)).assets,
    dispatch: (op, opts) => actions.dispatch(op, opts),
    room: () => roomReadOf(store.getState()),
    subscribe: (listener) => store.subscribe(listener),
    storage: localLedgerStorage(),
    notify: (text) => ui.notify(text),
    hidden: () => document.visibilityState === "hidden",
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    sleep,
    now: () => Date.now(),
  };
}

/** The room's job and the way to start one, for the DM panel's block and form. */
export function usePdfJob() {
  const slot = useScoped(pdfJobSlot);
  const job = useStore(slot.store, (s) => s.job);
  const roomId = useRoomView((s) => s.roomId);
  const memberId = useRoomView((s) => s.you?.memberId ?? null);
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  /** A runner for this room, replacing a finished one. */
  const runner = (): JobRunner | null => {
    if (!memberId) return null;
    slot.runner?.dispose();
    const next = new JobRunner(liveDeps(roomId, memberId, store, actions, ui), slot.store);
    slot.runner = next;
    return next;
  };
  return {
    job,
    store: slot.store,
    /** The runner of the job showing, if any. */
    current: () => (slot.runner instanceof JobRunner ? slot.runner : null),
    start(file: File) {
      void runner()?.start(file, file.name);
    },
  };
}

/** Whether the job waits on the DM, for the DM panel's badge (4.1.1). */
export function useJobWaiting(): boolean {
  const slot = useScoped(pdfJobSlot);
  return useStore(slot.store, (s) => waitsOnDm(s.job));
}

/**
 * The room page's share of the job: the warning before the page goes while
 * a job is under way, and, when this device opens the room as a DM with a
 * ledger and no job, the recovery line, or the ledger cleared quietly when
 * its save happened (4.1.2, 4.1.6). Mounted once by the Room page, so it
 * runs with the DM panel closed.
 */
export function usePdfJobRoom(): void {
  const scope = useRoomScope();
  const slot = scope.get(pdfJobSlot);
  const active = useStore(slot.store, (s) => jobActive(s.job));
  const roomId = useRoomView((s) => s.roomId);
  const memberId = useRoomView((s) => (s.you?.role === "dm" ? s.you.memberId : null));
  const loaded = useRoomView((s) => s.view !== null);
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const checked = useRef<string | null>(null);

  // The Library's "Uploading" tags and Clean up's skip read the job's pages here (images/library.ts uploadingSlot), emptied when the job ends.
  const uploading = scope.get(uploadingSlot);
  useEffect(() => {
    const mirror = (job: Parameters<typeof jobPageIds>[0]) => {
      const ids = jobPageIds(job);
      const now = uploading.getState().ids;
      if (ids.size !== now.size || [...ids].some((id) => !now.has(id))) uploading.setState({ ids: new Set(ids) });
    };
    mirror(slot.store.getState().job);
    return slot.store.subscribe((s) => mirror(s.job));
  }, [slot, uploading]);

  useEffect(() => {
    if (!active) return;
    // A reload or a closed tab asks first where the browser lets it. iPhone Safari often does not, and the ledger covers it.
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  useEffect(() => {
    if (!memberId || !loaded || slot.store.getState().job) return;
    const key = ledgerKey(roomId, memberId);
    if (checked.current === key) return;
    checked.current = key;
    const storage = localLedgerStorage();
    const ledger = readLedger(storage, key);
    // What the server is known to hold, not this device's pending changes.
    const found = recoveryOf(ledger, roomReadOf(store.getState()).savedDocs ?? undefined);
    if (found === "saved") clearLedger(storage, key);
    if (found !== "offer" || !ledger) return;
    const runner = new JobRunner(liveDeps(roomId, memberId, store, actions, ui), slot.store);
    slot.runner = runner;
    runner.recover(ledger);
  }, [memberId, loaded, roomId, slot, store, actions, ui]);
}

/** Whether leaving the room now would cut a PDF upload short, for Leave room's question (4.1.6). */
export function useJobActive(): boolean {
  const slot = useScoped(pdfJobSlot);
  return useStore(slot.store, (s) => jobActive(s.job));
}
