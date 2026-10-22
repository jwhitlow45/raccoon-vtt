import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { openResync, stepResync, type ResyncEvent, type ResyncState, type SyncOp } from "./resyncFlow.ts";

/**
 * The re-sync dialog's state machine (docs/design-v1-resync.md 5) under
 * many random orders of taps and answers: opens, Get it, late, refused
 * and aborted answers, pasted JSON, ticks, bulk buttons, live changes,
 * Apply and its answers, Undo and its answers, and closing.
 */

const FILL: PcFill = { source: "ddb", stats: { rolls: [] }, actor: {}, warnings: [] };
const OP: SyncOp = { patch: { ddbSync: { base: {}, rolls: {} } }, expect: { ddbSync: "0123456789ab", "actor.shape": "0123456789ab" } };
const LINES = ["field:spellAbility", "field:abilities.wis", "roll:w:0123456789ab", "also:level", "also:name"];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

describe("the re-sync dialog's steps", () => {
  test("it fetches at once, reviews, applies once, and undoes once after a taken Apply", () => {
    let s = openResync();
    let r = stepResync(s, { t: "open" });
    assert.deepEqual(r.effects, [{ kind: "fetch", id: 1 }]);
    s = r.state;
    s = stepResync(s, { t: "got", id: 1, result: { fill: FILL, ids: LINES, ticks: new Set(["also:level"]) } }).state;
    assert.equal(s.step, "review");
    assert.deepEqual([...s.ticks], ["also:level"]);
    r = stepResync(s, { t: "apply", op: OP });
    assert.deepEqual(r.effects, [{ kind: "send", what: "apply", op: OP }]);
    assert.deepEqual(stepResync(r.state, { t: "apply", op: OP }).effects, [], "never a second while one waits");
    s = stepResync(r.state, { t: "applied", answer: "taken" }).state;
    assert.equal(s.step, "done");
    r = stepResync(s, { t: "undo", op: OP });
    assert.equal(r.effects.length, 1);
    s = stepResync(r.state, { t: "undid", answer: "taken" }).state;
    assert.equal(s.step, "undone");
  });

  test("a stale refusal keeps the review and its ticks, and the rebuild drops only ticks whose lines went", () => {
    let s = stepResync(stepResync(openResync(), { t: "open" }).state, { t: "got", id: 1, result: { fill: FILL, ids: LINES, ticks: new Set(["also:level", "field:spellAbility"]) } }).state;
    s = stepResync(s, { t: "apply", op: OP }).state;
    s = stepResync(s, { t: "applied", answer: "stale" }).state;
    assert.equal(s.step, "review");
    assert.equal(s.refused?.answer, "stale");
    assert.deepEqual([...s.ticks].sort(), ["also:level", "field:spellAbility"]);
    s = stepResync(s, { t: "lines", ids: LINES.filter((id) => id !== "field:spellAbility"), changed: false }).state;
    assert.deepEqual([...s.ticks], ["also:level"]);
    assert.equal(s.live, null, "the stale notice says it, not the live line");
    s = stepResync(s, { t: "lines", ids: ["also:name"], changed: true }).state;
    assert.deepEqual(s.live, { dropped: true });
  });

  test("Done with nothing to send closes and sends nothing, and the budget's refusal waits for its refill", () => {
    const review = stepResync(stepResync(openResync(), { t: "open" }).state, { t: "got", id: 1, result: { fill: FILL, ids: [], ticks: new Set() } }).state;
    assert.deepEqual(stepResync(review, { t: "apply", op: null }).effects, [{ kind: "close" }]);
    let s = stepResync(review, { t: "apply", op: OP }).state;
    s = stepResync(s, { t: "applied", answer: "fast", message: "slow down" }).state;
    assert.equal(s.waiting, true);
    assert.deepEqual(stepResync(s, { t: "apply", op: OP }).effects, []);
    s = stepResync(s, { t: "refilled" }).state;
    assert.equal(stepResync(s, { t: "apply", op: OP }).effects.length, 1);
  });

  test("a failed fetch shows the field, and pasted JSON read while a fetch waits wins and aborts it", () => {
    let s = stepResync(openResync(), { t: "open" }).state;
    s = stepResync(s, { t: "got", id: 1, result: { error: "private" } }).state;
    assert.deepEqual([s.step, s.field, s.error], ["ddb", true, "private"]);
    const r = stepResync(stepResync(s, { t: "get" }).state, { t: "read", fill: FILL, ids: LINES, ticks: new Set() });
    assert.deepEqual(r.effects, [{ kind: "abort", id: 2 }]);
    assert.equal(r.state.from, "paste");
    assert.equal(stepResync(r.state, { t: "back" }).state.error, null, "Back to the link shows no refusal the read answered");
    assert.equal(stepResync(r.state, { t: "got", id: 2, result: { fill: FILL, ids: [], ticks: new Set() } }).state, r.state, "the aborted answer changes nothing");
  });
});

