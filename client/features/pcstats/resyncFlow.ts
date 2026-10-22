import type { CharacterExpect, CharacterPatch } from "#shared/protocol.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";

/**
 * The re-sync dialog as one state machine (docs/design-v1-resync.md 1.2
 * and 3), free of React so a randomized test runs it through many orders
 * of taps and answers (resyncFlow.test.ts). The dialog works out each
 * review and each op from the live character and hands them in, and runs
 * the effects that come back: fetch or abort a D&D Beyond request, send
 * Apply's or Undo's op, or close.
 *
 * One fetch at a time: a newer Get it, pasted JSON or closing aborts the
 * one in flight, and an answer that is not the latest request's changes
 * nothing. Apply sends one op and nothing more until its answer, and Undo
 * one, only after a taken Apply. Ticks change only by a tick, a bulk
 * button or a line going away, and nothing is sent or fetched once the
 * dialog closed.
 */

export type ResyncStep = "ddb" | "review" | "done" | "undone";

/** An op the dialog sends: always a patch with its `expect`. */
export type SyncOp = { patch: CharacterPatch; expect: CharacterExpect };

/** An Apply's or Undo's answer, sorted by what the dialog does with it (3.5). */
export type SyncAnswer = "taken" | "stale" | "refused" | "fast" | "unknown";

export type ResyncState = {
  step: ResyncStep;
  /** The D&D Beyond step shows its field once a fetch failed or the review went back to it. Before, it is the loading line alone. */
  field: boolean;
  /** The request in flight, by its number. */
  get: number | null;
  nextGet: number;
  /** Why the last Get it read nothing, in the step's words. */
  error: string | null;
  fill: PcFill | null;
  /** Where the read came from, for the review's Back. */
  from: "fetch" | "paste" | null;
  /** The review's lines, by id, as last built. */
  ids: readonly string[];
  ticks: ReadonlySet<string>;
  /** The status after another device changed the character: whether a tick went with a line. */
  live: { dropped: boolean } | null;
  /** What Apply sent while it waits for its answer. */
  applying: SyncOp | null;
  /** What Apply sent once it was taken, for Undo. */
  applied: SyncOp | null;
  /** The `at` the server wrote on Apply's record, from its answer. Undo expects that very record, so without it Undo is off (3.4). */
  appliedAt: string | null;
  undoing: boolean;
  /** The server refused Undo as stale: it stays off. */
  undoStale: boolean;
  /** Apply waits for the save budget to refill. */
  waiting: boolean;
  /** The last refusal's kind, for its words. */
  refused: { of: "apply" | "undo"; answer: Exclude<SyncAnswer, "taken">; message?: string } | null;
  closed: boolean;
};

export type ResyncEvent =
  /** The dialog opened: it fetches at once. */
  | { t: "open" }
  | { t: "get" }
  | { t: "got"; id: number; result: { fill: PcFill; ids: readonly string[]; ticks: ReadonlySet<string> } | { error: string } }
  /** Pasted JSON read, with its review's lines. */
  | { t: "read"; fill: PcFill; ids: readonly string[]; ticks: ReadonlySet<string> }
  | { t: "back" }
  | { t: "tick"; id: string }
  /** A bulk button's rows, ticked or unticked as one. */
  | { t: "bulk"; ticks: ReadonlySet<string> }
  /** The review rebuilt from the live character: the lines it now has. `changed` when another device changed the character. */
  | { t: "lines"; ids: readonly string[]; changed: boolean }
  /** Apply, with the op worked out from the review, or null when nothing would change, which is Done. */
  | { t: "apply"; op: SyncOp | null }
  | { t: "applied"; answer: SyncAnswer; message?: string; at?: string }
  | { t: "undo"; op: SyncOp }
  | { t: "undid"; answer: SyncAnswer; message?: string }
  /** The save budget refilled. */
  | { t: "refilled" }
  | { t: "close" };

export type ResyncEffect = { kind: "fetch"; id: number } | { kind: "abort"; id: number } | { kind: "send"; what: "apply" | "undo"; op: SyncOp } | { kind: "close" };

const NONE: ResyncEffect[] = [];

export function openResync(): ResyncState {
  return { step: "ddb", field: false, get: null, nextGet: 1, error: null, fill: null, from: null, ids: [], ticks: new Set(), live: null, applying: null, applied: null, appliedAt: null, undoing: false, undoStale: false, waiting: false, refused: null, closed: false };
}

function dropGet(state: ResyncState): { state: ResyncState; effects: ResyncEffect[] } {
  return state.get === null ? { state, effects: NONE } : { state: { ...state, get: null }, effects: [{ kind: "abort", id: state.get }] };
}

