import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RollRequest, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { SaveOutcomeLedger, SaveOutcomeRecord } from "#shared/saveOutcomeContract.ts";
import { DM, room as testRoom, token } from "#shared/testutil.ts";
import { createRoomStore } from "../../../state/store.ts";
import { FakeClock } from "../../../state/testing.ts";
import { ReceiptTracker } from "../useReceipt.ts";
import { newPage, type Page } from "./chain.ts";
import { authorityOf, bindSaveLifecycle } from "./lifecycle.ts";
import { captureChoices, OUTCOME_UNAVAILABLE, OUTCOME_UNDONE, SAVE_MEMORY_ONLY, type SaveSession } from "./reopen.ts";
import type { SaveDraft } from "./reopenContract.ts";
import type { GroupSaveState } from "./store.ts";

const PLAN = "019a4000-0000-7000-8000-000000000001";
const APPLIED = "Group save: applied. Undo takes it all back.";
const record = (state: "applied" | "undone", revision: number, seq = 10): SaveOutcomeRecord => ({ memberId: DM.memberId, plan: PLAN, revision, state, seq, firstAppliedAt: "2026-10-31T00:00:00.000Z" });

function page(): Page {
  return {
    ...newPage({ id: "page", sceneId: "s1", source: { kind: "selection", tokenIds: ["g1"] }, test: { kind: "save", ability: "dex" }, dc: 15, secret: false, spell: false, switches: { dcShown: true, resultShown: true } }),
    phase: "rolled", rows: [{ holder: "token:g1", target: { tokenId: "g1" }, tokenId: "g1", name: "Goblin", ways: ["type"], bonus: 0, skip: false }], states: { "token:g1": { way: "type", typed: 14 } },
  };
}

function session(phase: "applying" | "applied" = "applied"): SaveSession {
  const before = page();
  return {
    page: { ...before, phase, apply: phase === "applying" ? "sending" : "taken", plan: { t: "actor.outcome", plan: PLAN, targets: [{ target: { tokenId: "g1" }, amount: 3 }] } },
    reopen: {
      tracking: { id: PLAN, plan: PLAN, revision: phase === "applying" ? 0 : 1 },
      beforeApply: { version: 1, pageId: before.id, plan: PLAN, choices: captureChoices(before) },
      check: phase === "applying" ? "checking" : "applied",
    },
  };
}

function asking(): Page {
  const held = page();
  return {
    ...held,
    rows: held.rows.map(row => ({ ...row, ways: ["ask"], askRef: { tokenId: "g1" } })),
    states: { "token:g1": { way: "ask", asked: { rollId: "old", dc: 12 }, answer: { tokenId: "g1", total: 19 }, mark: "pass" } },
    requests: [
      { rollId: "old", holders: ["token:g1"], state: "closed" },
      { rollId: "fresh", holders: ["token:g1"], selected: ["token:g1"], replaces: ["old"], dc: 15, state: "sending" },
    ],
  };
}

const ask = (): RollRequest => ({ id: "fresh", rev: 1, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: true, resultShown: true, at: "2026-10-31T00:00:00.000Z", targets: [{ tokenId: "g1" }] });

function fixture(initial: SaveSession | null = session(), ledger: SaveOutcomeLedger = { [PLAN]: record("applied", 1) }) {
  const room = createRoomStore({ roomId: "room", you: DM, clock: new FakeClock(), undoNotice: { claim: () => false } });
  const game = testRoom({ tokens: { g1: token("g1") } });
  const snapshot = (outcomes: SaveOutcomeLedger, seq = 10) => room.applySnapshot({ t: "snapshot", seq, watermark: 0, state: { ...projectState(game, DM, { sceneId: "s1" }), saveOutcomes: outcomes }, you: { ...DM, sceneId: "s1" } });
  room.setConnection("open");
  snapshot(ledger);
  const store = createStore<GroupSaveState>(() => ({ page: initial?.page ?? null, reopen: initial?.reopen ?? null, shownIn: null, restored: true }));
  const receipts = new ReceiptTracker();
  let lookups = 0;
  receipts.env = { lookup: async () => { lookups++; return { parts: [] }; }, log: () => [] };
  const writes: (SaveDraft | null)[] = [];
  const notices: string[] = [];
  const options = { store, room: room.store, receipts, persist: (_roomId: string, draft: SaveDraft | null) => { writes.push(structuredClone(draft)); return true; }, notify: (text: string) => { notices.push(text); room.ui.notify(text, "info"); } };
  return { room, game, store, receipts, snapshot, writes, notices, options, lookups: () => lookups };
}

test("authority reads only confirmed state and requires the current connection's snapshot", () => {
  const f = fixture();
  const confirmed = f.room.store.getState().confirmed as unknown as RoomState & { saveOutcomes: SaveOutcomeLedger };
  f.room.store.setState({ view: { ...f.game, saveOutcomes: { [PLAN]: record("undone", 2) } } as RoomState });
  const current = authorityOf(f.room.store.getState(), page());
  assert.equal(current.ready, true);
  assert.equal(current.ledger, confirmed.saveOutcomes);
  assert.equal(current.ledger[PLAN]!.state, "applied");
  assert.equal(current.seq, 10);
  assert.equal(current.sceneAvailable, true);
  assert.equal(authorityOf({ ...f.room.store.getState(), sceneId: "elsewhere" }, page()).sceneAvailable, false);
  assert.equal(authorityOf({ ...f.room.store.getState(), confirmedReady: false }, page()).ready, false);
  assert.equal(authorityOf({ ...f.room.store.getState(), connection: "offline" }, page()).ready, false);
  f.room.dispose();
});

