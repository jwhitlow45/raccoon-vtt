import type { Camera, Insets, Size } from "../lib/camera.ts";
import { scopeSlot } from "../state/scope.ts";

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
 *   (features/find/findToken.ts).
 */
export const fitSlot = scopeSlot(() => ({
  fit: null as (() => void) | null,
  show: null as ((camera: (viewport: Size, bars: Insets, bar: Insets) => Camera) => void) | null,
}));