function startGet(state: ResyncState): { state: ResyncState; effects: ResyncEffect[] } {
  const dropped = dropGet(state);
  const id = state.nextGet;
  return { state: { ...dropped.state, get: id, nextGet: id + 1, error: null }, effects: [...dropped.effects, { kind: "fetch", id }] };
}

function review(state: ResyncState, fill: PcFill, ids: readonly string[], ticks: ReadonlySet<string>, from: "fetch" | "paste"): ResyncState {
  // A read clears the last fetch's refusal, so Back to the link never shows one the read since answered.
  return { ...state, step: "review", fill, from, ids, ticks: new Set([...ticks].filter((id) => ids.includes(id))), live: null, refused: null, error: null };
}

export function stepResync(state: ResyncState, event: ResyncEvent): { state: ResyncState; effects: ResyncEffect[] } {
  if (state.closed) return { state, effects: NONE };
  switch (event.t) {
    case "open":
      // Opened again before anything came back, as React's strict mode mounts twice: the newer fetch replaces the older.
      if (state.step !== "ddb" || state.fill || state.field) return { state, effects: NONE };
      return startGet(state);
    case "get":
      if (state.step !== "ddb") return { state, effects: NONE };
      return startGet({ ...state, field: true });
    case "got": {
      if (state.get !== event.id || state.step !== "ddb") return { state, effects: NONE };
      const result = event.result;
      if ("error" in result) return { state: { ...state, get: null, error: result.error, field: true }, effects: NONE };
      return { state: review({ ...state, get: null }, result.fill, result.ids, result.ticks, "fetch"), effects: NONE };
    }
    case "read": {
      if (state.step !== "ddb") return { state, effects: NONE };
      // Pasted JSON read while a fetch waits: the paste wins, and the request goes.
      const dropped = dropGet(state);
      return { state: review(dropped.state, event.fill, event.ids, event.ticks, "paste"), effects: dropped.effects };
    }
    case "back":
      if (state.step !== "review" || state.applying) return { state, effects: NONE };
      return { state: { ...state, step: "ddb", field: true, fill: null, from: null, ids: [], ticks: new Set(), live: null, refused: null }, effects: NONE };
    case "tick": {
      if (state.step !== "review" || state.applying || !state.ids.includes(event.id)) return { state, effects: NONE };
      const ticks = new Set(state.ticks);
      if (ticks.has(event.id)) ticks.delete(event.id);
      else ticks.add(event.id);
      return { state: { ...state, ticks }, effects: NONE };
    }
    case "bulk":
      if (state.step !== "review" || state.applying) return { state, effects: NONE };
      return { state: { ...state, ticks: new Set([...event.ticks].filter((id) => state.ids.includes(id))) }, effects: NONE };
    case "lines": {
      // While Apply waits the review holds still, so what it sent is what it shows.
      if (state.step !== "review" || state.applying) return { state, effects: NONE };
      const ticks = new Set([...state.ticks].filter((id) => event.ids.includes(id)));
      const dropped = ticks.size < state.ticks.size || (state.live?.dropped ?? false);
      return { state: { ...state, ids: event.ids, ticks, live: event.changed ? { dropped } : state.live }, effects: NONE };
    }
    case "apply":
      if (state.step !== "review" || state.applying || state.waiting) return { state, effects: NONE };
      if (event.op === null) return { state: { ...state, closed: true }, effects: [{ kind: "close" }] };
      return { state: { ...state, applying: event.op, refused: null }, effects: [{ kind: "send", what: "apply", op: event.op }] };
    case "applied": {
      if (!state.applying) return { state, effects: NONE };
      if (event.answer === "taken") return { state: { ...state, applying: null, applied: state.applying, appliedAt: event.at ?? null, step: "done", refused: null }, effects: NONE };
      // A refusal or a lost answer leaves the review and its ticks, for the player to act on.
      return { state: { ...state, applying: null, waiting: event.answer === "fast", refused: { of: "apply", answer: event.answer, ...(event.message ? { message: event.message } : {}) } }, effects: NONE };
    }
    case "undo":
      if (state.step !== "done" || state.undoing || state.undoStale || state.applied === null) return { state, effects: NONE };
      return { state: { ...state, undoing: true, refused: null }, effects: [{ kind: "send", what: "undo", op: event.op }] };
    case "undid":
      if (!state.undoing) return { state, effects: NONE };
      if (event.answer === "taken") return { state: { ...state, undoing: false, step: "undone", refused: null }, effects: NONE };
      return { state: { ...state, undoing: false, undoStale: event.answer === "stale", refused: { of: "undo", answer: event.answer, ...(event.message ? { message: event.message } : {}) } }, effects: NONE };
    case "refilled":
      return { state: { ...state, waiting: false }, effects: NONE };
    case "close": {
      const dropped = dropGet(state);
      return { state: { ...dropped.state, closed: true }, effects: [...dropped.effects, { kind: "close" }] };
    }
  }
}
