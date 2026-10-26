import type { CSSProperties } from "react";
import type { Label } from "#shared/model.ts";
import { labelBox, type LabelBox } from "#shared/rules/labels.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { theme } from "../../lib/theme.ts";
import { measureLabel } from "./draw.ts";
import type { PanePlacement } from "./labelEdit.ts";

/** The height the label pane is placed for until it has been laid out and measured. */
export const PANE_HEIGHT_UNMEASURED = 200;

/** A label's box on screen, in pixels from the canvas's top left. */
export function labelScreenBox(label: Pick<Label, "x" | "y" | "text" | "size">, camera: Camera): LabelBox {
  const box = labelBox(label, measureLabel);
  const topLeft = viewToScreen(camera, toView(TOP_DOWN, { x: box.x0, y: box.y0 }));
  const bottomRight = viewToScreen(camera, toView(TOP_DOWN, { x: box.x1, y: box.y1 }));
  return { x0: topLeft.x, y0: topLeft.y, x1: bottomRight.x, y1: bottomRight.y };
}

/**
 * The label pane's box over the canvas for its placement: a bottom sheet,
 * over the top bars where they leave it too little room, or a card by its
 * label. The pin, light and trap panes take it too, and the panes' loading
 * notices take the same box, so each shows where its pane will appear
 * while the pane's code downloads.
 *
 * The top padding is slight because every pane opens with a PaneHeader
 * (components/SheetHeader.tsx), a 48 px row that centers its title and
 * close button, so the close sits near the corner with no negative margins.
 */
export function labelPaneFrame(place: PanePlacement): CSSProperties {
  const common: CSSProperties = {
    position: "absolute",
    zIndex: place.kind === "sheet" && place.overBars ? theme.z.paneOverBars : theme.z.pane,
    maxHeight: place.maxHeight,
    background: theme.color.surface,
    border: `${theme.line.border}px solid ${theme.color.border}`,
    fontSize: theme.font.body14,
  };
  if (place.kind === "sheet") {
    return {
      ...common,
      left: 0,
      right: 0,
      bottom: place.bottom,
      borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
      borderWidth: `${theme.line.border}px 0 0`,
      padding: `${theme.space(1)}px calc(${theme.safe.right} + ${theme.space(4)}px) ${theme.space(3)}px calc(${theme.safe.left} + ${theme.space(4)}px)`,
      boxShadow: theme.shadow.sheet,
    };
  }
  return {
    ...common,
    left: place.left,
    top: place.top,
    width: place.width,
    borderRadius: theme.radius.lg,
    padding: `${theme.space(1)}px ${theme.space(3)}px ${theme.space(3)}px`,
    boxShadow: theme.shadow.pane,
  };
}
