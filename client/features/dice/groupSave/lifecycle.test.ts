import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RollRequest, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { SaveOutcomeLedger, SaveOutcomeRecord } from "#shared/saveOutcomeContract.ts";
import { DM, room as testRoom, token } from "#shared/testutil.ts";
import { createRoomStore } from "../../../state/store.ts";
import { FakeClock } from "../../../state/testing.ts";
import { ReceiptTracker } from "../useReceipt.ts";
import { askAnswered, newPage, type Page } from "./chain.ts";
import { askAgain } from "./reroll.ts";
import { authorityOf, bindSaveLifecycle, serverTime } from "./lifecycle.ts";
import { captureChoices, OUTCOME_RESTORED, OUTCOME_UNAVAILABLE, OUTCOME_UNDONE, prepareSave, resumeSaveEdits, SAVE_MEMORY_ONLY, sessionOfDraft, type SaveSession } from "./reopen.ts";
import type { SaveDraft } from "./reopenContract.ts";
import type { GroupSaveState } from "./store.ts";

const PLAN = "019a4000-0000-7000-8000-000000000001";
const APPLIED = "Group save: applied. Undo takes it all back.";
// Retention runs from the first Apply against the server's time, which is this test's clock.
const FIRST = new Date().toISOString();
const record = (state: "applied" | "undone", revision: number, seq = 10): SaveOutcomeRecord => ({ memberId: DM.memberId, plan: PLAN, revision, state, seq, firstAppliedAt: FIRST });

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

/*
 * A reopened page restores its requests as closed. An explicit Undo can
 * bring one back to the room, and a row that still names it must take its
 * new answers, or Ask again retires it without the answered creature.
 */
function restoredAsk(bobFirst?: number) {
  const room = createRoomStore({ roomId: "room", you: DM, clock: new FakeClock(), undoNotice: { claim: () => false } });
  const game = testRoom({ tokens: { a: token("a"), b: token("b") } });
  const request = (alice: number | undefined, bob: number | undefined, rev = 1): RollRequest => ({ id: "old", rev, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: true, resultShown: true, at: "2026-10-31T00:00:00.000Z", targets: [{ tokenId: "a", ...(alice === undefined ? {} : { total: alice }) }, { tokenId: "b", ...(bob === undefined ? {} : { total: bob }) }] });
  const snapshot = (outcomes: SaveOutcomeLedger, rolls: Record<string, RollRequest>, seq: number) => room.applySnapshot({ t: "snapshot", seq, watermark: 0, state: { ...projectState({ ...game, rolls }, DM, { sceneId: "s1" }), saveOutcomes: outcomes }, you: { ...DM, sceneId: "s1" } });
  const asked = (holder: string, total?: number) => ({ way: "ask" as const, asked: { rollId: "old", dc: 15 }, ...(total === undefined ? {} : { answer: { tokenId: holder.slice(6), total } }) });
  const before: Page = {
    ...page(),
    rows: ["a", "b"].map(id => ({ holder: `token:${id}`, target: { tokenId: id }, tokenId: id, name: id === "a" ? "Alice" : "Bob", ways: ["ask" as const], askRef: { tokenId: id }, bonus: 0, skip: false })),
    states: { "token:a": asked("token:a", 12), "token:b": asked("token:b", bobFirst) },
    requests: [{ rollId: "old", holders: ["token:a", "token:b"], state: "open" }],
  };
  room.setConnection("open");
  snapshot({ [PLAN]: record("applied", 1) }, {}, 10);
  const applied: SaveSession = {
    page: { ...before, phase: "applied", apply: "taken", plan: { t: "actor.outcome", plan: PLAN, targets: [{ target: { tokenId: "a" }, amount: 3 }] } },
    reopen: { tracking: { id: PLAN, plan: PLAN, revision: 1 }, beforeApply: { version: 1, pageId: before.id, plan: PLAN, choices: captureChoices(before) }, check: "applied" },
  };
  const store = createStore<GroupSaveState>(() => ({ page: applied.page, reopen: applied.reopen, shownIn: null, restored: true }));
  const receipts = new ReceiptTracker();
  receipts.env = { lookup: async () => ({ parts: [] }), log: () => [] };
  const stop = bindSaveLifecycle({ store, room: room.store, receipts, persist: () => true });
  return { room, store, request, snapshot, stop, bob: () => store.getState().page!.states["token:b"]?.answer?.total };
}

