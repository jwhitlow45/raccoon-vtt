import type { Scene, SceneMap } from "#shared/model.ts";
import { gridOfShape, isHex, OWN_SQUARE_GRID, sceneGrid, shapeOfGrid, SQUARES, type Grid } from "#shared/rules/grid.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { StoreApi } from "zustand/vanilla";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";
import { boxAt, boxAtCell, boxSides, canonicalToWorld, fitBounds, sameCalibration, type CalBox, type Calibration, type KeptGrid, type Point } from "./calibrate.ts";
import type { MapShape } from "./detectHex.ts";
import { beside, cameWithGrid, findFound, offeredOnly, pickedGrid, searchGrid, within, type FoundGrid, type GridSearch, type SearchWorker, type Timers } from "./findGrid.ts";
import { endFinding, type Fallback, type FoundNote, type GridToolState } from "./store.ts";

/**
 * What a search for a map's drawn grid does to the scene and the grid
 * tool (docs/design-v1-grid-detect.md sections 6 and 10.5 to 10.7). A
 * grid found with high confidence is applied, a doubtful one is only
 * offered by the box, and no grid is said. A sure find of another shape
 * than the scene's, found alone, switches the scene to it with the grid
 * when the scene can switch, and is otherwise only said. A hex find held
 * only by the stretch margin can switch the shape while offering its
 * lattice (10.5). Import and Find the grid share it.
 */

export type GridScene = Pick<Scene, "id" | "bounds" | "gridFromFile" | "gridShape"> & { map: SceneMap };
type Gesture = Pick<RoomActions, "dispatch" | "newId">;

/**
 * The ops that put a calibration on a scene, and when `fit`, the scene's
 * size to the squares the map covers: the ops Apply sends, but as one
 * undo step, so one undo takes back the whole of a found grid.
 */
export function gridOps(scene: GridScene, cal: Calibration, fit: boolean): ClientOp[] {
  const ops: ClientOp[] = [];
  if (!sameCalibration(cal, scene.map)) ops.push({ t: "scene.setGrid", sceneId: scene.id, cellPx: cal.cellPx, originPx: cal.originPx });
  const bounds = fitBounds({ ...scene.map, ...cal });
  if (fit && (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h)) ops.push({ t: "scene.update", sceneId: scene.id, patch: { bounds } });
  return ops;
}

/**
 * Apply: the box's grid and, when the scene should match the map, its
 * size, each its own op as the DM sends them by hand. A Find the grid
 * still running for the scene ends first, so its answer cannot overwrite
 * them.
 */
export function applyGrid(input: {
  actions: Pick<RoomActions, "dispatch">;
  store: StoreApi<GridToolState>;
  sceneId: string;
  /** Null when the grid is already this. */
  cal: Calibration | null;
  /** Null when the size stays. */
  bounds: { w: number; h: number } | null;
}): void {
  const { actions, sceneId, cal, bounds } = input;
  endFinding(input.store, sceneId);
  if (cal) actions.dispatch({ t: "scene.setGrid", sceneId, cellPx: cal.cellPx, originPx: cal.originPx });
  if (bounds) actions.dispatch({ t: "scene.update", sceneId, patch: { bounds } });
}

/**
 * The ops Use default sends, as one undo step: the grid the import started
 * with, and the size the scene had then. The size is put back as it was,
 * not fitted to that grid: a battle mat that took its first image, or a
 * scene that took new art, had a size of its own. Shape, calibration and
 * size travel in one op, so a refused switch cannot leave half a reset.
 */
export function fallbackOps(scene: GridScene, fallback: Fallback): ClientOp[] {
  const shape = fallback.shape ?? mapShape(sceneGrid(scene));
  const { bounds } = fallback;
  if (shape === mapShape(sceneGrid(scene)) && sameCalibration(fallback, scene.map) && bounds.w === scene.bounds.w && bounds.h === scene.bounds.h) return [];
  return [{ t: "scene.setGrid", sceneId: scene.id, cellPx: fallback.cellPx, originPx: fallback.originPx, gridShape: shape, bounds }];
}

