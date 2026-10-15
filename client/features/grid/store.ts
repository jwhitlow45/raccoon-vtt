import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { CalBox, Corner, Point } from "./calibrate.ts";

/**
 * The alignment box while the grid tool is active. It lives outside the
 * room state: nobody else sees it, and nothing is sent until the DM applies
 * it. The tool's pointer handlers, its option bar and its canvas overlay all
 * read this one store.
 */
export type GridDrag =
  | { kind: "move"; from: Point; start: CalBox }
  | { kind: "corner"; corner: Corner; start: CalBox }
  | { kind: "new"; from: Point; start: CalBox | null; moved: boolean };

export type GridToolState = {
  /** In canonical pixels of the map. Null when the scene has no map. */
  box: CalBox | null;
  drag: GridDrag | null;
  /** Also resize the scene to the squares the map covers when applying. */
  fitScene: boolean;
};

/** How close, in screen pixels, a finger must land to grab a corner: half a 44 px target. */
export const HANDLE_HIT_PX = 22;

/** One Room page's alignment box (client/state/scope.ts). */
export const gridSlot = scopeSlot(() => createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true })));

/** This Room's grid tool store, for the option bar and the canvas overlay. */
export function useGridStore(): StoreApi<GridToolState> {
  return useScoped(gridSlot);
}
