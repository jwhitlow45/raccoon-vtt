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
 * 60 px header of a sheet that swipes, one 44 px row and the start of the
 * next, so its body still reads as a list that scrolls. When the bars, the
 * safe areas and the reserve leave less than that, the sheet keeps its
 * minimum and the gap gives way.
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

// ------------------------------------------------------------ sideways sheets (docs/design-v1-layout-hierarchy.md 4.2)

/** A sheet header's one row, and the stacked header of a narrow sheet: 6 px, the 44 px row, a 22 px title line, 6 px. */
export const SHEET_HEADER = 56;
export const SHEET_HEADER_STACKED = 78;
/** The least body a sheet keeps below its header: two 44 px rows, one whole control and room to see there is more. */
export const SHEET_BODY_MIN = 88;
/** A header's title never shrinks below a few letters and the ellipsis (SheetHeader.tsx). */
const TITLE_MIN = 40;
const HEADER_GAP = theme.space(1);

/**
 * Whether a sheet's header stacks: its buttons at 44 px each, a title of
 * at least 40 px, a 4 px gap between each two and the header's side
 * padding (8 px, or 4 px when it holds actions such as the dock's) do not
 * fit in one row. Back, Hide and Close need 200 px, or 192 with actions.
 * `width` is the header's: the sheet's width less its side padding (the
 * safe areas it holds) and its 1 px borders, which Room knows from the
 * layout, so the header never flickers between two shapes as it measures.
 */
export function headerStacks(input: { width: number; buttons: number; actions: boolean }): boolean {
  const padding = input.actions ? theme.space(1) : theme.space(2);
  return input.width < input.buttons * (theme.touch + HEADER_GAP) + TITLE_MIN + 2 * padding;
}

/** A sheet docked on the right of a phone held sideways: 340 px, or 60% of a narrower layout (Sheet.tsx). */
export function sideSheetWidth(layoutWidth: number): number {
  return Math.min(theme.layout.landscapeSheetWidth, layoutWidth * 0.6);
}

/**
 * A sideways sheet runs from under the top bars (52 px, and 48 more while
 * the turn strip is a band) to the toolbar (60 px), inside the safe areas.
 * Where that leaves its body under 88 px below its header, inside its 1 px
 * borders, it opens in the very short mode, "full": the whole screen,
 * modal, over the bars. All of it comes from the layout, never from a
 * measure.
 */
export function sheetMode(input: { height: number; safeTop: number; safeBottom: number; topBars: number; header: number }): "side" | "full" {
  const body = input.height - input.safeTop - input.topBars - input.safeBottom - theme.layout.toolbar - input.header - 2 * theme.line.border;
  return body < SHEET_BODY_MIN ? "full" : "side";
}