/**
 * Use default, after an import applied a grid or only switched its shape:
 * `fallbackOps` as one undo step, and the box on the grid put back. A
 * locally known switch refusal keeps the note and says why. The server
 * rechecks the same rule atomically with the calibration and size in case
 * another device changed the scene since. False when refused locally.
 */
export function putBack(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  scene: GridScene;
  fallback: Fallback;
  /** Why the scene cannot change to a shape, as the room holds it now (shared/rules/grid.ts `switchRefusal`). */
  refusal?: (to: Grid) => string | null;
}): boolean {
  const { scene, fallback, store } = input;
  const grid = sceneGrid(scene);
  const back = fallback.shape === undefined ? grid : gridOfShape(fallback.shape === "squares" ? undefined : fallback.shape);
  const refused = mapShape(back) !== mapShape(grid) ? (input.refusal?.(back) ?? null) : null;
  const { found, box } = store.getState();
  if (refused !== null) {
    if (found) store.setState({ found: { ...found, backRefused: refused } });
    return false;
  }
  dispatchGesture(input.actions, fallbackOps(scene, fallback), { groupScope: "setup" });
  store.setState({ found: null, box: boxAround(fallback, middleOf(box, scene.map, grid), back) });
  return true;
}

/** The box over the 3 by 3 squares of `cal` nearest a point of the map, or on hexes the 7 hexes, in canonical pixels. */
export function boxAround(cal: Calibration, at: Point, g: Grid = SQUARES): CalBox {
  const cell = canonicalToWorld(cal, at);
  return isHex(g) ? boxAt(cal, g, cell) : boxAtCell(cal, Math.floor(cell.x) - 1, Math.floor(cell.y) - 1);
}

/** A grid's shape as a find names it. */
export function mapShape(g: Grid): MapShape {
  return shapeOfGrid(g) ?? "squares";
}

/**
 * Where a found grid's box goes: the middle of the box there is, or of the
 * map when there is none or its middle is off the image. The tool centers
 * its box on the view, which after a scene switch can still be the last
 * scene's, far off this image.
 */
export function middleOf(box: CalBox | null, map: SceneMap, g: Grid = SQUARES): Point {
  const sides = box && boxSides(box, g);
  const middle = box && sides && { x: box.x + sides.w / 2, y: box.y + sides.h / 2 };
  const onImage = middle && middle.x >= 0 && middle.y >= 0 && middle.x <= map.widthPx && middle.y <= map.heightPx;
  return onImage ? middle : { x: map.widthPx / 2, y: map.heightPx / 2 };
}

/**
 * Shows a search's outcome on a scene. High confidence sends the grid as
 * one undo step. The note and the box go to the grid tool's store, which
 * the tool reads when it opens and the options line reads while the box
 * stays where the search left it.
 *
 * A find of another shape than the scene's switches the scene to it, in
 * the same undo step, only when it is sure, found alone (not contested)
 * and the switch is allowed. Otherwise nothing is sent and the line says
 * what was found, keeping the find for Grid shape to bring.
 */
