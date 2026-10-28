import type { BuildChunk, Trap } from "#shared/model.ts";
import type { Grid } from "#shared/rules/grid.ts";
import type { LabelBox } from "#shared/rules/labels.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { zoneBox } from "./rules.ts";

/** A trap's zone on screen, in pixels from the canvas's top left, for placing its pane beside it. A door trap whose door is gone has none. */
export function trapScreenBox(g: Grid, trap: Pick<Trap, "zone" | "sceneId">, chunks: Readonly<Record<string, BuildChunk>>, camera: Camera): LabelBox {
  const box = zoneBox(g, trap, chunks) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const a = viewToScreen(camera, toView(TOP_DOWN, { x: box.x0, y: box.y0 }));
  const b = viewToScreen(camera, toView(TOP_DOWN, { x: box.x1, y: box.y1 }));
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}
