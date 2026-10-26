import { createStore, type StoreApi } from "zustand/vanilla";
import type { StairDirection } from "#shared/model.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { Point } from "../cells.ts";

/**
 * Height mode's choices and its gesture in progress (docs/design-v1-maps-vision.md
 * section 4.2), local to this device. Heights and stairs only change
 * through ops: the overlay draws the unsent part of a stroke and the
 * dragged area from here, so they show under the finger before the op goes.
 */

/** What a stroke paints: a height on cells, stair marks, or difficult ground marks (the builder's own Difficult ground mode). */
export type HeightPaint = "height" | "stairs" | "rough";
/** Difficult ground mode's choice: mark the cells or clear their marks (docs/design-v1-movement.md 3.4). */
export type RoughChoice = "mark" | "clear";
/** A brush of 1 to 3 cells, or an area dragged from corner to corner. Brush and Erase's size goes to 10 (D-261026-4), and this one keeps its three. */
export type HeightShape = 1 | 2 | 3 | "area";
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
  rough: RoughChoice;
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
    store: createStore<HeightState>(() => ({ paint: "height", shape: 1, height: 10, stairs: "a", rough: "mark", unsent: [], area: null })),
    gesture: { stroke: null as HeightStroke | null, areaSceneId: null as string | null, paint: "height" as HeightPaint },
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
 * The height readout's slot (docs/design-v1-heights-readout.md section 2):
 * the cell a tap with the Select tool read, and the words the status line
 * speaks. The pill reads the cell's ground from the view on each render,
 * so it follows a repaint and goes when the ground does, and the host keeps
 * `words` on what the pill says (`followReadout`). `voiced` is whether the
 * status line has said them yet.
 */
export type HeightReadout = { id: number; sceneId: string; cell: { x: number; y: number }; at: number; words: string; voiced: boolean };
export type ReadoutState = { readout: HeightReadout | null; spoken: string };

export const readoutSlot = scopeSlot(() => ({
  store: createStore<ReadoutState>(() => ({ readout: null, spoken: "" })),
  seq: 0,
  /** Runs `fn` on the next animation frame. Tests run it when they choose. */
  nextFrame: (fn: () => void): void => void requestAnimationFrame(fn),
}));

type ReadoutSlot = ReturnType<typeof readoutSlot.create>;

/**
 * Shows a readout of a cell. The status line is cleared and then set on
 * the next frame, so a second reading with the same words, two areas at
 * the same height, is spoken again rather than heard as no change.
 */
export function showReadout(slot: ReadoutSlot, at: { sceneId: string; cell: { x: number; y: number } }, words: string, now: number = Date.now()): void {
  const id = ++slot.seq;
  slot.store.setState({ readout: { id, sceneId: at.sceneId, cell: at.cell, at: now, words, voiced: false }, spoken: "" });
  slot.nextFrame(() => {
    const readout = slot.store.getState().readout;
    if (readout?.id === id) slot.store.setState({ readout: { ...readout, voiced: true }, spoken: readout.words });
  });
}

/**
 * Keeps an open readout's words on what its pill says now. A repaint or a
 * stair change under the readout changes the pill, and the status line
 * says the new words too, rather than a height that is no longer there.
 * Before the first frame the line stays clear, and the frame says the
 * newest words.
 */
export function followReadout(slot: ReadoutSlot, words: string): void {
  const s = slot.store.getState();
  if (!s.readout || s.readout.words === words) return;
  slot.store.setState({ readout: { ...s.readout, words }, spoken: s.readout.voiced ? words : s.spoken });
}

/** Ends the readout, and the status line with it. */
export function closeReadout(slot: ReadoutSlot): void {
  const s = slot.store.getState();
  if (s.readout !== null || s.spoken !== "") slot.store.setState({ readout: null, spoken: "" });
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
