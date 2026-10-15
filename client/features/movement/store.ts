import { createStore } from "zustand/vanilla";
import type { Blocker } from "#shared/ruleHooks.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { Point } from "./drop.ts";
import type { StopNote } from "./teleport.ts";

/**
 * A lone token's drag held at a wall or a ledge (docs/design-v1-maps-vision.md
 * 4.1): the spot the preview stays on and what is in the way. The canvas
 * writes it only when it changes, never on every pointer frame, and the
 * movement layer draws the red outline and the label from it.
 */
export type Hold = { tokenId: string; at: Point; blocker: Blocker };

export const holdSlot = scopeSlot(() => createStore<{ hold: Hold | null }>(() => ({ hold: null })));

export function sameHold(a: Hold | null, b: Hold | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tokenId === b.tokenId && a.at.x === b.at.x && a.at.y === b.at.y && a.blocker === b.blocker;
}

/**
 * The note after a stopped drop, with its ghost and "Teleport here", and
 * whether the teleport is on its way (the button then reads
 * "Teleporting…" and ignores another tap).
 */
export type NoteState = { note: StopNote | null; busy: boolean };

export const stopNoteSlot = scopeSlot(() => createStore<NoteState>(() => ({ note: null, busy: false })));
