import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { HandoutDoc } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { OpRefusal, RoomActions, RoomView } from "../../state/types.ts";
import { imageErrorMessage } from "./errors.ts";
import type { DeleteResult } from "./library.ts";

/**
 * Deleting a document from the DM's Library (docs/design-v1-pdf-handouts.md
 * 3.5 and 8.1): `handoutDoc.delete`, then the document's images through the
 * delete route, which keeps any image another handout or document names.
 *
 * The images may go only once the document is known to be gone, or the
 * route would refuse them as in use and leave them, and a lost answer
 * (`unknown`) must not be guessed from a state older than the delete. So
 * every answer goes through one pure step function, and an `unknown` waits
 * for the checking rule of section 4.1.5 before it decides anything.
 *
 * Each delete lives in a room-scoped store, not in the panel, so closing
 * the Library while the answer is out or the images are going still
 * deletes them, and the note is there when the Library opens again.
 */

/**
 * How an `unknown` answer was settled (section 4.1.5): `snapshot` when a
 * reconnect's snapshot settled the op and is installed as the answer
 * arrives, `expired` when the op grew too old to resend and was dropped
 * while the store prepared its hello, before any new snapshot.
 */
export type UnknownMark = "snapshot" | "expired";

/**
 * The mark of an `unknown` answer, read as it arrives: the store's own,
 * which it passes as the answer's third argument (section 4.1.5, with the
 * PDF upload job), else read from the connection.
 *
 * Why the connection stands in for a store that passes none: the socket
 * sets the connection to "open" before `applySnapshot` tells its answers,
 * and `prepareHello` tells while a new socket is still connecting. A
 * server's resync prepares a hello on a socket that stays "open", so an op
 * that expired there would read as `snapshot` and be checked against the
 * state from before the resync. The store's own mark closes that gap.
 */
export function unknownMark(state: Pick<RoomView, "connection">, told?: UnknownMark): UnknownMark {
  return told ?? (state.connection === "open" ? "snapshot" : "expired");
}

/** What the room says about the document, read when an answer or a change of the store arrives. */
export type RoomCheck = { accessVersion: number; open: boolean; present: boolean };

/**
 * `accessVersion` rises with every snapshot (state/types.ts), which is what
 * an `expired` answer waits for. Presence is read from the server's
 * confirmed state, which the live store keeps beside the view: the view
 * replays this device's pending ops over it, and the checking rule asks
 * what the server holds.
 */
export function roomCheck(state: RoomView, docId: string): RoomCheck {
  const confirmed = (state as RoomView & { confirmed?: Pick<RoomView, "view">["view"] }).confirmed;
  const docs = (confirmed ?? state.view)?.handoutDocs;
  return { accessVersion: state.accessVersion, open: state.connection === "open", present: docs?.[docId] !== undefined };
}

export type DocDeletePhase =
  /** `handoutDoc.delete` is queued or sent, its answer not heard yet. */
  | { t: "sending" }
  /** An `expired` answer, waiting for a snapshot newer than `after` on an open connection. */
  | { t: "checking"; after: number }
  /** The document is gone, and its images are being deleted. */
  | { t: "deleting"; ids: readonly string[] }
  /** Done. `kept` are the images the route kept because something else uses them. */
  | { t: "deleted"; kept: readonly string[] }
  /** The document is gone, but deleting its images failed. Try again sends `ids` again. Until then they are loose images. */
  | { t: "imagesFailed"; ids: readonly string[]; reason: string }
  | { t: "refused"; reason: string }
  /** The checking rule found the document still there. Try again sends the delete again. */
  | { t: "notDeleted" }
  /** `dispatch` refused the op before sending it. */
  | { t: "unsent" };

export type DocDelete = {
  docId: string;
  title: string;
  /** Every page's image in order, a repeated page each time, so a kept image is named by every page number it fills. */
  pages: readonly string[];
  phase: DocDeletePhase;
};

export type DocDeleteEvent =
  | { t: "unsent" }
  | { t: "taken" }
  | { t: "refused"; reason: string }
  | { t: "unknown"; mark: UnknownMark; room: RoomCheck }
  /** The room store changed while an answer is being checked. */
  | { t: "room"; room: RoomCheck }
  /** The image delete finished. `error` is its words when it failed. */
  | { t: "images"; remaining: readonly string[]; error: string | null }
  | { t: "retry" };

export type DocDeleteEffect = { t: "dispatch" } | { t: "deleteImages"; ids: readonly string[] };

export function startingDelete(doc: Pick<HandoutDoc, "id" | "title" | "pages">): { flow: DocDelete; effect: DocDeleteEffect } {
  return { flow: { docId: doc.id, title: doc.title, pages: doc.pages.map((p) => p.assetId), phase: { t: "sending" } }, effect: { t: "dispatch" } };
}