test("a closed retained panel reopens from confirmed Undo without opening UI and persists later edits", () => {
  const f = fixture();
  const local = f.room.store.getState().local;
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.equal(f.store.getState().page!.phase, "rolled");
  assert.equal(f.store.getState().page!.plan, null);
  assert.equal(f.store.getState().reopen!.notice, OUTCOME_UNDONE);
  assert.equal(f.store.getState().shownIn, null);
  assert.equal(f.room.store.getState().local, local);
  assert.deepEqual(f.notices, [APPLIED, OUTCOME_UNDONE]);
  f.store.setState({ page: { ...f.store.getState().page!, dc: 19 } });
  assert.equal(f.writes.at(-1)!.page.dc, 19);
  assert.equal(f.writes.at(-1)!.beforeApply!.choices.dc, 15);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 12);
  assert.deepEqual(f.notices, [APPLIED, OUTCOME_UNDONE], "duplicate views and notification updates never repeat the notice");
  stop();
  f.room.dispose();
});

test("no local draft is manufactured by an outcome and clearing a page removes only its stored draft", () => {
  const f = fixture(null, { [PLAN]: record("undone", 2) });
  const stop = bindSaveLifecycle(f.options);
  assert.equal(f.store.getState().page, null);
  assert.equal(f.lookups(), 0);
  assert.deepEqual(f.notices, []);
  f.store.setState({ ...session(), shownIn: "dice", restored: false });
  f.store.setState({ page: null });
  assert.equal(f.store.getState().reopen, null);
  assert.equal(f.writes.at(-1), null);
  assert.equal((f.room.store.getState().confirmed as unknown as { saveOutcomes: SaveOutcomeLedger }).saveOutcomes[PLAN]!.state, "undone");
  stop();
  f.room.dispose();
});

test("receipt before view stays checking until coverage, and a closed panel looks up its retained Apply once", async () => {
  const f = fixture(session("applying"), {});
  let lookups = 0;
  f.receipts.env = { lookup: async () => { lookups++; return { parts: [{ part: 0, state: "committed", seq: 20, lines: [] }] }; }, log: () => [] };
  const stop = bindSaveLifecycle(f.options);
  await f.receipts.lookup(PLAN);
  assert.equal(lookups, 1);
  assert.equal(f.store.getState().reopen?.receipt?.seq, 20);
  assert.equal(f.store.getState().reopen?.check, "checking");
  assert.deepEqual(f.notices, []);
  f.snapshot({}, 20);
  assert.equal(f.store.getState().reopen?.check, "unavailable");
  assert.deepEqual(f.notices, [OUTCOME_UNAVAILABLE]);
  stop();
  f.room.dispose();
});

test("confirmed status before an Apply ack reopens once and the late receipt cannot relock it", () => {
  const f = fixture(session("applying"), {});
  f.receipts.sending(PLAN, 0);
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.equal(f.store.getState().page!.phase, "rolled");
  f.store.setState({ page: { ...f.store.getState().page!, dc: 21 } });
  f.receipts.answer(PLAN, 0, "taken");
  assert.equal(f.store.getState().page!.dc, 21);
  assert.equal(f.store.getState().page!.phase, "rolled");
  assert.deepEqual(f.notices, [OUTCOME_UNDONE]);
  stop();
  f.room.dispose();
});

test("storage failure retains memory and announces once without a subscription loop", () => {
  const f = fixture();
  let writes = 0;
  const stop = bindSaveLifecycle({ ...f.options, persist: () => { writes++; return false; } });
  assert.equal(f.store.getState().reopen?.memoryOnly, true);
  assert.equal(f.store.getState().page!.id, "page");
  assert.deepEqual(f.notices, [APPLIED, SAVE_MEMORY_ONLY]);
  const failedWrites = writes;
  f.room.ui.notify("Unrelated message", "info");
  assert.equal(writes, failedWrites, "unrelated room updates do not retry the same failed storage write");
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.equal(f.store.getState().page!.phase, "rolled");
  assert.equal(f.notices.filter(n => n === SAVE_MEMORY_ONLY).length, 1);
  stop();
  f.room.dispose();
});

test("multiple restoration hooks share one binding until the last unmount", () => {
  const f = fixture({ page: page(), reopen: null }, {});
  const first = bindSaveLifecycle(f.options);
  const writes = f.writes.length;
  const second = bindSaveLifecycle(f.options);
  assert.equal(f.writes.length, writes);
  f.store.setState({ page: { ...f.store.getState().page!, dc: 16 } });
  assert.equal(f.writes.length, writes + 1);
  first();
  f.store.setState({ page: { ...f.store.getState().page!, dc: 17 } });
  assert.equal(f.writes.length, writes + 2);
  second();
  f.store.setState({ page: { ...f.store.getState().page!, dc: 18 } });
  assert.equal(f.writes.length, writes + 2);
  f.room.dispose();
});

