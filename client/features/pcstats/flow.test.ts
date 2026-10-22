import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, sameRecord, syncPatch, syncResult, type SyncCharacter } from "#shared/rules/pcSync.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor } from "#shared/testutil.ts";
import { openDraft } from "./draft.ts";
import { alsoPatch } from "./fill.ts";
import { editorHelpCharacter, editorSyncPlan, editorSyncUse, openFlow, stepFlow, type FlowEvent, type FlowState } from "./flow.ts";
import { alsoLine } from "./resync.ts";

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
  test("a new block's fill, its roll deleted, then a fill before Save offers Add it back, since the pending record makes the draft a block (RSBUILD-ASTRA-05)", () => {
    const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ ac: 15 }) };
    const sling = { id: "read-1", name: "Sling", kind: "weapon" as const, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4" }], ddb: true as const };
    const read = (id: string): PcFill => ({ source: "ddb", stats: { rolls: [{ ...sling, id }] }, level: 5, name: "Bree", actor: { ac: 15 }, warnings: [], read: { weapon: true, spell: true, other: true } });
    const opened = openDraft(bare);
    let state = run(openFlow(opened.draft), { t: "open", step: "ddb" }).state;
    const first = editorSyncPlan(read("read-1"), state, opened, bare);
    assert.equal(first.source, "first");
    state = run(state, { t: "read", fill: read("read-1"), lines: [], ticks: defaultTicks(first) }, { t: "use", sync: editorSyncUse(syncResult(first, defaultTicks(first)), bare) }).state;
    assert.deepEqual(state.draft.stats.rolls.map((r) => r.name), ["Sling"]);
    assert.ok(state.record);
    // Deleting the roll leaves the draft as it opened, with the record still pending.
    state = run(state, { t: "edit", update: (d) => ({ ...d, stats: { ...d.stats, rolls: [] } }) }, { t: "open", step: "ddb" }).state;
    assert.deepEqual(state.draft, opened.draft);
    const again = editorSyncPlan(read("read-2"), state, opened, bare);
    assert.equal(again.source, "same");
    const back = again.items.find((i) => i.type === "roll");
    assert.deepEqual([back?.section, back?.type === "roll" && back.case], ["kept", "deleted"], "listed with Add it back");
    assert.deepEqual(syncResult(again, defaultTicks(again)).stats.rolls, [], "and left out unless ticked");
  });

  test("after an earlier fill set a lower maximum, a later one's HP help reads the saved HP, as Save works it out (RSBUILD-ASTRA-06)", () => {
    const AT = "2026-10-20T19:00:00.000Z";
    const read = (hpMax: number): PcFill => ({ source: "ddb", stats: { rolls: [] }, level: 5, name: "Bree", actor: { ac: 15, hpMax }, warnings: [], read: { weapon: true, spell: true, other: true } });
    const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ ac: 15, hp: { cur: 35, max: 38, temp: 0 } }) };
    const p0 = planSync({ mode: "resync", stats: undefined, level: 5, character: bare, fill: read(38) });
    const saved = afterSync(bare, syncPatch(bare, syncResult(p0, defaultTicks(p0)))!.patch, AT);
    assert.deepEqual(saved.actor.hp, { cur: 35, max: 38, temp: 0 });
    const opened = openDraft(saved);
    let state = openFlow(opened.draft);
    const fill = (f: PcFill) => {
      state = run(state, { t: "open", step: "ddb" }).state;
      const plan = editorSyncPlan(f, state, opened, saved);
      const ticks = defaultTicks(plan);
      state = run(state, { t: "read", fill: f, lines: [], ticks }).state;
      return plan;
    };
    const use = (plan: ReturnType<typeof fill>) => (state = run(state, { t: "use", sync: editorSyncUse(syncResult(plan, defaultTicks(plan)), saved) }).state);
    use(fill(read(35)));
    assert.equal(state.also.hpMax, 35);
    const plan = fill(read(45));
    const line = plan.also.find((a) => a.key === "hpMax")!;
    assert.equal(alsoLine(line, plan.input.character, "ddb").help, "Bree is unhurt and stays at full HP: 45 of 45.", "the pending character reads as full");
    assert.equal(alsoLine(line, editorHelpCharacter(plan, saved), "ddb").help, "Bree keeps 35 HP, now out of 45.");
    use(plan);
    // Save works the HP from the saved character and the maximum the fills left: 35 of 45, as the help says.
    const hp = alsoPatch(state.also, saved).actor?.hp;
    assert.deepEqual(hp, { max: 45 });
    assert.deepEqual(afterSync(saved, { actor: { hp: hp! } }, AT).actor.hp, { cur: 35, max: 45, temp: 0 });
  });

  test("several D&D Beyond fills before Save: each is reviewed against what the last one took, and its record replaces the last one (RSBUILD-ASTRA-02)", () => {
    const AT = "2026-10-20T19:00:00.000Z";
    const read = (dex: number, ac: number): PcFill => ({ source: "ddb", stats: { abilities: { ...EMPTY_PC_STATS.abilities, dex }, rolls: [] }, level: 5, name: "Bree", actor: { ac }, warnings: [], read: { weapon: true, spell: true, other: true } });
    // Bree as saved: synced once from dex 14 and AC 15.
    const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ ac: 15 }) };
    const first = planSync({ mode: "resync", stats: undefined, level: 5, character: bare, fill: read(14, 15) });
    const saved = afterSync(bare, syncPatch(bare, syncResult(first, defaultTicks(first)))!.patch, AT);
    const opened = openDraft(saved);
    let state = openFlow(opened.draft);
    const fill = (f: PcFill) => {
      state = run(state, { t: "open", step: "ddb" }).state;
      const plan = editorSyncPlan(f, state, opened, saved);
      const ticks = defaultTicks(plan);
      state = run(state, { t: "read", fill: f, lines: [], ticks }, { t: "use", sync: editorSyncUse(syncResult(plan, ticks), saved) }).state;
      return plan;
    };

    const one = fill(read(16, 16));
    assert.deepEqual(one.items.map((i) => [i.id, i.section]), [["field:abilities.dex", "changes"]]);
    assert.deepEqual([state.draft.stats.abilities.dex, state.also.ac, state.record?.base.abilities?.dex, state.record?.base.ac], [16, 16, 16, 16]);
    const pending = state.record;

    // The same read again finds nothing new: not dex 16 as an edit of the player's against the saved dex 14, nor AC 16 still to set.
    const two = fill(read(16, 16));
    assert.deepEqual([two.source, two.items, two.also], ["same", [], []]);
    assert.ok(pending && state.record && sameRecord(state.record, pending), "the pending record is kept");

    // D&D Beyond back where the saved record has it: the pending record is replaced by none, so Save sends the saved one unchanged.
    const three = fill(read(14, 15));
    assert.deepEqual(three.items.map((i) => [i.id, i.section]), [["field:abilities.dex", "changes"]]);
    assert.deepEqual(three.also.map((a) => [a.key, a.now, a.theirs]), [["ac", 16, 15]]);
    assert.deepEqual([state.draft.stats.abilities.dex, state.also.ac, state.record], [14, 15, null]);
  });

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

  test("a D&D Beyond read is reviewed by its ticks, and Use it takes the block, the fields beside it and the record it carries (docs/design-v1-resync.md 1.1)", () => {
    const ddb: PcFill = { ...FILL, source: "ddb" };
    const start = openFlow({ stats: BLOCK, level: 5 });
    let { state } = run(start, { t: "open", step: "ddb" }, { t: "get" });
    state = run(state, { t: "got", id: 1, result: { fill: ddb, lines: [], ticks: new Set(["also:level"]) } }, { t: "tick", id: "field:spellAbility" }, { t: "tick", id: "also:level" }).state;
    assert.deepEqual([...state.review!.ticks!], ["field:spellAbility"]);
    assert.equal(state.review!.merge, undefined, "a review by its ticks merges nothing of its own");
    state = run(state, { t: "ticks", ticks: new Set(["also:ac"]) }).state;
    assert.deepEqual([...state.review!.ticks!], ["also:ac"]);
    assert.equal(run(state, { t: "use" }).state.step, "review", "Use it needs what the editor worked out");
    const record = { base: { level: 6 }, rolls: {} };
    const used = run(state, { t: "use", sync: { stats: { ...BLOCK, saves: ["wis"] }, level: 6, also: { level: 6, ac: 16 }, record } }).state;
    assert.deepEqual([used.step, used.draft.stats.saves, used.draft.level, used.also, used.record], ["block", ["wis"], 6, { level: 6, ac: 16 }, record]);
    // A later Use it replaces the record, and null, one equal to the saved record, drops it.
    const again = run(used, { t: "open", step: "ddb" }, { t: "read", fill: ddb, lines: [], ticks: new Set() }, { t: "use", sync: { stats: used.draft.stats, level: 6, also: {}, record: null } }).state;
    assert.equal(again.record, null);
    const pasted = run(start, { t: "open", step: "paste" }, { t: "read", fill: FILL, lines: [] }, { t: "tick", id: "x" }).state.review!;
    assert.equal(pasted.ticks, undefined, "pasted text keeps today's review");
    assert.ok(pasted.merge, "with its summary's merge");
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
          () => ({ t: "read", fill, lines: [{ key: "ac", text: "AC", on: r() < 0.5 }], ...(fill.source === "ddb" ? { ticks: new Set(["also:ac"]) } : {}) }),
          () => ({ t: "toggle", key: "ac" }),
          () => ({ t: "tick", id: pick(["also:ac", "field:spellAbility"]) }),
          () => ({ t: "use" }),
          () => ({ t: "use", sync: { stats: { ...BLOCK, saves: [pick(["wis", "cha"] as const)] }, level: 1 + Math.floor(r() * 20), also: {}, record: r() < 0.5 ? { base: {}, rolls: {} } : null } }),
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
