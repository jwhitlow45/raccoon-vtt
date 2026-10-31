import assert from "node:assert/strict";
import { test } from "node:test";
import type { SaveOutcomeLedger, SaveOutcomeRecord } from "#shared/saveOutcomeContract.ts";
import { newPage, setDc, type Page } from "./chain.ts";
import { rowResult } from "./rows.ts";
import { reconcileSave, prepareSave, resumeSaveEdits, OUTCOME_UNDONE, OUTCOME_RESTORED, OUTCOME_UNAVAILABLE } from "./reopen.ts";

const A = "019a3df0-1000-7000-8000-000000000001";
const B = "019a3df0-1000-7000-8000-000000000002";
const page = (): Page => ({ ...newPage({ id: "page", sceneId: "s1", source: { kind: "selection", tokenIds: ["t1", "t2"], live: true }, test: { kind: "save", ability: "dex" }, dc: 15, secret: true, spell: true, switches: { dcShown: true, resultShown: false }, outcome: { damage: "2d6 fire", conditions: ["prone"] } }), phase: "rolled", rows: ["t1", "t2"].map(tokenId => ({ holder: `token:${tokenId}`, tokenId, target: { tokenId }, name: tokenId, ways: ["server"], bonus: 2, skip: false })), states: { "token:t1": { way: "server", typed: 14, batch: { tag: "old", part: 0 } }, "token:t2": { way: "server", mark: "pass", typed: 10 } }, damage: { tag: "damage", state: "committed", amounts: [9] }, rolls: [{ tag: "old", holders: ["token:t1"], state: "committed" }], requests: [{ rollId: "asked", holders: ["token:t2"], state: "open" }] });
const authority = (ledger: SaveOutcomeLedger = {}, seq = 10, ready = true) => ({ ledger, seq, ready, memberId: "dm", sceneAvailable: true });
const record = (state: "applied" | "undone", revision: number, plan = A, seq = revision): SaveOutcomeRecord => ({ memberId: "dm", plan, revision, state, firstAppliedAt: "2026-10-31T00:00:00.000Z", seq });
const plan = (id = A) => ({ t: "actor.outcome" as const, plan: id, targets: [{ target: { tokenId: "t1" }, amount: 9 }] });
const start = () => prepareSave({ page: page(), reopen: null }, plan(), authority());

test("capture precedes closes and Apply, strips transient state and freezes the source", () => {
  const initial = page();
  const sent = prepareSave({ page: initial, reopen: null }, plan(), authority());
  assert.equal(sent.send.length, 2);
  assert.equal(sent.send[0]?.kind, "op");
  assert.equal(sent.reopen?.beforeApply?.choices.phase, "rolled");
  assert.deepEqual(sent.reopen?.beforeApply?.choices.source, { kind: "selection", tokenIds: ["t1", "t2"] });
  assert.equal("batch" in sent.reopen!.beforeApply!.choices.states["token:t1"]!, false);
  initial.states["token:t1"]!.typed = 99;
  assert.equal(sent.reopen?.beforeApply?.choices.states["token:t1"]?.typed, 14);
  assert.deepEqual(sent.reopen?.tracking, { id: A, plan: A, revision: 0 });
  const outcome = sent.send.find(c => c.kind === "outcome");
  assert.ok(outcome?.kind === "outcome");
  assert.deepEqual((outcome.op as typeof outcome.op & { page: unknown }).page, { id: A, expectRevision: 0 });
});

test("whole Undo restores exact choices and DC rejudges totals while explicit marks survive", () => {
  const applied = reconcileSave(start(), authority({ [A]: record("applied", 1) }));
  assert.equal(applied.page.phase, "applied");
  const undone = reconcileSave(applied, authority({ [A]: record("undone", 2) }));
  assert.equal(undone.page.phase, "rolled");
  assert.equal(undone.reopen?.check, "undone");
  assert.equal(undone.reopen?.notice, OUTCOME_UNDONE);
  assert.equal(undone.page.plan, null);
  assert.equal(undone.page.apply, "idle");
  assert.equal(undone.page.requests[0]?.state, "closed");
  assert.deepEqual(undone.page.damage?.amounts, [9]);
  const edited = setDc(undone.page, 12);
  assert.equal(rowResult(edited.rows[0]!, edited.states["token:t1"]!, edited.test, edited.dc), "pass");
  assert.equal(rowResult(edited.rows[1]!, edited.states["token:t2"]!, edited.test, 40), "pass");
  assert.equal("send" in undone, false, "reconciliation has no command channel");
});

