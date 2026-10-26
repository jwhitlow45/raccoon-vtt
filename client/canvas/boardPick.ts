import { DEFAULT_SETTINGS, type RoomState, type Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { cameraOfStage, type Camera, type Point } from "../lib/camera.ts";
import { drawnHeights, flatHeights, heightsStand, pickGround, type DrawnSource, type View } from "../lib/view.ts";

/**
 * The map point a press on the board means, from what the board itself
 * reads (docs/design-v1-isometric-view.md 4.3 and 6.2): in Top-down the
 * point under it, and in Isometric the first ground its ray meets, on the
 * drawn heights this viewer may see, so a press never reads terrain the
 * fog hides. For what answers a press outside the board's own gestures,
 * such as the hold-to-ping.
 */

export type BoardGround = {
  room: Pick<RoomState, "buildChunks" | "fogTiles" | "meta"> | null;
  scene: Pick<Scene, "id" | "bounds" | "gridShape">;
  role: "dm" | "player";
  /** Whether the scene draws fog (features/layers.ts LayerProps). */
  fog: boolean;
  lowPower: boolean;
};

/** The drawn heights' source as the isometric board reads it (relief/IsoBoard.tsx): a player's own fog on a scene with fog, else all the ground. */
export function drawnSourceOf(input: BoardGround, scale: number): DrawnSource {
  const { room, scene } = input;
  return {
    chunks: room?.buildChunks ?? {},
    sceneId: scene.id,
    bounds: scene.bounds,
    fog: input.role === "player" && input.fog ? (room?.fogTiles ?? {}) : null,
    stand: heightsStand(scale, input.lowPower),
  };
}

export function pickAt(camera: Camera, view: View, input: BoardGround, screen: Point): Point {
  // Top-down reads no heights, so it builds none.
  if (view.kind === "topDown") return pickGround({ camera, view, grid: sceneGrid(input.scene), heights: flatHeights(input.scene.bounds) }, screen);
  const feet = input.room?.meta.settings.feetPerCell ?? DEFAULT_SETTINGS.feetPerCell;
  return pickGround({ camera, view, grid: sceneGrid(input.scene), heights: drawnHeights(drawnSourceOf(input, camera.scale), feet) }, screen);
}

/** `pickAt` with the camera of the stage pressed. */
export function pickOnBoard(stage: { x(): number; y(): number; scaleX(): number }, view: View, input: BoardGround, screen: Point): Point {
  return pickAt(cameraOfStage(stage), view, input, screen);
}
