import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { dispatchGesture } from "../../state/actions.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { OpAnswer } from "../../state/types.ts";
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
  /** A fight started with "Roll monsters' Initiative" on, waiting for the server to take it before the monsters roll. */
  start: StartWait | null;
  /** The storage key "Roll monsters' Initiative" was read from, or null before the first read, and its value. */
  startKey: string | null;
  startOn: boolean;
};

// Per Room page, so the card survives the tracker sheet closing and "view as a player" never sees it.
const autoSlot = scopeSlot(() => createStore<AutoState>(() => ({ key: null, mode: DEFAULT_ROLL_MODE, last: null, start: null, startKey: null, startOn: true })));

function readMode(key: string): RollMode {
  try {
    return decodePrefs(localStorage.getItem(key)).mode;
  } catch {
    // Storage blocked: the default for this page load.
    return DEFAULT_ROLL_MODE;
  }
}

/** The sharing mode as the tracker shows it now, for a roll that starts outside render: the store's, else storage's for the room. */
export function modeIn(state: Pick<AutoState, "key" | "mode">, roomId: string): RollMode {
  const key = prefsKey(roomId);
  return state.key === key ? state.mode : readMode(key);
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

// ---------------------------------------------------------------- rolling as the fight starts

/**
 * "Roll monsters' Initiative" under the start buttons
 * (docs/design/design-v1-qol.md 3, Q12, D-261106-112 and 177): on unless this
 * device turned it off for the room. Kept beside the sharing mode, on this
 * device only, never in the room.
 */
export function startRollKey(roomId: string): string {
  return `rvtt.autoInitiativeStart.${roomId}`;
}

export function parseStartRoll(raw: string | null): boolean {
  return raw !== "off";
}

function readStartRoll(key: string): boolean {
  try {
    return parseStartRoll(localStorage.getItem(key));
  } catch {
    // Storage blocked: on, the default, for this page load.
    return true;
  }
}

export function useStartRoll(): { on: boolean; setOn(on: boolean): void } {
  const store = useScoped(autoSlot);
  const roomId = useRoomView((s) => s.roomId);
  const key = startRollKey(roomId);
  const state = useStore(store);
  // As the mode: storage once per room, and meanwhile straight from it.
  const on = state.startKey === key ? state.startOn : readStartRoll(key);
  useEffect(() => {
    if (store.getState().startKey !== key) store.setState({ startKey: key, startOn: readStartRoll(key) });
  }, [store, key]);
  const setOn = (next: boolean) => {
    store.setState({ startKey: key, startOn: next });
    try {
      localStorage.setItem(key, next ? "on" : "off");
    } catch {
      // As above: the choice lasts until the page closes.
    }
  };
  return { on, setOn };
}

/** The start button pressed: the selected token, everyone here or those visible to players. */
export type StartFrom = "selected" | "scene" | "visible";

/**
 * A start that rolls once the server takes it (D-261106-118): its press,
 * the button, how many ops it sent (`encounter.start`, then each
 * `encounter.add` batch, one gesture) and which of them were taken, by
 * their place in the start.
 */
export type StartWait = { press: string; from: StartFrom; ops: number; taken: readonly number[] };

export type StartEvent =
  | { kind: "press"; press: string; from: StartFrom; ops: number }
  /** What became of the start's op at `index`. A dispatch that sent nothing counts as refused. */
  | { kind: "answer"; press: string; index: number; answer: OpAnswer };

/**
 * One step of the start's wait: what it becomes, and whether the monsters
 * roll now. A press while one waits is refused, so each press rolls at
 * most once. Every op taken rolls. Any other answer ends the wait with no
 * roll, and the refusal shows as it does today. An answer for a press
 * that no longer waits changes nothing.
 */
export function startStep(wait: StartWait | null, event: StartEvent): { wait: StartWait | null; roll: boolean } {
  if (event.kind === "press") {
    if (wait !== null) return { wait, roll: false };
    return { wait: event.ops > 0 ? { press: event.press, from: event.from, ops: event.ops, taken: [] } : null, roll: false };
  }
  if (wait === null || wait.press !== event.press || event.index < 0 || event.index >= wait.ops || wait.taken.includes(event.index)) return { wait, roll: false };
  if (event.answer !== "taken") return { wait: null, roll: false };
  const taken = [...wait.taken, event.index];
  return taken.length === wait.ops ? { wait: null, roll: true } : { wait: { ...wait, taken }, roll: false };
}

/** The auto state's store, for the start, which steps its wait from the ops' answers wherever the DM is. */
export function useAutoStore(): StoreApi<AutoState> {
  return useScoped(autoSlot);
}

/** The button a start that waits to roll was pressed on, or null. */
export function useStartWaiting(): StartFrom | null {
  return useStore(useScoped(autoSlot), (s) => s.start?.from ?? null);
}

const NO_OPS: readonly number[] = [];

/**
 * Whether the last roll is still on its way: its dice, or the ops that set
 * its totals, and from a start's press until its roll goes. Every roll
 * button waits on it.
 */
export function useRollBusy(): boolean {
  const last = useStore(useScoped(autoSlot), (s) => s.last);
  const starting = useStore(useScoped(autoSlot), (s) => s.start !== null);
  const pending = useAnyPending(last?.sent ?? NO_OPS);
  return starting || (last !== null && (!last.done || pending));
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
