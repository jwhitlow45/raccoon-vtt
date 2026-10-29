import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { GridShape } from "#shared/model.ts";
import { shapeOfGrid, type Grid } from "#shared/rules/grid.ts";
import type { MapShape } from "./detectHex.ts";
import { boxAt, boxSides, calibrationFromBox, canonicalToWorld, nudgeBox, type CalBox, type Calibration, type Corner, type Point } from "./calibrate.ts";

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
  /** A grid applied, one only offered by the box, none found, or one found and dropped because the scene changed while the search ran. */
  outcome: "applied" | "offered" | "none" | "changed";
  /** The found squares' size, px. 0 when none was found or the scene changed. */
  cellPx: number;
  box: CalBox | null;
  /** The grid found, as measured, which the box stands for while it is the one the search left. None when no grid was found. */
  cal?: Calibration;
  /** The grid and the scene's size before an applied one, which Use default puts back. Only an import has one: after Find the grid, Undo does. */
  fallback?: Fallback;
  /** An offer on a scene that came with its own grid, from a Universal VTT file. */
  ownGrid?: true;
  /** The shape the note's box and grid are cells of, as a scene stores it: absent for squares. */
  shape?: GridShape;
  /** The find set the scene's shape with its grid (docs/design-v1-grid-detect.md 10.7). */
  switched?: true;
  /** Squares and hexes were both found: the shape not offered and its size, which the line names too. */
  contested?: { shape: MapShape; cellPx: number };
  /**
   * A find of another shape than the scene's, only offered: its grid and
   * its box, which Grid shape changed to it brings (`shapeChanged`), and
   * when a switch was refused, why. The note's own box stays the scene's.
   */
  other?: { shape: MapShape; cal: Calibration; box: CalBox; refusal?: string };
  /** Use default was refused, since the scene can no longer take back the shape the find switched it from: why. */
  backRefused?: string;
};

/**
 * What Use default puts back: the grid an import started with, the size
 * the scene had then, and when the find switched its shape, that shape.
 */
export type Fallback = Calibration & { bounds: { w: number; h: number }; shape?: MapShape };

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
 * A search's note for a scene on grid `g`, or null. A note's box and grid
 * are cells of the shape the scene had when it was left, so after Grid
 * shape switched, on this device or another, it stands for cells the
 * scene no longer has. Only the note that the scene changed, which
 * measured nothing, still holds.
 */
export function noteFor(found: FoundNote | null, sceneId: string, g: Grid): FoundNote | null {
  return found?.sceneId === sceneId && (found.outcome === "changed" || found.shape === shapeOfGrid(g)) ? found : null;
}

/**
 * The grid the box stands for. A box a search left on this scene stands for
 * the grid it measured, so Apply, the drawn lines and the size read that,
 * not `calibrationFromBox`, whose snap for a hand-drawn box would move a
 * measured origin off its lines. Once the box moves, it is the DM's own.
 */
export function boxCalibration(box: CalBox, found: FoundNote | null, sceneId: string, g: Grid): Calibration {
  const note = noteFor(found, sceneId, g);
  return note?.box === box && note.cal ? note.cal : calibrationFromBox(box, g);
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

/**
 * The scene's Grid shape changed on this device: a search still running
 * for it ends, and its note goes, since it measured the cells of the shape
 * before. The tool's box moves to the new cells at the same spot. Line up
 * grid already open is not opened again (Stage runs `activate` only on a
 * change of tool, scene or role), so with no box it would lose Apply,
 * Nudge and Find until the DM drew one.
 *
 * A find of the new shape that was only offered ("Change Grid shape to
 * use them") becomes the offer on it: its box and its grid, for Apply.
 */
export function shapeChanged(store: StoreApi<GridToolState>, sceneId: string, shape?: { map: Calibration; from: Grid; to: Grid }): void {
  endFinding(store, sceneId);
  const { found, box, sceneId: open } = store.getState();
  const other = found?.sceneId === sceneId && shape ? found.other : undefined;
  if (other && shape && (shapeOfGrid(shape.to) ?? "squares") === other.shape) {
    const to = shapeOfGrid(shape.to);
    store.setState({ found: { sceneId, outcome: "offered", cellPx: other.cal.cellPx, box: other.box, cal: other.cal, ...(to ? { shape: to } : {}) }, ...(open === sceneId ? { box: other.box, drag: null } : {}) });
    return;
  }
  let next: CalBox | null = null;
  if (box && shape) {
    const { w, h } = boxSides(box, shape.from);
    const at = boxAt(shape.map, shape.to, canonicalToWorld(shape.map, { x: box.x + w / 2, y: box.y + h / 2 }));
    next = nudgeBox(at, 0, 0, box.size - at.size, shape.to);
  }
  store.setState({ ...(found?.sceneId === sceneId ? { found: null } : {}), ...(open === sceneId ? { box: next, drag: null } : {}) });
}

/** How close, in screen pixels, a finger must land to grab a corner: half a 44 px target. */
export const HANDLE_HIT_PX = 22;

/** One Room page's alignment box (client/state/scope.ts). */
export const gridSlot = scopeSlot(() => createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null })));

/** This Room's grid tool store, for the option bar and the canvas overlay. */
export function useGridStore(): StoreApi<GridToolState> {
  return useScoped(gridSlot);
}