test("a reopened page takes an unselected creature's answer on a request an explicit Undo brought back", () => {
  const f = restoredAsk();
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, { old: f.request(12, undefined) }, 11);
  assert.equal(f.store.getState().page!.phase, "rolled");
  assert.equal(f.store.getState().page!.requests[0]!.state, "closed", "the restored request stays closed on the page");
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, { old: f.request(12, 18, 2) }, 12);
  assert.equal(f.bob(), 18, "Bob's answer reaches the reopened page");
  const again = askAgain(f.store.getState().page!, { holders: ["token:a"], requests: f.room.store.getState().confirmed!.rolls, requestIds: () => "fresh" });
  const op = again.send[0]?.kind === "op" ? again.send[0].op : null;
  assert.ok(op?.t === "roll.ask");
  assert.deepEqual(op.request.targets, [{ tokenId: "a" }], "Ask again asks Alice alone, since Bob has answered");
  f.stop();
  f.room.dispose();
});

test("a refused replacement leaves the page following the old request's new answers, and a retry keeps them", () => {
  const f = restoredAsk(7);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, { old: f.request(12, 7) }, 11);
  const sent = askAgain(f.store.getState().page!, { holders: ["token:a"], requests: f.room.store.getState().confirmed!.rolls, requestIds: () => "fresh" });
  f.store.setState({ page: sent.page });
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, { old: f.request(12, 20, 3) }, 12);
  f.store.setState({ page: askAnswered(f.store.getState().page!, "fresh", { ok: false, message: "The roll request changed. Check its answers and ask again." }) });
  assert.equal(f.store.getState().page!.requests.find(r => r.rollId === "fresh")?.state, "refused");
  assert.equal(f.bob(), 20, "the page follows Bob's new answer, not the 7 it restored");
  const retry = askAgain(f.store.getState().page!, { holders: ["token:a"], requests: f.room.store.getState().confirmed!.rolls, requestIds: () => "retry" });
  const op = retry.send[0]?.kind === "op" ? retry.send[0].op : null;
  assert.ok(op?.t === "roll.ask");
  assert.deepEqual(op.request.targets, [{ tokenId: "a" }]);
  assert.equal(retry.page.states["token:b"]?.answer?.total, 20);
  f.stop();
  f.room.dispose();
});

test("the room learns how far the server's clock is from a fast device's as log lines arrive, keeping the least delayed reading", () => {
  const stamped = Date.parse("2026-10-31T00:00:00.000Z");
  const clock = new FakeClock();
  clock.t = stamped + 10 * 60 * 1000;
  const room = createRoomStore({ roomId: "room", you: DM, clock, undoNotice: { claim: () => false } });
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, watermark: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" } });
  assert.equal(room.store.getState().serverOffset, undefined, "a snapshot's old lines say nothing of the clock");
  const line = (id: string, at: number) => ({ key: `log:${id}`, value: { id, at: new Date(at).toISOString(), kind: "event", text: "Torch lit." } });
  room.applyEv({ t: "ev", seq: 1, changes: [line("1:0", stamped)] });
  assert.equal(room.store.getState().serverOffset, -10 * 60 * 1000);
  clock.t += 2_000;
  room.applyEv({ t: "ev", seq: 2, changes: [line("2:0", stamped + 500)] });
  assert.equal(room.store.getState().serverOffset, -10 * 60 * 1000, "a line the network held up longer reads lower and is not taken");
  assert.equal(serverTime(room.store.getState(), clock), stamped + 2_000);
  room.dispose();
});

test("an Apply the queue let go of with no receipt offers Start over and Discard instead of checking for good", async () => {
  const f = fixture(session(), { [PLAN]: record("undone", 2, 11) });
  const B = "019a4000-0000-7000-8000-000000000002";
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  const stop = bindSaveLifecycle(f.options);
  const undone = f.store.getState();
  assert.equal(undone.reopen?.check, "undone");
  const sent = prepareSave({ page: undone.page!, reopen: undone.reopen }, { t: "actor.outcome", plan: B, targets: [{ target: { tokenId: "g1" }, amount: 3 }] }, authorityOf(f.room.store.getState(), undone.page!));
  f.store.setState({ page: sent.page, reopen: sent.reopen });
  f.receipts.sending(B, 0);
  f.room.store.setState({ pending: [{ n: 1, op: sent.page.plan!, at: 0 }] as never });
  f.receipts.answer(B, 0, "unknown", undefined, "expired");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.store.getState().reopen?.check, "checking", "an attempt still queued may yet be answered");
  f.room.store.setState({ pending: [] });
  assert.equal(f.store.getState().reopen?.check, "unavailable");
  assert.equal(f.store.getState().page!.phase, "applying", "the missing receipt is not taken for a refusal");
  stop();
  f.room.dispose();
});

