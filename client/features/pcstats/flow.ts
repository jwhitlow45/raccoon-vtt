import type { Character, PcStats } from "#shared/model.ts";
import type { DdbSyncPatch } from "#shared/protocol.ts";
import type { FillMerge, PcFill } from "#shared/rules/pcFill.ts";
import { mergeFill } from "#shared/rules/pcFill.ts";
import { planSync, sameRecord, type SyncPlan, type SyncResult } from "#shared/rules/pcSync.ts";
import { draftDirty, type PcDraft } from "./draft.ts";
import { alsoSet, pendingCharacter, type AlsoKey, type AlsoLine, type AlsoSet } from "./fill.ts";

/**
 * The stat block editor's steps and its Save as one state machine
 * (docs/design-v1-pc-stats.md 7.2), free of React so a randomized test can
 * run it through many orders of taps and answers (flow.test.ts). The
 * editor's own fields change the draft through `edit`, a fill's "Use it"
 * through `use`, and nothing else does. A Save sends one op and nothing
 * more until its answer, and nothing is sent once the editor closed.
 *
 * D&D Beyond's "Get it" is one request at a time: a newer Get it, Back or
 * closing aborts the one in flight, and an answer that is not the latest
 * request's changes nothing.
 *
 * A D&D Beyond read is reviewed as a re-sync is (docs/design-v1-resync.md
 * 1.1): its ticks are the review's line ids, and its "Use it" carries the
 * block, the fields beside it and the sync record the editor worked out
 * from the draft as it is then, so Save sends the record with the block.
 * A later read before Save is reviewed against what the earlier one took
 * (`editorSyncPlan`), and its record replaces the earlier one.
 *
 * `step` returns the next state and the effects the editor runs: send the
 * Save's op, fetch or abort a D&D Beyond request, or close.
 */

export type Step = "block" | "paste" | "ddb" | "review";

/**
 * A fill being looked over: what it read, what it does to the block, and
 * the other fields it sets, ticked or not. A D&D Beyond read has `ticks`,
 * the re-sync review's, in place of `merge` and `lines`, which stay empty.
 */
export type Review = { fill: PcFill; merge?: FillMerge; lines: AlsoLine[]; from: "paste" | "ddb"; ticks?: ReadonlySet<string> };

/**
 * What a D&D Beyond review's Use it sets: the merged block and level, the
 * fields beside it, and the record Save sends, null when it equals the
 * saved one. Either way it replaces the record an earlier Use it made, so
 * a record equal to the saved one drops that earlier record.
 */
export type SyncUse = { stats: PcStats; level: number | undefined; also: AlsoSet; record: DdbSyncPatch | null };

/**
 * A D&D Beyond read in the editor, planned as a re-sync against the
 * character as Save would leave it: the draft, the fields earlier fills set
 * beside it and their record. With no block yet and nothing typed, a first
 * sync, which takes everything read.
 */
export function editorSyncPlan(
  fill: PcFill,
  state: Pick<FlowState, "draft" | "also" | "record">,
  opened: { draft: PcDraft; had: boolean },
  saved: Pick<Character, "name" | "actor" | "ddbSync">,
): SyncPlan {
  const block = opened.had || draftDirty(opened.draft, state.draft) ? state.draft.stats : undefined;
  return planSync({ mode: "editor", stats: block, level: state.draft.level, character: pendingCharacter(saved, state.also, state.record), fill });
}

/** A review's Use it, with its record compared with the saved one (`SyncUse`). */
export function editorSyncUse(result: SyncResult, saved: Pick<Character, "ddbSync"> | undefined): SyncUse {
  const record = saved && sameRecord(result.record, saved.ddbSync) ? null : result.record;
  return { stats: result.stats, level: result.level, also: result.also, record };
}

export type FlowState = {
  step: Step;
  draft: PcDraft;
  /** The fields beside the block the last "Use it" set, sent with the next Save. */
  also: AlsoSet;
  /** The sync record a D&D Beyond "Use it" made, sent with the next Save (docs/design-v1-resync.md 1.1). */
  record: DdbSyncPatch | null;
  review: Review | null;
  /** A Save's op waits for its answer. */
  saving: boolean;
  closed: boolean;
  /** The D&D Beyond request in flight, by its number. */
  get: number | null;
  nextGet: number;
  /** Why the last Get it read nothing, in the step's words. */
  error: string | null;
};

export type FlowEvent =
  | { t: "edit"; update(draft: PcDraft): PcDraft }
  | { t: "open"; step: "paste" | "ddb" }
  | { t: "back" }
  /** A fill read, with its review's lines worked out against the character as it is now, and a D&D Beyond read's ticks. */
  | { t: "read"; fill: PcFill; lines: AlsoLine[]; ticks?: ReadonlySet<string> }
  | { t: "toggle"; key: AlsoKey }
  /** A D&D Beyond review's tick, or a bulk button's ticks. */
  | { t: "tick"; id: string }
  | { t: "ticks"; ticks: ReadonlySet<string> }
  /** Use it. A D&D Beyond review's carries what it sets. */
  | { t: "use"; sync?: SyncUse }
  | { t: "save" }
  | { t: "saved"; answer: "taken" | "refused" | "unknown" }
  | { t: "close" }
  | { t: "get" }
  /** A D&D Beyond request's answer: its fill and lines, or why it read nothing. */
  | { t: "got"; id: number; result: { fill: PcFill; lines: AlsoLine[]; ticks?: ReadonlySet<string> } | { error: string } };

