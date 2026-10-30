import type { Label } from "#shared/model.ts";
import { createContext } from "react";
import type { MeasureText } from "#shared/rules/labels.ts";
import { LABEL_INK, labelInkBox, labelShape } from "../../features/builder/labelShape.ts";
import type { Box } from "../../lib/boardText.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { toView, type View } from "../../lib/view.ts";
import type { PillSpec } from "../boardView.ts";
import type { VBox } from "./pieces.ts";
import { placedTextBoxes } from "../textBoxes.ts";
import type { TokenText } from "../useBoardText.ts";
import { pillInkReach } from "../../features/measure/pillPlace.ts";

/** Names place after token text in Isometric. Keeping this one way avoids two labels chasing each other. */
export type IsoNames = { view: View; ground: (x: number, y: number) => number; boxes: readonly Box[] };
export const IsoNamesContext = createContext<IsoNames | null>(null);

export function tokenLayoutPills(pills: Readonly<Record<string, readonly PillSpec[]>>): PillSpec[] {
  return Object.entries(pills).flatMap(([key, list]) => key.startsWith("area:") || key.startsWith("trap:") ? [] : list);
}

/** Actual frames, rings, marks and placed text, in the same view units as standing names. */
export function isoTokenBoxes(tokens: readonly ViewToken[], text: ReadonlyMap<string, TokenText>, scale: number, place: (t: ViewToken) => { x: number; y: number; ring?: Box }): Box[] {
  const placed = tokens.map((t) => ({ ...t, ...place(t) }));
  return [
    ...placed.flatMap((t) => {
      const fp = footprint(t);
      return [{ x0: t.x, y0: t.y, x1: t.x + fp.w, y1: t.y + fp.h }, ...(t.ring ? [t.ring] : [])];
    }),
    ...placedTextBoxes(placed, text, scale).map((b) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale })),
  ];
}

/** Candidates stay in world cells for the stand rule. Their costs use the upright pill's complete viewport-slide reach. */
export function isoNamePill(candidates: readonly PillSpec[], layout: IsoNames, scale: number, allowed: (p: PillSpec) => boolean = () => true, others: readonly PillSpec[] = []): PillSpec {
  const otherBoxes = others.map((p) => pillInkReach({ ...viewPill(p, layout.view, layout.ground), scale }));
  let best = candidates[0]!;
  let tokenCost = Infinity;
  let otherCost = Infinity;
  const overlap = (box: Box, boxes: readonly Box[]) => boxes.reduce((sum, b) => sum + Math.max(0, Math.min(box.x1, b.x1) - Math.max(box.x0, b.x0)) * Math.max(0, Math.min(box.y1, b.y1) - Math.max(box.y0, b.y0)), 0);
  for (const candidate of candidates) {
    if (!allowed(candidate)) continue;
    const box = pillInkReach({ ...viewPill(candidate, layout.view, layout.ground), scale });
    const token = overlap(box, layout.boxes);
    const other = overlap(box, otherBoxes);
    // Token text draws over these names. A trap name must not make an area
    // trade a clear token label for a smaller combined overlap.
    if (token < tokenCost || (token === tokenCost && other < otherCost)) {
      best = candidate;
      tokenCost = token;
      otherCost = other;
    }
    if (tokenCost === 0 && otherCost === 0) break;
  }
  return best;
}

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
 * its footprint's middle at the drawn ground under it (relief/standee.ts,
 * 5.2).
 */
export function decorPlace(view: View, t: ViewToken, standee: { frame: VBox; ring: VBox } | undefined, ground = 0): { x: number; y: number; ring?: VBox } {
  if (standee) return { x: standee.frame.x0, y: standee.frame.y0, ring: standee.ring };
  const fp = footprint(t);
  // On the drawn ground under it (`ground`, cells), where the ground stage lays its picture.
  const c = toView(view, { x: t.x + fp.w / 2, y: t.y + fp.h / 2 }, ground);
  return { x: c.x - fp.w / 2, y: c.y - fp.h / 2 };
}

/**
 * The box a map label's ink can touch as the board draws it, `ground` the
 * drawn ground of a cell in cells. One that stands (by the stand rule over
 * its ink, labelShape.ts labelStands) is a block on its anchor at the drawn
 * ground there, its text centered on the block's middle with LABEL_INK's
 * reach round it. One lying flat draws on the ground stage, each part
 * lifted with the cell it lies on, so its box holds its ink box seen at the
 * lowest and the highest ground under it, and every part between.
 */
export function mapLabelInk(label: Pick<Label, "x" | "y" | "text" | "size">, view: View, upright: boolean, ground: (x: number, y: number) => number, measure: MeasureText): Box {
  const k = label.size;
  if (upright) {
    const { box } = labelShape(label, view, { measure, upright: true, ground: ground(label.x, label.y) });
    const middle = box.y + box.height / 2;
    return { x0: box.x - LABEL_INK.side * k, y0: middle - LABEL_INK.above * k, x1: box.x + box.width + LABEL_INK.side * k, y1: middle + LABEL_INK.below * k };
  }
  const ink = labelInkBox(label, measure);
  let low = Infinity;
  let high = -Infinity;
  for (let y = Math.floor(ink.y0); y < Math.ceil(ink.y1); y++) {
    for (let x = Math.floor(ink.x0); x < Math.ceil(ink.x1); x++) {
      const g = ground(x + 0.5, y + 0.5);
      low = Math.min(low, g);
      high = Math.max(high, g);
    }
  }
  const corners = [low, high].flatMap((z) => [toView(view, { x: ink.x0, y: ink.y0 }, z), toView(view, { x: ink.x1, y: ink.y0 }, z), toView(view, { x: ink.x1, y: ink.y1 }, z), toView(view, { x: ink.x0, y: ink.y1 }, z)]);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** A published pill where the board stands it: on its point at the drawn ground there, as IsoParts.tsx MarkPill draws it. */
export function viewPill(spec: PillSpec, view: View, ground: (x: number, y: number) => number): PillSpec {
  const v = toView(view, spec, ground(spec.x, spec.y));
  return { ...spec, x: v.x, y: v.y };
}
