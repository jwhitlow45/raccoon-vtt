import type { Camera, Insets, Rect, Size } from "../lib/camera.ts";
import type { BoardPick } from "./boardPick.ts";
import { openSceneCamera } from "./sceneCamera.ts";
import { scopeSlot } from "../state/scope.ts";

/** A one-shot request that the next scene a canvas opens be framed on a part of it. */
export type FrameRequest = { sceneId: string; rect: Rect };

/**
 * The Room page's "Fit map" and "Find my token" buttons and its map canvas
 * meet here (UP-20). The canvas leaves functions that move its camera, and
 * the buttons call them. Per Room (client/state/scope.ts), because "view as
 * a player" puts a second canvas on the page.
 *
 * - `fit` fits the map, or a player's revealed part of it.
 * - `show` moves to a camera the caller works out from the canvas size, the
 *   bars over it and what the docked token bar covers past those bars
 *   (canvas/barDock.ts barCover), as "Find my token" does
 *   (features/find/findToken.ts), given the board's pick: the view it shows
 *   and this viewer's drawn heights.
 * - `frameOnOpen` is left by a dialog about to open a scene it made, such
 *   as a generated dungeon framed on its entrance (D-261102-387). The
 *   canvas takes it when it next opens a scene, whichever scene that is
 *   (`openingFrame`). It lives only here, never in the scene, so other
 *   devices and players learn nothing from it.
 */
export const fitSlot = scopeSlot(() => ({
  fit: null as (() => void) | null,
  show: null as ((camera: (viewport: Size, bars: Insets, bar: Insets, pick: BoardPick) => Camera) => void) | null,
  frameOnOpen: null as FrameRequest | null,
}));

type FrameHolder = { frameOnOpen: FrameRequest | null };

/**
 * The rectangle asked for `sceneId`, or null. The request is cleared either
 * way: one for another scene means the DM went elsewhere before that scene
 * opened, and it must not frame a later visit.
 */
export function takeFrame(slot: FrameHolder, sceneId: string): Rect | null {
  const frame = slot.frameOnOpen;
  slot.frameOnOpen = null;
  return frame && frame.sceneId === sceneId ? frame.rect : null;
}

/**
 * The frame for a canvas about to show a scene, taken only when it opens
 * that scene anew: sized, and not already on it, as sceneCamera.ts
 * `openSceneCamera` decides. Taken before that chooses between the scene's
 * saved view and a fit, so a scene with a saved view still uses up a
 * request meant for another (DG-OPUS-27). A canvas with no size yet leaves
 * the request for the opening its size brings.
 */
export function openingFrame(slot: FrameHolder, a: { size: Size | null; cameraScene: string | null; sceneId: string }): Rect | null {
  if (!a.size || a.cameraScene === a.sceneId) return null;
  return takeFrame(slot, a.sceneId);
}

type OpenCamera<Fit extends { cam: Camera }> = Parameters<typeof openSceneCamera<Fit>>[0];

/**
 * Stage.tsx's opening camera: the frame taken first (`openingFrame`), then
 * the scene's saved view or a fit that frames what was taken.
 * sceneCamera.ts `openSceneCamera` stays as it was, and the frame reaches
 * the fit as its target.
 */
export function openFramed<Fit extends { cam: Camera }>(slot: FrameHolder, a: Omit<OpenCamera<Fit>, "fit"> & { fit(frame: Rect | null): Fit }): void {
  const frame = openingFrame(slot, { size: a.size, cameraScene: a.cameraScene.current, sceneId: a.scene.id });
  openSceneCamera({ ...a, fit: () => a.fit(frame) });
}

/** A rectangle grown by `by` cells on every side, kept inside the scene's bounds. */
export function grownWithin(rect: Rect, by: number, bounds: { w: number; h: number }): Rect {
  const x = Math.max(0, rect.x - by);
  const y = Math.max(0, rect.y - by);
  return { x, y, width: Math.min(bounds.w, rect.x + rect.width + by) - x, height: Math.min(bounds.h, rect.y + rect.height + by) - y };
}
