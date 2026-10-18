import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { CalBox, Calibration, Corner, Point } from "./calibrate.ts";

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

/**
 * What a search for the map's drawn grid left (docs/design-v1-grid-detect.md
 * section 6), said on the options line while the box is the one it left.
 * Moving the box ends it.
 */
export type FoundNote = {
  sceneId: string;
  /** A grid applied, one only offered by the box, or none found. */
  outcome: "applied" | "offered" | "none";
  /** The found squares' size, px. */
  cellPx: number;
  box: CalBox | null;
  /** The grid before an applied one, which Use default puts back. Only an import has one: after Find the grid, Undo does. */
  fallback?: Calibration;
  /** An offer on a scene that came with its own grid, from a Universal VTT file. */
  ownGrid?: true;
};

export type GridToolState = {
  /** In canonical pixels of the map. Null when the scene has no map. */
  box: CalBox | null;
  drag: GridDrag | null;
  /** Also resize the scene to the squares the map covers when applying. */
  fitScene: boolean;
  /**
   * The scene the tool was opened on. The tool's context reads the scene
   * now on screen, which on a switch is already the next one when the
   * tool closes on the last, so closing goes by this instead.
   */
  sceneId: string | null;
  found: FoundNote | null;
  /** The scene a Find the grid search runs for, and how to stop it. */
  finding: { sceneId: string; cancel(): void } | null;
};

/** How close, in screen pixels, a finger must land to grab a corner: half a 44 px target. */
export const HANDLE_HIT_PX = 22;

/** One Room page's alignment box (client/state/scope.ts). */
export const gridSlot = scopeSlot(() => createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null })));

/** This Room's grid tool store, for the option bar and the canvas overlay. */
export function useGridStore(): StoreApi<GridToolState> {
  return useScoped(gridSlot);
}