test("Redo holds newer edits and a second Undo offers them separately", () => {
  const undone = reconcileSave(start(), authority({ [A]: record("undone", 2) }));
  const edited = { ...undone, page: setDc(undone.page, 19) };
  const redone = reconcileSave(edited, authority({ [A]: record("applied", 3) }));
  assert.equal(redone.page.phase, "applied");
  assert.equal(redone.reopen?.notice, OUTCOME_RESTORED);
  assert.equal(redone.reopen?.redoHeld?.dc, 19);
  const back = reconcileSave(redone, authority({ [A]: record("undone", 4) }));
  assert.equal(back.page.dc, 15);
  assert.equal(resumeSaveEdits(back, authority({ [A]: record("undone", 4) })).page.dc, 19);
});

test("Redo keeps oversized newer edits in memory when persistence cannot keep them", () => {
  const undone = reconcileSave(start(), authority({ [A]: record("undone", 2) }));
  const text = "x".repeat(512 * 1024);
  const edited = { ...undone, page: { ...undone.page, outcome: { ...undone.page.outcome, damage: text } } };
  const redone = reconcileSave(edited, authority({ [A]: record("applied", 3) }));
  assert.ok(redone.reopen?.redoHeld?.outcome.damage === text, "oversized edits stay in memory");
  const back = reconcileSave(redone, authority({ [A]: record("undone", 4) }));
  assert.equal(back.page.outcome.damage, "2d6 fire");
  assert.ok(resumeSaveEdits(back, authority({ [A]: record("undone", 4) })).page.outcome.damage === text, "resuming restores oversized edits");
});

test("receipt-before-view stays checking, status-before-receipt can reopen, and late A traffic cannot change B", () => {
  const sent = start();
  const receipt = { plan: A, state: "committed" as const, seq: 20 };
  const waiting = reconcileSave({ ...sent, reopen: { ...sent.reopen!, receipt } }, authority({}, 19));
  assert.equal(waiting.reopen?.check, "checking");
  const missing = reconcileSave(waiting, authority({}, 20));
  assert.equal(missing.reopen?.check, "unavailable");
  const undone = reconcileSave(sent, authority({ [A]: record("undone", 2) }));
  const next = prepareSave({ ...undone, page: setDc(undone.page, 18) }, plan(B), authority({ [A]: record("undone", 2) }));
  assert.equal(next.send.length, 1);
  const inFlight = reconcileSave(next, authority({ [A]: record("undone", 2) }));
  assert.equal(inFlight.page.phase, "applying");
  const appliedB = reconcileSave(inFlight, authority({ [A]: record("applied", 3, B) }));
  const delayed = reconcileSave({ ...appliedB, reopen: { ...appliedB.reopen!, receipt } }, authority({ [A]: record("undone", 2) }));
  assert.equal(delayed.page.phase, "applied");
  assert.equal(delayed.reopen?.tracking?.plan, B);
  const undoB = reconcileSave(appliedB, authority({ [A]: record("undone", 4, B) }));
  assert.equal(undoB.page.dc, 18);
});

test("missing, mismatched, offline, and missing checkpoint never authorize edits", () => {
  const sent = start();
  const applied = reconcileSave(sent, authority({ [A]: record("applied", 1) }));
  for (const context of [authority(), authority({ [A]: { ...record("undone", 2), memberId: "other" } }), authority({ [A]: record("undone", 2, B) }), authority({ [A]: record("undone", 2) }, 10, false)]) {
    const result = reconcileSave(applied, context);
    assert.notEqual(result.reopen?.check, "undone");
    assert.equal(prepareSave(result, plan(B), context).send.length, 0);
  }
  const missing = reconcileSave({ ...applied, reopen: { ...applied.reopen!, beforeApply: undefined } }, authority({ [A]: record("undone", 2) }));
  assert.equal(missing.reopen?.check, "unavailable");
  assert.equal(missing.reopen?.notice, OUTCOME_UNAVAILABLE);
  const legacy = reconcileSave({ page: { ...page(), phase: "applied" as const, apply: "taken" as const }, reopen: null }, authority());
  assert.equal(legacy.reopen?.check, "unavailable");
});

test("No save retains its editable setup phase and refusals require covering authority before a fresh first identity", () => {
  const initial = { ...page(), phase: "setup" as const, test: { kind: "none" as const } };
  const sent = prepareSave({ page: initial, reopen: null }, plan(), authority());
  assert.equal(reconcileSave(sent, authority({ [A]: record("undone", 2) })).page.phase, "setup");
  const refused = { ...sent, reopen: { ...sent.reopen!, receipt: { plan: A, state: "refused" as const, seq: 20, says: "Refused" } } };
  assert.equal(prepareSave(reconcileSave(refused, authority({}, 19)), plan(B), authority({}, 19)).send.length, 0);
  const free = reconcileSave(refused, authority({}, 20));
  assert.equal(free.reopen?.tracking, undefined);
  assert.equal(free.page.apply, "refused");
  assert.equal(prepareSave(free, plan(B), authority({}, 20)).reopen?.tracking?.id, B);
});

