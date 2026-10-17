import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { dispatchGesture } from "../../state/actions.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { useReceipts } from "../dice/useReceipt.ts";
import { DEFAULT_ROLL_MODE, decodePrefs, encodePrefs, prefsKey, rollStillShown, settleRoll, type RollMode, type RollPress } from "./autoRoll.ts";
import { useAnyPending } from "./hooks.ts";

/**
 * The DM's auto initiative state on this device: the remembered mode and
 * the last roll. It lives apart from AutoInitiative.tsx so the initiative
 * strip, which is always on screen, can set a roll's totals when its dice
 * land and clear a stale roll without loading the tracker's code.
 */

/** A roll the card shows, with the numbers of the ops that set its totals. */
export type ShownRoll = RollPress & { sent: readonly number[] };

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

/** Whether the last roll is still on its way: its dice, or the ops that set its totals. Every roll button waits on it. */
export function useRollBusy(): boolean {
  const last = useStore(useScoped(autoSlot), (s) => s.last);
  const pending = useAnyPending(last?.sent ?? NO_OPS);
  return last !== null && (!last.done || pending);
}

/**
 * The last roll while it still describes the fight, else null. A stale roll
 * is cleared, not only hidden, so it never comes back, for example when a
 * redo or a typed value happens to restore its totals. A roll cleared while
 * its dice are on their way never sets them, since its fight is over.
 */
export function useShownRoll(): { store: StoreApi<AutoState>; roll: ShownRoll | null } {
  const store = useScoped(autoSlot);
  const last = useStore(store, (s) => s.last);
  // Until the first snapshot there is no fight to compare with, so nothing is judged.
  const loaded = useRoomView((s) => s.view !== null);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const pending = useAnyPending(last?.sent ?? NO_OPS);
  const waiting = last !== null && (!last.done || pending);
  const shown = last !== null && (!loaded || rollStillShown(last, encounter, waiting));
  useEffect(() => {
    // Only the roll judged here: a newer one may have replaced it since this render.
    if (last !== null && !shown && store.getState().last === last) store.setState({ last: null });
  }, [store, last, shown]);
  return { store, roll: shown ? last : null };
}

/**
 * Sets a roll's totals once its dice land (settleRoll), wherever the DM is,
 * so closing the tracker never loses them. It reads the receipt without
 * watching it: while the card is not on screen, the receipt's own toast
 * tells the DM how the roll went.
 */
function useLanding(): void {
  const store = useScoped(autoSlot);
  const last = useStore(store, (s) => s.last);
  const tracker = useReceipts();
  const version = useSyncExternalStore(tracker.subscribe, tracker.version);
  const room = useRoomStore();
  const actions = useRoomActions();
  // Read again once a fight is in view, for a roll whose answer came while the view was being replaced.
  const fight = useRoomView((s) => s.view?.encounter != null);
  useEffect(() => {
    if (!last || last.done) return;
    const entries = room.getState().view?.encounter?.entries;
    if (!entries) return;
    const settled = settleRoll(last, last.tag === null ? null : tracker.state(last.tag), entries);
    // A newer roll or a dismissal since this render owns the slot now.
    if (!settled || store.getState().last !== last) return;
    const sent = settled.ops.length > 0 ? dispatchGesture(actions, settled.ops) : NO_OPS;
    store.setState({ last: { ...settled.press, sent } });
  }, [store, last, tracker, version, room, actions, fight]);
}

/**
 * Sets landed totals and clears a stale roll while the tracker is closed
 * too, so the totals always arrive and the card never reappears in a later
 * fight. The initiative strip renders it for the DM.
 */
export function AutoRollWatch(): null {
  useLanding();
  useShownRoll();
  return null;
}