export type FlowEffect = { kind: "send" } | { kind: "close" } | { kind: "fetch"; id: number } | { kind: "abort"; id: number };

export function openFlow(draft: PcDraft): FlowState {
  return { step: "block", draft, also: {}, record: null, review: null, saving: false, closed: false, get: null, nextGet: 1, error: null };
}

/** The request in flight, aborted, for a step that leaves it behind. */
function dropGet(state: FlowState): { state: FlowState; effects: FlowEffect[] } {
  return state.get === null ? { state, effects: NONE } : { state: { ...state, get: null }, effects: [{ kind: "abort", id: state.get }] };
}

const NONE: FlowEffect[] = [];

export function stepFlow(state: FlowState, event: FlowEvent): { state: FlowState; effects: FlowEffect[] } {
  if (state.closed) return { state, effects: NONE };
  switch (event.t) {
    case "edit":
      // While a Save waits, the draft it sent is the draft: the fields hold still until its answer.
      if (state.saving) return { state, effects: NONE };
      return { state: { ...state, draft: event.update(state.draft) }, effects: NONE };
    case "open":
      return { state: { ...state, step: event.step, error: null }, effects: NONE };
    case "back": {
      if (state.step === "review") return { state: { ...state, step: state.review?.from ?? "block", review: null }, effects: NONE };
      const dropped = dropGet(state);
      return { state: { ...dropped.state, step: "block", error: null }, effects: dropped.effects };
    }
    case "get": {
      if (state.step !== "ddb") return { state, effects: NONE };
      const dropped = dropGet(state);
      const id = state.nextGet;
      return { state: { ...dropped.state, get: id, nextGet: id + 1, error: null }, effects: [...dropped.effects, { kind: "fetch", id }] };
    }
    case "got": {
      // A stale or aborted request's answer changes nothing.
      if (state.get !== event.id || state.step !== "ddb") return { state, effects: NONE };
      const result = event.result;
      if ("error" in result) return { state: { ...state, get: null, error: result.error }, effects: NONE };
      const reviewed = result.ticks ? { ticks: result.ticks } : { merge: mergeFill(state.draft.stats, result.fill) };
      return { state: { ...state, get: null, step: "review", review: { fill: result.fill, lines: result.lines, from: "ddb", ...reviewed } }, effects: NONE };
    }
    case "read": {
      if (state.step !== "paste" && state.step !== "ddb") return { state, effects: NONE };
      // Pasted JSON read while a Get it waits: the paste wins, and the request goes.
      const dropped = dropGet(state);
      const reviewed = event.ticks ? { ticks: event.ticks } : { merge: mergeFill(state.draft.stats, event.fill) };
      return { state: { ...dropped.state, step: "review", review: { fill: event.fill, lines: event.lines, from: state.step, ...reviewed } }, effects: dropped.effects };
    }
    case "toggle": {
      const review = state.review;
      if (!review || state.step !== "review") return { state, effects: NONE };
      const lines = review.lines.map((l) => (l.key === event.key ? { ...l, on: !l.on } : l));
      return { state: { ...state, review: { ...review, lines } }, effects: NONE };
    }
    case "tick": {
      const review = state.review;
      if (!review?.ticks || state.step !== "review") return { state, effects: NONE };
      const ticks = new Set(review.ticks);
      if (ticks.has(event.id)) ticks.delete(event.id);
      else ticks.add(event.id);
      return { state: { ...state, review: { ...review, ticks } }, effects: NONE };
    }
    case "ticks": {
      const review = state.review;
      if (!review?.ticks || state.step !== "review") return { state, effects: NONE };
      return { state: { ...state, review: { ...review, ticks: event.ticks } }, effects: NONE };
    }
    case "use": {
      const review = state.review;
      if (!review || state.step !== "review" || state.saving) return { state, effects: NONE };
      if (review.ticks) {
        // A D&D Beyond review: the editor merged it from the draft as it is now, so it never undoes an edit made since it was read.
        const sync = event.sync;
        if (!sync) return { state, effects: NONE };
        const draft: PcDraft = { stats: sync.stats, level: sync.level };
        return { state: { ...state, step: "block", review: null, draft, also: { ...state.also, ...sync.also }, record: sync.record }, effects: NONE };
      }
      const also = { ...state.also, ...alsoSet(review.fill, review.lines) };
      // The block is merged again from the draft as it is now, so the review never undoes an edit made since it was read.
      const merged = mergeFill(state.draft.stats, review.fill).stats;
      const draft: PcDraft = { stats: merged, level: also.level ?? state.draft.level };
      return { state: { ...state, step: "block", review: null, draft, also }, effects: NONE };
    }
    case "save":
      if (state.saving || state.step !== "block") return { state, effects: NONE };
      return { state: { ...state, saving: true }, effects: [{ kind: "send" }] };
    case "saved":
      if (!state.saving) return { state, effects: NONE };
      if (event.answer === "taken") return { state: { ...state, saving: false, closed: true }, effects: [{ kind: "close" }] };
      // A refusal, or a lost answer, leaves the draft as it was, for the player to act on.
      return { state: { ...state, saving: false }, effects: NONE };
    case "close": {
      const dropped = dropGet(state);
      return { state: { ...dropped.state, closed: true }, effects: [...dropped.effects, { kind: "close" }] };
    }
  }
}
