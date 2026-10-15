import type { Label } from "#shared/model.ts";
import type { Point } from "../../lib/camera.ts";
import type { ToolContext } from "../tools.ts";
import { measureLabel } from "./draw.ts";
import { labelTapOutcome } from "./labelEdit.ts";
import { labelAt } from "./query.ts";
import { builderSlot, labelPaneSlot } from "./store.ts";

/** A finger's slop around a label's text, in screen pixels. */
const LABEL_SLOP_PX = 6;

/** The label under a world point, measured as it draws, with room for a finger. */
export function labelUnder(ctx: Pick<ToolContext, "getState" | "scene" | "camera">, world: Point): Label | null {
  return labelAt(ctx.getState().view, ctx.scene.id, world, { measure: measureLabel, slop: LABEL_SLOP_PX / ctx.camera().scale });
}

/**
 * A tap on the map, as the label edit pane sees it (labelEdit.ts
 * labelTapOutcome): it opens the pane of the label under it, or closes an
 * open pane when it lands elsewhere. Returns whether the tap was the
 * pane's, so the tool does nothing more with it. The builder's Label mode
 * calls it from its own tap, and the canvas from a tap on empty map with
 * the Select tool, since labels are part of the map and not shapes that
 * catch a tap of their own.
 */
export function tapMapLabel(ctx: ToolContext, tool: string, world: Point): boolean {
  const pane = ctx.scope.get(labelPaneSlot);
  const outcome = labelTapOutcome({
    role: ctx.role,
    tool,
    mode: ctx.scope.get(builderSlot).store.getState().mode,
    hit: ctx.role === "dm" ? (labelUnder(ctx, world)?.id ?? null) : null,
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