test("a page locked by its own later Apply never reads Outcome restored, and a reload repeats no announcement", () => {
  const B = "019a4000-0000-7000-8000-000000000002";
  const f = fixture();
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.equal(f.store.getState().reopen?.notice, OUTCOME_UNDONE);
  const undoneDraft = structuredClone(f.writes.at(-1)!);
  const held = f.store.getState();
  const sent = prepareSave({ page: held.page!, reopen: held.reopen }, { t: "actor.outcome", plan: B, targets: [{ target: { tokenId: "g1" }, amount: 3 }] }, authorityOf(f.room.store.getState(), held.page!));
  f.store.setState({ page: sent.page, reopen: sent.reopen });
  f.receipts.sending(B, 0);
  f.snapshot({ [PLAN]: { ...record("applied", 3, 12), plan: B } }, 12);
  f.receipts.answer(B, 0, "taken");
  assert.equal(f.store.getState().page!.phase, "applied");
  assert.notEqual(f.store.getState().reopen?.notice, OUTCOME_RESTORED);
  const appliedDraft = structuredClone(f.writes.at(-1)!);
  stop();
  f.room.dispose();
  for (const [draft, ledger, shown] of [[appliedDraft, { [PLAN]: { ...record("applied", 3, 12), plan: B } }, undefined], [undoneDraft, { [PLAN]: record("undone", 2, 11) }, OUTCOME_UNDONE]] as const) {
    const reloaded = fixture(sessionOfDraft(draft), ledger);
    reloaded.snapshot(ledger, 12);
    const again = bindSaveLifecycle(reloaded.options);
    assert.equal(reloaded.store.getState().reopen?.check, shown ? "undone" : "applied");
    assert.equal(reloaded.store.getState().reopen?.notice, shown, "the page's own line is as it was");
    assert.deepEqual(reloaded.notices, [], "the reload announces nothing already said");
    again();
    reloaded.room.dispose();
  }
});

test("after Apply, Undo and a refused second Apply, a reload does not say Outcome undone again", () => {
  const B = "019a4000-0000-7000-8000-000000000002";
  const f = fixture();
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.ok(f.notices.includes(OUTCOME_UNDONE));
  const held = f.store.getState();
  const sent = prepareSave({ page: { ...held.page!, dc: 18 }, reopen: held.reopen }, { t: "actor.outcome", plan: B, targets: [{ target: { tokenId: "g1" }, amount: 3 }] }, authorityOf(f.room.store.getState(), held.page!));
  f.store.setState({ page: sent.page, reopen: sent.reopen });
  f.receipts.sending(B, 0);
  f.receipts.answer(B, 0, "refused", { code: "invalid", message: "This save's outcome changed. Check the save before trying again.", text: "This save's outcome changed. Check the save before trying again." });
  assert.equal(f.store.getState().reopen?.check, "undone", "the refusal goes back to the undone page");
  assert.equal(f.store.getState().page!.dc, 18);
  const draft = structuredClone(f.writes.at(-1)!);
  stop();
  f.room.dispose();
  const reloaded = fixture(sessionOfDraft(draft), { [PLAN]: record("undone", 2, 11) });
  reloaded.snapshot({ [PLAN]: record("undone", 2, 11) }, 12);
  const again = bindSaveLifecycle(reloaded.options);
  assert.equal(reloaded.store.getState().reopen?.notice, OUTCOME_UNDONE);
  assert.deepEqual(reloaded.notices, [], "nothing said before the reload is said again");
  again();
  reloaded.room.dispose();
});

