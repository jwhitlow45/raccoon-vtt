import type { Light } from "#shared/model.ts";
import type { LabelBox } from "#shared/rules/labels.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";

/** Half the ring the builder draws around a selected sun, in pixels: the box a light's pane keeps clear of. */
const SUN_RING_PX = 17;

/** A light's sun on screen, in pixels from the canvas's top left, for placing its pane beside it. */
export function lightScreenBox(light: Pick<Light, "x" | "y">, camera: Camera): LabelBox {
  const c = viewToScreen(camera, toView(TOP_DOWN, light));
  return { x0: c.x - SUN_RING_PX, y0: c.y - SUN_RING_PX, x1: c.x + SUN_RING_PX, y1: c.y + SUN_RING_PX };
}
