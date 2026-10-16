import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { HandoutDoc } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "../../state/scope.ts";
import type { OpAnswer, OpRefusal, RoomView } from "../../state/types.ts";
import {
  docDeleteNote,
  docDeleteSlot,
  docDeleteStep,
  pageList,
  refusalReason,
  retryDocDelete,
  roomCheck,
  startDocDelete,
  startingDelete,
  unknownMark,
  type DocDelete,
  type DocDeleteDeps,
  type DocDeleteEvent,
  type RoomCheck,
} from "./docDelete.ts";
import type { DeleteResult } from "./library.ts";

/*
 * Deleting a document from the DM's Library (docs/design-v1-pdf-handouts.md
 * 3.5, 4.1.5's checking rule, 8.1, and the rows of 10.5 and 10.6): the op's
 * every answer, the image delete after it, and an `unknown` answer decided
 * only from a snapshot of the current connection.
 */

const page = (assetId: string) => ({ assetId, width: 1584, height: 2048 });
/** Twelve pages, the second and the last the same blank page. */
const LETTER: Pick<HandoutDoc, "id" | "title" | "pages"> = {
  id: "letter",
  title: "Strange letter",
  pages: ["p1", "blank", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "blank"].map(page),
};
const DISTINCT = ["p1", "blank", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"];

const room = (over: Partial<RoomCheck> = {}): RoomCheck => ({ accessVersion: 4, open: true, present: true, ...over });

/** Steps from the start through each event, returning every step's result. */
function run(...events: DocDeleteEvent[]) {
  const start = startingDelete(LETTER);
  const steps: { flow: DocDelete; effect: ReturnType<typeof docDeleteStep>["effect"] }[] = [start];
  let flow = start.flow;
  for (const e of events) {
    const step = docDeleteStep(flow, e);
    steps.push(step);
    flow = step.flow;
  }
  return { flow, steps, last: steps[steps.length - 1]! };
}

describe("a document delete, step by step", () => {
  test("starts by sending the delete", () => {
    const { flow, effect } = startingDelete(LETTER);
    assert.deepEqual(effect, { t: "dispatch" });
    assert.equal(flow.phase.t, "sending");
    assert.deepEqual(docDeleteNote(flow), { text: "Deleting Strange letter…", error: false, busy: true, retry: false });
    // Offline, the op waits in the outbox, and the note says why nothing happens yet.
    assert.equal(docDeleteNote(flow, false).text, "Waiting for the connection to delete Strange letter.");
  });

  test("taken: the document's images go, each once, and the note says so", () => {
    const taken = run({ t: "taken" });
    assert.deepEqual(taken.last.effect, { t: "deleteImages", ids: DISTINCT });
    assert.equal(docDeleteNote(taken.flow).busy, true);
    const done = run({ t: "taken" }, { t: "images", remaining: [], error: null });
    assert.equal(done.last.effect, null);
    assert.deepEqual(docDeleteNote(done.flow), { text: "Deleted Strange letter and its 12 pages.", error: false, busy: false, retry: false });
  });

  test("taken, then pages another handout uses are kept and named by every page number they fill", () => {
    const one = run({ t: "taken" }, { t: "images", remaining: ["p3"], error: null });
    assert.equal(docDeleteNote(one.flow).text, "Deleted Strange letter. Page 3 was kept, since another handout uses it.");
    const blank = run({ t: "taken" }, { t: "images", remaining: ["blank", "p4", "p5"], error: null });
    assert.equal(docDeleteNote(blank.flow).text, "Deleted Strange letter. Pages 2, 4, 5 and 12 were kept, since another handout uses them.");
    const all = run({ t: "taken" }, { t: "images", remaining: DISTINCT, error: null });
    assert.equal(docDeleteNote(all.flow).text, "Deleted Strange letter. Its pages were kept, since another handout uses them.");
  });

  test("taken, then the image delete fails: the ids are kept, and Try again deletes them again", () => {
    const failed = run({ t: "taken" }, { t: "images", remaining: ["p4", "p5"], error: "Could not reach the server. Check your connection." });
    assert.deepEqual(failed.flow.phase, { t: "imagesFailed", ids: ["p4", "p5"], reason: "Could not reach the server. Check your connection." });
    assert.deepEqual(docDeleteNote(failed.flow), {
      text: "Deleted Strange letter, but its pages could not be deleted. Could not reach the server. Check your connection.",
      error: true,
      busy: false,
      retry: true,
    });
    const again = docDeleteStep(failed.flow, { t: "retry" });
    assert.deepEqual(again.effect, { t: "deleteImages", ids: ["p4", "p5"] });
    const done = docDeleteStep(again.flow, { t: "images", remaining: [], error: null });
    assert.equal(docDeleteNote(done.flow).text, "Deleted Strange letter and its 12 pages.");
    // A failure that left nothing behind is done.
    assert.equal(run({ t: "taken" }, { t: "images", remaining: [], error: "Cancelled." }).flow.phase.t, "deleted");
  });

  test("refused: nothing is deleted, and the note gives the reason", () => {
    const refused = run({ t: "refused", reason: "It was already gone." });
    assert.equal(refused.last.effect, null);
    assert.deepEqual(docDeleteNote(refused.flow), { text: "The handout was not deleted. It was already gone.", error: true, busy: false, retry: false });
    assert.equal(docDeleteNote(run({ t: "refused", reason: "" }).flow).text, "The handout was not deleted.");
  });

  test("a null dispatch: the handout could not be sent", () => {
    const unsent = run({ t: "unsent" });
    assert.equal(unsent.last.effect, null);
    assert.deepEqual(docDeleteNote(unsent.flow), { text: "The handout could not be sent.", error: true, busy: false, retry: false });
  });

  test("unknown marked snapshot is checked at once: gone means deleted, so the images go", () => {
    const gone = run({ t: "unknown", mark: "snapshot", room: room({ present: false }) });
    assert.deepEqual(gone.last.effect, { t: "deleteImages", ids: DISTINCT });
  });

  test("unknown marked snapshot is checked at once: still there means not deleted, with Try again", () => {
    const there = run({ t: "unknown", mark: "snapshot", room: room({ present: true }) });
    assert.equal(there.last.effect, null);
    assert.deepEqual(docDeleteNote(there.flow), { text: "The handout was not deleted.", error: true, busy: false, retry: true });
  });

  test("unknown marked expired waits for the current connection's snapshot, deciding nothing before it", () => {
    const waiting = run({ t: "unknown", mark: "expired", room: room({ accessVersion: 4, open: false, present: false }) });
    assert.deepEqual(waiting.flow.phase, { t: "checking", after: 4 });
    assert.equal(waiting.last.effect, null);
    assert.deepEqual(docDeleteNote(waiting.flow), { text: "Checking whether the handout was deleted…", error: false, busy: true, retry: false });
    assert.deepEqual(docDeleteNote(waiting.flow, false), { text: "Waiting for the connection to check whether the handout was deleted.", error: false, busy: true, retry: false });
    // The stale state says absent, then present, then the socket opens: none of it is a new snapshot.
    for (const r of [room({ accessVersion: 4, open: false, present: false }), room({ accessVersion: 4, open: false, present: true }), room({ accessVersion: 4, open: true, present: false })]) {
      const step = docDeleteStep(waiting.flow, { t: "room", room: r });
      assert.equal(step.flow, waiting.flow);
      assert.equal(step.effect, null);
    }
    // A rise while the connection is not open is not this connection's snapshot either.
    assert.equal(docDeleteStep(waiting.flow, { t: "room", room: room({ accessVersion: 5, open: false, present: false }) }).effect, null);
  });

  test("unknown marked expired, then the snapshot without the document: deleted, and the images go", () => {
    const waiting = run({ t: "unknown", mark: "expired", room: room({ accessVersion: 4, open: false }) });
    const gone = docDeleteStep(waiting.flow, { t: "room", room: room({ accessVersion: 5, open: true, present: false }) });
    assert.deepEqual(gone.effect, { t: "deleteImages", ids: DISTINCT });
  });

  test("unknown marked expired, then the snapshot with the document: not deleted, and Try again sends the delete again", () => {
    const waiting = run({ t: "unknown", mark: "expired", room: room({ accessVersion: 4, open: false }) });
    const there = docDeleteStep(waiting.flow, { t: "room", room: room({ accessVersion: 5, open: true, present: true }) });
    assert.equal(there.flow.phase.t, "notDeleted");
    assert.equal(there.effect, null);
    const again = docDeleteStep(there.flow, { t: "retry" });
    assert.deepEqual(again.effect, { t: "dispatch" });
    assert.equal(again.flow.phase.t, "sending");
  });

  test("an answer that does not fit the phase changes nothing", () => {
    const done = run({ t: "taken" }, { t: "images", remaining: [], error: null });
    for (const e of [{ t: "taken" }, { t: "refused", reason: "x" }, { t: "unsent" }, { t: "retry" }, { t: "room", room: room({ accessVersion: 9, present: true }) }] as const) {
      const step = docDeleteStep(done.flow, e);
      assert.equal(step.flow, done.flow);
      assert.equal(step.effect, null);
    }
    // Images answering before any delete was taken are ignored too.
    const sending = startingDelete(LETTER).flow;
    assert.equal(docDeleteStep(sending, { t: "images", remaining: [], error: null }).flow, sending);
  });

  test("one page: its own words", () => {
    const one = { id: "one", title: "Map scrap", pages: [page("a")] };
    let flow = startingDelete(one).flow;
    flow = docDeleteStep(flow, { t: "taken" }).flow;
    assert.equal(docDeleteNote(docDeleteStep(flow, { t: "images", remaining: [], error: null }).flow).text, "Deleted Map scrap and its page.");
    assert.equal(docDeleteNote(docDeleteStep(flow, { t: "images", remaining: ["a"], error: null }).flow).text, "Deleted Map scrap. Its page was kept, since another handout uses it.");
  });

  test("page numbers read as a list, runs of three or more as a range", () => {
    assert.equal(pageList([3]), "3");
    assert.equal(pageList([3, 7]), "3 and 7");
    assert.equal(pageList([3, 4]), "3 and 4");
    assert.equal(pageList([1, 2, 3, 4, 7, 9]), "1 to 4, 7 and 9");
    assert.equal(pageList([2, 4, 5, 6, 12]), "2, 4 to 6 and 12");
    assert.equal(pageList([]), "");
  });
});

describe("reading the room for the checking rule", () => {
  test("the store's own mark wins, and without one an answer heard while the connection is open came with a snapshot", () => {
    assert.equal(unknownMark({ connection: "open" }, "expired"), "expired");
    assert.equal(unknownMark({ connection: "reconnecting" }, "snapshot"), "snapshot");
    assert.equal(unknownMark({ connection: "open" }), "snapshot");
    for (const connection of ["connecting", "reconnecting", "offline"] as const) assert.equal(unknownMark({ connection }), "expired");
  });

  test("presence is read from the confirmed state, not from the view that replays pending ops", () => {
    const docs = { letter: { ...LETTER, rev: 1, createdAt: "2026-10-16T10:00:00.000Z" } };
    const state = { accessVersion: 7, connection: "open", view: { handoutDocs: {} }, confirmed: { handoutDocs: docs } } as unknown as RoomView;
    assert.deepEqual(roomCheck(state, "letter"), { accessVersion: 7, open: true, present: true });
    const viewOnly = { accessVersion: 2, connection: "reconnecting", view: { handoutDocs: docs } } as unknown as RoomView;
    assert.deepEqual(roomCheck(viewOnly, "letter"), { accessVersion: 2, open: false, present: true });
    assert.equal(roomCheck(viewOnly, "other").present, false);
  });

  test("a refusal's reason drops the edit toast's opener, and gone says the document was already gone", () => {
    const refusal = (code: OpRefusal["code"], text: string): OpRefusal => ({ code, message: "", text });
    assert.equal(refusalReason(refusal("forbidden", "Only the DM can do that.")), "Only the DM can do that.");
    assert.equal(refusalReason(refusal("invalid", "Not saved. The room is read-only.")), "The room is read-only.");
    assert.equal(refusalReason(refusal("gone", "Not saved. That is not here.")), "It was already gone.");
    assert.equal(refusalReason(undefined), "");
  });
});

/** A room store, a dispatch that keeps each op's answer callback, and an image delete that answers when told. */
function harness(initial: { connection?: RoomView["connection"]; accessVersion?: number; present?: boolean } = {}) {
  const docs = (present: boolean) => (present ? { letter: { ...LETTER, rev: 1, createdAt: "2026-10-16T10:00:00.000Z" } } : {});
  const roomStore = createStore<RoomView>(
    () =>
      ({
        roomId: "room",
        connection: initial.connection ?? "open",
        accessVersion: initial.accessVersion ?? 1,
        view: { handoutDocs: {} },
        confirmed: { handoutDocs: docs(initial.present ?? true) },
      }) as unknown as RoomView,
  );
  const sent: { op: ClientOp; answer(a: OpAnswer, refusal?: OpRefusal): void }[] = [];
  const deletes: { ids: readonly string[]; settle(r: Partial<DeleteResult>): void }[] = [];
  let refuseDispatch = false;
  const deps: DocDeleteDeps = {
    roomId: "room",
    room: roomStore,
    dispatch: (op, opts) => {
      if (refuseDispatch) return null;
      sent.push({ op, answer: (a, r) => opts?.onAnswer?.(a, r) });
      assert.equal(opts?.quiet, true, "the note answers it, not a toast");
      return sent.length;
    },
    deleteImages: (_roomId, ids) =>
      new Promise((resolve) => deletes.push({ ids, settle: (r) => resolve({ deleted: 0, inUse: false, error: null, remaining: [], ...r }) })),
  };
  const scope = new RoomScope();
  const slot = scope.get(docDeleteSlot);
  return {
    deps,
    slot,
    sent,
    deletes,
    scope,
    refuse: () => (refuseDispatch = true),
    flow: () => slot.store.getState().flows.letter,
    snapshot: (present: boolean) => roomStore.setState((s) => ({ connection: "open", accessVersion: s.accessVersion + 1, confirmed: { handoutDocs: docs(present) } }) as Partial<RoomView>),
    setRoom: (patch: Record<string, unknown>) => roomStore.setState(patch as Partial<RoomView>),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a document delete in the room scope", () => {
  test("sends handoutDoc.delete, and once it is taken deletes the images, whoever has the Library open", async () => {
    const h = harness();
    startDocDelete(h.slot, h.deps, LETTER);
    assert.deepEqual(h.sent.map((s) => s.op), [{ t: "handoutDoc.delete", docId: "letter" }]);
    h.sent[0]!.answer("taken");
    assert.deepEqual(h.deletes.map((d) => d.ids), [DISTINCT]);
    h.deletes[0]!.settle({ remaining: [] });
    await settle();
    assert.equal(docDeleteNote(h.flow()!).text, "Deleted Strange letter and its 12 pages.");
  });

  test("a failed image delete keeps its ids, and Try again deletes them", async () => {
    const h = harness();
    startDocDelete(h.slot, h.deps, LETTER);
    h.sent[0]!.answer("taken");
    h.deletes[0]!.settle({ remaining: ["p4"], error: new Error("offline") });
    await settle();
    assert.equal(h.flow()!.phase.t, "imagesFailed");
    retryDocDelete(h.slot, h.deps, "letter");
    assert.deepEqual(h.deletes[1]!.ids, ["p4"]);
    h.deletes[1]!.settle({ remaining: [] });
    await settle();
    assert.equal(h.flow()!.phase.t, "deleted");
  });

  test("an image delete that throws counts as failed, keeping every id", async () => {
    const h = harness();
    h.deps.deleteImages = () => Promise.reject(new Error("boom"));
    startDocDelete(h.slot, h.deps, LETTER);
    h.sent[0]!.answer("taken");
    await settle();
    assert.deepEqual(h.flow()!.phase.t === "imagesFailed" ? h.flow()!.phase : null, { t: "imagesFailed", ids: DISTINCT, reason: "Something went wrong with that image." });
  });

  test("refused, and a null dispatch, delete nothing", () => {
    const refused = harness();
    startDocDelete(refused.slot, refused.deps, LETTER);
    refused.sent[0]!.answer("refused", { code: "forbidden", message: "only the DM", text: "Only the DM." });
    assert.equal(docDeleteNote(refused.flow()!).text, "The handout was not deleted. Only the DM.");
    assert.equal(refused.deletes.length, 0);

    const unsent = harness();
    unsent.refuse();
    startDocDelete(unsent.slot, unsent.deps, LETTER);
    assert.equal(docDeleteNote(unsent.flow()!).text, "The handout could not be sent.");
    assert.equal(unsent.deletes.length, 0);
  });

  test("an unknown answer heard with the snapshot installed is checked at once", () => {
    const gone = harness({ connection: "open", present: false });
    startDocDelete(gone.slot, gone.deps, LETTER);
    gone.sent[0]!.answer("unknown");
    assert.deepEqual(gone.deletes.map((d) => d.ids), [DISTINCT]);

    const there = harness({ connection: "open", present: true });
    startDocDelete(there.slot, there.deps, LETTER);
    there.sent[0]!.answer("unknown");
    assert.equal(there.flow()!.phase.t, "notDeleted");
    assert.equal(there.deletes.length, 0);
    assert.equal(there.slot.unwatch, null, "nothing left to watch");
  });

  test("an expired answer waits for the next snapshot, though the stale state lacks the document, then deletes the images", () => {
    const h = harness({ connection: "reconnecting", accessVersion: 3, present: false });
    startDocDelete(h.slot, h.deps, LETTER);
    h.sent[0]!.answer("unknown");
    assert.equal(h.flow()!.phase.t, "checking");
    assert.notEqual(h.slot.unwatch, null);
    // The socket opens before its snapshot installs: still nothing decided.
    h.setRoom({ connection: "open" });
    h.setRoom({ online: [] });
    assert.equal(h.flow()!.phase.t, "checking");
    assert.equal(h.deletes.length, 0);
    h.snapshot(false);
    assert.deepEqual(h.deletes.map((d) => d.ids), [DISTINCT]);
    assert.equal(h.slot.unwatch, null, "stops watching once decided");
  });

  test("an expired answer whose snapshot still holds the document is not deleted, and Try again sends it again", () => {
    const h = harness({ connection: "reconnecting", accessVersion: 3, present: true });
    startDocDelete(h.slot, h.deps, LETTER);
    h.sent[0]!.answer("unknown");
    h.snapshot(true);
    assert.equal(docDeleteNote(h.flow()!).text, "The handout was not deleted.");
    assert.equal(h.deletes.length, 0);
    retryDocDelete(h.slot, h.deps, "letter");
    assert.equal(h.sent.length, 2);
    h.sent[1]!.answer("taken");
    assert.equal(h.deletes.length, 1);
  });

  test("a new delete keeps the notes that still offer something and drops the rest, and an earlier run's late answer is dropped", () => {
    const h = harness();
    startDocDelete(h.slot, h.deps, { ...LETTER, id: "a" });
    h.sent[0]!.answer("refused");
    startDocDelete(h.slot, h.deps, { ...LETTER, id: "b" });
    h.setRoom({ confirmed: { handoutDocs: { b: { ...LETTER, id: "b" } } } });
    h.sent[1]!.answer("unknown");
    assert.equal(h.slot.store.getState().flows.b!.phase.t, "notDeleted");
    startDocDelete(h.slot, h.deps, { ...LETTER, id: "c" });
    assert.deepEqual(Object.keys(h.slot.store.getState().flows).sort(), ["b", "c"]);
    // Deleting b anew replaces its run, so the first run's answer arriving again changes nothing.
    startDocDelete(h.slot, h.deps, { ...LETTER, id: "b" });
    h.sent[1]!.answer("taken");
    assert.equal(h.slot.store.getState().flows.b!.phase.t, "sending");
    assert.equal(h.deletes.length, 0);
  });

  test("the scope's end stops watching the room", () => {
    const h = harness({ connection: "reconnecting" });
    startDocDelete(h.slot, h.deps, LETTER);
    h.sent[0]!.answer("unknown");
    assert.notEqual(h.slot.unwatch, null);
    h.scope.dispose();
    assert.equal(h.slot.unwatch, null);
  });
});
