import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { DEFAULT_ROLL_MODE, decodePrefs, encodePrefs, prefsKey, rollStillShown, type RollMode, type RollResult } from "./autoRoll.ts";
import { useAnyPending } from "./hooks.ts";

/**
 * The DM's auto initiative state on this device: the remembered mode and
 * the last roll. It lives apart from AutoInitiative.tsx so the initiative
 * strip, which is always on screen, can clear a stale roll without loading
 * the tracker's code.
 */

/** A roll the card shows, with the numbers of the ops that sent it. */
export type ShownRoll = RollResult & { sent: readonly number[] };

export type AutoState = {
  /** The storage key the mode below was read from, or null before the first read. */
  key: string | null;
  mode: RollMode;
  /** The latest roll, until the DM dismisses it or it no longer describes the fight (rollStillShown). */
  last: ShownRoll | null;
};

// Per Room page, so the card survives the tracker sheet closing and "view as a player" never sees it.
const autoSlot = scopeSlot(() => createStore<AutoState>(() => ({ key: null, mode: DEFAULT_ROLL_MODE, last: null })));

function readMode(key: string): RollMode {
  try {
    return decodePrefs(localStorage.getItem(key)).mode;
  } catch {
    // Storage blocked: the default for this page load.
    return DEFAULT_ROLL_MODE;
  }
}

export function useAuto(): { store: StoreApi<AutoState>; mode: RollMode; setMode(mode: RollMode): void } {
  const store = useScoped(autoSlot);
  const roomId = useRoomView((s) => s.roomId);
  const key = prefsKey(roomId);
  const state = useStore(store);
  // Reads storage once per room, and meanwhile answers from it directly so the first frame already shows the remembered mode.
  const mode = state.key === key ? state.mode : readMode(key);
  useEffect(() => {
    if (store.getState().key !== key) store.setState({ key, mode: readMode(key) });
  }, [store, key]);
  const setMode = (next: RollMode) => {
    store.setState({ key, mode: next });
    try {
      localStorage.setItem(key, encodePrefs({ mode: next }));
    } catch {
      // As above: the choice lasts until the page closes.
    }
  };
  return { store, mode, setMode };
}

const NO_OPS: readonly number[] = [];

/**
 * The last roll while it still describes the fight, else null. A stale roll
 * is cleared, not only hidden, so it never comes back, for example when a
 * redo or a typed value happens to restore its totals.
 */
export function useShownRoll(): { store: StoreApi<AutoState>; roll: ShownRoll | null } {
  const store = useScoped(autoSlot);
  const last = useStore(store, (s) => s.last);
  // Until the first snapshot there is no fight to compare with, so nothing is judged.
  const loaded = useRoomView((s) => s.view !== null);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const waiting = useAnyPending(last?.sent ?? NO_OPS);
  const shown = last !== null && (!loaded || rollStillShown(last, encounter, waiting));
  useEffect(() => {
    // Only the roll judged here: a newer one may have replaced it since this render.
    if (last !== null && !shown && store.getState().last === last) store.setState({ last: null });
  }, [store, last, shown]);
  return { store, roll: shown ? last : null };
}

/**
 * Clears a stale roll while the tracker is closed too, so its card never
 * reappears in a later fight. The initiative strip renders it for the DM.
 */
export function AutoRollWatch(): null {
  useShownRoll();
  return null;
}
