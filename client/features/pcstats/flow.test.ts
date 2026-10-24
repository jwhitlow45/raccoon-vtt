import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, sameRecord, syncPatch, syncResult, type SyncCharacter } from "#shared/rules/pcSync.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor } from "#shared/testutil.ts";
import { openDraft } from "./draft.ts";
import { alsoPatch } from "./fill.ts";
import { editorHelpCharacter, editorSyncPlan, editorSyncUse, openFlow, resourcesSave, resourcesUnsaved, stepFlow, type FlowEvent, type FlowState } from "./flow.ts";
import { levelUps, resourcesAfter } from "#shared/rules/classResources.ts";
import { expectHash } from "#shared/permissions.ts";
import { hash12 } from "#shared/rules/pcSync.ts";
import { goneDroppedLine } from "./resync.ts";
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
    state = run(state, { t: "read", fill: read("read-1"), lines: [], ticks: defaultTicks(first) }, { t: "use", sync: editorSyncUse(syncResult(first, defaultTicks(first)), bare, { fill: read("read-1"), ticks: defaultTicks(first) }) }).state;
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
    const use = (plan: ReturnType<typeof fill>) => (state = run(state, { t: "use", sync: editorSyncUse(syncResult(plan, defaultTicks(plan)), saved, { fill: plan.input.fill, ticks: defaultTicks(plan) }) }).state);
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
      state = run(state, { t: "read", fill: f, lines: [], ticks }, { t: "use", sync: editorSyncUse(syncResult(plan, ticks), saved, { fill: f, ticks }) }).state;
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
    const used = run(state, { t: "use", sync: { stats: { ...BLOCK, saves: ["wis"] }, level: 6, also: { level: 6, ac: 16 }, record, resources: null } }).state;
    assert.deepEqual([used.step, used.draft.stats.saves, used.draft.level, used.also, used.record], ["block", ["wis"], 6, { level: 6, ac: 16 }, record]);
    // A later Use it replaces the record, and null, one equal to the saved record, drops it.
    const again = run(used, { t: "open", step: "ddb" }, { t: "read", fill: ddb, lines: [], ticks: new Set() }, { t: "use", sync: { stats: used.draft.stats, level: 6, also: {}, record: null, resources: null } }).state;
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
    const reached = { stale: 0, used: 0, refused: 0, taken: 0, gotFill: 0, gotError: 0, abortedByGet: 0, closedMidFetch: 0, afterClose: 0, resourcesAgain: 0 };
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
          () => ({ t: "use", sync: { stats: { ...BLOCK, saves: [pick(["wis", "cha"] as const)] }, level: 1 + Math.floor(r() * 20), also: {}, record: r() < 0.5 ? { base: {}, rolls: {} } : null, resources: r() < 0.5 ? { fill, ticks: new Set(), expect: "000000000000" } : null } }),
          () => ({ t: "save" }),
          () => ({ t: "saved", answer: pick(["taken", "refused", "unknown", "refused"] as const), ...(r() < 0.3 ? { stale: true } : {}) }),
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
            assert.equal(state.also, before.also, "and the fields beside it");
            // Refused for the class resources: they alone are reviewed again, from the read Use it held, with no fetch (6.2 c).
            if (event.stale && before.resources) {
              reached.resourcesAgain++;
              assert.deepEqual([state.step, state.review?.only, state.review?.fill], ["review", "resources", before.resources.fill]);
              assert.deepEqual(effects, []);
            }
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