export function showOutcome(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  scene: GridScene;
  found: FoundGrid | null;
  fit: boolean;
  /** Where the box goes, in canonical pixels. */
  at: Point;
  /** The grid Use default puts back, after an import, with the scene's size as `scene` gives it. */
  fallback?: Calibration;
  /** The scene came with its own grid (findGrid.ts `cameWithGrid`), which an offer says. */
  ownGrid?: boolean;
  /** Why the scene cannot change to a shape, as the room holds it now (shared/rules/grid.ts `switchRefusal`). Absent: nothing holds it, as on a scene just made. */
  refusal?: (to: Grid) => string | null;
}): FoundNote | null {
  const { scene, found } = input;
  const grid = sceneGrid(scene);
  const shape = scene.gridShape ? { shape: scene.gridShape } : {};
  if (!found) {
    const box = input.store.getState().box;
    const note: FoundNote = { sceneId: scene.id, outcome: "none", cellPx: 0, box, ...shape };
    input.store.setState({ found: note });
    return note;
  }
  const to = gridOfShape(found.shape);
  if (mapShape(to) !== mapShape(grid)) return otherShape({ ...input, found, grid, to });
  if (found.tier === "high") dispatchGesture(input.actions, gridOps(scene, found.cal, input.fit), { groupScope: "setup" });
  const box = boxAround(found.cal, input.at, grid);
  const note: FoundNote = {
    sceneId: scene.id,
    outcome: found.tier === "high" ? "applied" : "offered",
    cellPx: found.cal.cellPx,
    box,
    cal: found.cal,
    ...(found.tier === "high" && input.fallback ? { fallback: { ...input.fallback, bounds: scene.bounds } } : {}),
    ...(found.tier !== "high" && input.ownGrid ? { ownGrid: true as const } : {}),
    ...shape,
    ...(found.contested ? { contested: found.contested } : {}),
  };
  input.store.setState({ found: note, box });
  return note;
}

/**
 * A find of shape `to` on a scene of `grid`: switched to when sure of its
 * shape, alone and allowed, else only said. A hex find the stretch margin
 * alone held is sure of its shape but not of its lattice, so the switch
 * comes alone, as its own undo step, and the box is only offered
 * (D-261029-210).
 */
function otherShape(input: Parameters<typeof showOutcome>[0] & { found: FoundGrid; grid: Grid; to: Grid }): FoundNote {
  const { scene, found, grid, to } = input;
  const refusal = input.ownGrid && !isHex(grid) ? OWN_SQUARE_GRID : (input.refusal?.(to) ?? null);
  const box = boxAround(found.cal, input.at, to);
  const high = found.tier === "high";
  if ((high || found.shapeSure === true) && !found.contested && refusal === null) {
    const switched: ClientOp = { t: "scene.update", sceneId: scene.id, patch: { gridShape: mapShape(to) } };
    dispatchGesture(input.actions, high ? [switched, ...gridOps({ ...scene, gridShape: shapeOfGrid(to) }, found.cal, input.fit)] : [switched], { groupScope: "setup" });
    const note: FoundNote = {
      sceneId: scene.id,
      outcome: high ? "applied" : "offered",
      cellPx: found.cal.cellPx,
      box,
      cal: found.cal,
      switched: true,
      ...(found.shape ? { shape: found.shape } : {}),
      ...(input.fallback ? { fallback: { ...input.fallback, bounds: scene.bounds, shape: mapShape(grid) } } : {}),
    };
    input.store.setState({ found: note, box });
    return note;
  }
  // The scene keeps its shape, so the box stays the one the tool holds for it, or one of its cells is placed for the line to stand by.
  const held = input.store.getState();
  const own = held.sceneId === scene.id && held.box ? held.box : boxAround(scene.map, input.at, grid);
  const note: FoundNote = {
    sceneId: scene.id,
    outcome: "offered",
    cellPx: found.cal.cellPx,
    box: own,
    ...(scene.gridShape ? { shape: scene.gridShape } : {}),
    ...(found.contested ? { contested: found.contested } : {}),
    other: { shape: mapShape(to), cal: found.cal, box, ...(refusal !== null ? { refusal } : {}) },
  };
  input.store.setState({ found: note, box: own });
  return note;
}

/** Whether a scene shows the image it did at `start`, with the same grid, grid shape and size. */
function unchangedSince(start: GridScene, now: GridScene): boolean {
  return (
    now.map.assetId === start.map.assetId &&
    sameCalibration(now.map, start.map) &&
    sceneGrid(now) === sceneGrid(start) &&
    now.bounds.w === start.bounds.w &&
    now.bounds.h === start.bounds.h
  );
}

/** How long Find the grid waits for the map to download, decode and be searched, ms. Past it, no grid is found. */
export const FIND_TIMEOUT_MS = 30_000;