/** One step of a document delete. An event that does not fit the phase changes nothing, so a late or repeated answer is harmless. */
export function docDeleteStep(flow: DocDelete, event: DocDeleteEvent): { flow: DocDelete; effect: DocDeleteEffect | null } {
  const to = (phase: DocDeletePhase, effect: DocDeleteEffect | null = null) => ({ flow: { ...flow, phase }, effect });
  const stay = { flow, effect: null };
  const deleteImages = () => {
    const ids = [...new Set(flow.pages)];
    return to({ t: "deleting", ids }, { t: "deleteImages", ids });
  };
  // Only a snapshot of this connection decides: gone means deleted, so the images go, and present means it was not.
  const decide = (present: boolean) => (present ? to({ t: "notDeleted" }) : deleteImages());
  const phase = flow.phase;
  switch (event.t) {
    case "unsent":
      return phase.t === "sending" ? to({ t: "unsent" }) : stay;
    case "taken":
      return phase.t === "sending" ? deleteImages() : stay;
    case "refused":
      return phase.t === "sending" ? to({ t: "refused", reason: event.reason }) : stay;
    case "unknown":
      if (phase.t !== "sending") return stay;
      return event.mark === "snapshot" ? decide(event.room.present) : to({ t: "checking", after: event.room.accessVersion });
    case "room":
      if (phase.t !== "checking" || !event.room.open || event.room.accessVersion <= phase.after) return stay;
      return decide(event.room.present);
    case "images":
      if (phase.t !== "deleting") return stay;
      if (event.error !== null && event.remaining.length > 0) return to({ t: "imagesFailed", ids: event.remaining, reason: event.error });
      return to({ t: "deleted", kept: event.remaining });
    case "retry":
      if (phase.t === "notDeleted") return to({ t: "sending" }, { t: "dispatch" });
      if (phase.t === "imagesFailed") return to({ t: "deleting", ids: phase.ids }, { t: "deleteImages", ids: phase.ids });
      return stay;
  }
}

/** Whether the delete still runs, so the document's Delete waits and its pages are not listed loose. */
export function deleteRunning(flow: DocDelete): boolean {
  return flow.phase.t === "sending" || flow.phase.t === "checking" || flow.phase.t === "deleting";
}

