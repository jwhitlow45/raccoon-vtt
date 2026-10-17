import type { FillMerge, PcFill } from "#shared/rules/pcFill.ts";
import { mergeFill } from "#shared/rules/pcFill.ts";
import type { PcDraft } from "./draft.ts";
import { alsoSet, type AlsoKey, type AlsoLine, type AlsoSet } from "./fill.ts";

/**
 * The stat block editor's steps and its Save as one state machine
 * (docs/design-v1-pc-stats.md 7.2), free of React so a randomized test can
 * run it through many orders of taps and answers (flow.test.ts). The
 * editor's own fields change the draft through `edit`, a fill's "Use it"
 * through `use`, and nothing else does. A Save sends one op and nothing
 * more until its answer, and nothing is sent once the editor closed.
 *
 * `step` returns the next state and the effects the editor runs: send the
 * Save's op, or close.
 */

export type Step = "block" | "paste" | "ddb" | "review";

/** A fill being looked over: what it read, what it does to the block, and the other fields it sets, ticked or not. */
export type Review = { fill: PcFill; merge: FillMerge; lines: AlsoLine[]; from: "paste" | "ddb" };

export type FlowState = {
  step: Step;
  draft: PcDraft;
  /** The fields beside the block the last "Use it" set, sent with the next Save. */
  also: AlsoSet;
  review: Review | null;
  /** A Save's op waits for its answer. */
  saving: boolean;
  closed: boolean;
};

export type FlowEvent =
  | { t: "edit"; update(draft: PcDraft): PcDraft }
  | { t: "open"; step: "paste" | "ddb" }
  | { t: "back" }
  /** A fill read, with its review's lines worked out against the character as it is now. */
  | { t: "read"; fill: PcFill; lines: AlsoLine[] }
  | { t: "toggle"; key: AlsoKey }
  | { t: "use" }
  | { t: "save" }
  | { t: "saved"; answer: "taken" | "refused" | "unknown" }
  | { t: "close" };

export type FlowEffect = { kind: "send" } | { kind: "close" };

export function openFlow(draft: PcDraft): FlowState {
  return { step: "block", draft, also: {}, review: null, saving: false, closed: false };
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
      return { state: { ...state, step: event.step }, effects: NONE };
    case "back":
      if (state.step === "review") return { state: { ...state, step: state.review?.from ?? "block", review: null }, effects: NONE };
      return { state: { ...state, step: "block" }, effects: NONE };
    case "read": {
      if (state.step !== "paste" && state.step !== "ddb") return { state, effects: NONE };
      const merge = mergeFill(state.draft.stats, event.fill);
      return { state: { ...state, step: "review", review: { fill: event.fill, merge, lines: event.lines, from: state.step } }, effects: NONE };
    }
    case "toggle": {
      const review = state.review;
      if (!review || state.step !== "review") return { state, effects: NONE };
      const lines = review.lines.map((l) => (l.key === event.key ? { ...l, on: !l.on } : l));
      return { state: { ...state, review: { ...review, lines } }, effects: NONE };
    }
    case "use": {
      const review = state.review;
      if (!review || state.step !== "review" || state.saving) return { state, effects: NONE };
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
    case "close":
      return { state: { ...state, closed: true }, effects: [{ kind: "close" }] };
  }
}
