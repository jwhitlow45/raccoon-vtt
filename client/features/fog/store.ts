import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { FogMode, Point } from "./shapes.ts";

/**
 * The fog tool's choices and its gesture in progress, local to this device.
 * Fog changes only through ops: to the scene's draft by default, or straight
 * to the players in live mode (design 13.2).
 */
export type FogShapeKind = "rect" | "poly" | "brush" | "room";

export type FogToolState = {
  mode: FogMode;
  shape: FogShapeKind;
  /** Brush width in cells. */
  width: number;
  /** Each edit goes to the players at once instead of into the draft. */
  live: boolean;
  rect: { a: Point; b: Point } | null;
  poly: readonly Point[];
  stroke: readonly Point[];
  note: string | null;
};

export const BRUSH_WIDTHS = [1, 2, 4] as const;

/** One Room page's fog tool (client/state/scope.ts): its choices, its gesture, and where a tap started. */
export const fogSlot = scopeSlot(() => ({
  store: createStore<FogToolState>(() => ({
    mode: "reveal",
    shape: "rect",
    width: 2,
    live: false,
    rect: null,
    poly: [],
    stroke: [],
    note: null,
  })),
  downAt: null as Point | null,
}));

/** This Room's fog tool store, for the option bar and the canvas preview. */
export function useFogStore(): StoreApi<FogToolState> {
  return useScoped(fogSlot).store;
}

export function resetFogGesture(store: StoreApi<FogToolState>): void {
  store.setState({ rect: null, poly: [], stroke: [], note: null });
}

/** Clear or add fog, in the row's order, which the tool's key steps through too. Named for the fog itself, so they never read like the publish button. */
export const FOG_MODES: readonly { value: FogMode; label: string }[] = [
  { value: "reveal", label: "Clear fog" },
  { value: "hide", label: "Add fog" },
];

/** Whether the next shape clears fog or adds it. A polygon keeps its corners and a draft keeps waiting. */
export function pickFogMode(scope: RoomScope, mode: FogMode): void {
  scope.get(fogSlot).store.setState({ mode });
}
