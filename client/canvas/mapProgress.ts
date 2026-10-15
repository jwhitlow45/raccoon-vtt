import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../state/scope.ts";
import type { MapProgress } from "../state/sceneLoad.ts";

/**
 * Where the map layer reports the image it last finished, so the loading
 * notice over the canvas (SceneLoading.tsx) knows when a scene's map has
 * drawn. One per Room page, so a player preview's canvas reports to its own.
 */
export const mapProgressSlot = scopeSlot(() => createStore<{ progress: MapProgress }>(() => ({ progress: null })));

export function useMapProgressStore(): StoreApi<{ progress: MapProgress }> {
  return useScoped(mapProgressSlot);
}
