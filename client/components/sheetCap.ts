import { screenHeight } from "../features/device/layout.ts";
import { theme } from "../lib/theme.ts";

/**
 * How tall a bottom sheet may grow (components/Sheet.tsx), as CSS for the
 * sheet and in numbers for whoever must know whether something fits
 * above it (docs/design-v1-visual.md 2.3 and 3.2.1).
 *
 * A sheet takes at most 60% of the screen, and keeps a gap free between
 * the top bars and its top edge: 24 px, so the map still shows above it,
 * or `reserveTop` when something docks there (the folded token bar and
 * the fight alerts, 3.2.1). It never goes below SHEET_MIN_HEIGHT: the
 * 56 px header, one 44 px row and the start of the next, so its body
 * still reads as a list that scrolls. When the bars, the safe areas and
 * the reserve leave less than that, the sheet keeps its minimum and the
 * gap gives way.
 */

export const SHEET_MIN_HEIGHT = 120;
/** The map that stays in view above a sheet when nothing docks there. */
export const SHEET_TOP_GAP = 24;
/** The share of the screen's height a sheet may take. */
export const SHEET_SCREEN_SHARE = 60;

export type SheetSpace = {
  /** The layout's height, in the chrome's own pixels (features/device/layout.ts layoutSize). */
  height: number;
  safeTop: number;
  safeBottom: number;
  /** The top bars' and the toolbar's heights, before the safe areas, as the Sheet's `inset` takes them. */
  insetTop: number;
  insetBottom: number;
  /** What docks on the sheet's top edge, with its gap. */
  reserveTop?: number;
};

/** The pixels between the top bars and the toolbar left for the sheet once the gap or reserve above it is kept. Under SHEET_MIN_HEIGHT, the dock does not fit (3.2.1). */
export function sheetRoom(space: SheetSpace): number {
  return space.height - space.safeTop - space.safeBottom - space.insetTop - space.insetBottom - Math.max(SHEET_TOP_GAP, space.reserveTop ?? 0);
}

/** The sheet's height cap in pixels: the rule sheetMaxHeight writes as CSS. */
export function sheetCap(space: SheetSpace): number {
  return Math.max(SHEET_MIN_HEIGHT, Math.min((space.height * SHEET_SCREEN_SHARE) / 100, sheetRoom(space)));
}

/**
 * The bottom sheet's `maxHeight`. The safe areas stay CSS (`env()`), and
 * the share of the screen goes through screenHeight, which divides out the
 * interface size's zoom.
 */
export function sheetMaxHeight(inset: { top: number; bottom: number }, reserveTop = 0): string {
  const gap = Math.max(SHEET_TOP_GAP, reserveTop);
  return `max(${SHEET_MIN_HEIGHT}px, min(${screenHeight(SHEET_SCREEN_SHARE)}, calc(100% - ${theme.safe.top} - ${theme.safe.bottom} - ${inset.top + inset.bottom + gap}px)))`;
}