/**
 * One random life of the dialog: answers come back in any order, late or
 * not at all, the character changes on another device, and the dialog
 * closes at any point.
 */
function life(seed: number): void {
  const r = rng(seed);
  let state: ResyncState = openResync();
  /** Fetches the effects started and nothing aborted or answered yet. */
  const inFlight = new Set<number>();
  const started: number[] = [];
  let sentApply = 0;
  let sentUndo = 0;
  let applyTaken = false;
  let closedAt = -1;
  const ids = () => (r() < 0.5 ? LINES : LINES.filter(() => r() < 0.7));

  for (let step = 0; step < 40; step++) {
    const events: (() => ResyncEvent)[] = [
      () => ({ t: "open" }),
      () => ({ t: "get" }),
      () => ({ t: "got", id: started.length > 0 ? pick(r, started) : 1, result: r() < 0.3 ? { error: pick(r, ["private", "busy", "failed"]) } : { fill: FILL, ids: ids(), ticks: new Set(LINES.filter(() => r() < 0.4)) } }),
      () => ({ t: "read", fill: FILL, ids: ids(), ticks: new Set() }),
      () => ({ t: "back" }),
      () => ({ t: "tick", id: pick(r, LINES) }),
      () => ({ t: "bulk", ticks: new Set(LINES.filter(() => r() < 0.5)) }),
      () => ({ t: "lines", ids: ids(), changed: r() < 0.7 }),
      () => ({ t: "apply", op: r() < 0.1 ? null : OP }),
      () => ({ t: "applied", answer: pick(r, ["taken", "stale", "refused", "fast", "unknown"] as const), ...(r() < 0.5 ? { message: "no" } : {}) }),
      () => ({ t: "undo", op: OP }),
      () => ({ t: "undid", answer: pick(r, ["taken", "stale", "refused", "fast", "unknown"] as const) }),
      () => ({ t: "refilled" }),
      () => ({ t: "close" }),
    ];
    const event = pick(r, events)();
    const before = state;
    const { state: next, effects } = stepResync(state, event);
    state = next;

    // Nothing is sent or fetched after close.
    if (before.closed) {
      assert.equal(state, before, "a closed dialog changes nothing");
      assert.deepEqual(effects, []);
      continue;
    }
    for (const effect of effects) {
      if (effect.kind === "fetch") {
        inFlight.add(effect.id);
        started.push(effect.id);
      } else if (effect.kind === "abort") inFlight.delete(effect.id);
      else if (effect.kind === "send") {
        // Apply sends at most one op, never while one waits, always with expect. Undo only after a taken Apply.
        assert.ok(Object.keys(effect.op.expect).length > 0, "always with expect");
        if (effect.what === "apply") {
          assert.equal(before.applying, null, "never while one waits");
          assert.equal(applyTaken, false, "nothing after a taken Apply but Undo");
          sentApply++;
        } else {
          assert.ok(applyTaken, "Undo only after a taken Apply");
          sentUndo++;
          assert.ok(sentUndo <= 1 || before.refused?.of === "undo", "one Undo at a time, again only after its refusal");
          assert.equal(before.undoing, false);
        }
      } else closedAt = step;
    }
    if (event.t === "got") inFlight.delete(event.id);
    // At most one fetch in flight: a newer one aborts the older.
    assert.ok(inFlight.size <= 1, "one fetch at a time");
    // A stale or aborted answer never changes the review.
    if (event.t === "got" && before.get !== event.id) assert.equal(state, before, "a stale answer changes nothing");
    if (event.t === "applied" && before.applying && event.answer === "taken") applyTaken = true;
    if (before.applying && event.t !== "applied" && event.t !== "close") assert.equal(state.ticks, before.ticks, "the review holds still while Apply waits");
    // Ticks change only by a tick, a bulk button or a line going away, besides a new review or Back.
    if (!["tick", "bulk", "lines", "got", "read", "back"].includes(event.t)) assert.equal(state.ticks, before.ticks, `ticks kept through ${event.t}`);
    if (event.t === "lines" && state.ticks !== before.ticks) for (const id of state.ticks) assert.ok(before.ticks.has(id), "a line going away only drops ticks");
    // A refusal leaves the ticks whose lines remain.
    if (event.t === "applied" && event.answer !== "taken") assert.equal(state.ticks, before.ticks);
    for (const id of state.ticks) assert.ok(state.ids.includes(id), "a tick is on a line the review shows");
    if (state.closed) assert.ok(closedAt >= 0);
  }
  assert.ok(sentUndo === 0 || sentApply > 0);
}

test("the re-sync dialog's invariants hold over many random sequences", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    try {
      life(seed);
    } catch (err) {
      throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
    }
  }
});