test("a device ten minutes slow whose clock is then set right still mints a first Apply the server accepts", () => {
  const stamped = Date.parse("2026-10-31T12:00:00.000Z");
  const clock = new FakeClock();
  clock.t = stamped - 10 * 60 * 1000;
  const room = createRoomStore({ roomId: "room", you: DM, clock, undoNotice: { claim: () => false } });
  room.setConnection("open");
  room.applySnapshot({ t: "snapshot", seq: 0, watermark: 0, state: projectState(testRoom(), DM, { sceneId: "s1" }), you: { ...DM, sceneId: "s1" } });
  const line = (id: string, at: number) => ({ key: `log:${id}`, value: { id, at: new Date(at).toISOString(), kind: "event", text: "Torch lit." } });
  room.applyEv({ t: "ev", seq: 1, changes: [line("1:0", stamped)] });
  // The device's clock is set right, ten minutes forward, and two seconds pass before the next line.
  clock.jump(10 * 60 * 1000);
  clock.advance(2_000);
  room.applyEv({ t: "ev", seq: 2, changes: [line("2:0", stamped + 2_000)] });
  const now = serverTime(room.store.getState(), clock);
  assert.equal(now, stamped + 2_000, "the reckoning follows the server, not the jump");
  const id = uuidv7(now);
  const first = applyOp(testRoom({ tokens: { g1: token("g1") } }), { t: "actor.outcome", plan: id, page: { id, expectRevision: 0 }, label: "Fire", targets: [{ target: { tokenId: "g1" }, amount: 3 }] } as never, DM, { seq: 1, at: new Date(stamped + 2_000).toISOString() });
  assert.ok(first.ok, first.ok ? "" : first.message);
  room.dispose();
});

test("a Redo confirmed while the check waits relocks the page on the applied choices, and the edits made meanwhile come back by Resume after an Undo", () => {
  const f = fixture();
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  assert.equal(f.store.getState().reopen?.check, "undone");
  // The connection blips, so the check waits, and the DM changes the total meanwhile.
  f.room.suspend();
  assert.equal(f.store.getState().reopen?.check, "checking");
  const edited = f.store.getState().page!;
  f.store.setState({ page: { ...edited, states: { "token:g1": { way: "type", typed: 20 } } } });
  f.snapshot({ [PLAN]: record("applied", 3, 12) }, 12);
  const relocked = f.store.getState();
  assert.equal(relocked.page!.phase, "applied");
  assert.deepEqual(relocked.page!.states, { "token:g1": { way: "type", typed: 14 } }, "the locked page shows what was applied");
  assert.equal(relocked.page!.plan, null);
  assert.equal(relocked.reopen?.redoHeld?.states["token:g1"]?.typed, 20, "the edits are held apart");
  assert.equal(f.writes.at(-1)!.page.states["token:g1"]?.typed, 14, "a reload shows what was applied too");
  f.snapshot({ [PLAN]: record("undone", 4, 13) }, 13);
  const undone = f.store.getState();
  assert.equal(undone.page!.phase, "rolled");
  assert.equal(undone.page!.states["token:g1"]?.typed, 14);
  const resumed = resumeSaveEdits({ page: undone.page!, reopen: undone.reopen }, authorityOf(f.room.store.getState(), undone.page!));
  assert.equal(resumed.page.states["token:g1"]?.typed, 20, "Resume your edits brings them back");
  assert.equal(resumed.reopen?.redoHeld, undefined);
  stop();
  f.room.dispose();
});

test("a later Apply refused because Redo restored the earlier outcome relocks the page on that outcome's choices and holds the refused ones", () => {
  const B = "019a4000-0000-7000-8000-000000000002";
  const f = fixture();
  const stop = bindSaveLifecycle(f.options);
  f.snapshot({ [PLAN]: record("undone", 2, 11) }, 11);
  const held = f.store.getState();
  const sent = prepareSave({ page: { ...held.page!, dc: 18 }, reopen: held.reopen }, { t: "actor.outcome", plan: B, targets: [{ target: { tokenId: "g1" }, amount: 3 }] }, authorityOf(f.room.store.getState(), held.page!));
  f.store.setState({ page: sent.page, reopen: sent.reopen });
  f.receipts.sending(B, 0);
  // Another DM device redoes the first outcome before this one's second Apply arrives, so the second is refused.
  f.snapshot({ [PLAN]: record("applied", 3, 12) }, 12);
  f.receipts.answer(B, 0, "refused", { code: "invalid", message: "This save's outcome changed. Check the save before trying again.", text: "This save's outcome changed. Check the save before trying again." });
  const relocked = f.store.getState();
  assert.equal(relocked.page!.phase, "applied");
  assert.equal(relocked.page!.dc, 15, "the locked page shows the outcome Redo restored");
  assert.equal(relocked.reopen?.redoHeld?.dc, 18, "the refused choices are held for Resume your edits");
  stop();
  f.room.dispose();
});