/** "3", "3 and 7", "1 to 4, 7 and 9": page numbers, runs of three or more as a range. */
export function pageList(numbers: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${numbers[i]} to ${numbers[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(numbers[k]));
    i = j + 1;
  }
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type DocDeleteNote = { text: string; error: boolean; busy: boolean; retry: boolean };

/** The note under the Handouts grid for one delete. */
export function docDeleteNote(flow: DocDelete): DocDeleteNote {
  const { title, pages, phase } = flow;
  const note = (text: string, more: Partial<DocDeleteNote> = {}): DocDeleteNote => ({ text, error: false, busy: false, retry: false, ...more });
  switch (phase.t) {
    case "sending":
    case "deleting":
      return note(`Deleting ${title}…`, { busy: true });
    case "checking":
      return note("Checking whether the handout was deleted…", { busy: true });
    case "deleted": {
      if (phase.kept.length === 0) return note(`Deleted ${title} and ${pages.length === 1 ? "its page" : `its ${pages.length} pages`}.`);
      const kept = new Set(phase.kept);
      const numbers = pages.flatMap((id, i) => (kept.has(id) ? [i + 1] : []));
      if (numbers.length === pages.length) return note(`Deleted ${title}. ${pages.length === 1 ? "Its page was kept, since another handout uses it." : "Its pages were kept, since another handout uses them."}`);
      const one = numbers.length === 1;
      return note(`Deleted ${title}. ${one ? "Page" : "Pages"} ${pageList(numbers)} ${one ? "was" : "were"} kept, since another handout uses ${one ? "it" : "them"}.`);
    }
    case "imagesFailed":
      return note(`Deleted ${title}, but its pages could not be deleted. ${phase.reason}`, { error: true, retry: true });
    case "refused":
      return note(`The handout was not deleted.${phase.reason ? ` ${phase.reason}` : ""}`, { error: true });
    case "notDeleted":
      return note("The handout was not deleted.", { error: true, retry: true });
    case "unsent":
      return note("The handout could not be sent.", { error: true });
  }
}

/**
 * A refusal's own words, without the "Not saved." that opens an edit's
 * toast. `gone` means the document was not there to delete, deleted from
 * another device or taken back by an undo, which "That is not here" would
 * say less plainly.
 */
export function refusalReason(refusal: OpRefusal | undefined): string {
  if (!refusal) return "";
  if (refusal.code === "gone") return "It was already gone.";
  return refusal.text.replace(/^Not saved\.\s*/, "").trim();
}

// ---------------------------------------------------------------- running it in the room scope

/** `run` tells a delete from an earlier one of the same document, whose late answers are dropped. */
type Running = DocDelete & { run: number };

export type DocDeletes = { flows: Readonly<Record<string, Running>> };

export type DocDeleteRoom = {
  store: StoreApi<DocDeletes>;
  /** Stops watching the room store, while a delete waits on the checking rule. */
  unwatch: (() => void) | null;
  runs: number;
};

export const docDeleteSlot = scopeSlot<DocDeleteRoom>(
  () => ({ store: createStore<DocDeletes>(() => ({ flows: {} })), unwatch: null, runs: 0 }),
  (room) => {
    room.unwatch?.();
    room.unwatch = null;
  },
);

export type DocDeleteDeps = {
  roomId: string;
  room: Pick<StoreApi<RoomView>, "getState" | "subscribe">;
  dispatch: RoomActions["dispatch"];
  deleteImages(roomId: string, ids: readonly string[]): Promise<DeleteResult>;
};

/**
 * Starts deleting a document. Notes that offer nothing more give way to it.
 * Returns the delete as it stands once the op is queued, so a caller sees at
 * once a dispatch that refused it.
 */
export function startDocDelete(slot: DocDeleteRoom, deps: DocDeleteDeps, doc: Pick<HandoutDoc, "id" | "title" | "pages">): DocDelete {
  const flows: Record<string, Running> = {};
  for (const [id, f] of Object.entries(slot.store.getState().flows)) if (deleteRunning(f) || docDeleteNote(f).retry) flows[id] = f;
  const { flow, effect } = startingDelete(doc);
  const run = ++slot.runs;
  flows[doc.id] = { ...flow, run };
  slot.store.setState({ flows });
  perform(slot, deps, doc.id, run, effect);
  return slot.store.getState().flows[doc.id] ?? flow;
}

export function retryDocDelete(slot: DocDeleteRoom, deps: DocDeleteDeps, docId: string): void {
  const flow = slot.store.getState().flows[docId];
  if (flow) send(slot, deps, docId, flow.run, { t: "retry" });
}

/** Steps one delete, and does what the step asks. */
function send(slot: DocDeleteRoom, deps: DocDeleteDeps, docId: string, run: number, event: DocDeleteEvent): void {
  const flow = slot.store.getState().flows[docId];
  if (!flow || flow.run !== run) return;
  const step = docDeleteStep(flow, event);
  if (step.flow !== flow) slot.store.setState({ flows: { ...slot.store.getState().flows, [docId]: { ...step.flow, run } } });
  watch(slot, deps);
  if (step.effect) perform(slot, deps, docId, run, step.effect);
}

function perform(slot: DocDeleteRoom, deps: DocDeleteDeps, docId: string, run: number, effect: DocDeleteEffect): void {
  if (effect.t === "deleteImages") {
    deps.deleteImages(deps.roomId, effect.ids).then(
      (r) => send(slot, deps, docId, run, { t: "images", remaining: r.remaining, error: r.error === null ? null : imageErrorMessage(r.error) }),
      (err: unknown) => send(slot, deps, docId, run, { t: "images", remaining: effect.ids, error: imageErrorMessage(err) }),
    );
    return;
  }
  const n = deps.dispatch(
    { t: "handoutDoc.delete", docId },
    {
      // The note says what became of it, where a toast would say it twice.
      quiet: true,
      onAnswer: (answer, refusal, told?: UnknownMark) => {
        if (answer === "taken") return send(slot, deps, docId, run, { t: "taken" });
        if (answer === "refused") return send(slot, deps, docId, run, { t: "refused", reason: refusalReason(refusal) });
        const state = deps.room.getState();
        send(slot, deps, docId, run, { t: "unknown", mark: unknownMark(state, told), room: roomCheck(state, docId) });
      },
    },
  );
  if (n === null) send(slot, deps, docId, run, { t: "unsent" });
}

/** Watches the room store only while a delete waits on the checking rule, and feeds it every change. */
function watch(slot: DocDeleteRoom, deps: DocDeleteDeps): void {
  const checking = Object.values(slot.store.getState().flows).some((f) => f.phase.t === "checking");
  if (checking && !slot.unwatch) {
    slot.unwatch = deps.room.subscribe(() => {
      for (const f of Object.values(slot.store.getState().flows)) {
        if (f.phase.t === "checking") send(slot, deps, f.docId, f.run, { t: "room", room: roomCheck(deps.room.getState(), f.docId) });
      }
    });
  } else if (!checking && slot.unwatch) {
    slot.unwatch();
    slot.unwatch = null;
  }
}
