import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/**
 * Asks the map camera to bring a point into view, for "tap a tracker row to
 * find its token".
 *
 * Why a channel and not store state: a pan is a one-time nudge, not
 * something the room remembers, and the camera lives in the canvas's own
 * React state. The canvas listens for the scene it shows (Stage.tsx). A
 * view only holds the tokens of the scene on screen (design 7.3), so a row
 * can only ask to pan to a token the canvas is already drawing, and a
 * request nobody is listening for is simply dropped. The channel is per
 * Room page (client/state/scope.ts), so a row in "view as a player" moves
 * only the preview's camera.
 */

export type PanRequest = {
  sceneId: string;
  /** World cells. */
  x: number;
  y: number;
  /**
   * Where the point should land, as fractions of the canvas from its top
   * left. A sheet over part of the map on phones moves the visible middle.
   */
  anchor: { x: number; y: number };
};

type Listener = { sceneId: string; fn(request: PanRequest): void };

const panSlot = scopeSlot(() => new Set<Listener>());

export function requestPan(scope: RoomScope, request: PanRequest): void {
  for (const l of scope.get(panSlot)) if (l.sceneId === request.sceneId) l.fn(request);
}

/** Runs `fn` for every request on `sceneId`. Returns the unsubscribe. */
export function watchPans(scope: RoomScope, sceneId: string, fn: (request: PanRequest) => void): () => void {
  const listener: Listener = { sceneId, fn };
  const listeners = scope.get(panSlot);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Where a token should land so that a panel over the map does not cover it:
 * the upper part of the map under a phone's bottom sheet, the left part
 * beside a landscape sheet, and the middle when the panel docks beside the
 * map on wide screens.
 */
export function panAnchor(viewport: { width: number; height: number }, wideMinWidth: number, sheetOpen: boolean): { x: number; y: number } {
  if (!sheetOpen || viewport.width >= wideMinWidth) return { x: 0.5, y: 0.5 };
  if (viewport.width > viewport.height) return { x: 0.3, y: 0.5 };
  return { x: 0.5, y: 0.25 };
}
