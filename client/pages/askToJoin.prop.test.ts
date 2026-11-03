import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import type { JoinRequestState, Me } from "../lib/api.ts";
import { advance, BACKOFF_MS, initialAskState, type AskEvent, type AskState, type Effect, type WaitState } from "./askToJoin.ts";

/**
 * Random sequences of what the ask page meets: taps, answers that arrive
 * late or out of order, failures, displacement by another tab, and reloads.
 * A driver stands in for the page and the server: it runs the one effect the
 * reducer names, then resolves started calls in any order. The invariants are
 * the design's (join-requests 10, the page's reducer).
 */

const ME = { member: { id: "m1", name: "Quinn", color: "#fff", kind: "player" }, role: "player" } as unknown as Me;

type Op =
  | { k: "send" }
  | { k: "asked"; ok: "ok" | "fail" | "already" }
  | { k: "found"; state: JoinRequestState }
  | { k: "resolve"; pick: number; answer: WaitState | "fail" | "gone"; me: "me" | "none" | "error"; own: boolean; cancel: "done" | "deciding" | "fail" | "gone" }
  | { k: "cancel" }
  | { k: "waitHere" }
  | { k: "reset" }
  | { k: "rewind" };

const waitStates: readonly (WaitState | "fail" | "gone")[] = ["waiting", "waiting", "waiting", "in", "turned_away", "expired", "closed", "superseded", "fail", "gone"];

const ops = fc.array(
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<Op>({ k: "send" }) },
    { weight: 2, arbitrary: fc.constantFrom<"ok" | "fail" | "already">("ok", "ok", "fail", "already").map<Op>((ok) => ({ k: "asked", ok })) },
    { weight: 1, arbitrary: fc.constantFrom<JoinRequestState>("waiting", "in", "turned_away", "expired", "closed").map<Op>((state) => ({ k: "found", state })) },
    {
      weight: 10,
      arbitrary: fc
        .record({
          pick: fc.nat(8),
          answer: fc.constantFrom(...waitStates),
          me: fc.constantFrom<"me" | "none" | "error">("me", "none", "error"),
          own: fc.boolean(),
          cancel: fc.constantFrom<"done" | "deciding" | "fail" | "gone">("done", "deciding", "fail", "gone"),
        })
        .map<Op>((r) => ({ k: "resolve", ...r })),
    },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "cancel" }) },
    { weight: 1, arbitrary: fc.constant<Op>({ k: "waitHere" }) },
    { weight: 2, arbitrary: fc.constant<Op>({ k: "reset" }) },
    { weight: 1, arbitrary: fc.constant<Op>({ k: "rewind" }) },
  ),
  { maxLength: 60 },
);

type Run = { state: AskState; issued: number; pending: Effect[]; asks: number; ids: number };

/** Applies one event the way the page does, checking the invariants of the step. */
function apply(run: Run, event: AskEvent): void {
  const before = run.state;
  const liveBefore = before.kind === "waiting" && before.io.step === "inflight";
  const next = advance(before, event, run.issued);
  run.state = next.state;
  if (next.effect) {
    if ("seq" in next.effect) run.issued = Math.max(run.issued, next.effect.seq);
    run.pending.push(next.effect);
    // AT-MOST-ONE-WAIT: a wait never starts while the state's own wait is in flight.
    if (next.effect.kind === "wait") {
      assert.equal(liveBefore && event.type !== "answer" && event.type !== "waitFailed" && event.type !== "slept" && event.type !== "rewind", false, "a wait started over a running one");
      assert.equal(run.state.kind === "waiting" && run.state.io.step === "inflight", true);
    }
    // BACKOFF-BOUNDED
    if (next.effect.kind === "sleep") assert.ok(next.effect.ms <= BACKOFF_MS[BACKOFF_MS.length - 1]!);
  }
  // ME-BEFORE-ENDED: "Request ended" is reached only from a me check.
  if (run.state.kind === "outcome" && run.state.outcome === "ended" && before.kind !== "outcome") {
    assert.equal(before.kind, "checking", "ended without asking GET /me");
  }
  // OUTCOME-ONCE: a card is left only by Back, Ask again or Wait here.
  if (before.kind === "outcome" && run.state !== before) {
    assert.ok(event.type === "reset" || event.type === "waitHere" || event.type === "found", `outcome moved by ${event.type}`);
  }
  // STOP-ON-SUPERSEDED: no call runs on a card.
  if (run.state.kind === "outcome") assert.equal(next.effect, null);
  // CANCEL-STOPS-WAIT: no wait runs while Cancel is out, and nothing a wait says moves the page then.
  if (run.state.kind === "waiting" && run.state.cancel === "sent") {
    assert.notEqual(run.state.io.step, "inflight", "a wait in flight beside Cancel");
    assert.equal(next.effect?.kind === "wait", false);
  }
  if (before.kind === "waiting" && before.cancel === "sent" && (event.type === "answer" || event.type === "waitFailed" || event.type === "slept")) {
    assert.equal(run.state, before, `${event.type} moved the page while Cancel was out`);
  }
}

