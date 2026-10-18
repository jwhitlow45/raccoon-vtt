import { useCallback } from "react";
import { useAssets, useRoomActions, useRoomStore } from "../../state/view.ts";
import { thisDevice } from "../uvtt/limits.ts";
import type { Calibration } from "./calibrate.ts";
import { copyUrls, type GridSearch } from "./findGrid.ts";
import { FIND_TIMEOUT_MS, findOnScene, landSearch, type GridScene } from "./outcome.ts";
import { useGridStore } from "./store.ts";

/** A scene of this Room with its map, as the room holds it now, or null. */
function useSceneOf(): (sceneId: string) => GridScene | null {
  const room = useRoomStore();
  return useCallback(
    (sceneId: string) => {
      const scene = room.getState().view?.scenes[sceneId];
      return scene?.map ? { ...scene, map: scene.map } : null;
    },
    [room],
  );
}

/**
 * Find the grid for a scene of this Room, on its map as the room holds it
 * when the answer comes (outcome.ts `findOnScene`), from the phone-sized
 * copy, and on a computer the full image if that fails (findGrid.ts
 * `copyUrls`).
 */
export function useFindGrid(): (sceneId: string) => void {
  const store = useGridStore();
  const sceneOf = useSceneOf();
  const actions = useRoomActions();
  const assets = useAssets();
  return useCallback(
    (sceneId: string) => {
      const start = sceneOf(sceneId);
      if (!start) return;
      const { assetId } = start.map;
      void findOnScene({ actions, store, sceneId, scene: () => sceneOf(sceneId), urls: copyUrls(thisDevice(), (variant) => assets.url(assetId, variant)) });
    },
    [store, sceneOf, actions, assets],
  );
}

/**
 * Hands an import's search of the phone copy that outlived the import's
 * wait (findGrid.ts `ImportWait.later`) to Line up grid, which says it is
 * looking and shows what it finds on the scene the import made, as it
 * shows Find the grid's answer (outcome.ts `landSearch`). It has as long
 * as Find the grid has.
 */
export function useLandLater(): (input: { sceneId: string; start: GridScene; search: GridSearch; fallback: Calibration; ownGrid?: boolean }) => void {
  const store = useGridStore();
  const sceneOf = useSceneOf();
  const actions = useRoomActions();
  return useCallback(
    (input) => {
      void landSearch({ ...input, actions, store, scene: () => sceneOf(input.sceneId), ms: FIND_TIMEOUT_MS, fit: true });
    },
    [store, sceneOf, actions],
  );
}