/**
 * Find the grid, on the scene's current map at any time, whatever its
 * shape: the phone-sized copy first, which is at most the size the Worker
 * decodes anyway. A second press while one runs does nothing. It lands as
 * `landSearch` says.
 */
export async function findOnScene(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  sceneId: string;
  scene(): GridScene | null;
  urls: string[];
  makeWorker?: () => SearchWorker;
  timers?: Timers;
  refusal?: (scene: GridScene, to: Grid) => string | null;
}): Promise<void> {
  const start = input.scene();
  if (!start || input.store.getState().finding) return;
  const search = searchGrid({ urls: input.urls }, input.makeWorker);
  await landSearch({ ...input, start, search, ms: FIND_TIMEOUT_MS });
}

/**
 * A search the grid tool holds for a scene as its `finding`, and what it
 * finds shown there: Find the grid's, and an import's search of the phone
 * copy that outlived the import's wait. The options line says "Looking for
 * a grid…" meanwhile. Apply, a move of the box by hand, the tool closing
 * and leaving the scene each end it (store.ts `endFinding`, tool.tsx
 * `deactivate`), and so does a newer search, which takes its place. An
 * answer that still comes is dropped unless the scene shows the same
 * image with the same grid and size as at `start`, so work done meanwhile,
 * on this device or another, is never overwritten. A grid found and
 * dropped so leaves a note that says the scene changed. On a scene that
 * came with its own grid, a find is only offered. On art that keeps its
 * scene's grid (`kept`), every find is only offered and one on the kept
 * grid's lines is none, as on time (findGrid.ts `replacementFound`): it
 * ends the search with nothing to say, since the scene stands on it.
 */
export async function landSearch(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  sceneId: string;
  /** The scene as the search began, or as the import made it. */
  start: GridScene;
  scene(): GridScene | null;
  search: GridSearch;
  /** How long it may still take, ms. */
  ms: number;
  timers?: Timers;
  /** Fit the scene to a found grid. Find the grid goes by Resize scene, an import always fits, as on time. */
  fit?: boolean;
  /** An import's first guess, for Use default. */
  fallback?: Calibration;
  /** The scene came with its own grid, when its image before says so and this one cannot (findGrid.ts `replacementFound`). */
  ownGrid?: boolean;
  /** The grid art of the old image's shape keeps (scenes/create.ts `replacement`). */
  kept?: KeptGrid | null;
  /** Why the scene, as it is when the answer lands, cannot change to a shape (`showOutcome`'s). */
  refusal?: (scene: GridScene, to: Grid) => string | null;
}): Promise<void> {
  const { store } = input;
  store.getState().finding?.cancel();
  const finding = { sceneId: input.sceneId, cancel: input.search.cancel };
  store.setState({ finding, found: null });
  const searched = await within(input.search, input.ms, input.timers);
  if (store.getState().finding !== finding) return;
  store.setState({ finding: null });
  const scene = input.scene();
  if (!scene) return;
  const state = store.getState();
  const kept = input.kept ?? null;
  const answer = searched && kept ? offeredOnly(searched) : searched;
  const pickedOn = (on: GridScene) => (answer ? pickedGrid(answer, on.map, on.gridShape) : null);
  if (!unchangedSince(input.start, scene)) {
    // Said, or the DM would see "Looking for a grid…" give way to nothing. A search that found no grid on the
    // image before says nothing of this one, so it leaves the line as it was.
    if (beside(pickedOn(input.start), kept, input.start.gridShape, input.start.map)) store.setState({ found: { sceneId: scene.id, outcome: "changed", cellPx: 0, box: state.box } });
    return;
  }
  const picked = pickedOn(scene);
  const found = beside(picked, kept, scene.gridShape, scene.map);
  // A find on the kept grid's lines is no find, and not "No grid found" either: the scene stands on it.
  if (picked && !found) return;
  const ownGrid = input.ownGrid ?? cameWithGrid(scene);
  const { refusal } = input;
  showOutcome({
    actions: input.actions,
    store,
    scene,
    found: findFound(found, ownGrid),
    fit: input.fit ?? state.fitScene,
    at: middleOf(state.box, scene.map, sceneGrid(scene)),
    ownGrid,
    ...(input.fallback ? { fallback: input.fallback } : {}),
    ...(refusal ? { refusal: (to: Grid) => refusal(scene, to) } : {}),
  });
}

