import type { Scene, SceneMap } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { StoreApi } from "zustand/vanilla";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";
import { boxAtCell, canonicalToWorld, fitBounds, sameCalibration, type CalBox, type Calibration, type Point } from "./calibrate.ts";
import { cameWithGrid, findFound, foundGrid, searchGrid, within, type FoundGrid, type SearchWorker } from "./findGrid.ts";
import type { FoundNote, GridToolState } from "./store.ts";

/**
 * What a search for a map's drawn grid does to the scene and the grid
 * tool (docs/design-v1-grid-detect.md section 6). A grid found with high
 * confidence is applied, a doubtful one is only offered by the box, and
 * no grid is said. Import and Find the grid share it.
 */

type GridScene = Pick<Scene, "id" | "bounds" | "autoWalls"> & { map: SceneMap };
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

/** The box over the 3 by 3 squares of `cal` nearest a point of the map, in canonical pixels. */
export function boxAround(cal: Calibration, at: Point): CalBox {
  const cell = canonicalToWorld(cal, at);
  return boxAtCell(cal, Math.floor(cell.x) - 1, Math.floor(cell.y) - 1);
}

/**
 * Where a found grid's box goes: the middle of the box there is, or of the
 * map when there is none or its middle is off the image. The tool centers
 * its box on the view, which after a scene switch can still be the last
 * scene's, far off this image.
 */
export function middleOf(box: CalBox | null, map: SceneMap): Point {
  const middle = box && { x: box.x + box.size / 2, y: box.y + box.size / 2 };
  const onImage = middle && middle.x >= 0 && middle.y >= 0 && middle.x <= map.widthPx && middle.y <= map.heightPx;
  return onImage ? middle : { x: map.widthPx / 2, y: map.heightPx / 2 };
}

/**
 * Shows a search's outcome on a scene. High confidence sends the grid as
 * one undo step. The note and the box go to the grid tool's store, which
 * the tool reads when it opens and the options line reads while the box
 * stays where the search left it.
 */
export function showOutcome(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  scene: GridScene;
  found: FoundGrid | null;
  fit: boolean;
  /** Where the box goes, in canonical pixels. */
  at: Point;
  /** The grid Use default puts back, after an import. */
  fallback?: Calibration;
  /** The scene came with its own grid (findGrid.ts `cameWithGrid`), which an offer says. */
  ownGrid?: boolean;
}): FoundNote | null {
  const { scene, found } = input;
  if (!found) {
    const box = input.store.getState().box;
    const note: FoundNote = { sceneId: scene.id, outcome: "none", cellPx: 0, box };
    input.store.setState({ found: note });
    return note;
  }
  if (found.tier === "high") dispatchGesture(input.actions, gridOps(scene, found.cal, input.fit));
  const box = boxAround(found.cal, input.at);
  const note: FoundNote = {
    sceneId: scene.id,
    outcome: found.tier === "high" ? "applied" : "offered",
    cellPx: found.cal.cellPx,
    box,
    ...(found.tier === "high" && input.fallback ? { fallback: input.fallback } : {}),
    ...(found.tier !== "high" && input.ownGrid ? { ownGrid: true as const } : {}),
  };
  input.store.setState({ found: note, box });
  return note;
}

/** How long Find the grid waits for the map to download, decode and be searched, ms. Past it, no grid is found. */
export const FIND_TIMEOUT_MS = 30_000;

/**
 * Find the grid, on the scene's current map at any time: the phone-sized
 * copy first, which is at most the size the Worker decodes anyway. A
 * second press while one runs does nothing. When the answer comes, the
 * scene must still show the same image, or it is dropped. On a scene that
 * came with its own grid, a find is only offered.
 */
export async function findOnScene(input: {
  actions: Gesture;
  store: StoreApi<GridToolState>;
  sceneId: string;
  scene(): GridScene | null;
  urls: string[];
  makeWorker?: () => SearchWorker;
}): Promise<void> {
  const { store } = input;
  const start = input.scene();
  if (!start || store.getState().finding) return;
  const search = searchGrid({ urls: input.urls }, input.makeWorker);
  const finding = { sceneId: input.sceneId, cancel: search.cancel };
  store.setState({ finding, found: null });
  const answer = await within(search, FIND_TIMEOUT_MS);
  if (store.getState().finding !== finding) return;
  store.setState({ finding: null });
  const scene = input.scene();
  if (!scene || scene.map.assetId !== start.map.assetId) return;
  const state = store.getState();
  const ownGrid = cameWithGrid(scene);
  showOutcome({
    actions: input.actions,
    store,
    scene,
    found: findFound(answer ? foundGrid(answer.result, answer, scene.map) : null, ownGrid),
    fit: state.fitScene,
    at: middleOf(state.box, scene.map),
    ownGrid,
  });
}
