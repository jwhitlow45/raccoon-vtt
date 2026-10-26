/**
 * Where a popover stands (docs/design-v1-tool-options.md 7.1, "Placement").
 * A pure function of measured rectangles, all in the chrome's own px: a
 * client rectangle divided by the interface size, as Room's measures are,
 * so the interface size never enters the rule.
 *
 * The popover keeps inside a bound, a margin in from its edges. Where the
 * bound leaves it less than its minimum height on the side it opens on, it
 * may grow into a taller rise region, up to that region's edge: a popover
 * above the tool options on a short phone in a fight rises over the top
 * bars rather than open with no room. Past the room it has, its content
 * scrolls. The rule is cardPlace's clamping (features/movement/anchor.ts),
 * rewritten for an anchor in the page rather than a point on the map.
 */

/** A rectangle in the chrome's own px. */
export type Rect = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

export type PopoverSide = "above" | "below";

export type PlaceInput = {
  anchor: Rect;
  /** The rectangle the popover keeps inside, `margin` in from its edges. */
  bound: Rect;
  /** A taller rectangle it may grow into, up to its edge, where the bound leaves less than `minHeight`. */
  rise?: Rect | null;
  side: PopoverSide;
  /** Between the anchor and the popover. */
  gap: number;
  margin: number;
  /** The content's natural size, the box's padding and border included, wrapped at the widest the bound allows. */
  content: { width: number; height: number };
  minHeight: number;
};

export type Place = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The content is taller than the box, so it scrolls, with "Scroll for more" while it runs past the foot. */
  scrolls: boolean;
  /** It took room from the rise region. */
  rose: boolean;
};

export function popoverPlace(input: PlaceInput): Place {
  const { anchor, bound, rise, side, gap, margin, content } = input;
  const widest = Math.max(0, bound.right - bound.left - 2 * margin);
  const width = Math.min(Math.max(content.width, anchor.right - anchor.left), widest);

  // The start edge at the anchor's, moved back inside the far edge, then inside the near one, which wins.
  let left = Math.min(anchor.left, bound.right - margin - width);
  left = Math.max(left, bound.left + margin);

  const edge = side === "above" ? anchor.top - gap : anchor.bottom + gap;
  const inBound = side === "above" ? edge - (bound.top + margin) : bound.bottom - margin - edge;
  const inRise = rise ? (side === "above" ? edge - rise.top : rise.bottom - edge) : -Infinity;
  const rose = inBound < input.minHeight && inRise > inBound && content.height > inBound;
  const room = Math.max(0, rose ? inRise : inBound);
  const height = Math.min(content.height, room);
  const top = side === "above" ? edge - height : edge;
  return { left, top, width, height, scrolls: content.height > height, rose };
}

/** The inputs a placement depends on, apart from the content, whose changes never move or resize an open popover. */
export type PlaceFrame = { anchor: Rect; bound: Rect; rise: Rect | null };

/** Under half a layout px, so subpixel rounding between two reads never places a popover again. */
const SAME = 0.5;

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.left - b.left) < SAME && Math.abs(a.top - b.top) < SAME && Math.abs(a.right - b.right) < SAME && Math.abs(a.bottom - b.bottom) < SAME;
}

/**
 * Whether an open popover is placed again: when its anchor moves or
 * changes size, or the bound or the rise region changes. Its content is
 * not an input, so a choice inside that adds a line never moves the box
 * under the finger. The content scrolls instead.
 */
export function needsPlace(last: PlaceFrame | null, next: PlaceFrame): boolean {
  if (last === null) return true;
  return !sameRect(last.anchor, next.anchor) || !sameRect(last.bound, next.bound) || !sameRect(last.rise, next.rise);
}

/** `rect` cut to what shows above the on-screen keyboard (lib/keyboardInset.ts visibleSpan), so a popover never opens under it. Never inverted: a rect wholly hidden keeps its top as its bottom. */
export function clipToVisible(rect: Rect, visible: { top: number; bottom: number } | null): Rect {
  if (!visible) return rect;
  const top = Math.max(rect.top, visible.top);
  return { ...rect, top, bottom: Math.max(top, Math.min(rect.bottom, visible.bottom)) };
}

/** A client rectangle in the chrome's own px. */
export function chromeRect(r: { left: number; top: number; right: number; bottom: number }, scale: number): Rect {
  return { left: r.left / scale, top: r.top / scale, right: r.right / scale, bottom: r.bottom / scale };
}
