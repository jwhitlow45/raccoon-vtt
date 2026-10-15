import type { Insets, Point, Size } from "../../lib/camera.ts";

/** The canvas's edge room a card keeps, in pixels. */
const MARGIN = 8;

/**
 * Where a small card over the map goes (the note after a stopped drop, a
 * door's pill): centered on its anchor, on the side it prefers when it
 * fits there, else on the other, and always inside the part of the canvas
 * the Room page's bars leave clear. `gap` is the room left between the
 * anchor and the card, for the thing the card points at.
 */
export function cardPlace(input: { anchor: Point; viewport: Size; insets: Insets; width: number; height: number; gap: number; prefer: "above" | "below" }): { left: number; top: number } {
  const { anchor, viewport, insets, width, height, gap } = input;
  const minTop = insets.top + MARGIN;
  const maxTop = Math.max(minTop, viewport.height - insets.bottom - MARGIN - height);
  const above = anchor.y - gap - height;
  const below = anchor.y + gap;
  const fitsAbove = above >= minTop;
  const fitsBelow = below <= maxTop;
  const want = input.prefer === "above" ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
  const minLeft = insets.left + MARGIN;
  const maxLeft = Math.max(minLeft, viewport.width - insets.right - MARGIN - width);
  return {
    left: Math.min(Math.max(minLeft, anchor.x - width / 2), maxLeft),
    top: Math.min(Math.max(minTop, want), maxTop),
  };
}
