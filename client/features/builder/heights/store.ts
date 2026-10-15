import { createStore, type StoreApi } from "zustand/vanilla";
import type { StairDirection } from "#shared/model.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { BrushSize, Point } from "../cells.ts";

/**
 * Height mode's choices and its gesture in progress (docs/design-v1-maps-vision.md
 * section 4.2), local to this device. Heights and stairs only change
 * through ops: the overlay draws the unsent part of a stroke and the
 * dragged area from here, so they show under the finger before the op goes.
 */

/** What a stroke paints: a height on cells, or stair marks. */
export type HeightPaint = "height" | "stairs";
/** A brush of 1 to 3 cells, or an area dragged from corner to corner. */
export type HeightShape = BrushSize | "area";
/** The way marked stairs point: by the rule ("a"), one way, or "remove" to take marks away. */
export type StairChoice = StairDirection | "remove";

/**
 * The stepper's range and step (section 4.2, raised to 100 ft by
 * docs/design-v1-heights-readout.md section 5). The model allows -100 to
 * 200 ft, which other tools may store.
 */
export const HEIGHT_STEP_FT = 5;
export const HEIGHT_MIN_FT = -20;
export const HEIGHT_MAX_FT = 100;

export type HeightState = {
  paint: HeightPaint;
  shape: HeightShape;
  /** Feet. 0 clears. */
  height: number;
  stairs: StairChoice;
  /** Cells the stroke has touched and not yet sent. */
  unsent: readonly string[];
  /** The area being dragged, in world cells. */
  area: { a: Point; b: Point } | null;
};

/** A stroke's bookkeeping that nothing draws. `group` is its undo group: its flushes undo as one step. */
export type HeightStroke = {
  sceneId: string;
  seen: Set<string>;
  last: Point;
  group: string;
  timer: ReturnType<typeof setInterval>;
  /** Whether a finger draws it, and when it began (cells.ts strokeMaySend). */
  touch: boolean;
  startedAt: number;
};

/** One Room page's Height mode (client/state/scope.ts). */
export const heightSlot = scopeSlot(
  () => ({
    store: createStore<HeightState>(() => ({ paint: "height", shape: 1, height: 10, stairs: "a", unsent: [], area: null })),
    gesture: { stroke: null as HeightStroke | null, areaSceneId: null as string | null },
  }),
  (slot) => {
    if (slot.gesture.stroke) clearInterval(slot.gesture.stroke.timer);
    slot.gesture.stroke = null;
  },
);

export function useHeightStore(): StoreApi<HeightState> {
  return useScoped(heightSlot).store;
}

/**
 * Steps the stepper's height `by` feet within its range. It reads the
 * store, never a render's value, since a held − or + steps from a timer
 * that outlives renders. Returns whether another step the same way would
 * still change it, so a held button stops at -20 and at 100.
 */
export function stepHeight(store: StoreApi<HeightState>, by: number): boolean {
  const now = store.getState().height;
  const next = Math.min(HEIGHT_MAX_FT, Math.max(HEIGHT_MIN_FT, now + by));
  if (next !== now) store.setState({ height: next });
  return by > 0 ? next < HEIGHT_MAX_FT : next > HEIGHT_MIN_FT;
}

/** How the stepper names a height: "10 ft up", "10 ft down", or ground level. */
export function heightName(feet: number): string {
  if (feet === 0) return "Ground (clears)";
  return feet > 0 ? `${feet} ft up` : `${-feet} ft down`;
}
