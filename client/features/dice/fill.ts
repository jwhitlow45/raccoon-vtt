import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/*
 * A formula another surface puts in the Dice panel's field without rolling
 * it: the room search's Shift+Enter on a dice row (designs/qol/search.md
 * 5.5). Kept apart from Roller.tsx, which loads with the panel, so the
 * search asks without loading the panel's code.
 */

/** The newest formula asked for, `seq` telling one ask from the next, and the last one the field took. */
export type DiceFill = { readonly text: string; readonly seq: number; readonly taken: number };

/** Per Room page (state/scope.ts), as the panel's own state is. */
export const diceFillSlot = scopeSlot<StoreApi<DiceFill>>(() => createStore<DiceFill>(() => ({ text: "", seq: 0, taken: 0 })));

/** Asks the Dice panel's field to hold `text`, once, whether the panel is drawn now or draws later. */
export function fillDiceField(scope: RoomScope, text: string): void {
  const store = scope.get(diceFillSlot);
  store.setState((s) => ({ text, seq: s.seq + 1 }));
}

/** The formula the field has yet to take, marked taken, or null when it took the newest. */
export function takeDiceFill(store: StoreApi<DiceFill>): string | null {
  const { text, seq, taken } = store.getState();
  if (seq === taken) return null;
  store.setState({ taken: seq });
  return text;
}
