import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { calibrationFromBox, type CalBox, type Calibration, type Corner, type Point } from "./calibrate.ts";

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
  /** The grid found, as measured, which the box stands for while it is the one the search left. None when no grid was found. */
  cal?: Calibration;
  /** The grid and the scene's size before an applied one, which Use default puts back. Only an import has one: after Find the grid, Undo does. */
  fallback?: Fallback;
  /** An offer on a scene that came with its own grid, from a Universal VTT file. */
  ownGrid?: true;
};

/** What Use default puts back: the grid an import started with, and the size the scene had then. */
export type Fallback = Calibration & { bounds: { w: number; h: number } };

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

/**
 * The grid the box stands for. A box a search left on this scene stands for
 * the grid it measured, so Apply, the drawn lines and the size read that,
 * not `calibrationFromBox`, whose snap for a hand-drawn box would move a
 * measured origin off its lines. Once the box moves, it is the DM's own.
 */
export function boxCalibration(box: CalBox, found: FoundNote | null, sceneId: string): Calibration {
  return found?.sceneId === sceneId && found.box === box && found.cal ? found.cal : calibrationFromBox(box);
}

/**
 * Ends a Find the grid still running for the scene. Apply and a move of
 * the box by hand (a drag, a tap, a nudge) each call it: the DM has taken
 * the grid into their own hands, and an answer that came later would put
 * the search's grid and box over theirs.
 */
export function endFinding(store: StoreApi<GridToolState>, sceneId: string): void {
  const { finding } = store.getState();
  if (!finding || finding.sceneId !== sceneId) return;
  finding.cancel();
  store.setState({ finding: null });
}

/** How close, in screen pixels, a finger must land to grab a corner: half a 44 px target. */
export const HANDLE_HIT_PX = 22;

/** One Room page's alignment box (client/state/scope.ts). */
export const gridSlot = scopeSlot(() => createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null })));

/** This Room's grid tool store, for the option bar and the canvas overlay. */
export function useGridStore(): StoreApi<GridToolState> {
  return useScoped(gridSlot);
}
