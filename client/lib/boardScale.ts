/**
 * How big the board's marks and text draw at a zoom (decided 2026-10-14).
 * Every token mark and board label is sized in cells, so it grows and
 * shrinks with the tokens and the map, pinned to its old fixed size at
 * PIN_CELL_PX. Two bounds keep that usable:
 *
 * - Each text element is clamped on its own to TEXT_FLOOR_PX, so a phone
 *   zoomed out to a whole scene (11 to 13 px a cell, where a name would be
 *   3 px tall) still draws readable text. Below the floor, text stops
 *   shrinking, and the label placement (boardText.ts) drops what no longer
 *   fits instead.
 * - A ceiling, so a close zoom does not draw names over the map.
 *
 * Strokes and icon-only marks have their own, lower floors so they stay
 * visible. Touch targets, handles and the bars over the map stay in screen
 * pixels, since fingers do not zoom.
 *
 * Font sizes are rounded to half pixels, and the measure caches by the size
 * it is given, so what placement measures is exactly what Konva draws. The
 * rounding makes text grow in steps while the map grows smoothly, so a
 * label's shape (where its name wraps) is decided from the sizes before
 * rounding instead (`unrounded`, lib/boardText.ts).
 */

/** The zoom at which every scaled mark is its old fixed size: about ten cells across a phone. */
export const PIN_CELL_PX = 40;
/** No board text draws smaller than this, a size a phone at a dim table still reads. */
export const TEXT_FLOOR_PX = 11;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const half = (v: number) => Math.round(v * 2) / 2;

/** A text size: its design size at the pin, scaled with the zoom, clamped to the floor and its ceiling. */
export function textPx(designPx: number, cellPx: number, ceilingPx: number): number {
  return half(unroundedTextPx(designPx, cellPx, ceilingPx));
}

function unroundedTextPx(designPx: number, cellPx: number, ceilingPx: number): number {
  return clamp((designPx * cellPx) / PIN_CELL_PX, TEXT_FLOOR_PX, ceilingPx);
}

export type BoardSizes = {
  /** Screen pixels per cell over PIN_CELL_PX, unclamped. */
  f: number;
  /** A token's name. */
  namePx: number;
  /** Its HP line: numbers, or a word such as "Bloodied". */
  hpPx: number;
  /** The selected or hovered token's full label. */
  focusNamePx: number;
  focusHpPx: number;
  /** Board pills that follow the map: area names, range labels, ping and laser names, area previews. */
  pillPx: number;
  /** A condition chip that shows only an icon. A chip holding text grows to fit it (chipFit). */
  chipPx: number;
  /** Letters on a chip ("Ex", "+3"), a counter on a chip, and the elevation badge's text. */
  chipTextPx: number;
  counterPx: number;
  badgeTextPx: number;
  /** A numbered picture token's number, shown when its name gives way. */
  numberPx: number;
  /** The disposition ring around a token. Outlines scale with it. */
  ringPx: number;
  /** The HP bar's height. */
  barPx: number;
  /** Clearance between a label and what it keeps off. */
  gapPx: number;
  /**
   * The label sizes before rounding to half pixels, which follow the zoom
   * smoothly between the floor and the ceiling. Labels decide their shape
   * from these and draw at the rounded ones.
   */
  unrounded: { namePx: number; focusNamePx: number; gapPx: number };
};

/**
 * This device's interface size (features/device, docs/design-v1-dm-tools.md
 * 3.16). The names, chips and badges drawn on tokens grow and shrink with
 * the bars and panels, while the map and the tokens themselves keep the
 * zoom's size. A module value, not an argument, because every board
 * renderer reads its sizes here, the token renderers among them, and the
 * canvas draws anew when it changes (canvas/Stage.tsx).
 */
let interfaceScale = 1;

export function setBoardInterfaceScale(scale: number): void {
  interfaceScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function boardSizes(cellPx: number, ui: number = interfaceScale): BoardSizes {
  const f = cellPx / PIN_CELL_PX;
  const nameUnrounded = unroundedTextPx(12, cellPx, 16);
  const namePx = half(nameUnrounded);
  const hpPx = textPx(11, cellPx, 15);
  const gapUnrounded = clamp(3 * f, 2, 4);
  // Every screen size but the ring scales: the ring is the token's own edge, which belongs to the map.
  const k = (px: number) => half(px * ui);
  return {
    f,
    namePx: k(namePx),
    hpPx: k(hpPx),
    focusNamePx: k(Math.max(14, namePx)),
    focusHpPx: k(Math.max(14, hpPx)),
    pillPx: k(textPx(12, cellPx, 16)),
    chipPx: k(clamp(18 * f, 12, 28)),
    chipTextPx: k(textPx(10, cellPx, 15)),
    counterPx: k(textPx(8, cellPx, 13)),
    badgeTextPx: k(textPx(11, cellPx, 15)),
    numberPx: k(textPx(10, cellPx, 14)),
    ringPx: half(clamp(3 * f, 1.5, 5)),
    barPx: k(clamp(5 * f, 3, 8)),
    gapPx: k(gapUnrounded),
    unrounded: { namePx: nameUnrounded * ui, focusNamePx: Math.max(14, nameUnrounded) * ui, gapPx: gapUnrounded * ui },
  };
}

/**
 * A chip's side when it holds text: the icon chip's side, or the text plus a
 * little room, whichever is bigger, so letters at the floor never spill out.
 */
export function chipFit(sizes: Pick<BoardSizes, "chipPx" | "chipTextPx">, textWidthPx: number): number {
  return Math.max(sizes.chipPx, Math.ceil(Math.max(textWidthPx + 6, sizes.chipTextPx + 6)));
}
