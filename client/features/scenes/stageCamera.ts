import { scopeSlot, type RoomScope } from "../../state/scope.ts";

export type StageCamera = { camera: { x: number; y: number; scale: number }; viewport: { width: number; height: number } };

/**
 * The map canvas's camera, read live from the canvas of this Room page. The
 * camera is the canvas's own state (Stage.tsx), and the Scenes panel needs
 * it only at the moment the DM saves a starting view, so the canvas leaves
 * a reader here instead of copying the camera on every frame. It is per
 * Room (client/state/scope.ts), because "view as a player" puts a second
 * map canvas on the page.
 */
export const stageCameraSlot = scopeSlot(() => ({ read: null as (() => StageCamera | null) | null }));

/** Null when this Room has no map canvas, or the canvas has not measured itself yet. */
export function currentStageCamera(scope: RoomScope): StageCamera | null {
  return scope.get(stageCameraSlot).read?.() ?? null;
}
