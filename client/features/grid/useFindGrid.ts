import { useCallback } from "react";
import { useAssets, useRoomActions, useRoomStore } from "../../state/view.ts";
import { thisDevice } from "../uvtt/limits.ts";
import { copyUrls } from "./findGrid.ts";
import { findOnScene } from "./outcome.ts";
import { useGridStore } from "./store.ts";

/**
 * Find the grid for a scene of this Room, on its map as the room holds it
 * when the answer comes (outcome.ts `findOnScene`), from the phone-sized
 * copy, and on a computer the full image if that fails (findGrid.ts
 * `copyUrls`).
 */
export function useFindGrid(): (sceneId: string) => void {
  const store = useGridStore();
  const room = useRoomStore();
  const actions = useRoomActions();
  const assets = useAssets();
  return useCallback(
    (sceneId: string) => {
      const sceneOf = () => {
        const scene = room.getState().view?.scenes[sceneId];
        return scene?.map ? { ...scene, map: scene.map } : null;
      };
      const start = sceneOf();
      if (!start) return;
      const { assetId } = start.map;
      void findOnScene({ actions, store, sceneId, scene: sceneOf, urls: copyUrls(thisDevice(), (variant) => assets.url(assetId, variant)) });
    },
    [store, room, actions, assets],
  );
}