test("initial Apply is announced once, owns its receipt, and effect remounts do not announce it again", () => {
  const f = fixture(session("applying"), {});
  f.receipts.sending(PLAN, 0);
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("applied", 1, 11) }, 11);
  f.receipts.answer(PLAN, 0, "taken");
  assert.deepEqual(f.notices, [APPLIED]);
  assert.deepEqual(f.receipts.unannounced(), [], "the generic receipt announcer never repeats the lifecycle result");
  stop();
  const remount = bindSaveLifecycle(f.options);
  assert.deepEqual(f.notices, [APPLIED]);
  remount();
  f.room.dispose();
});

test("freshly prepared Apply waits for dispatch to register its receipt instead of racing a lookup", () => {
  const initial = session("applying");
  initial.reopen!.receipt = { plan: PLAN, state: "sending" };
  const f = fixture(initial, {});
  const stop = bindSaveLifecycle(f.options);
  assert.equal(f.lookups(), 0, "even a previously restored page can be preparing a fresh Apply");
  stop();
  f.room.dispose();
});

test("a restored unknown Ask again permits explicit retry only after a fresh snapshot settles its queue", () => {
  const pending = asking();
  const f = fixture({ page: pending, reopen: null }, {});
  f.room.store.setState({ confirmedReady: false });
  const stop = bindSaveLifecycle(f.options);
  assert.equal(f.store.getState().page!.requests[1]!.state, "sending");
  f.snapshot({}, 11);
  const recovered = f.store.getState().page!;
  assert.equal(recovered.requests[1]!.state, "refused");
  assert.match(recovered.requests[1]!.says ?? "", /Ask again/);
  assert.equal(recovered.states, pending.states, "old answers and references remain available for the explicit retry");
  assert.equal(f.room.store.getState().pending.length, 0, "recovery never dispatches a replacement");
  stop();
  f.room.dispose();
});

test("new Ask again waits for dispatch and leaves live answers to their callbacks", () => {
  const f = fixture({ page: page(), reopen: null }, {});
  const stop = bindSaveLifecycle(f.options);
  f.store.setState({ page: asking() });
  assert.equal(f.store.getState().page!.requests[1]!.state, "sending", "a restored page can prepare new requests before dispatch");
  const request = { ...ask(), targets: [{ tokenId: "g1" }] };
  f.room.store.setState({ pending: [{ n: 1, at: 0, op: { t: "roll.ask", request } }] });
  f.room.store.setState({ pending: [] });
  assert.equal(f.store.getState().page!.requests[1]!.state, "sending", "ordinary events leave refusal wording to the sending callback");
  f.snapshot({}, 11);
  assert.equal(f.store.getState().page!.requests[1]!.state, "refused", "a later covering snapshot settles a swallowed answer");
  stop();
  f.room.dispose();
});

test("confirmed fresh Ask acceptance wins reload recovery and applied pages never copy live answers", () => {
  const pending = asking();
  const f = fixture({ page: pending, reopen: null }, {});
  f.game.rolls.fresh = { ...ask(), targets: [{ tokenId: "g1", total: 17 }] };
  f.snapshot({}, 11);
  const stop = bindSaveLifecycle(f.options);
  const accepted = f.store.getState().page!;
  assert.equal(accepted.requests[1]!.state, "open");
  assert.deepEqual(accepted.states["token:g1"]!.asked, { rollId: "fresh", dc: 15 });
  assert.equal(accepted.states["token:g1"]!.answer!.total, 17);
  const applied = { ...accepted, phase: "applied" as const };
  f.store.setState({ page: applied });
  f.game.rolls.fresh = { ...ask(), targets: [{ tokenId: "g1", total: 20 }] };
  f.snapshot({}, 12);
  assert.equal(f.store.getState().page!.states["token:g1"]!.answer!.total, 17);
  stop();
  f.room.dispose();
});

test("live refusal waits for its confirmed sequence before restoring Apply choices", () => {
  const f = fixture(session("applying"), {});
  f.receipts.env!.seq = () => 20;
  f.receipts.sending(PLAN, 0);
  const stop = bindSaveLifecycle(f.options);
  f.receipts.answer(PLAN, 0, "refused", { code: "invalid", message: "The save changed.", text: "Not saved. The save changed." });
  assert.equal(f.store.getState().reopen?.receipt?.seq, 20);
  assert.equal(f.store.getState().page!.phase, "applying");
  assert.deepEqual(f.notices, []);
  f.snapshot({}, 20);
  assert.equal(f.store.getState().page!.phase, "rolled");
  assert.equal(f.store.getState().page!.applySays, "The save changed.");
  assert.deepEqual(f.notices, ["The save changed."]);
  f.snapshot({}, 21);
  assert.deepEqual(f.notices, ["The save changed."], "the lifecycle owns its refusal announcement once");
  stop();
  f.room.dispose();
});
