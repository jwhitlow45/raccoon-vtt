import type { MapImageState } from "../useImage.ts";

/** The map image the board's trees share (MapLayer.tsx SharedMapImage): what it loads from, and how far it got. */
export type SharedMap = { url: string | null; state: MapImageState };

export const LOADING: MapImageState = { image: null, status: "loading" };

/**
 * What one tree's map layer draws from. Under the board's shared loader it
 * is the loader's answer when the loader loads this tree's map. A frozen
 * tree can still hold another map's props, as a hidden one does after a
 * phase switch or a new map: it draws nothing then and keeps no last image
 * (features/phases/swap.ts), since the loader frees that image once the new
 * one settles, and a freed bitmap throws when drawn or read. Anywhere else
 * the tree's own loader answers, and its last image stays up while the
 * next loads.
 */
export function treeMap(shared: SharedMap | null, url: string | null, own: MapImageState): { state: MapImageState; keepsLast: boolean } {
  if (!shared) return { state: own, keepsLast: true };
  if (shared.url !== url) return { state: LOADING, keepsLast: false };
  return { state: shared.state, keepsLast: true };
}
