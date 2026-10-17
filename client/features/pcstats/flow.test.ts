import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { openFlow, stepFlow, type FlowEvent, type FlowState } from "./flow.ts";

/** The editor's steps and Save (docs/design-v1-pc-stats.md 7.2). */

const BLOCK: PcStats = structuredClone(EMPTY_PC_STATS as PcStats);
const FILL: PcFill = { source: "paste", stats: { saves: ["dex"], rolls: [] }, actor: { ac: 16 }, warnings: [] };

function run(state: FlowState, ...events: FlowEvent[]) {
  const effects: string[] = [];
  for (const e of events) {
    const r = stepFlow(state, e);
    state = r.state;
    effects.push(...r.effects.map((x) => x.kind));
  }
  return { state, effects };
}

describe("the editor's flow", () => {
  test("paste, read, review, Use it fills the draft and the fields beside it, and Save sends one op", () => {
    const start = openFlow({ stats: BLOCK, level: 5 });
    const { state, effects } = run(start, { t: "open", step: "paste" }, { t: "read", fill: FILL, lines: [{ key: "ac", text: "AC 16, now 15", on: true }] }, { t: "use" }, { t: "save" }, { t: "save" });
    assert.deepEqual(state.draft.stats.saves, ["dex"]);
    assert.deepEqual(state.also, { ac: 16 });
    assert.equal(state.step, "block");
    assert.deepEqual(effects, ["send"], "a second tap while the first waits sends nothing");
  });

  test("a refusal leaves the draft as it was, taken closes, and nothing more happens once closed", () => {
    const start = openFlow({ stats: BLOCK, level: 5 });
    const refused = run(start, { t: "save" }, { t: "saved", answer: "refused" });
    assert.equal(refused.state.saving, false);
    assert.equal(refused.state.draft, start.draft);
    const taken = run(start, { t: "save" }, { t: "saved", answer: "taken" }, { t: "save" }, { t: "edit", update: (d) => ({ ...d, level: 9 }) });
    assert.deepEqual(taken.effects, ["send", "close"]);
    assert.equal(taken.state.draft.level, 5);
  });

  test("Back from the review returns to its step and drops what it read", () => {
    const { state } = run(openFlow({ stats: BLOCK, level: 5 }), { t: "open", step: "paste" }, { t: "read", fill: FILL, lines: [] }, { t: "back" });
    assert.equal(state.step, "paste");
    assert.equal(state.review, null);
    assert.deepEqual(state.draft.stats.saves, []);
  });
});

/** A seeded generator, so a failing sequence can be run again. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the fill flow under random taps and answers (docs/design-v1-pc-stats.md 12)", () => {
  /*
   * Many random sequences of Get it, Read it, Back, Use it, edits, Save,
   * close, and late, refused, unknown and aborted answers, against the
   * invariants that must always hold: at most one fetch in flight; a stale
   * or aborted answer never changes the draft; the draft changes only by an
   * edit or Use it; a Save sends at most one op, never while one waits and
   * never after close; a refusal leaves the draft as it was; after close
   * nothing more is sent.
   */
  test("its invariants hold over 300 sequences of 80 steps", () => {
    const reached = { stale: 0, used: 0, refused: 0, taken: 0, gotFill: 0, gotError: 0, abortedByGet: 0, closedMidFetch: 0, afterClose: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
      let state = openFlow({ stats: BLOCK, level: 5 });
      const inFlight = new Set<number>();
      const issued: number[] = [];
      let sends = 0;
      for (let step = 0; step < 80; step++) {
        const fill: PcFill = { source: pick(["paste", "ddb"] as const), stats: { saves: [pick(["str", "dex", "con"] as const)], rolls: [] }, actor: {}, warnings: [] };
        const events: (() => FlowEvent)[] = [
          () => ({ t: "edit", update: (d) => ({ ...d, level: 1 + Math.floor(r() * 20) }) }),
          () => ({ t: "open", step: pick(["paste", "ddb"] as const) }),
          () => ({ t: "back" }),
          () => ({ t: "read", fill, lines: [{ key: "ac", text: "AC", on: r() < 0.5 }] }),
          () => ({ t: "toggle", key: "ac" }),
          () => ({ t: "use" }),
          () => ({ t: "save" }),
          () => ({ t: "saved", answer: pick(["taken", "refused", "unknown", "refused"] as const) }),
          () => ({ t: "get" }),
          () => ({ t: "got", id: issued.length > 0 ? pick(issued) : 99, result: r() < 0.6 ? { fill, lines: [] } : { error: "D&D Beyond did not answer." } }),
          () => ({ t: r() < 0.1 ? "close" : "back" }),
        ];
        const event = pick(events)();
        const before = state;
        const { state: next, effects } = stepFlow(state, event);
        state = next;
        for (const e of effects) {
          if (e.kind === "fetch") {
            assert.equal(before.closed, false, "nothing is fetched after close");
            inFlight.add(e.id);
            issued.push(e.id);
          }
          if (e.kind === "abort") {
            inFlight.delete(e.id);
            if (event.t === "get") reached.abortedByGet++;
            if (event.t === "close") reached.closedMidFetch++;
          }
          if (e.kind === "send") {
            assert.equal(before.closed, false, "nothing is sent after close");
            assert.equal(before.saving, false, "never while a Save waits");
            sends++;
            assert.equal(sends, 1, "one op waits at a time");
          }
        }
        if (event.t === "saved" && before.saving) sends = 0;
        assert.ok(inFlight.size <= 1, "at most one fetch in flight");
        if (event.t === "got") {
          if (before.get !== event.id) {
            reached.stale++;
            assert.equal(state, before, "a stale or aborted answer changes nothing");
          } else {
            inFlight.delete(event.id);
            if ("error" in event.result) reached.gotError++;
            else reached.gotFill++;
          }
        }
        if (event.t !== "edit" && event.t !== "use") assert.equal(state.draft, before.draft, `the draft changes only by an edit or Use it, not by ${event.t}`);
        if (event.t === "use" && state.draft !== before.draft) reached.used++;
        if (event.t === "saved" && before.saving) {
          if (event.answer === "taken") {
            reached.taken++;
            assert.equal(state.closed, true);
          } else {
            reached.refused++;
            assert.equal(state.draft, before.draft, "a refusal leaves the draft as it was");
          }
        }
        if (before.closed) {
          reached.afterClose++;
          assert.deepEqual(effects, [], "after close nothing happens");
        }
      }
    }
    for (const [path, count] of Object.entries(reached)) assert.ok(count > 0, `the run reached ${path}`);
  });
});
