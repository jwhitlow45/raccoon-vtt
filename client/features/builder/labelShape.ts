import type { Label } from "#shared/model.ts";
import { labelBox, type LabelBox, type MeasureText } from "#shared/rules/labels.ts";
import { toView, type View, type ViewBox } from "../../lib/view.ts";
import { boxStands } from "../../canvas/relief/stand.ts";
import type { FogView } from "../../canvas/relief/fogView.ts";

/**
 * A map label's displayed bounds (docs/design-v1-isometric-view.md 6.2),
 * the one shape that drawing, the stand rule, a tap and the label pane all
 * read. In Top-down it is the flat box the text draws in (shared/rules
 * labels.ts labelBox, measured on a canvas). In Isometric a label stands
 * upright, its text block centered on its anchor at the ground under it,
 * when the stand rule lets it, and otherwise lies flat on the ground under
 * the fog, the flat box's corners seen through the projection.
 */
export type LabelShape = {
  /** Upright, or flat on the ground as Top-down draws it. */
  upright: boolean;
  /** The flat box in cells, which the stand rule tests. */
  flat: LabelBox;
  /** The displayed bounds in view units. */
  box: ViewBox;
  /** The flat box's corners in view units, clockwise from the top left: the drawn outline of a flat label. Upright labels give their box's corners. */
  corners: readonly { x: number; y: number }[];
};

export function labelShape(label: Pick<Label, "x" | "y" | "text" | "size">, view: View, opts: { measure: MeasureText; upright: boolean; ground?: number }): LabelShape {
  const flat = labelBox(label, opts.measure);
  if (opts.upright && view.kind === "isometric") {
    const at = toView(view, { x: label.x, y: label.y }, opts.ground ?? 0);
    const halfW = (flat.x1 - flat.x0) / 2;
    const halfH = (flat.y1 - flat.y0) / 2;
    // The block stands on its anchor: its bottom at the ground, as a sign stands.
    const box = { x: at.x - halfW, y: at.y - 2 * halfH, width: 2 * halfW, height: 2 * halfH } as ViewBox;
    return { upright: true, flat, box, corners: rectCorners(box) };
  }
  const corners = [toView(view, { x: flat.x0, y: flat.y0 }), toView(view, { x: flat.x1, y: flat.y0 }), toView(view, { x: flat.x1, y: flat.y1 }), toView(view, { x: flat.x0, y: flat.y1 })];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } as ViewBox;
  return { upright: false, flat, box, corners };
}

function rectCorners(b: { x: number; y: number; width: number; height: number }): { x: number; y: number }[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ];
}

/** Whether a label stands upright for this viewer: by the stand rule over its measured flat box (5.2). */
export function labelStands(fog: FogView, label: Pick<Label, "x" | "y" | "text" | "size">, measure: MeasureText): boolean {
  return boxStands(fog, labelBox(label, measure));
}

/** A scene's labels split into those that stand and those that lie flat under the fog. */
export function splitLabels<L extends Pick<Label, "x" | "y" | "text" | "size">>(fog: FogView, labels: readonly L[], measure: MeasureText): { upright: L[]; flat: L[] } {
  const upright: L[] = [];
  const flat: L[] = [];
  for (const l of labels) (labelStands(fog, l, measure) ? upright : flat).push(l);
  return { upright, flat };
}
