import type { OpAnswer, OpRefusal } from "../../state/types.ts";

/**
 * A draft with a Save in flight, for the journal editor and the pin pane,
 * which both close only once the server has taken what they sent (draft.ts
 * saveAnswer, pins/rules.ts pinSaveAnswer).
 *
 * While the save is pending the draft is locked: an edit then would be lost
 * when the acknowledgment closes the dialog, since the op carries the draft
 * as it was at Save (W5-ASTRA-05). So every edit goes through `editDraft`,
 * which refuses one while pending, and the controls show as disabled too. A
 * refusal, or an answer lost with the connection, unlocks the same draft for
 * another try. Closing stays possible: it never takes back the save sent.
 */

export type SaveState<D> = {
  draft: D;
  /** A save was sent and the server has not answered. */
  pending: boolean;
  /** Why the last save did not go through. */
  failure: string | null;
};

export function saveState<D>(draft: D): SaveState<D> {
  return { draft, pending: false, failure: null };
}

/** The state after an edit, or the same state when a save is pending and the edit is refused. */
export function editDraft<D>(state: SaveState<D>, change: (draft: D) => D): SaveState<D> {
  return state.pending ? state : { ...state, draft: change(state.draft) };
}

/** A save went out: the draft locks until the server answers. */
export function saveSent<D>(state: SaveState<D>): SaveState<D> {
  return { ...state, pending: true, failure: null };
}

/** A save could not even be sent: the draft stays open with why. */
export function saveNotSent<D>(state: SaveState<D>, problem: string): SaveState<D> {
  return { ...state, pending: false, failure: problem };
}

/**
 * The server answered. Taken closes with the draft as it was sent, which
 * nothing could change meanwhile. Anything else unlocks it with the reason.
 */
export function saveAnswered<D>(state: SaveState<D>, outcome: { kind: "kept"; problem: string } | { kind: "saved" | "closed" }): { state: SaveState<D>; close: boolean } {
  if (outcome.kind !== "kept") return { state: { ...state, pending: false }, close: true };
  return { state: { ...state, pending: false, failure: outcome.problem }, close: false };
}

/**
 * What closing says while a save is pending. The op is queued, and the
 * store sends it again after a reconnect, so the save goes on whatever the
 * dialog does: closing takes nothing back, and a Discard would promise what
 * it cannot do.
 */
export function pendingCloseText(what: "page" | "pin", connected: boolean): string {
  return connected ? `The ${what} is still saving.` : `The ${what} will save when the connection is back.`;
}

/**
 * What a save that was left pending says when its answer comes after the
 * dialog closed, in a toast: nothing when it went through, and otherwise
 * that it did not, since the draft that would have shown why is gone.
 */
export function closedAnswerText(what: "page" | "pin", answer: OpAnswer, refusal?: OpRefusal): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so the ${what} may not be saved.`;
  return refusal ? `The ${what} was not saved. ${refusal.text.replace(/^Not saved\.\s*/, "")}`.trim() : `The ${what} was not saved.`;
}
