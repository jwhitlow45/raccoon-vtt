import { useEffect, useState } from "react";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";

export const DISCARD = "Discard changes?";

/**
 * Leaving a dialog with changes asks first, as the new character form does:
 * the first Cancel, Escape or backdrop tap turns Cancel into "Discard
 * changes?" and the next leaves, while the dialog's status line asks it
 * aloud (DiscardQuestion), since a second Escape must never discard unheard.
 * Any edit in between disarms it. The swipe
 * that closes a phone sheet springs back while changes are unsaved.
 * `edits` are the draft's parts, each compared by identity.
 */
export function useDiscard(dirty: boolean, close: () => void, ...edits: readonly unknown[]): { armed: boolean; leave(): void } {
  const [armed, setArmed] = useState(false);
  useUnsavedInput(dirty);
  // Each edit is a dependency of its own: a list built per render would disarm it on the render that armed it.
  useEffect(() => setArmed(false), edits);
  return {
    armed,
    leave() {
      if (dirty && !armed) setArmed(true);
      else close();
    },
  };
}