/** A shape in a found line's words: "squares", "hex rows" or "hex columns", or "hexes" when named beside squares. */
function shapeWords(shape: MapShape, beside?: MapShape): string {
  if (shape === "squares") return "squares";
  if (beside === "squares") return "hexes";
  return shape === "hexRows" ? "hex rows" : "hex columns";
}

/** A found cell's size in a sentence, to a tenth of a pixel: "70.4", or "70" for 69.998. */
export function formatFound(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/**
 * What Line up grid's options line says of a search's note on a scene of
 * grid `g` (docs/design-v1-grid-detect.md 6.1 and 10.8). Only a note that
 * stands for this scene's cells reaches it (store.ts `noteFor`).
 */
export function foundLine(note: FoundNote, g: Grid): { tone: "status" | "hint" | "warning"; content: string } {
  const n = formatFound(note.cellPx);
  const hex = isHex(g);
  const status = (content: string) => ({ tone: "status" as const, content });
  const hint = (content: string) => ({ tone: "hint" as const, content });
  const warning = (content: string) => ({ tone: "warning" as const, content });
  if (note.backRefused && note.fallback?.shape) {
    const why = note.backRefused;
    return warning(`Can't go back to ${shapeWords(note.fallback.shape)}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`);
  }
  switch (note.outcome) {
    case "applied": {
      if (!note.switched) return status(`Found a grid of ${n} px ${hex ? "hexes" : "squares"}.`);
      const words = shapeWords(mapShape(g));
      return status(`Found ${words} of ${n} px. The grid is ${words} now.`);
    }
    case "offered": {
      // The shape is sure and switched, its lattice only offered (D-261029-210).
      if (note.switched) {
        const words = shapeWords(mapShape(g));
        return hint(`Found ${words}. The grid is ${words} now. Check the box on its ${n} px hexes, then Apply.`);
      }
      const offered = note.other?.shape ?? mapShape(g);
      const { contested } = note;
      // Another shape than the scene's is named in full, so "hexes" never stands for the orientation the scene is not on.
      const both = contested && `The map shows ${shapeWords(offered, note.other ? undefined : contested.shape)} of ${n} px and ${shapeWords(contested.shape, offered)} of ${formatFound(contested.cellPx)} px.`;
      if (note.other) {
        const words = shapeWords(note.other.shape);
        if (both) return hint(`${both} Change Grid shape to use them.`);
        const { refusal } = note.other;
        // A refused switch says what stopped it, as Can't go back does: a refusal, so a warning.
        if (refusal) return warning(`Found ${words} of ${n} px, but ${refusal.charAt(0).toLowerCase()}${refusal.slice(1)}`);
        return hint(`These lines may be ${words} of ${n} px. Change Grid shape to use them.`);
      }
      if (both) return hint(`${both} Check the box, then Apply.`);
      if (note.ownGrid) return hint(`This scene came with its own grid. The lines found make ${n} px squares: check the box, then Apply.`);
      return hint(hex ? `These lines may be the map's hexes: ${n} px. Check the box, then Apply.` : `These lines may be the map's grid: ${n} px squares. Check the box, then Apply.`);
    }
    // A search that found nothing or came too late failed, so it takes the warning tone: green says only that something worked (docs/design-v1-design-pass.md 2.4 rule 5).
    case "none":
      return warning(hex ? "No grid found. Drag a box over 3 hexes across instead." : "No grid found. Drag a box over 3 by 3 squares instead.");
    case "changed":
      return warning("The scene changed, so the grid found was not applied.");
  }
}
