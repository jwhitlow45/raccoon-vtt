import type { Label } from "#shared/model.ts";
import type { MeasureText } from "#shared/rules/labels.ts";
import { LABEL_INK, labelInkBox, labelShape } from "../../features/builder/labelShape.ts";
import type { Box } from "../../lib/boardText.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { toView, type View } from "../../lib/view.ts";
import type { PillSpec } from "../boardView.ts";
import type { VBox } from "./pieces.ts";

/**
 * What the token label layout (useBoardText.ts) reads in the isometric view,
 * all in view units (docs/design-v1-isometric-view.md 5.4): where each
 * token's decor lays out, and the pills and map labels the labels keep off,
 * each where the board draws it. A pan moves none of these, so a pan lays
 * out nothing.
 */

/**
 * Where a token's decor lays out: a standee's frame, where its art stands,
 * with the ring under it, or for a creature lying flat a box its size on
 * its footprint's middle (relief/standee.ts, 5.2).
 */
export function decorPlace(view: View, t: ViewToken, standee: { frame: VBox; ring: VBox } | undefined): { x: number; y: number; ring?: VBox } {
  if (standee) return { x: standee.frame.x0, y: standee.frame.y0, ring: standee.ring };
  const fp = footprint(t);
  const c = toView(view, { x: t.x + fp.w / 2, y: t.y + fp.h / 2 });
  return { x: c.x - fp.w / 2, y: c.y - fp.h / 2 };
}

/**
 * The box a map label's ink can touch as the board draws it. One that
 * stands (by the stand rule over its ink, labelShape.ts labelStands) is a
 * block on its anchor at the drawn ground, its text centered on the block's
 * middle with LABEL_INK's reach round it. One lying flat under the fog is
 * its ink box on the ground at 0, seen through the projection.
 */
export function mapLabelInk(label: Pick<Label, "x" | "y" | "text" | "size">, view: View, upright: boolean, ground: number, measure: MeasureText): Box {
  const k = label.size;
  if (upright) {
    const { box } = labelShape(label, view, { measure, upright: true, ground });
    const middle = box.y + box.height / 2;
    return { x0: box.x - LABEL_INK.side * k, y0: middle - LABEL_INK.above * k, x1: box.x + box.width + LABEL_INK.side * k, y1: middle + LABEL_INK.below * k };
  }
  const ink = labelInkBox(label, measure);
  const corners = [toView(view, { x: ink.x0, y: ink.y0 }), toView(view, { x: ink.x1, y: ink.y0 }), toView(view, { x: ink.x1, y: ink.y1 }), toView(view, { x: ink.x0, y: ink.y1 })];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** A published pill where the board stands it: on its point at the drawn ground there, as IsoParts.tsx MarkPill draws it. */
export function viewPill(spec: PillSpec, view: View, ground: (x: number, y: number) => number): PillSpec {
  const v = toView(view, spec, ground(spec.x, spec.y));
  return { ...spec, x: v.x, y: v.y };
}
