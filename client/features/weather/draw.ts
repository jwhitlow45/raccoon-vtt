import type { Camera } from "../../lib/camera.ts";
import type { View } from "../../lib/view.ts";
import type { Field } from "./sim.ts";
import type { TextureSource } from "./textures.ts";

/**
 * Draws a weather field into a 2D context (the weather design note, 5.2):
 * in CSS px from an identity transform, clipped to the scene on screen,
 * batched to one path a color. It reads the field and never steps it, so a
 * camera draw shows the same moment a tick drew.
 */

export type DrawFrame = {
  /** The weather layer's own stage as it draws: x, y and scaleX. */
  camera: Camera;
  /** The scene on screen as a polygon, x and y pairs in CSS px, or null for the whole screen. */
  clip: ArrayLike<number> | null;
};

/** The scene's outline on screen: its bounds through the view's turn and squash, then the camera. */
export function sceneClip(view: View, bounds: { w: number; h: number }, camera: Camera): Float64Array {
  void view;
  void bounds;
  void camera;
  return new Float64Array(0);
}

export function drawWeather(g: CanvasRenderingContext2D, field: Field, frame: DrawFrame, textures: TextureSource | null): void {
  void g;
  void field;
  void frame;
  void textures;
}
