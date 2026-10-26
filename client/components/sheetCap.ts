import { screenHeight } from "../features/device/layout.ts";
import type { KeyboardView } from "../lib/keyboardInset.ts";
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
 *
 * While the on-screen keyboard is open (lib/keyboardInset.ts) the sheet
 * rides on it: its foot stands at the visible area's bottom where the
 * keyboard reaches above the toolbar, and its top stays clear of the bars
 * or, where the browser has panned the page up to show a field, of the
 * visible area's top, the same gap or reserve below that. The 60% share
 * stays the screen's, so a keyboard never makes a sheet taller.
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
  /** The on-screen keyboard's view, in the chrome's own pixels (sheetKeyboard). */
  keyboard?: SheetKeyboard | null;
};

/** The keyboard's view (lib/keyboardInset.ts) in the chrome's own pixels: where the visible area starts, and how much of the layout's bottom it hides. */
export type SheetKeyboard = { top: number; inset: number };

/** The keyboard's view in a sheet's own pixels, at the interface size `zoom`. */
export function sheetKeyboard(view: KeyboardView | null, zoom: number): SheetKeyboard | null {
  return view ? { top: view.top / zoom, inset: view.inset / zoom } : null;
}

/** The pixels between the top bars and the toolbar left for the sheet once the gap or reserve above it is kept. Under SHEET_MIN_HEIGHT, the dock does not fit (3.2.1). */
export function sheetRoom(space: SheetSpace): number {
  const kb = space.keyboard;
  const above = Math.max(space.safeTop + space.insetTop, kb?.top ?? 0);
  const below = Math.max(space.safeBottom + space.insetBottom, kb?.inset ?? 0);
  return space.height - above - below - Math.max(SHEET_TOP_GAP, space.reserveTop ?? 0);
}

/** The sheet's height cap in pixels: the rule sheetMaxHeight writes as CSS. */
export function sheetCap(space: SheetSpace): number {
  return Math.max(SHEET_MIN_HEIGHT, Math.min((space.height * SHEET_SCREEN_SHARE) / 100, sheetRoom(space)));
}

/**
 * The bottom sheet's `maxHeight`. The safe areas stay CSS (`env()`), and
 * the share of the screen goes through screenHeight, which divides out the
 * interface size's zoom. With the keyboard open it is sheetRoom's rule,
 * with the sheet's top and foot from sheetTop and sheetFoot.
 */
export function sheetMaxHeight(inset: { top: number; bottom: number }, reserveTop = 0, keyboard: SheetKeyboard | null = null): string {
  const gap = Math.max(SHEET_TOP_GAP, reserveTop);
  const room = keyboard
    ? `calc(100% - ${sheetTop(inset.top, keyboard)} - ${sheetFoot(inset.bottom, keyboard)} - ${gap}px)`
    : `calc(100% - ${theme.safe.top} - ${theme.safe.bottom} - ${inset.top + inset.bottom + gap}px)`;
  return `max(${SHEET_MIN_HEIGHT}px, min(${screenHeight(SHEET_SCREEN_SHARE)}, ${room}))`;
}

/** Where a sheet's foot stands above the layout's bottom: on the toolbar `bottom` px tall, or on the keyboard where that reaches higher. */
export function sheetFoot(bottom: number, keyboard: SheetKeyboard | null): string {
  const bar = `calc(${theme.safe.bottom} + ${bottom}px)`;
  return keyboard ? `max(${bar}, ${keyboard.inset}px)` : bar;
}

/** Where a sheet on the right starts below the layout's top, and the line a bottom sheet keeps its gap under: the top bars `top` px tall, or the visible area's top where the page is panned past them. */
export function sheetTop(top: number, keyboard: SheetKeyboard | null): string {
  const bars = `calc(${theme.safe.top} + ${top}px)`;
  return keyboard ? `max(${bars}, ${keyboard.top}px)` : bars;
}

/**
 * A bottom sheet's widest, in the chrome's own pixels: a medium dialog's
 * (docs/design-v1-look-pass.md 2.8). A sheet as wide as a tablet held
 * upright set a field's label 600 px from its input and ran help past 90
 * characters a line, so a wider screen centers the sheet over the map at
 * this width. A phone, under 560 px across, never meets it. The sheet on
 * the right of a phone held sideways has its own width (sideSheetWidth),
 * and the very short mode keeps the whole screen.
 */
export const SHEET_MAX_WIDTH = theme.layout.dialog.md;

/** A sheet's width in the chrome's own pixels, its borders included, for a layout `layoutWidth` across. */
export function sheetWidth(mode: "bottom" | "side" | "full", layoutWidth: number): number {
  if (mode === "side") return sideSheetWidth(layoutWidth);
  return mode === "bottom" ? Math.min(layoutWidth, SHEET_MAX_WIDTH) : layoutWidth;
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