/** The editor's D&D Beyond step with class resources (docs/design-v1-ddb-resources.md 6.2), one row per letter. */
describe("the editor's class resources", () => {
  const AT = "2026-10-24T10:00:00.000Z";
  const SHEET = "https://www.dndbeyond.com/characters/12345678";
  const rageRead = (used = 0, max = 3) => ({ name: "Rage", max, reset: "shortOne" as const, preset: "barbarian-rage", level: 3, classId: "barbarian" as const, used });
  const read = (resources: NonNullable<PcFill["resources"]>): PcFill => ({ source: "ddb", stats: { rolls: [] }, level: 5, name: "Bree", actor: { sheetUrl: SHEET }, warnings: [], read: { weapon: true, spell: true, other: true, resource: true }, resources });
  /** Bree as saved: synced once with Rage, which she has spent 1 of since. */
  function savedBree(): SyncCharacter {
    const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ sheetUrl: SHEET }) };
    const p = planSync({ mode: "resync", stats: undefined, level: 5, character: bare, fill: read([rageRead()]) });
    const synced = afterSync(bare, syncPatch(bare, syncResult(p, defaultTicks(p)))!.patch, AT);
    return { ...synced, resources: synced.resources!.map((r) => ({ ...r, used: 1 })) };
  }
  const review = (saved: SyncCharacter, f: PcFill, state: FlowState, ticks?: ReadonlySet<string>) => {
    const opened = openDraft(saved);
    const plan = editorSyncPlan(f, state, opened, saved);
    const t = ticks ?? defaultTicks(plan);
    return { plan, ticks: t, use: editorSyncUse(syncResult(plan, t), saved, { fill: f, ticks: t }) };
  };

  test("(a) Use it holds the fill, its ticks, the list and the hash of the list it was planned from", () => {
    const saved = savedBree();
    const f = read([rageRead(0, 4), { name: "Luck Points", max: 3, reset: "long", used: 1 }]);
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state;
    const { use, ticks } = review(saved, f, start);
    const state = run(start, { t: "read", fill: f, lines: [], ticks }, { t: "use", sync: use }).state;
    assert.equal(state.resources?.fill, f);
    assert.deepEqual(state.resources?.list?.map((r) => [r.name, r.max]), [["Rage", 4], ["Luck Points", 3]]);
    assert.equal(state.resources?.expect, expectHash(saved as never, "resources"));
    assert.ok(state.record?.res && Object.keys(state.record.res).length === 2);
  });

  test("(b) a later read plans against the live list and the saved record's part, never the pending record's new ids", () => {
    const saved = savedBree();
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state;
    const f = read([rageRead(), { name: "Luck Points", max: 3, reset: "long" }]);
    const one = review(saved, f, start);
    const state = run(start, { t: "read", fill: f, lines: [], ticks: one.ticks }, { t: "use", sync: one.use }, { t: "open", step: "ddb" }).state;
    // The pending record names Luck Points by an id the live list lacks: read again, it is still an addition, never "you removed it".
    const two = review(saved, f, state);
    assert.deepEqual(two.plan.items.filter((i) => i.type === "resource").map((i) => i.type === "resource" && i.case), ["add"]);
  });

  test("(c) refused for the class resources: they alone are reviewed again against the live list, the draft and Also set kept, and Use it then Save sends again", () => {
    const saved = savedBree();
    const f = read([rageRead(0, 4)]);
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }, { t: "edit", update: (d) => ({ ...d, level: 6 }) }, { t: "open", step: "ddb" }).state;
    const one = review(saved, f, start);
    let state = run(start, { t: "read", fill: f, lines: [], ticks: one.ticks }, { t: "use", sync: one.use }).state;
    const draft = state.draft;
    state = run(state, { t: "save" }, { t: "saved", answer: "refused", stale: true }).state;
    assert.deepEqual([state.step, state.review?.only], ["review", "resources"]);
    assert.equal(state.draft, draft);
    // Another device spent a second Rage meanwhile: the review reads the live list.
    const live: SyncCharacter = { ...saved, resources: saved.resources!.map((r) => ({ ...r, used: 2 })) };
    const again = review(live, f, state, state.review!.ticks);
    assert.deepEqual(again.plan.spent.map((x) => [x.theirs, x.now]), [[0, 2]]);
    const { effects, state: used } = run(state, { t: "use", sync: again.use }, { t: "save" });
    assert.equal(used.draft, draft, "the draft stays");
    assert.equal(used.resources?.expect, expectHash(live as never, "resources"));
    assert.deepEqual(effects, ["send"]);
  });

  test("(d) a held result that changes nothing: no resources and no expect, so a spend meanwhile never refuses the Save", () => {
    const saved = savedBree();
    const { use } = review(saved, read([rageRead(1)]), run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state);
    assert.equal(use.resources, null);
    assert.equal(use.record, null);
  });

  test("(e) only a spent line ticked: held, so it counts as unsaved and Save sends it, with the record as saved", () => {
    const saved = savedBree();
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state;
    const plain = review(saved, read([rageRead(0)]), start);
    assert.equal(plain.use.resources, null, "unticked, nothing to hold");
    const ticked = review(saved, read([rageRead(0)]), start, new Set([...plain.ticks, plain.plan.spent[0]!.id]));
    assert.equal(ticked.use.record, null, "the record is as saved");
    assert.deepEqual(ticked.use.resources?.list?.map((r) => r.used), [0]);
    const state = run(start, { t: "read", fill: read([rageRead(0)]), lines: [], ticks: ticked.ticks }, { t: "use", sync: ticked.use }).state;
    assert.ok(state.resources, "unsaved, and Save sends it");
  });

  test("only the record's resource part changes, a removed resource's marker: held with no list, so Save expects the resources and sends the record", () => {
    const saved0 = savedBree();
    const saved: SyncCharacter = { ...saved0, resources: [] };
    const { use } = review(saved, read([rageRead()]), run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state);
    assert.ok(use.resources, "held");
    assert.equal(use.resources.list, undefined, "the list is as it is");
    assert.deepEqual(use.record?.gone, [`r:${hash12("barbarian:rage")}`]);
  });

  test("a second sheet read twice before Save: the resource part's source is the saved record's, so the first sheet's entries never remove its resources (DDBBUILD-ASTRA-02)", () => {
    const saved = savedBree();
    const b: PcFill = { ...read([{ name: "Luck Points", max: 3, reset: "long", used: 0 }]), actor: { sheetUrl: "https://www.dndbeyond.com/characters/87654321" } };
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state;
    const one = review(saved, b, start);
    const state = run(start, { t: "read", fill: b, lines: [], ticks: one.ticks }, { t: "use", sync: one.use }, { t: "open", step: "ddb" }).state;
    assert.equal(state.record?.from, "87654321");
    const two = review(saved, b, state);
    const cases = two.plan.items.flatMap((i) => (i.type === "resource" ? [i.case] : []));
    assert.ok(!cases.includes("remove"), cases.join());
    assert.deepEqual(two.use.resources?.list?.map((r) => r.name), ["Rage", "Luck Points"]);
    // Sheet B's own Rage meets the saved one by name, with no record between them, so it is offered as the editor offers a fill's values.
    const withRage: PcFill = { ...b, resources: [rageRead(0, 4), ...b.resources!] };
    const first = review(saved, withRage, start);
    const pending = run(start, { t: "read", fill: withRage, lines: [], ticks: first.ticks }, { t: "use", sync: first.use }, { t: "open", step: "ddb" }).state;
    const rage = review(saved, withRage, pending).plan.items.find((i) => i.type === "resource" && (i.mine ?? i.theirs!.resource).name === "Rage");
    assert.deepEqual([rage?.type === "resource" && rage.case, rage?.section], ["sameName", "replaces"]);
  });

  describe("after a Save refused for the class resources (DDBBUILD-ASTRA-03)", () => {
    const sling = { id: "sling1", name: "Sling", kind: "weapon" as const, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4", mod: true as const }], ddb: true as const };
    const withSling = (resources: NonNullable<PcFill["resources"]>): PcFill => ({ ...read(resources), stats: { rolls: [sling] } });
    /** Bree synced with a Sling and Rage, Rage then raised to 5 here, the Sling deleted in the editor, and a read where D&D Beyond raised Rage to 4. */
    function refused() {
      const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ sheetUrl: SHEET }) };
      const p0 = planSync({ mode: "resync", stats: undefined, level: 5, character: bare, fill: withSling([rageRead()]) });
      const synced = afterSync(bare, syncPatch(bare, syncResult(p0, defaultTicks(p0)))!.patch, AT);
      const saved: SyncCharacter = { ...synced, resources: synced.resources!.map((r) => ({ ...r, max: 5 })) };
      const f = withSling([rageRead(0, 4)]);
      const opened = openDraft(saved);
      const start = run(openFlow(opened.draft), { t: "edit", update: (d) => ({ ...d, stats: { ...d.stats, rolls: [] } }) }, { t: "open", step: "ddb" }).state;
      const one = review(saved, f, start);
      const slingMarker = one.use.record!.gone!.find((k) => k.startsWith("w:"));
      assert.ok(slingMarker, "the deleted Sling is marked");
      const state = run(start, { t: "read", fill: f, lines: [], ticks: one.ticks }, { t: "use", sync: one.use }, { t: "save" }, { t: "saved", answer: "refused", stale: true }).state;
      assert.equal(state.review?.only, "resources");
      return { saved, f, state, slingMarker };
    }

    test("Use it keeps the pending record's roll markers, though a hidden Add it back was ticked, and takes the r: markers from the review", () => {
      const { saved, f, state, slingMarker } = refused();
      const plan = editorSyncPlan(f, state, openDraft(saved), saved);
      const slingBack = plan.items.find((i) => i.type === "roll" && i.case === "deleted")!;
      const ticks = new Set([...state.review!.ticks!, slingBack.id]);
      const result = syncResult(plan, ticks);
      assert.ok(!result.record.gone?.includes(slingMarker), "the review's own record lets the Sling back");
      const use = editorSyncUse(result, saved, { fill: f, ticks }, { pending: state.record });
      const after = run(state, { t: "use", sync: use }).state;
      assert.ok(after.record!.gone!.includes(slingMarker), "the Sling stays deleted, as the draft without it says");
      assert.deepEqual(after.draft.stats.rolls, [], "the draft stays");
      assert.equal(resourcesSave(after.resources, { ddbSync: after.record! }).expect?.resources, expectHash(saved as never, "resources"));
    });

    test("a review whose record is the saved one replaces the pending record's resource part, never keeps it", () => {
      const saved = savedBree();
      const { res: _res, ...rest } = saved.ddbSync!;
      const pending = { ...rest, res: {} };
      const f = read([rageRead(1)]);
      const state: FlowState = { ...run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state, record: pending };
      const plan = editorSyncPlan(f, state, openDraft(saved), saved);
      const ticks = defaultTicks(plan);
      const use = editorSyncUse(syncResult(plan, ticks), saved, { fill: f, ticks }, { pending });
      assert.equal(use.record, null, "as saved");
      assert.equal(use.resources, null);
    });

    describe("the joint 40 is cut once, after the splice (DDBBUILD-ASTRA-07)", () => {
      const luck = `r:${hash12("luck points")}`;
      const others = Array.from({ length: 39 }, (_, i) => `o:${(i + 1).toString(16).padStart(12, "0")}`);
      /** Bree with a Sling and Rage synced, Luck Points removed here the longest ago, then 39 other rolls; D&D Beyond still has Luck Points and sends no other rolls. */
      function boundary(rageMax: number) {
        const bare: SyncCharacter = { name: "Bree", level: 5, actor: actor({ sheetUrl: SHEET }) };
        const p0 = planSync({ mode: "resync", stats: undefined, level: 5, character: bare, fill: withSling([rageRead()]) });
        const synced = afterSync(bare, syncPatch(bare, syncResult(p0, defaultTicks(p0)))!.patch, AT);
        const saved: SyncCharacter = { ...synced, resources: synced.resources!.map((r) => ({ ...r, used: 1 })), ddbSync: { ...synced.ddbSync!, gone: [luck, ...others] } };
        const f: PcFill = { ...withSling([rageRead(0, rageMax), { name: "Luck Points", max: 3, reset: "long", used: 0 }]), read: { weapon: true, spell: true, other: false, resource: true } };
        return { saved, f };
      }
      /** Use it with these ticks, the Sling then deleted, and a Save refused for the class resources, reviewed again against `live`. */
      function stale(saved: SyncCharacter, f: PcFill, extra: (plan: ReturnType<typeof editorSyncPlan>) => string[] = () => [], live: SyncCharacter = saved) {
        const opened = openDraft(saved);
        const start = run(openFlow(opened.draft), { t: "open", step: "ddb" }).state;
        const plan = editorSyncPlan(f, start, opened, saved);
        const ticks = new Set([...defaultTicks(plan), ...extra(plan)]);
        const use = editorSyncUse(syncResult(plan, ticks), saved, { fill: f, ticks });
        const state = run(start, { t: "read", fill: f, lines: [], ticks }, { t: "use", sync: use }, { t: "edit", update: (d) => ({ ...d, stats: { ...d.stats, rolls: [] } }) }, { t: "save" }, { t: "saved", answer: "refused", stale: true }).state;
        assert.equal(state.review?.only, "resources");
        const again = editorSyncPlan(f, state, opened, live);
        const result = syncResult(again, state.review!.ticks!);
        assert.ok(!result.record.gone!.includes(luck), "the full review's cap took Luck Points for the deleted Sling");
        return run(state, { t: "use", sync: editorSyncUse(result, live, { fill: f, ticks: state.review!.ticks! }, { pending: state.record }) }).state;
      }

      test("a pending record: Luck Points keeps its place among the 40, and the Sling's new marker stays out", () => {
        const { saved, f } = boundary(4);
        const after = stale(saved, f);
        assert.deepEqual(after.record!.gone, [luck, ...others]);
      });

      test("past 40 after the splice, the oldest goes: Rage removed on another device meanwhile takes Luck Points' place", () => {
        const { saved, f } = boundary(4);
        const after = stale(saved, f, undefined, { ...saved, resources: [] });
        assert.deepEqual(after.record!.gone, [...others, `r:${hash12("barbarian:rage")}`]);
      });

      test("nothing pending: the saved record's markers are the base, so the record stays as saved", () => {
        const { saved, f } = boundary(3);
        const after = stale(saved, f, (plan) => plan.spent.map((x) => x.id));
        assert.equal(after.record, null);
        assert.ok(after.resources?.list, "the spent line still holds the list");
      });
    });
  });

  test("a read with no class resources still marks a removed linked one: held with no list, so Save expects the resources (DDBBUILD-ASTRA-04)", () => {
    const saved: SyncCharacter = { ...savedBree(), resources: [] };
    const f: PcFill = { source: "ddb", stats: { rolls: [] }, level: 5, name: "Bree", actor: { sheetUrl: SHEET }, warnings: [], read: { weapon: true, spell: true, other: false, resource: false } };
    const { use } = review(saved, f, run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state);
    assert.deepEqual(use.record?.gone, [`r:${hash12("barbarian:rage")}`]);
    assert.ok(use.resources, "held");
    assert.equal(use.resources.list, undefined);
    assert.ok(resourcesUnsaved(use.resources));
    assert.deepEqual(resourcesSave(use.resources, { ddbSync: use.record! }), { expect: { resources: expectHash(saved as never, "resources") } });
  });

  test("a Barbarian 4 read at 5: Rage's level rides with the Save's other writes, never alone, and the Update question never comes (DDBBUILD-OPUS-1, D-261024-41)", () => {
    const rage4 = { ...rageRead(), level: 4 };
    const bare: SyncCharacter = { name: "Bree", level: 4, stats: structuredClone(EMPTY_PC_STATS) as PcStats, actor: actor({ sheetUrl: SHEET }) };
    const p0 = planSync({ mode: "resync", stats: bare.stats, level: 4, character: bare, fill: { ...read([rage4]), level: 4 } });
    const saved = afterSync(bare, syncPatch(bare, syncResult(p0, defaultTicks(p0)))!.patch, AT);
    assert.deepEqual([saved.resources![0]!.level, saved.resources![0]!.atLevel], [4, 4]);
    const f = read([{ ...rageRead(), level: 5 }]);
    const start = run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state;
    const { use, ticks } = review(saved, f, start);
    const held = use.resources!;
    assert.ok(held, "held");
    assert.equal(held.list, undefined, "the list itself is as it was");
    assert.equal(resourcesUnsaved(held), false, "levels alone are not unsaved");
    const state = run(start, { t: "read", fill: f, lines: [], ticks }, { t: "use", sync: use }).state;
    assert.equal(state.draft.level, 5);
    const sent = resourcesSave(state.resources, { level: 5 });
    assert.deepEqual(sent.resources?.map((r) => [r.level, r.atLevel]), [[5, 5]]);
    assert.equal(sent.expect?.resources, expectHash(saved as never, "resources"));
    assert.deepEqual(levelUps(resourcesAfter(saved.resources, sent.resources!), 5), []);
    assert.deepEqual(resourcesSave(state.resources, {}), {}, "alone, nothing is sent");
  });

  test("an editor splice past 40 markers drops the oldest, and the line names what dropped (OP-21)", () => {
    const saved0 = savedBree();
    const rollMarkers = Array.from({ length: 40 }, (_, i) => `o:${i.toString(16).padStart(12, "0")}`);
    const rageId = saved0.resources![0]!.id;
    const saved: SyncCharacter = { ...saved0, resources: [], ddbSync: { ...saved0.ddbSync!, gone: rollMarkers } };
    const f: PcFill = { ...read([rageRead()]), read: { weapon: true, spell: true, other: false, resource: true } };
    const { plan, ticks } = review(saved, f, run(openFlow(openDraft(saved).draft), { t: "open", step: "ddb" }).state);
    const result = syncResult(plan, ticks);
    assert.equal(result.record.gone!.length, 40);
    assert.equal(result.record.gone!.at(-1), `r:${hash12("barbarian:rage")}`);
    assert.equal(goneDroppedLine(result.goneDropped), "A roll you deleted may come back on a later re-sync. Only 40 deleted rolls and class resources are remembered.");
    assert.ok(!Object.keys(result.record.res ?? {}).includes(hash12(rageId)));
  });
});
