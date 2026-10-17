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
