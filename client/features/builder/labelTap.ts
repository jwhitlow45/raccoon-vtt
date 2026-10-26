import type { Label } from "#shared/model.ts";
import { labelBox } from "#shared/rules/labels.ts";
import type { Point } from "../../lib/camera.ts";
import { TOP_DOWN } from "../../lib/view.ts";
import { boardPickOf, drawnAt, pressView, type BoardPick } from "../../canvas/boardPick.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import type { ToolContext } from "../tools.ts";
import { measureLabel } from "./draw.ts";
import { labelTapOutcome } from "./labelEdit.ts";
import type { LabelLook } from "./labelPaneFrame.ts";
import { labelShape, labelStands } from "./labelShape.ts";
import { labelAt } from "./query.ts";
import { builderSlot, labelPaneSlot } from "./store.ts";

/** A finger's slop around a label's text, in screen pixels. */
const LABEL_SLOP_PX = 6;

/**
 * How the board on screen shows a label (docs/design-v1-isometric-view.md
 * 6.2): in Isometric standing on the drawn ground under its anchor where
 * the stand rule lets it, as IsoBoard.tsx draws it, else lying flat.
 */
export function labelLook(pick: BoardPick, sceneId: string, label: Pick<Label, "x" | "y" | "text" | "size">, fog: FogView = viewerFog(pick, sceneId)): LabelLook {
  if (pick.view.kind !== "isometric") return { view: TOP_DOWN, upright: false, ground: 0 };
  return { view: pick.view, upright: labelStands(fog, label, measureLabel), ground: drawnAt(pick, label) };
}

/** The viewer's fog on the board's scene, for the stand rule: one for every label a press tests. */
function viewerFog(pick: BoardPick, sceneId: string): FogView {
  return new FogView(pick.src?.fog ?? null, sceneId, pick.heights.bounds);
}

/**
 * The label under a press, measured as it draws, with room for a finger.
 * In Isometric a label standing up is reached by its displayed bounds on
 * screen (`screen`), and one lying flat by the world point under the press,
 * whose ground the column tops lift with it.
 */
export function labelUnder(ctx: Pick<ToolContext, "getState" | "scene" | "camera" | "scope">, world: Point, screen?: Point): Label | null {
  const pick = boardPickOf(ctx);
  const slop = LABEL_SLOP_PX / ctx.camera().scale;
  if (pick.view.kind !== "isometric" || !screen) return labelAt(ctx.getState().view, ctx.scene.id, world, { measure: measureLabel, slop });
  const v = pressView(pick, screen);
  const fog = viewerFog(pick, ctx.scene.id);
  let hit: Label | null = null;
  for (const label of Object.values(ctx.getState().view?.labels ?? {})) {
    if (!label || label.sceneId !== ctx.scene.id) continue;
    const look = labelLook(pick, ctx.scene.id, label, fog);
    if (look.upright) {
      const { box } = labelShape(label, pick.view, { measure: measureLabel, upright: true, ground: look.ground });
      if (v.x >= box.x - slop && v.x <= box.x + box.width + slop && v.y >= box.y - slop && v.y <= box.y + box.height + slop) hit = label;
    } else {
      const b = labelBox(label, measureLabel);
      if (world.x >= b.x0 - slop && world.x <= b.x1 + slop && world.y >= b.y0 - slop && world.y <= b.y1 + slop) hit = label;
    }
  }
  return hit;
}

/**
 * A tap on the map, as the label edit pane sees it (labelEdit.ts
 * labelTapOutcome): it opens the pane of the label under it, or closes an
 * open pane when it lands elsewhere. Returns whether the tap was the
 * pane's, so the tool does nothing more with it. The builder's Label mode
 * calls it from its own tap, and the canvas from a tap on empty map with
 * the Select tool, since labels are part of the map and not shapes that
 * catch a tap of their own. `screen` is the press, for a label standing up
 * in Isometric.
 */
export function tapMapLabel(ctx: ToolContext, tool: string, world: Point, screen?: Point): boolean {
  const pane = ctx.scope.get(labelPaneSlot);
  const outcome = labelTapOutcome({
    role: ctx.role,
    tool,
    mode: ctx.scope.get(builderSlot).store.getState().mode,
    hit: ctx.role === "dm" ? (labelUnder(ctx, world, screen)?.id ?? null) : null,
    open: pane.getState().labelId,
  });
  if (outcome.kind === "pass") return false;
  if (outcome.kind === "open") {
    // One thing floats over the map at a time: the pane, or a token's bar.
    ctx.ui.select(null);
    pane.setState({ labelId: outcome.labelId });
  } else {
    pane.setState({ labelId: null });
  }
  return true;
}