test("reconciliation preserves invariants over deterministic repeated delayed events", () => {
  for (let seed = 1; seed <= 100; seed++) {
    let n = seed;
    const random = () => ((n = Math.imul(n, 1664525) + 1013904223 >>> 0) / 2 ** 32);
    let current = start();
    let revision = 0;
    for (let i = 0; i < 80; i++) {
      revision += random() > .4 ? 1 : 0;
      const observed = Math.max(1, revision - (random() > .7 ? 2 : 0));
      const ready = random() > .15;
      const context = authority({ [A]: record(observed % 2 ? "applied" : "undone", observed) }, 100, ready);
      const before = current.reopen?.tracking?.revision ?? 0;
      const result = reconcileSave(current, context);
      assert.ok((result.reopen?.tracking?.revision ?? 0) >= before);
      if (result.reopen?.check === "undone") assert.ok(ready && observed >= before && observed % 2 === 0);
      assert.equal("send" in result, false);
      current = { ...result, send: [] };
    }
  }
});

test("a refused replacement preserves the previous checkpoint for a later Redo", () => {
  const undone = reconcileSave(start(), authority({ [A]: record("undone", 2) }));
  const replacement = prepareSave({ ...undone, page: setDc(undone.page, 19) }, plan(B), authority({ [A]: record("undone", 2) }));
  const refused = reconcileSave({ ...replacement, reopen: { ...replacement.reopen!, receipt: { plan: B, state: "refused", seq: 10, says: "Changed meanwhile" } } }, authority({ [A]: record("undone", 2) }));
  assert.equal(refused.page.dc, 19);
  assert.equal(refused.reopen?.beforeApply?.plan, A);
  assert.equal(refused.reopen?.beforeApply?.choices.dc, 15);
  const redone = reconcileSave(refused, authority({ [A]: record("applied", 3) }));
  const back = reconcileSave(redone, authority({ [A]: record("undone", 4) }));
  assert.equal(back.page.dc, 15);
  assert.equal(back.reopen?.redoHeld?.dc, 19);
});

test("Redo racing a refused replacement relocks A and keeps B's edits for the next Undo", () => {
  const undone = reconcileSave(start(), authority({ [A]: record("undone", 2) }));
  const replacement = prepareSave({ ...undone, page: setDc(undone.page, 19) }, plan(B), authority({ [A]: record("undone", 2) }));
  const refused = { ...replacement, reopen: { ...replacement.reopen!, receipt: { plan: B, state: "refused" as const, seq: 10, says: "Changed meanwhile" } } };
  const redone = reconcileSave(refused, authority({ [A]: record("applied", 3) }));
  assert.equal(redone.reopen?.check, "applied");
  assert.equal(redone.reopen?.beforeApply?.plan, A);
  assert.equal(redone.reopen?.redoHeld?.dc, 19);
  const back = reconcileSave(redone, authority({ [A]: record("undone", 4) }));
  assert.equal(back.page.dc, 15);
  assert.equal(resumeSaveEdits(back, authority({ [A]: record("undone", 4) })).page.dc, 19);
  const alreadyUndone = reconcileSave(refused, authority({ [A]: record("undone", 4) }));
  assert.equal(alreadyUndone.page.dc, 15);
  assert.equal(alreadyUndone.reopen?.redoHeld?.dc, 19);
});

test("pending, invalid checkpoints and an unavailable scene cannot send closes or Apply", () => {
  for (const mutate of [
    (p: Page) => { p.requests[0]!.state = "sending"; },
    (p: Page) => { p.damage = { tag: "pending", state: "sending" }; },
    (p: Page) => { p.states["token:t1"]!.typed = NaN; },
  ]) {
    const p = page(); mutate(p);
    assert.deepEqual(prepareSave({ page: p, reopen: null }, plan(), authority()).send, []);
  }
  assert.deepEqual(prepareSave({ page: page(), reopen: null }, plan(), { ...authority(), sceneAvailable: false }).send, []);
});

test("the final Close the ask has no reopen status or lifecycle proof", () => {
  const closed: Page = { ...page(), phase: "applied", apply: "taken", cast: { ask: { id: "ask", rev: 1, by: "player", caster: "caster", sceneId: "s1", spell: "Hold Person", targets: ["t1"], at: "2026-10-31T00:00:00.000Z" }, who: "Caster", closing: "rolled" } };
  const result = reconcileSave({ page: closed, reopen: { check: "checking" } }, authority());
  assert.equal(result.page.phase, "applied");
  assert.equal(result.reopen?.check, null);
  assert.equal(result.reopen?.tracking, undefined);
});
