import { isometric, K, toView, turnAxes, type Turn } from "../../lib/view.ts";
import type { VBox } from "./pieces.ts";

/**
 * Where a standee draws (docs/design-v1-isometric-view.md 5.4), in view
 * units. The art box is the footprint's w by h, its bottom middle on the
 * footprint's center at the base, so every decor layout keeps its numbers.
 * The ring is the footprint's ellipse at the base, and a base above the
 * drawn ground under the footprint casts a shadow ellipse on that ground
 * with a stem up to the ring.
 */

/** How far a standee's decor reaches past its art box, in screen pixels: chips above, a label of a few lines below, wide names to the sides. */
export const DECOR_REACH_PX = { top: 44, bottom: 72, side: 96 } as const;

/** How far a lift may raise a standee on screen, in canvas heights (5.4): past it the stem is capped and draws a break mark. */
export const LIFT_CAP_CANVAS = 1;

export type StandeeShape = {
  /** The footprint's center on the ground, in view units. */
  ground: { x: number; y: number };
  /** The footprint's center at the base. */
  base: { x: number; y: number };
  art: VBox;
  ring: VBox;
  /** The shadow on the drawn ground, when the base is above it. */
  shadow: VBox | null;
  /** Everything it draws, its decor included. */
  bounds: VBox;
  /** Whether the lift was capped, so the stem draws a break mark. */
  capped: boolean;
};

/** The view box of a footprint's ellipse, w by h cells on the ground, at a view point: the same at every turn, since the ground turns by 45 degrees plus right angles. */
export function ellipseBox(turn: Turn, w: number, h: number, at: { x: number; y: number }): VBox {
  const { c, s } = turnAxes(turn);
  // A world ellipse with semi-axes a and b, turned: its half-width along u, and half its half-height along v.
  const a = w / 2;
  const b = h / 2;
  const hu = Math.sqrt(a * a * c * c + b * b * s * s);
  const hv = Math.sqrt(a * a * s * s + b * b * c * c) / 2;
  return { x0: at.x - hu, x1: at.x + hu, y0: at.y - hv, y1: at.y + hv };
}

/**
 * A standee's shape. `box` is its footprint as drawn, in cells, `base` its
 * drawn base and `ground` the drawn ground under it, both in cells, and
 * `scale` the camera's px per view unit, for the decor's reach and the
 * lift's cap (`canvasHeight` in px).
 */
export function standeeShape(turn: Turn, box: { x: number; y: number; w: number; h: number }, base: number, ground: number, scale: number, canvasHeight: number): StandeeShape {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const g = toView(isometric(turn), center, ground);
  let lift = K * (base - ground);
  const cap = (LIFT_CAP_CANVAS * canvasHeight) / Math.max(scale, 1e-9);
  const capped = lift > cap;
  if (capped) lift = cap;
  const at = { x: g.x, y: g.y - lift };
  const art = { x0: at.x - box.w / 2, x1: at.x + box.w / 2, y0: at.y - box.h, y1: at.y };
  const ring = ellipseBox(turn, box.w, box.h, at);
  const shadow = base > ground ? ellipseBox(turn, box.w, box.h, g) : null;
  const k = 1 / Math.max(scale, 1e-9);
  const bounds = {
    x0: Math.min(art.x0, ring.x0) - DECOR_REACH_PX.side * k,
    x1: Math.max(art.x1, ring.x1) + DECOR_REACH_PX.side * k,
    y0: art.y0 - DECOR_REACH_PX.top * k,
    y1: Math.max(ring.y1, shadow?.y1 ?? -Infinity) + DECOR_REACH_PX.bottom * k,
  };
  return { ground: g, base: at, art, ring, shadow, bounds, capped };
}
