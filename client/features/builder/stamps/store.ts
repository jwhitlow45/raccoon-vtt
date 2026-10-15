import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import { browserClickWait, type ClickWait } from "./afterClick.ts";
import type { ChosenArt, Point, StampPose } from "./rules.ts";

/**
 * The Stamp mode's choices and its gesture in progress, local to this
 * device. Stamps themselves only change through ops: the board draws a
 * stamp being moved, turned or resized from `preview` until the op goes out.
 */
export type StampState = {
  /** What a tap on empty map places. */
  chosen: ChosenArt | null;
  /** The stamp whose handles and options show. */
  selectedId: string | null;
  /** The selected stamp where the gesture in progress has it. */
  preview: { id: string; pose: StampPose } | null;
  /** Turns snap to 15 degrees and moves to half cells. Off, both follow the pointer. */
  snap: boolean;
  pickerOpen: boolean;
};

/** A gesture's bookkeeping that nothing draws. `grab` is where on the stamp the press landed. */
export type StampGesture = {
  kind: "place" | "move" | "rotate" | "resize";
  id: string | null;
  sceneId: string;
  start: StampPose | null;
  grab: Point;
  downAt: Point;
};

/**
 * One Room page's Stamp mode (client/state/scope.ts). `openingPicker` calls
 * off a picker that a tap will open once its click has gone by (afterClick.ts).
 */
export const stampSlot = scopeSlot(
  () => ({
    store: createStore<StampState>(() => ({ chosen: null, selectedId: null, preview: null, snap: true, pickerOpen: false })),
    gesture: null as StampGesture | null,
    openingPicker: null as (() => void) | null,
    clickWait: browserClickWait as ClickWait,
  }),
  (slot) => slot.openingPicker?.(),
);

export function useStampStore(): StoreApi<StampState> {
  return useScoped(stampSlot).store;
}