function play(list: readonly Op[]): void {
  const run: Run = { state: initialAskState(), issued: 0, pending: [], asks: 0, ids: 0 };
  for (const op of list) {
    switch (op.k) {
      case "send":
        apply(run, { type: "send" });
        break;
      case "asked": {
        if (run.state.kind !== "asking") break;
        if (op.ok === "ok") apply(run, { type: "asked", requestId: `r${++run.ids}`, name: "Quinn" });
        else apply(run, op.ok === "fail" ? { type: "askFailed" } : { type: "alreadyIn" });
        break;
      }
      case "found":
        apply(run, { type: "found", requestId: `r${++run.ids}`, name: "Quinn", state: op.state });
        break;
      case "cancel":
        apply(run, { type: "cancel" });
        break;
      case "waitHere":
        apply(run, { type: "waitHere" });
        break;
      case "reset":
        apply(run, { type: "reset" });
        break;
      case "rewind":
        apply(run, { type: "rewind" });
        break;
      case "resolve": {
        const call = run.pending.splice(op.pick % Math.max(run.pending.length, 1), 1)[0];
        if (!call) break;
        const before = run.state;
        let event: AskEvent;
        switch (call.kind) {
          case "sleep":
            event = { type: "slept", seq: call.seq };
            break;
          case "me":
            event = { type: "meResult", seq: call.seq, me: op.me === "me" ? ME : op.me === "none" ? null : "error" };
            break;
          case "cancel":
            event =
              op.cancel === "done"
                ? { type: "cancelDone", requestId: call.requestId }
                : op.cancel === "deciding"
                  ? { type: "cancelDeciding", requestId: call.requestId }
                  : { type: "cancelFailed", requestId: call.requestId, gone: op.cancel === "gone" };
            break;
          case "wait": {
            const requestId = op.own ? call.requestId : `other-${call.requestId}`;
            event =
              op.answer === "fail" || op.answer === "gone"
                ? { type: "waitFailed", seq: call.seq, requestId, gone: op.answer === "gone" }
                : { type: "answer", seq: call.seq, requestId, state: op.answer, ...(op.answer === "in" ? { me: ME } : {}) };
            break;
          }
        }
        apply(run, event);
        // OWN-ANSWERS-ONLY: an answer for another request, or one that is not the running call's, moves nothing.
        if (event.type === "answer" || event.type === "waitFailed") {
          const own = before.kind === "waiting" && before.requestId === event.requestId && before.io.seq === event.seq && before.io.step === "inflight";
          if (!own) assert.equal(run.state, before, "a foreign answer moved the page");
        }
        // NO-MOVE-AFTER-CANCEL: once Cancel got its 204 the page is the form, whatever the wait says.
        if (before.kind === "form" && (event.type === "answer" || event.type === "waitFailed")) assert.equal(run.state, before);
        break;
      }
    }
  }
}

describe("the ask page's reducer", () => {
  test("holds its invariants over random sequences of taps, answers and failures", () => {
    holds(fc.property(ops, (list) => play(list)), 400);
  });
});
