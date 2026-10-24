import { createStore } from "zustand/vanilla";
import type { Point, Size } from "../lib/camera.ts";
import { isFinePointer } from "../lib/device.ts";
import { TAP_SLOP_PX } from "../lib/gestures.ts";
import { scopeSlot, type RoomScope } from "../state/scope.ts";

/*
 * Where the token action bar sits (docs/design-v1-bar-dock.md), as plain
 * functions over boxes in the chrome's own pixels (features/device/layout.ts),
 * so every rule runs under node --test.
 *
 * On a screen 600 px or wider, or one wider than tall, the bar docks: it
 * keeps one spot in the map's free area, the bottom right unless the
 * viewer moved it, so it never covers the tokens it acts on. A phone held
 * upright keeps the bar that spans the screen under its token. A screen
 * too short for either opens the bar as a taller overlay. The fight
 * alerts column and the floating notices share the right side of the map
 * with the bar, and `shareLane` and `noticePlace` settle who gives way.
 */

/**
 * The narrowest default width of a bar that does not span, and its width
 * until Room has measured the default (defaultBarWidth).
 */
export const BAR_WIDTH = 304;
/** The frame's 12 px side padding and 1 px borders, each side. */
const FRAME_SIDES = 26;
/** The gap between buttons in a row. */
const ROW_GAP = 4;

/**
 * The default width of a window that does not span
 * (docs/design-v1-token-window.md 3.3): the narrowest that holds
 * Conditions, Hidden and Multi-select on one line as this page draws them,
 * and never under 304. `buttons` are the widths of three hidden small
 * buttons with those labels, in layout px, so the device's font and the
 * browser's minimum font size count. The last pixel keeps sub-pixel
 * rounding from wrapping the row.
 */
export function defaultBarWidth(buttons: readonly number[]): number {
  const row = buttons.reduce((sum, w) => sum + w, 0) + ROW_GAP * Math.max(0, buttons.length - 1);
  return Math.max(BAR_WIDTH, Math.ceil(FRAME_SIDES + row) + 1);
}
/** The right of the free area that the column and a docked bar share: the bar and an 8 px gap before the map. */
export const LANE_WIDTH = 312;
/** The margin the free area keeps from every edge, and the gap between the column and the bar. */
export const EDGE = 8;
/**
 * The least height a docked or spanning bar needs: its header and two
 * 44 px rows of buttons with their gaps, or under the alerts summary row
 * the header and one row. Shorter than this, it opens compact. The sticky
 * header is 52 px now (components/SheetHeader.tsx), so a bar given just
 * this much shows its second row up to 4 px under the "Scroll for more"
 * fade. It stays 148 so 844 x 390 at 130% with a phone's insets, which
 * leaves 151, still docks (docs/design-v1-bar-dock.md 1.4).
 */
export const MIN_BAR_HEIGHT = 148;
/** Below this layout width, a layout no wider than tall spans the bar as a phone does. */
export const DOCK_MIN_WIDTH = 600;
/** The narrowest bar the app already draws (an upright span at 320 px and 130%), so the narrowest room beside the lane. */
export const BESIDE_MIN = 230;
/** The least height the bar gives way to under the column's first card. */
export const BAR_FLOOR = 120;
/** The column's alerts summary row, which stands in for its cards when nothing else fits. */
export const SUMMARY_ROW = 44;
/**
 * How tall the column's "Scroll for more" fade stands over its foot
 * (TokenActionBar.tsx SCROLL_FOR_MORE_PX). A bar stacked under the first
 * card keeps up to this much more room under it while more cards follow,
 * so the fade lies past the card and never over its last line (firstFoot).
 */
export const COLUMN_FADE = 48;
/** A dropped bar whose edge lands this close to the free area's edge snaps to it. */
export const SNAP_PX = 24;
/** The least room left of the lane for the notices to center there instead of spanning. */
export const NOTICES_BESIDE_MIN = 320;

export type Box = { left: number; top: number; width: number; height: number };
export type Sides = { top: number; right: number; bottom: number; left: number };
export type BarMode = "span" | "dock" | "compact";

/**
 * What Room measures of its chrome, in the chrome's own pixels. A safe
 * area counts at its full size, since the chrome adds `env()` inside its
 * zoom (design section 1).
 */
export type Chrome = {
  /** The top bar with the turn band and the top safe area. */
  top: number;
  /**
   * The toolbar with the bottom safe area, the tool's options row while it
   * stands at the foot, and its line's reserve: everything that stands over
   * the map's foot (docs/design-v1-tool-options.md 10.2).
   */
  bottom: number;
  /** As `bottom`, but only up to the row's highest control, or the line's top where it holds a reading, a warning or a status: a hint may be covered. */
  controls: number;
  /** The toolbar alone, with the bottom safe area. */
  toolbar: number;
  safe: Sides;
  /** A phone's sheet docked on the right in landscape, or 0. It covers the right safe area. */
  sheet: number;
};

export const NO_SIDES: Sides = { top: 0, right: 0, bottom: 0, left: 0 };

/** Until Room has measured: a 52 px top bar and a 60 px toolbar, no safe areas. */
export const DEFAULT_CHROME: Chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: NO_SIDES, sheet: 0 };

/**
 * The bars a token bar keeps clear of: the measured chrome, with its top
 * past the lasting notices, spanning the map or beside the alerts' lane.
 * They paint over the bar, and under the Starting view notice its header
 * and Close took no tap.
 */
export function barChrome(state: { chrome: Chrome | null; lasting: number | null }): Chrome {
  const chrome = state.chrome ?? DEFAULT_CHROME;
  return state.lasting === null || state.lasting <= chrome.top ? chrome : { ...chrome, top: state.lasting };
}

/**
 * The part of the map a docked bar lives in: the map less the bars over
 * it, the side safe areas and a landscape sheet, with an 8 px margin all
 * round. Its height may come out at 0 or less on a short
 * screen. `foot` is a roll card standing on a narrow screen's toolbar and
 * the active tool's options (features/rolls/PlayerRolls.tsx), which the
 * bar keeps above.
 */
export function freeArea(viewport: Size, chrome: Chrome, foot = 0): Box {
  const left = chrome.safe.left + EDGE;
  const right = viewport.width - (chrome.sheet > 0 ? chrome.sheet : chrome.safe.right) - EDGE;
  const top = chrome.top + EDGE;
  const bottom = viewport.height - chrome.bottom - Math.max(0, foot) - EDGE;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Span, dock or compact (design 1.1). `layout` is the window in the
 * chrome's pixels, which decides the device's shape, and `freeHeight` the
 * free area's height, which decides whether a bar fits at all.
 */
export function barMode(layout: Size, freeHeight: number): BarMode {
  if (freeHeight < MIN_BAR_HEIGHT) return "compact";
  return uprightLayout(layout) ? "span" : "dock";
}

/**
 * Where a bar hangs: from its top edge down, or from its bottom edge up,
 * as tall as its content up to `room`. A bar that hangs by its bottom
 * grows upward, so its buttons stay where the thumb left them.
 */
export type Hang = { left: number; width: number; anchor: "top" | "bottom"; at: number; room: number };

/** The box a bar draws for a content height. */
export function hangBox(hang: Hang, height: number): Box {
  const h = Math.max(0, Math.min(height, hang.room));
  return { left: hang.left, width: hang.width, top: hang.anchor === "top" ? hang.at : hang.at - h, height: h };
}

/**
 * The compact overlay (design 1.4): the dock's place across, or the
 * span's whole width on an upright layout, and down from 8 px under the
 * top bars to 8 px above the toolbar when that leaves it 148 px, else to
 * 8 px above the bottom safe area, over the toolbar too. It hangs by its
 * bottom, so a short bar sits where a docked one would.
 */
export function compactHang(layout: Size, viewport: Size, chrome: Chrome, barWidth = BAR_WIDTH): Hang & { coversToolbar: boolean } {
  const free = freeArea(viewport, chrome);
  const upright = layout.width <= layout.height;
  const width = Math.max(0, upright ? free.width : Math.min(barWidth, free.width));
  const left = upright ? free.left : free.left + free.width - width;
  const aboveToolbar = viewport.height - chrome.toolbar - EDGE;
  const coversToolbar = aboveToolbar - free.top < MIN_BAR_HEIGHT;
  const bottom = coversToolbar ? viewport.height - chrome.safe.bottom - EDGE : aboveToolbar;
  return { left, width, anchor: "bottom", at: bottom, room: Math.max(0, bottom - free.top), coversToolbar };
}

// ------------------------------------------------------------ the stored spot

export type Corner = "tl" | "tr" | "bl" | "br";

/**
 * Where the viewer left a docked bar, as `rvtt.tokenBarSpot` stores it:
 * the free area's corner nearest the bar's center, and the gaps from that
 * corner's two edges to the bar's matching corner. Kept as gaps from a
 * corner, so the bar keeps its corner through a resize, a rotation or a
 * sheet opening, and comes back to its spot when the room does.
 */
export type Spot = { corner: Corner; x: number; y: number };

export const SPOT_KEY = "rvtt.tokenBarSpot";
export const DEFAULT_SPOT: Spot = Object.freeze({ corner: "br", x: 0, y: 0 });
const SPOT_MAX = 4096;
const CORNERS: readonly Corner[] = ["br", "bl", "tl", "tr"];

/** The stored spot, or the default for anything else: a missing key, bad JSON, an unknown corner, a fraction, a negative or a gap past 4096. */
export function parseSpot(raw: string | null): Spot {
  if (raw === null) return DEFAULT_SPOT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SPOT;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_SPOT;
  const { corner, x, y } = value as Record<string, unknown>;
  const gap = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= SPOT_MAX;
  if (!CORNERS.includes(corner as Corner) || !gap(x) || !gap(y)) return DEFAULT_SPOT;
  return { corner: corner as Corner, x, y };
}

export function isDefaultSpot(spot: Spot): boolean {
  return spot.corner === "br" && spot.x === 0 && spot.y === 0;
}

/** What to store for a spot: null for the default, which is stored as no key. */
export function spotText(spot: Spot): string | null {
  return isDefaultSpot(spot) ? null : JSON.stringify({ corner: spot.corner, x: spot.x, y: spot.y });
}

/** The spot this device stored. Storage can throw (a private window, blocked site data), which reads as the default. */
export function readSpot(storage?: Pick<Storage, "getItem">): Spot {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return parseSpot(from?.getItem(SPOT_KEY) ?? null);
  } catch {
    return DEFAULT_SPOT;
  }
}

export function writeSpot(spot: Spot, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const to = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const text = spotText(spot);
    if (text === null) to?.removeItem(SPOT_KEY);
    else to?.setItem(SPOT_KEY, text);
  } catch {
    // The spot then lasts as long as the page, which is all a blocked storage allows.
  }
}

/**
 * A docked bar's hang from its spot. The gaps are clamped to keep a bar of
 * this size inside the free area, and the spot itself is left alone, so
 * the bar returns to it once the room comes back.
 */
export function spotHang(spot: Spot, free: Box, size: Size): Hang {
  const width = Math.max(0, Math.min(size.width, free.width));
  const height = Math.max(0, Math.min(size.height, free.height));
  const x = clamp(spot.x, 0, Math.max(0, free.width - width));
  const y = clamp(spot.y, 0, Math.max(0, free.height - height));
  const left = spot.corner[1] === "l" ? free.left + x : free.left + free.width - x - width;
  const room = Math.max(0, free.height - y);
  return spot.corner[0] === "t" ? { left, width, anchor: "top", at: free.top + y, room } : { left, width, anchor: "bottom", at: free.top + free.height - y, room };
}

/** A box dragged past the free area's edges, pulled back inside it. */
export function clampBox(box: Box, free: Box): Box {
  const left = clamp(box.left, free.left, Math.max(free.left, free.left + free.width - box.width));
  const top = clamp(box.top, free.top, Math.max(free.top, free.top + free.height - box.height));
  return { ...box, left, top };
}

/**
 * The spot a dropped bar takes: the free area's corner nearest its
 * center, and its gaps from that corner, whole pixels. A gap within 24 px
 * snaps to 0, so a bar dropped near the bottom right is in its default
 * spot again. There is no grid.
 */
export function releaseSpot(box: Box, free: Box): Spot {
  return cornerSpot(box, free, SNAP_PX);
}

/**
 * The spot a step of the grip's arrow keys stores (docs/design-v1-token-window.md
 * 4.3): the nearest corner as a drop picks it, with no snapping, since a
 * 24 px snap would never let an 8 px step leave an edge.
 */
export function keySpot(box: Box, free: Box): Spot {
  return cornerSpot(box, free, 0);
}

function cornerSpot(box: Box, free: Box, snap: number): Spot {
  const right = box.left + box.width / 2 > free.left + free.width / 2;
  const bottom = box.top + box.height / 2 > free.top + free.height / 2;
  const x = right ? free.left + free.width - (box.left + box.width) : box.left - free.left;
  const y = bottom ? free.top + free.height - (box.top + box.height) : box.top - free.top;
  const gap = (n: number) => (n <= snap ? 0 : clamp(Math.round(n), 0, SPOT_MAX));
  return { corner: `${bottom ? "b" : "t"}${right ? "r" : "l"}`, x: gap(x), y: gap(y) };
}

/** An arrow key's step for the grip and the handle: 8 px, the free area's margin, or 64 with Shift. Null for any other key. */
export function arrowStep(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = shift ? 64 : EDGE;
  if (key === "ArrowLeft") return { dx: -step, dy: 0 };
  if (key === "ArrowRight") return { dx: step, dy: 0 };
  if (key === "ArrowUp") return { dx: 0, dy: -step };
  if (key === "ArrowDown") return { dx: 0, dy: step };
  return null;
}

/**
 * What the window's status says of where it stands, read from its stored
 * spot (docs/design-v1-token-window.md 4.3): its corner when flush with
 * both edges, the edge and the gap along it when flush with one, and both
 * gaps otherwise.
 */
export function spotWords(spot: Spot): string {
  const v = spot.corner[0] === "t" ? "top" : "bottom";
  const h = spot.corner[1] === "l" ? "left" : "right";
  if (spot.x === 0 && spot.y === 0) return `Window at ${v} ${h}`;
  if (spot.y === 0) return `Window at the ${v} edge, ${pixels(spot.x)} from the ${h}`;
  if (spot.x === 0) return `Window at the ${h} edge, ${pixels(spot.y)} from the ${v}`;
  return `Window ${pixels(spot.x)} from the ${h} and ${pixels(spot.y)} from the ${v}`;
}

/**
 * A distance as the status speaks it: "pixels" in full, since several
 * screen readers spell "px" out as two letters (the build review's W5B-P-6).
 */
export function pixels(n: number): string {
  const whole = Math.round(n);
  return `${whole} ${whole === 1 ? "pixel" : "pixels"}`;
}

/** What the status says once Reset brings the window home. */
export const RESET_WORDS = "Window back at bottom right";

/*
 * A docked window narrower than the default width happens only beside a
 * phone's open sideways sheet, and its header follows the width it gets
 * (docs/design-v1-token-window.md 7.1). A header in two rows there left a
 * short window little more than its header, with Apply out of view (the
 * build review's W5B-P-3), so the header keeps one row at every width the
 * window shows at. What gives way first is what the window keeps elsewhere:
 * an elevation badge moves to the end of the vitals line, under the name,
 * and the Elevation row still says it. Then, on a touch device, where no
 * arrow keys move the window, the grip gives way to its drawn dots, which
 * drag as the header does. Narrower than that row, the window folds into
 * the sheet's header. Reset counts whether it shows or not, so moving the
 * window never changes the header. A computer's window is never narrower
 * than the default width, and should one be, its grip stays a button, the
 * keys' control, and the name gives up its floor instead.
 */
/** The grip as a button, and as the drawn dots a narrow window on a touch device keeps. */
const GRIP_BUTTON = 44;
const GRIP_DOTS = 16;
/** A badge up to "↑120 ft", about 51 px, and its gap. */
const BADGE = 51 + 4;
/** One row with the grip, the name's 40 px floor, Reset and Close, three 4 px gaps and the frame's 26 px, and the badge where it shows. */
export function headerRowMin(grip: "button" | "dots", badge: boolean): number {
  return (grip === "button" ? GRIP_BUTTON : GRIP_DOTS) + 40 + 44 + 44 + 3 * 4 + 26 + (badge ? BADGE : 0);
}
/** Narrower than one row with the dots and no badge, the window folds into the sheet's header. */
export const WINDOW_FOLD_BELOW = headerRowMin("dots", false);

/** A docked window's header at its width: whether its grip is a button or the dots, and whether an elevation badge stays in it. */
export function headerLayout(width: number, finePointer: boolean): { grip: "button" | "dots"; badgeInHeader: boolean } {
  return {
    grip: finePointer || width >= headerRowMin("button", false) ? "button" : "dots",
    badgeInHeader: width >= headerRowMin("button", true),
  };
}

// ------------------------------------------------------------ the stored size

/**
 * The size this device gave the token window on a computer, as
 * `rvtt.tokenBarSize` stores it (docs/design-v1-token-window.md 6): a
 * width, which the window takes exactly within its limits, and a height,
 * which caps it. Either may be missing, which is the default: the default
 * width, and as tall as the content up to the room.
 */
export type BarSize = { w?: number; h?: number };

export const SIZE_KEY = "rvtt.tokenBarSize";
export const NO_SIZE: BarSize = Object.freeze({});
const SIZE_MAX = 4096;

/** The stored size, or the default for anything else: a missing key, bad JSON, a fraction, a negative, zero, over 4096, a string, or no field at all. */
export function parseSize(raw: string | null): BarSize {
  if (raw === null) return NO_SIZE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_SIZE;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_SIZE;
  const { w, h } = value as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SIZE_MAX;
  if ((w !== undefined && !ok(w)) || (h !== undefined && !ok(h))) return NO_SIZE;
  return { ...(ok(w) ? { w } : {}), ...(ok(h) ? { h } : {}) };
}

export function hasSize(size: BarSize): boolean {
  return size.w !== undefined || size.h !== undefined;
}

/** What to store for a size: null for the default, which is stored as no key. */
export function sizeText(size: BarSize): string | null {
  return hasSize(size) ? JSON.stringify({ ...(size.w !== undefined ? { w: size.w } : {}), ...(size.h !== undefined ? { h: size.h } : {}) }) : null;
}

/** The size this device stored. Storage can throw, which reads as the default. */
export function readSize(storage?: Pick<Storage, "getItem">): BarSize {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return parseSize(from?.getItem(SIZE_KEY) ?? null);
  } catch {
    return NO_SIZE;
  }
}

export function writeSize(size: BarSize, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const to = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const text = sizeText(size);
    if (text === null) to?.removeItem(SIZE_KEY);
    else to?.setItem(SIZE_KEY, text);
  } catch {
    // The size then lasts as long as the page.
  }
}

/** The shortest a resized window gets: its 52 px header and two rows of buttons whole, 4 px over the least a docked bar needs. */
export const MIN_WINDOW_HEIGHT = MIN_BAR_HEIGHT + 4;
/**
 * How far the resize handle reaches past the window's corner: half its
 * 24 px disc. The free area's margin and the lane's gap are 8, so a
 * resizable window's free sides keep 4 px more from whatever clips or
 * covers, and the whole handle stays on the map and on top (5.3).
 */
export const HANDLE_REACH = 12;
const REACH_EXTRA = HANDLE_REACH - EDGE;
/** A width or height that ends within this of its default stores none (5.4). */
export const SIZE_SNAP = 24;

/** Where the resize handle stands: the window's corner diagonally opposite its spot's corner (5.3). */
export function handleCorner(corner: Corner): Corner {
  return `${corner[0] === "t" ? "b" : "t"}${corner[1] === "l" ? "r" : "l"}`;
}

/** The window's sides away from its spot's corner, where the handle and its bands stand. */
export function freeSides(corner: Corner): Sides {
  return { top: corner[0] === "b" ? 1 : 0, bottom: corner[0] === "t" ? 1 : 0, left: corner[1] === "r" ? 1 : 0, right: corner[1] === "l" ? 1 : 0 };
}

/** The extra room each side keeps for the handle: 4 px on the free sides of a resizable window, none on its anchored sides or anywhere else. */
export function handleReach(corner: Corner, resizable: boolean): Sides {
  if (!resizable) return NO_SIDES;
  const f = freeSides(corner);
  return { top: f.top * REACH_EXTRA, right: f.right * REACH_EXTRA, bottom: f.bottom * REACH_EXTRA, left: f.left * REACH_EXTRA };
}

/** A box less some room on each side. */
export function insetBox(box: Box, by: Sides): Box {
  return { left: box.left + by.left, top: box.top + by.top, width: Math.max(0, box.width - by.left - by.right), height: Math.max(0, box.height - by.top - by.bottom) };
}

/**
 * The room a window may move in: the free area, less the handle's reach on
 * the free sides of the corner nearest its middle, the corner a drop or a
 * key step will store.
 */
export function moveRoom(box: Box, free: Box, resizable: boolean): Box {
  return insetBox(free, handleReach(cornerSpot(box, free, 0).corner, resizable));
}

/** A box dragged or stepped past its room, pulled back inside it. */
export function clampMove(box: Box, free: Box, resizable: boolean): Box {
  return clampBox(box, moveRoom(box, free, resizable));
}

export type ResizePart = "corner" | "width" | "height";

/** The limits a resize meets, from the window's anchored edges (5.6): the default width and `MIN_WINDOW_HEIGHT` at least, the room and the content at most. */
export type ResizeLimits = { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number };

/**
 * The limits for a window anchored at `corner` with this box, in `room`
 * (the free area less the handle's reach), with `content` the height of
 * all it holds. Where the room is less than a least, the room wins.
 */
export function resizeLimits(input: { box: Box; corner: Corner; room: Box; defaultWidth: number; content: number }): ResizeLimits {
  const { box, corner, room } = input;
  const maxWidth = Math.max(0, corner[1] === "r" ? box.left + box.width - room.left : room.left + room.width - box.left);
  const roomHeight = Math.max(0, corner[0] === "b" ? box.top + box.height - room.top : room.top + room.height - box.top);
  const maxHeight = Math.min(roomHeight, input.content);
  return { minWidth: Math.min(input.defaultWidth, maxWidth), maxWidth, minHeight: Math.min(MIN_WINDOW_HEIGHT, maxHeight), maxHeight };
}

/**
 * The box a resize draws (5.4): the edges at the spot's corner stay put,
 * and the far edges follow the pointer, or the arrow keys' step. The handle
 * changes both dimensions, a band one. Each is held to its limits.
 */
export function resizeBox(input: { start: Box; corner: Corner; part: ResizePart; dx: number; dy: number; limits: ResizeLimits }): Box {
  const { start, corner, part, limits } = input;
  const right = corner[1] === "r";
  const bottom = corner[0] === "b";
  const width = part === "height" ? start.width : clamp(start.width + (right ? -input.dx : input.dx), limits.minWidth, limits.maxWidth);
  const height = part === "width" ? start.height : clamp(start.height + (bottom ? -input.dy : input.dy), limits.minHeight, limits.maxHeight);
  return { left: right ? start.left + start.width - width : start.left, top: bottom ? start.top + start.height - height : start.top, width, height };
}

/**
 * Where a window is drawn while a drag or a resize holds it: the dragged
 * box, held by the edge its spot's corner anchors, top or bottom, as at
 * rest. Its height is a cap, so content that wraps to fewer lines as the
 * window widens shrinks it away from that edge, which never moves under
 * the gesture (5.4, the build review's W5-ASTRA-05). The width is exact,
 * so the left and right edges are the box's.
 */
export function heldPlace(box: Box, corner: Corner, viewport: Size): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
  const across = { left: box.left, width: box.width, maxHeight: box.height };
  return corner[0] === "b" ? { ...across, bottom: viewport.height - (box.top + box.height) } : { ...across, top: box.top };
}

/**
 * The spot a resize stores: the drawn box's anchored edges, keeping its
 * corner, unsnapped, so a window clamped against the free area never jumps
 * on release by the clamp it had.
 */
export function anchoredSpot(box: Box, free: Box, corner: Corner): Spot {
  const x = corner[1] === "r" ? free.left + free.width - (box.left + box.width) : box.left - free.left;
  const y = corner[0] === "b" ? free.top + free.height - (box.top + box.height) : box.top - free.top;
  return { corner, x: clamp(Math.round(x), 0, SPOT_MAX), y: clamp(Math.round(y), 0, SPOT_MAX) };
}

/**
 * The size a pointer resize stores on release (5.4). A dimension the drag
 * changed by no more than the 8 px slop keeps its stored value, so a
 * clamped stored width is never written down as the clamp. A width within
 * 24 px of the default stores none, and a height within 24 px of the most
 * it may take (`tallest`: the content or the room) stores none, so the
 * window grows with its content again. Otherwise whole px.
 */
export function releaseSize(input: { stored: BarSize; start: Box; box: Box; defaultWidth: number; tallest: number }): BarSize {
  const { stored, start, box } = input;
  const w = Math.abs(box.width - start.width) <= TAP_SLOP_PX ? stored.w : Math.abs(box.width - input.defaultWidth) <= SIZE_SNAP ? undefined : Math.round(box.width);
  const h = Math.abs(box.height - start.height) <= TAP_SLOP_PX ? stored.h : input.tallest - box.height <= SIZE_SNAP ? undefined : Math.round(box.height);
  return withSize(w, h);
}

/**
 * The size a key step of the handle stores (5.5): the dimensions it
 * changed, unsnapped, so a width exactly at the default stores none and a
 * height at the most it may take stores none. The other keeps its value.
 */
export function keySize(input: { stored: BarSize; start: Box; box: Box; defaultWidth: number; tallest: number }): BarSize {
  const { stored, start, box } = input;
  const w = box.width === start.width ? stored.w : Math.round(box.width) === input.defaultWidth ? undefined : Math.round(box.width);
  const h = box.height === start.height ? stored.h : Math.round(box.height) >= Math.floor(input.tallest) ? undefined : Math.round(box.height);
  return withSize(w, h);
}

function withSize(w: number | undefined, h: number | undefined): BarSize {
  return { ...(w !== undefined ? { w: clamp(w, 1, SIZE_MAX) } : {}), ...(h !== undefined ? { h: clamp(h, 1, SIZE_MAX) } : {}) };
}

/** Which limit a key step met, the first of width then height, or null. */
export function limitMet(input: { start: Box; box: Box; dx: number; dy: number; corner: Corner; limits: ResizeLimits }): "narrowest" | "widest" | "shortest" | "tallest" | null {
  const { box, limits, corner } = input;
  const wantWider = (corner[1] === "r" ? -input.dx : input.dx) > 0;
  const wantTaller = (corner[0] === "b" ? -input.dy : input.dy) > 0;
  if (input.dx !== 0) {
    if (wantWider && box.width >= limits.maxWidth) return "widest";
    if (!wantWider && box.width <= limits.minWidth) return "narrowest";
  }
  if (input.dy !== 0) {
    if (wantTaller && box.height >= limits.maxHeight) return "tallest";
    if (!wantTaller && box.height <= limits.minHeight) return "shortest";
  }
  return null;
}

/** What the status says after the handle's keys: "Window 316 by 400 pixels", and the limit a press met. */
export function sizeWords(box: Pick<Box, "width" | "height">, limit: ReturnType<typeof limitMet>): string {
  const words = `Window ${Math.round(box.width)} by ${pixels(box.height)}`;
  return limit ? `${words}, ${limit} it can be here` : words;
}

// ------------------------------------------------------------ the right lane

export type Lane = "none" | "stacked" | "beside" | "summary";

/**
 * The column's measures as it publishes them: its top, its content's height
 * and its first card's. `row` is where its summary row stands while it has
 * risen from the column's top (InitiativeStrip.tsx FightAlerts), over the
 * band or the top bar's row, so the bar under it may take the room it left.
 * `cover` is the height of its first card counting a turn card, which only
 * a toast keeps under (toastTop): the bar's lane and a pane skip a turn
 * card, so a turn card alone gives facts whose `first` is 0.
 */
export type ColumnFacts = { top: number; content: number; first: number; cover?: number; row?: number };

/** The left edge of the lane, the right 312 px of the free area. */
export function laneLeft(free: Box): number {
  return free.left + free.width - LANE_WIDTH;
}

/** Whether a bar overlaps the lane across, so it meets the column. */
export function overlapsLane(hang: Pick<Hang, "left" | "width">, free: Box): boolean {
  return hang.left + hang.width > laneLeft(free);
}

/**
 * Who gives way when a bar and a column with cards overlap across
 * (design 1.3). `laneTop` and `laneHeight` are the free area's (the
 * overlay's when compact), and the first of these that fits wins:
 *
 * 1. Stacked: the column keeps at least its first card, and the bar sits
 *    8 px below it, no shorter than its floor, `min(120, L)`. Beyond the
 *    first card the column gives way first (it stops 8 px above the bar),
 *    then the bar down to its floor. A docked bar hung by its bottom moves
 *    down first, as far as the lane's bottom, so it keeps its content's
 *    height where the lane has room for it, and shrinks only past that.
 *    An upright span takes the first card's bottom as its top limit
 *    instead and stays off its token (placeBar).
 * 2. Beside: with 230 px or more left of the lane, the bar moves there,
 *    up to its own width, with the lane's whole height, and the column keeps
 *    the lane whole.
 * 3. Summary: the column shows a 44 px summary row in place of its cards,
 *    and the bar takes the rest of the lane, 8 px below it.
 *
 * With no cards nothing changes. Every room comes out at 0 or more.
 */
export function shareLane(input: {
  hang: Hang;
  laneTop: number;
  laneHeight: number;
  column: ColumnFacts | null;
  /** The lane's left edge, which a bar beside it keeps to. */
  laneLeft: number;
  /** The free width less the lane. */
  besideRoom: number;
  /** The bar's content height, which a bar hung by its bottom keeps by moving down. */
  content: number;
  /** More room a stacked bar keeps below the first card: the handle's reach, when its top is a free side (handleReach). */
  floorGap?: number;
}): { lane: Lane; hang: Hang } {
  const { hang, laneTop } = input;
  const laneBottom = laneTop + Math.max(0, input.laneHeight);
  const { lane, floor } = laneChoice(input);
  if (lane === "none") return { lane, hang };
  if (lane === "beside") {
    const width = Math.min(hang.width, input.besideRoom);
    const room = Math.max(0, hang.anchor === "top" ? laneBottom - hang.at : hang.at - laneTop);
    return { lane, hang: { ...hang, left: input.laneLeft - width, width, room } };
  }
  // A compact overlay already hangs from the lane's bottom (its lane is the overlay), so this leaves its bottom where it is.
  if (hang.anchor === "top") return { lane, hang: { ...hang, at: Math.max(hang.at, floor), room: Math.max(0, laneBottom - Math.max(hang.at, floor)) } };
  const at = Math.min(laneBottom, Math.max(hang.at, floor + Math.min(Math.max(0, input.content), laneBottom - floor)));
  return { lane, hang: { ...hang, at, room: Math.max(0, at - floor) } };
}

/**
 * Which way the lane goes for a bar that meets a column with cards
 * (shareLane), and the top the bar keeps below: the first card's bottom
 * when stacked, the summary row's when summarized, and the lane's own top
 * beside it or with no card.
 */
export function laneChoice(input: { laneTop: number; laneHeight: number; column: ColumnFacts | null; besideRoom: number; floorGap?: number }): { lane: Lane; floor: number } {
  const { laneTop, column } = input;
  const height = Math.max(0, input.laneHeight);
  if (!column || column.first <= 0) return { lane: "none", floor: laneTop };
  // Never above the lane: a column that has risen over the bars leaves the bar the lane's whole height, no more.
  const firstBottom = Math.max(laneTop, firstFoot(column) + (input.floorGap ?? 0));
  if (laneTop + height - firstBottom >= Math.min(BAR_FLOOR, height) && height > 0) return { lane: "stacked", floor: firstBottom };
  if (input.besideRoom >= BESIDE_MIN) return { lane: "beside", floor: laneTop };
  return { lane: "summary", floor: Math.max(laneTop, (column.row ?? column.top) + SUMMARY_ROW + EDGE) };
}

/**
 * The top a bar stacked under the column's first card keeps to: the
 * card's bottom and the 8 px gap, and while more cards follow, room for
 * the column's fade over its foot, or for all that follows where that is
 * shorter (COLUMN_FADE). Under the card alone the fade lay over its last
 * line, a time-up line's second one at 844 x 390.
 */
function firstFoot(column: ColumnFacts): number {
  return column.top + column.first + EDGE + Math.min(COLUMN_FADE, Math.max(0, column.content - column.first));
}

/** Where a map pane drawn as a card stands against a column with a card (paneLane). */
export type PaneLane = "beside" | "summary";

/** The lane as a map pane keeps out of it: the lane's left edge, and the top of the column's summary row, where its first card starts. */
export type PaneLaneBox = { left: number; top: number };

/**
 * Where a map pane drawn as a card (a label's, pin's, light's or trap's,
 * features/builder/labelEdit.ts panePlacement) goes while the column shows
 * a card (docs/design-v1-look-pass-2.md 2.8). The lane's rule for the
 * token window (shareLane) without its stacked step, since a pane stands
 * by its thing rather than in a corner:
 *
 * 1. Beside: where the room left of the lane holds the pane and both its
 *    margins, the pane keeps its right edge 8 px left of the lane.
 * 2. Summary: otherwise the column shows its summary row in place of its
 *    cards, and the pane keeps under the row where it meets the lane.
 *
 * `roomLeft` is the left edge of the room the pane may take, and `width`
 * the pane's width, in the lane's own px.
 */
export function paneLane(input: { laneLeft: number; roomLeft: number; width: number }): PaneLane {
  return input.laneLeft - input.roomLeft >= input.width + 2 * EDGE ? "beside" : "summary";
}

/**
 * The lane a map pane drawn as a card keeps out of (paneLane), while the
 * column shows a card or its summary row: the lane's left edge, as the
 * token window takes it (laneLeft), and where the row stands. `column` is
 * what the column publishes, which it keeps while its cards are hidden,
 * and `viewport` the map as the panes see it. The column's facts and the
 * chrome are already in the zoomed layout px the panes are placed in
 * (pages/Room.tsx divides the chrome by the zoom, the column its cards),
 * so nothing is divided here. Null before the chrome is measured, with no
 * card, or while a sheet folds the column.
 */
export function paneLaneBox(input: { viewport: Size; chrome: Chrome | null; column: ColumnFacts | null; folded: boolean }): PaneLaneBox | null {
  if (!input.chrome || !input.column || input.column.first <= 0 || input.folded) return null;
  return { left: laneLeft(freeArea(input.viewport, input.chrome)), top: input.column.row ?? input.column.top };
}

/**
 * The column's room while a bar shares the lane: down to 8 px above the
 * bar when stacked, nothing but the summary row when summarized, and the
 * whole lane otherwise. Null leaves the column as it is without a bar.
 */
export function columnRoom(input: { lane: Lane; columnTop: number; bar: Box }): number | null {
  if (input.lane === "stacked") return Math.max(0, input.bar.top - EDGE - input.columnTop);
  if (input.lane === "summary") return SUMMARY_ROW;
  return null;
}

// ------------------------------------------------------------ fit and find

/**
 * The bar's box as one inset over the map, for Fit the map, Find my token
 * and the pans that bring a token into view (design section 4). A bar in
 * the lane, or against the free area's right edge (`freeRight`), covers
 * the right side from its own left edge or the lane's, whichever is
 * further left, whatever its height, so a token never lands under a bar
 * that later grows, nor under a window wider than the lane
 * (docs/design-v1-token-window.md 9.1). A bar elsewhere covers the side
 * that leaves the largest clear rectangle. Measured from the viewport's
 * edges, like `bars`, in the same pixels as everything passed in.
 */
export function barCover(viewport: Size, bars: Sides, bar: { box: Box; laneLeft: number; freeRight: number; mode?: BarMode } | null): Sides {
  if (!bar) return NO_SIDES;
  const { box } = bar;
  // An upright phone's strip, or its expanded bar, crosses the free area at its foot, so it covers the bottom from its top whatever its height (docs/design-v1-bar-compact.md 4).
  if (bar.mode === "span") return { ...NO_SIDES, bottom: Math.max(0, viewport.height - box.top) };
  const inLane = box.left >= bar.laneLeft - 0.5;
  const againstRight = box.left + box.width >= bar.freeRight - 0.5;
  // A lane that does not fit the free area (a narrow phone) leaves the bar to cover a side like any other.
  if (bar.laneLeft > 0 && (inLane || againstRight)) return { ...NO_SIDES, right: Math.max(0, viewport.width - Math.min(box.left, bar.laneLeft)) };
  const sides: Sides[] = [
    { ...NO_SIDES, right: viewport.width - box.left },
    { ...NO_SIDES, bottom: viewport.height - box.top },
    { ...NO_SIDES, left: box.left + box.width },
    { ...NO_SIDES, top: box.top + box.height },
  ];
  const area = (cover: Sides) => {
    const clear = largerEach(bars, cover);
    return Math.max(0, viewport.width - clear.left - clear.right) * Math.max(0, viewport.height - clear.top - clear.bottom);
  };
  let best = sides[0]!;
  for (const side of sides) if (area(side) > area(best)) best = side;
  return best;
}

/** The larger inset on each side. */
export function largerEach(a: Sides, b: Sides): Sides {
  return { top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), left: Math.max(a.left, b.left) };
}

/** What a cover adds past the bars, for a caller that adds the two (features/find/findToken.ts findCamera). */
export function pastBars(cover: Sides, bars: Sides): Sides {
  return {
    top: Math.max(0, cover.top - bars.top),
    right: Math.max(0, cover.right - bars.right),
    bottom: Math.max(0, cover.bottom - bars.bottom),
    left: Math.max(0, cover.left - bars.left),
  };
}

/**
 * Where a pan lands its point once a cover takes part of the map: on each
 * axis the cover narrows, the middle of what it leaves. Without this a
 * 900 px window, whose map is 540 px wide, centers the token under the bar.
 */
export function clearAnchor(point: { x: number; y: number }, viewport: Size, bars: Sides, cover: Sides): { x: number; y: number } {
  const clear = largerEach(bars, cover);
  const x = cover.left > bars.left || cover.right > bars.right ? clear.left + (viewport.width - clear.left - clear.right) / 2 : point.x;
  const y = cover.top > bars.top || cover.bottom > bars.bottom ? clear.top + (viewport.height - clear.top - clear.bottom) / 2 : point.y;
  return x === point.x && y === point.y ? point : { x, y };
}

/** Below the token's name label, which hangs about 30 px under the footprint. */
export const OFFSET_Y = 34;
/**
 * The room an upright phone's bar gets on this screen whichever token is
 * tapped: the expanded bar's reach with no content
 * (docs/design-v1-bar-compact.md 9.1), which never reads a token. Given no
 * layout, the reach the free area alone leaves, which only a layout over
 * about 770 px tall caps lower.
 */
export function spanRoomAtWorst(free: Box, layout?: Size): number {
  return expandReach({ layout: layout ?? { width: 0, height: Number.POSITIVE_INFINITY }, free });
}

/**
 * Where the bar hangs, before a drag: at the free area's foot as the strip
 * or its expanded bar on an upright phone, whatever its token does
 * (docs/design-v1-bar-compact.md 3), at its spot when it docks, and the
 * overlay's place when compact, then shared with the column when they
 * meet across. The one rule for the bar drawn (TokenActionBar.tsx) and for
 * where a pan expects it (restingBar).
 */
export function placeBar(input: {
  layout: Size;
  viewport: Size;
  chrome: Chrome;
  foot: number;
  /** The selected token's anchor, which no placement reads: the strip and the window keep their places whatever the token does. */
  anchor?: Point | null;
  /** How far the token's top stands above `anchor`, which no placement reads either. */
  tokenHeight?: number;
  spot: Spot;
  /** The bar's content height. */
  height: number;
  column: ColumnFacts | null;
  /** The default width (defaultBarWidth), which every bar that does not span takes. */
  width?: number;
  /** The size this device stored (BarSize), which a resizable window takes: its width, and its height as a cap. */
  size?: BarSize;
  /** The window resizes here: on a computer, where it docks (5.1). Elsewhere the size is ignored and stays stored. */
  resizable?: boolean;
  /** The strip held since it showed (the dock store's `heldMode`), which no change of the free area turns compact. */
  heldMode?: HeldMode;
  /** Where a player's roll card stands (the dock store's `cardAt`), which the opening rule reads (openMode). */
  cardAt?: CardAt;
  /** The strip rests, or is expanded to `expandedHeight` (the dock store's, frozen at Expand), while it spans. */
  state?: RestState;
  expandedHeight?: number | null;
  /** The foot the strip places by: `foot`, or 0 while a roll card at the foot yields to it (stripSqueezed). */
  restFoot?: number;
}): { mode: BarMode; free: Box; hang: Hang; lane: Lane; resizable: boolean; room: Box } | null {
  const barWidth = input.width ?? BAR_WIDTH;
  const free = freeArea(input.viewport, input.chrome, input.foot);
  const mode = heldOrOpenMode({ layout: input.layout, free, foot: input.foot, cardAt: input.cardAt ?? null, heldMode: input.heldMode ?? null });
  if (mode === "span") {
    const strip = input.restFoot === undefined ? free : freeArea(input.viewport, input.chrome, input.restFoot);
    const state = input.state ?? "rest";
    const hang = restHang(strip, state, input.expandedHeight ?? null);
    const lane = state === "expanded" && input.expandedHeight != null ? expandedLane(input.column, strip) : restLane(input.column, hang.at - hang.room);
    return { mode, free: strip, hang, lane, resizable: false, room: strip };
  }
  /*
   * A resizable window takes its stored width, never under the default,
   * and keeps the handle's reach on its free sides (5.3). The stored
   * height caps it last, after the spot and the lane (6): whatever room
   * they give, it takes at most that, and a window the lane moves down
   * keeps min(content, cap) of height, as it kept its content's.
   */
  const resizable = mode === "dock" && input.resizable === true;
  const reach = handleReach(input.spot.corner, resizable);
  const room = insetBox(free, reach);
  // A stored height under the shortest is drawn at the shortest (5.6).
  const cap = resizable && input.size?.h !== undefined ? Math.max(MIN_WINDOW_HEIGHT, input.size.h) : undefined;
  const content = cap === undefined ? input.height : Math.min(input.height, cap);
  const width = resizable ? Math.max(barWidth, input.size?.w ?? barWidth) : barWidth;
  const hang = mode === "compact" ? compactHang(input.layout, input.viewport, input.chrome, barWidth) : spotHang(input.spot, room, { width, height: content });
  const capped = (h: Hang): Hang => (cap === undefined ? h : { ...h, room: Math.min(h.room, cap) });
  if (!input.column || !overlapsLane(hang, free)) return { mode, free, hang: capped(hang), lane: "none", resizable, room };
  const left = laneLeft(free) - reach.right;
  const shared = shareLane({
    hang,
    laneTop: mode === "compact" ? free.top : room.top,
    laneHeight: mode === "compact" ? hang.room : room.height,
    column: input.column,
    laneLeft: left,
    besideRoom: left - room.left,
    content,
    floorGap: reach.top,
  });
  return { mode, free, lane: shared.lane, hang: capped(shared.hang), resizable, room };
}

/**
 * Where a bar rests before it exists, for a pan that opens it: a docked or
 * compact bar at its spot with the height it last had, shared with the
 * column as the drawn bar will be (placeBar), and an upright phone's
 * strip, or its expanded bar while the bar stays expanded, at the free
 * area's foot (docs/design-v1-bar-compact.md 4). `mode` tells barCover
 * which side it covers.
 */
export function restingBar(input: {
  layout: Size;
  viewport: Size;
  chrome: Chrome;
  spot: Spot;
  height: number;
  foot?: number;
  column: ColumnFacts | null;
  width?: number;
  size?: BarSize;
  resizable?: boolean;
  heldMode?: HeldMode;
  cardAt?: CardAt;
  /** The strip's foot: `foot`, or 0 while a roll card yields to it (stripSqueezed). */
  restFoot?: number;
  state?: RestState;
  expandedHeight?: number | null;
}): { box: Box; laneLeft: number; freeRight: number; mode: BarMode } | null {
  const foot = input.foot ?? 0;
  const mode = heldOrOpenMode({ layout: input.layout, free: freeArea(input.viewport, input.chrome, foot), foot, cardAt: input.cardAt ?? null, heldMode: input.heldMode ?? null });
  if (mode === "span") {
    const free = freeArea(input.viewport, input.chrome, input.restFoot ?? foot);
    const hang = restHang(free, input.state ?? "rest", input.expandedHeight ?? null);
    return { box: hangBox(hang, hang.room), laneLeft: laneLeft(free), freeRight: free.left + free.width, mode };
  }
  const placed = placeBar({ ...input, foot, anchor: null });
  if (!placed) return null;
  return { box: hangBox(placed.hang, input.height), laneLeft: laneLeft(placed.free), freeRight: placed.free.left + placed.free.width, mode: placed.mode };
}

// ------------------------------------------------------------ an upright phone's resting bar

/*
 * On a phone held upright the bar rests as a strip at the foot of the
 * map's free area, across its width, and never follows its token
 * (docs/design-v1-bar-compact.md 3). Expand grows it up from the same
 * foot. The strip is held from the moment it shows, so a free area that
 * shrinks after the opening never turns it into the compact overlay.
 */

/** The strip's height: its border, the 52 px header, an 8 px gap, the 44 px quick row and an 8 px bottom padding (3.1). */
export const REST_HEIGHT = 114;
/** The least the strip gives up to, its header and quick row still whole, on the shortest free areas (3.1). */
export const REST_TIGHT = 94;
/** The map the strip keeps above it where it can: a touch target's height, which takes any token's middle for a tap. */
export const BAND_MIN = 44;
/** What Expand must add to the strip to be offered: a header's height (5.1). */
export const EXPAND_GAIN = 52;
/** How far in from each side of the frame the strip's note stands, over its top edge (3.3): its width is the frame's less twice this. */
export const NOTE_INSET = 12;

/**
 * The strip's height for a free area `free` px tall: 114, or less where
 * that would leave under 44 px of map and the 8 px gap above it, never
 * under 94 (3.1).
 */
export function restHeight(free: number): number {
  return clamp(free - BAND_MIN - EDGE, REST_TIGHT, REST_HEIGHT);
}

/**
 * Where a player's roll card stands on a narrow screen
 * (features/rolls/PlayerRolls.tsx): at the foot over the toolbar, standing
 * or folded, summoned onto the toolbar or onto the screen, or nowhere
 * there.
 */
export type CardAt = "foot" | "toolbar" | "screen" | null;

/** The one mode a bar keeps once it shows: the strip, or nothing held (2). */
export type HeldMode = "span" | null;

/** A layout an upright phone's bar spans, by its shape alone. */
function uprightLayout(layout: Size): boolean {
  return layout.width < DOCK_MIN_WIDTH && layout.width <= layout.height;
}

/**
 * The bar's mode as it opens (2, review BC-OPUS-25). On an upright phone
 * the free area counts a roll card standing at the foot as map, since the
 * card folds into the alerts where both would not fit, so the strip opens
 * where the card alone would have made the bar compact. A card summoned
 * onto the toolbar or the screen counts as today. `free` is the free area
 * with `foot` taken out (freeArea).
 */
export function openMode(input: { layout: Size; free: Box; foot: number; cardAt: CardAt }): BarMode {
  const back = input.cardAt === "foot" && uprightLayout(input.layout) ? Math.max(0, input.foot) : 0;
  return barMode(input.layout, input.free.height + back);
}

/**
 * The mode a bar draws in: the held strip while the layout is still an
 * upright phone's, whatever its free area does now, and else the opening
 * rule. The layout check covers the render between a turn of the screen
 * and the store letting go of the held mode.
 */
export function heldOrOpenMode(input: { layout: Size; free: Box; foot: number; cardAt: CardAt; heldMode: HeldMode }): BarMode {
  if (input.heldMode === "span" && uprightLayout(input.layout)) return "span";
  return openMode(input);
}

/*
 * The quick row's order on screen (3.3). "mode" is the HP entry's lead,
 * a token's or a group's: the mode toggle, the field and Apply. Roll's
 * place holds a passing action or Roll, so they share one spot, and only
 * one of them is drawn (restFit).
 */
const REST_DISPLAY: readonly string[] = ["mode", "crit", "useRoll", "conditions", "undoMove", "countLeg", "door", "roll", "multiSelect", "uses", "hidden", "details"];

/**
 * The quick row's candidates in the order they show, left to right (3.3).
 * An id the strip does not know keeps its place after the known ones, in
 * the order given.
 */
export function restOrder(ids: readonly string[]): string[] {
  const rank = (id: string) => {
    const at = REST_DISPLAY.indexOf(id);
    return at < 0 ? REST_DISPLAY.length : at;
  };
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((e) => e.id);
}

/** What a strip or an expanded bar leaves of the free area above it, for its token and label (5.1). */
const EXPAND_LEAVES = 120;
/** The share of the layout's height an expanded bar may take (5.1). */
const EXPAND_SHARE = 2 / 3;

/**
 * Whether the bar rests as the strip or is expanded, while it spans an
 * upright phone (5.3). Expanded lasts while the bar stays open.
 */
export type RestState = "rest" | "expanded";

/**
 * The strip's place: the free area's width at its foot, `restHeight` tall,
 * or an expanded bar's place on the same foot, `expandedHeight` tall.
 * `free` is the free area the strip stands in, a roll card that yields to
 * it left out (restFoot).
 */
export function restHang(free: Box, state: RestState, expandedHeight: number | null): Hang {
  const bottom = free.top + free.height;
  const room = state === "expanded" && expandedHeight !== null ? expandedHeight : restHeight(free.height);
  return { left: free.left, width: Math.max(0, free.width), anchor: "bottom", at: bottom, room: Math.max(0, room) };
}

/**
 * The alerts column beside a resting strip (3.5): its cards stack above
 * the strip where at least 44 px of map are left between the last card,
 * with its 8 px gap, and the strip's top, less its own 8 px gap, so a
 * token can still be panned in under the cards. Otherwise the column shows
 * its summary row. All the cards count, not only the first: a stacked
 * column reaches down to the strip (columnRoom), so cards after the first,
 * and the fade of a column cut short, would lie over the band. "none"
 * with no card.
 */
export function restLane(column: ColumnFacts | null, restTop: number): Lane {
  if (!column || column.first <= 0) return "none";
  return restTop - EDGE - (column.top + Math.max(column.first, column.content) + EDGE) >= BAND_MIN ? "stacked" : "summary";
}

/**
 * The alerts column beside an expanded bar (5.1): its first card stacks
 * above it only where it leaves the bar a header's height more than the
 * strip, else the column shows its summary row, so the column never caps
 * an expanded bar under that. "none" with no card.
 */
export function expandedLane(column: ColumnFacts | null, free: Box): Lane {
  if (!column || column.first <= 0) return "none";
  return underCard(column, free) >= REST_HEIGHT + EXPAND_GAIN ? "stacked" : "summary";
}

/** The free area left under the column's first card, its 8 px gap and the fade's room (firstFoot). */
function underCard(column: ColumnFacts, free: Box): number {
  return free.top + free.height - firstFoot(column);
}

/**
 * How tall an expanded bar may grow (5.1): two thirds of the layout's
 * height, but never so tall that it leaves its token under 120 px of the
 * free area and the 8 px gap above it. Expand is offered only where this
 * is at least a header's height over the strip (expandOffered).
 */
export function expandReach(input: { layout: Size; free: Box }): number {
  return Math.max(0, Math.min(Math.round(input.layout.height * EXPAND_SHARE), input.free.height - EXPAND_LEAVES - EDGE));
}

/** Whether Expand is offered: it must add at least a header's height to the strip (5.1, review BC-OPUS-22). */
export function expandOffered(input: { layout: Size; free: Box }): boolean {
  return expandReach(input) >= REST_HEIGHT + EXPAND_GAIN;
}

/**
 * An expanded bar's height (5.1): as tall as its content, up to its reach
 * and the room under a first card that stacks above it, and never under
 * the strip's 114 px. The frame works it out at Expand, for each new
 * token and on a change of the map's frame only, so a stat block that
 * loads late or a pinch never changes it.
 */
export function expandedRoom(input: { layout: Size; free: Box; column: ColumnFacts | null; content: number }): number {
  const { column, free } = input;
  const cap = column && expandedLane(column, free) === "stacked" ? underCard(column, free) : Number.POSITIVE_INFINITY;
  return Math.max(REST_HEIGHT, Math.min(input.content, expandReach(input), cap));
}

/**
 * How far the map moves so the bar clears its own token, in the chrome's
 * px, up being negative (3.6, 5.2). The token's label clearance, its
 * anchor and the 34 px under it, must end at or above the bar's top
 * (`barTop`). It moves no further than keeps the token's top, at its drawn
 * height, inside the free area and below the toasts over the map as they
 * stand (`toastFoot`, review LP19-BS-3). Toasts that already reach down
 * past the token's top limit nothing, so a stack in the middle of the
 * screen never stops the move (review LP19-OPUS-1). A token taller than
 * the room above the bar clears as far as its top allows. Zero where the
 * label already clears. Stage bounds the move by the camera's limits
 * (lib/camera.ts barShift).
 */
export function clearShift(input: { anchor: Point; tokenHeight: number; free: Box; barTop: number; toastFoot: number | null }): number {
  const need = input.anchor.y + OFFSET_Y - input.barTop;
  if (need <= 0) return 0;
  const top = input.anchor.y - Math.max(0, input.tokenHeight);
  const toasts = input.toastFoot !== null && input.toastFoot + EDGE <= top ? input.toastFoot + EDGE : Number.NEGATIVE_INFINITY;
  const most = Math.max(0, top - Math.max(input.free.top, toasts));
  const dy = Math.min(need, most);
  return dy > 0 ? -dy : 0;
}

/**
 * Whether a roll card at a narrow screen's foot folds for the strip
 * (3.2): while an upright phone's bar is open in its held strip mode,
 * shown or hidden for a drag (`held`), and the card would take the free
 * area under the 148 px a bar needs. With no bar held the card stands.
 */
export function stripSqueezed(input: { viewport: Size; chrome: Chrome; foot: number; held: boolean }): boolean {
  return input.held && input.foot > 0 && freeArea(input.viewport, input.chrome, input.foot).height < MIN_BAR_HEIGHT;
}

/**
 * What an upright phone's bar showed at a commit and shows at the next:
 * nothing, one token's bar by its id, or a group's bar.
 */
export type BarSubject = string | "group" | null;

/**
 * Whether an opening's intent asks the map to clear the token (3.6,
 * review BAR-ASTRA-09): the bar shows now and showed nothing at the commit
 * before, or showed one token and now another, or showed a group and now
 * one token by a plain tap (review BC-OPUS-37). A tap that gathers or
 * takes out a token in Multi-select (`gather`), a gathering tap that turns
 * one token's bar into a group's, a group to a group, and the same token
 * again ask nothing.
 */
export function keepsOpening(before: BarSubject, now: BarSubject, gather: boolean): boolean {
  if (now === null) return false;
  if (before === null) return true;
  if (now === "group") return false;
  if (before === "group") return !gather;
  return before !== now;
}

/**
 * Whether the newest toast shows as one 44 px row over the top bar's row
 * (3.5, review BC-OPUS-31): while the strip rests, the toasts' room runs
 * from their top (`top`) down to the strip's top less 60 (`restFloor`),
 * and under 44 px of it leaves no room for a toast there. Null while no
 * strip rests.
 */
export function toastsOverBars(input: { restFloor: number | null; top: number }): boolean {
  return input.restFloor !== null && input.restFloor - input.top < TOAST_MIN;
}

/** The foot of the room a resting strip leaves the toasts and the summary row: 8 px above the band's last 44 px over the strip (3.5). */
export function restFloor(stripTop: number): number {
  return stripTop - EDGE - BAND_MIN - EDGE;
}

// ------------------------------------------------------------ the stored Larger

/*
 * An upright phone's bar was once Smaller or Larger, and this device
 * remembered Larger under this key. Expanded now lasts only while the bar
 * is open (docs/design-v1-bar-compact.md 5.3, R1), so the dock store
 * removes the key once as it starts and never writes it.
 */
export const LARGER_KEY = "rvtt.tokenBarLarger";

/** Removes the stored Larger. Storage can throw, and then there is nothing to remove. */
export function forgetLarger(storage?: Pick<Storage, "removeItem">): void {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    from?.removeItem(LARGER_KEY);
  } catch {
    // Nothing stored can be read either.
  }
}

// ------------------------------------------------------------ notices

/**
 * Where the notice stack goes (design 1.3): centered left of the lane
 * when 320 px or more are left there, column or not, so nothing moves when
 * an alert arrives. Otherwise it spans as before, and the column starts
 * below its lasting notices.
 */
export function noticePlace(free: Box): { left: number; width: number } | null {
  const room = free.width - LANE_WIDTH;
  return room >= NOTICES_BESIDE_MIN ? { left: free.left, width: room } : null;
}

/**
 * What the column publishes after it measures itself: its cards' heights
 * while they are drawn, none when it has no card, and while they are
 * hidden (folded under a sheet or summarized beside the bar) the last
 * heights it had, at its top now. A turn band or a lasting notice still
 * moves the summary row that shows, and the bar must follow it. The same
 * object back when nothing changed, so nothing renders for nothing.
 */
export function columnFacts(prev: ColumnFacts | null, input: { top: number; measured: { content: number; first: number; cover?: number } | null; row?: number }): ColumnFacts | null {
  const { top, measured, row } = input;
  if (!measured) return prev && (prev.top !== top || prev.row !== row) ? withRow({ ...prev, top }, row) : prev;
  if (measured.first <= 0 && !((measured.cover ?? 0) > 0)) return null;
  if (prev && prev.top === top && prev.content === measured.content && prev.first === measured.first && prev.cover === measured.cover && prev.row === row) return prev;
  return withRow({ top, content: measured.content, first: Math.max(0, measured.first), ...(measured.cover !== undefined ? { cover: measured.cover } : null) }, row);
}

function withRow(facts: ColumnFacts, row: number | undefined): ColumnFacts {
  const { row: _, ...rest } = facts;
  return row === undefined ? rest : { ...rest, row };
}

/**
 * Where the alerts column's summary row stands (features/encounter
 * InitiativeStrip.tsx FightAlerts): the lowest spot at or above its usual
 * place whose foot keeps above the tool's option buttons (`floor`), that
 * meets no lasting notice (`taken`), and that stands over no button in the
 * top bars. Across, it takes the rightmost gap between those buttons, `gap`
 * clear of each, as wide as it is or at least `minWidth`, from its own
 * right edge leftward as far as `minLeft`: over a room's name or the band's
 * portrait, never a button. It may rise over the turn band and then the
 * top bar's row, up to `ceiling`. Null where no spot is left. `highest`
 * takes the highest spot instead of the lowest: where no spot keeps above
 * the tool's buttons, the caller lets the floor go and keeps the row as
 * far from them as it can. Any one unit throughout: screen px as drawn.
 */
export function raisedRow(input: {
  row: { left: number; right: number; top: number; height: number };
  minLeft: number;
  ceiling: number;
  floor: number;
  taken: readonly { top: number; bottom: number }[];
  controls: readonly { left: number; top: number; right: number; bottom: number }[];
  gap: number;
  minWidth: number;
  highest?: boolean;
}): { top: number; left: number; right: number } | null {
  const { row, gap } = input;
  const width = row.right - row.left;
  const at = (top: number): { top: number; left: number; right: number } | null => {
    const bottom = top + row.height;
    if (input.taken.some((t) => t.top < bottom && t.bottom > top)) return null;
    // What it may not cover in this band: each button and a gap either side.
    const blocks = input.controls
      .filter((c) => c.top < bottom && c.bottom > top)
      .map((c) => ({ left: c.left - gap, right: c.right + gap }))
      .sort((x, y) => x.left - y.left);
    const free: { left: number; right: number }[] = [];
    let from = input.minLeft;
    for (const b of blocks) {
      if (from >= row.right) break;
      if (b.left > from) free.push({ left: from, right: Math.min(b.left, row.right) });
      from = Math.max(from, b.right);
    }
    if (from < row.right) free.push({ left: from, right: row.right });
    // The rightmost gap wide enough, as near its own place as the buttons let it stand.
    for (const f of free.reverse()) {
      if (f.right - f.left >= input.minWidth) return { top, left: Math.max(f.left, f.right - width), right: f.right };
    }
    return null;
  };
  const lowest = Math.min(row.top, input.floor - row.height);
  if (input.highest) {
    for (let top = input.ceiling; top <= lowest; top += 1) {
      const spot = at(top);
      if (spot) return spot;
    }
    return null;
  }
  for (let top = lowest; top >= input.ceiling; top -= 1) {
    const spot = at(top);
    if (spot) return spot;
  }
  return null;
}

/** Where the cards a summary row stands for show once its tap asks for them (askedAlerts). */
export type AskedAlerts = "column" | "overlay" | "fullScreen";

/**
 * Where the summary row's tap shows the cards it stands for, on a screen
 * whose tool options leave the column under one whole card, so that the
 * first card always shows whole. `first` is its height as last drawn.
 * - `column`: where they are, the column reaching down to the toolbar,
 *   where the first card fits there (`column`, the room from the column's
 *   usual top, its 8 px top padding included).
 * - `overlay`: over the screen from its safe top down to the toolbar, where
 *   no lasting notice or bar can squeeze it, when the first card fits in
 *   its body (`overlay`, that body's room).
 * - `fullScreen`: the same down to the screen's foot, over the toolbar too,
 *   where even that is short. It is modal, and Close is one tap away.
 */
export function askedAlerts(input: { first: number; column: number; overlay: number }): AskedAlerts {
  if (EDGE + input.first <= input.column) return "column";
  return input.first <= input.overlay ? "overlay" : "fullScreen";
}

/** Room around the alert cards for their shadow (theme.shadow.float reaches about 20 px below a card). */
export const SHADOW_ROOM = 20;
/** The widest alert card. */
export const CARD_MAX = 300;

/**
 * The alerts column's card width and the shadow room at its left
 * (docs/design-v1-layout-hierarchy.md 3.5), in the column's own pixels.
 * The column hangs from the top bar and sizes its cards from the map's
 * width, so a sheet and the safe areas each take their share: a sheet in
 * place of the right safe area.
 * features/encounter/InitiativeStrip.tsx writes the same rule as CSS,
 * where the map's width is the column's 100%.
 */
export function columnCards(input: ColumnWidth): { card: number; shadowLeft: number } {
  const rightPad = EDGE + (input.sheet > 0 ? 0 : input.safe.right);
  const card = Math.min(CARD_MAX, input.mapWidth - input.sheet - 2 * EDGE - input.safe.left - (input.sheet > 0 ? 0 : input.safe.right));
  return { card, shadowLeft: Math.min(SHADOW_ROOM, input.mapWidth - card - rightPad) };
}

/** What the alerts column's width follows: the map's width, a phone's sideways sheet beside it, and the safe areas. */
export type ColumnWidth = { mapWidth: number; sheet: number; safe: Pick<Sides, "left" | "right"> };

/** A stack's left and right edges, in the chrome's px in from the map's own left and right edges. */
export type ToastEdges = { left: number; right: number };

/** The alerts column's cards' left and right edges (columnCards), which stand in from the map's right by the sheet and the column's right padding. */
export function columnEdges(input: ColumnWidth): ToastEdges {
  const right = input.sheet + EDGE + (input.sheet > 0 ? 0 : input.safe.right);
  return { left: input.mapWidth - right - columnCards(input).card, right };
}

/** A toast's least height, a touch target's: the room it needs under the column's first card. */
export const TOAST_MIN = 44;

/**
 * Where a toast that shows now starts on a phone (docs/design-v1-bar-dock.md
 * 1.3): 8 px under the alerts column's first card, a turn card included
 * (`cover`), its top plus its height, while the notices span the map over
 * the column and it shows a card (`cards`), so the toast never covers that
 * card's buttons. Null
 * keeps it at the top of the notices as before: beside the lane, with no
 * card, with the cards folded or a summary row standing for them, or with
 * under 44 px left above the tool's options (`optionsTop`). In the chrome's
 * own px from the page's top, read once as each toast shows, so a toast
 * never moves down or up. Across, it takes the column's cards' edges as
 * they stand now (toastLayerPlace).
 */
export function toastTop(input: { spanning: boolean; column: ColumnFacts | null; cards: boolean; optionsTop: number }): number | null {
  const { column } = input;
  const reach = column ? (column.cover ?? column.first) : 0;
  if (!input.spanning || !input.cards || !column || reach <= 0) return null;
  const top = column.top + reach + EDGE;
  return input.optionsTop - top >= TOAST_MIN ? top : null;
}

/**
 * Where a toast that shows now starts while a map pane stands as a bottom
 * sheet (docs/design-v1-bar-dock.md 1.3): 8 px under the pane's header,
 * `head` being its foot, so the toast lies over the pane's body and never
 * over its header and Close. Null keeps it at the top of the notices: no
 * header measured yet, or under 44 px left above the tool's options
 * (`optionsTop`). In the chrome's own px from the page's top. Unlike
 * toastTop's place, a stack placed here keeps under the header while the
 * pane stands (nextToastPlaces), since the pane moves its header.
 */
export function paneToastTop(input: { head: number | null; optionsTop: number }): number | null {
  if (input.head === null) return null;
  const top = input.head + EDGE;
  return input.optionsTop - top >= TOAST_MIN ? top : null;
}

/** A box's top and foot, in the chrome's px from the page's top. */
export type Band = { top: number; bottom: number };

/**
 * Where a toast that showed over an upright phone's spanning token bar's
 * header moves (docs/design-v1-bar-dock.md 1.3, review LP19-BS-2): 8 px
 * under the header, `head` being its box, so the toast never covers the
 * bar's Close or its Larger and Smaller. Null where no bar spans, or where
 * under 44 px would be left above the tool's options (`optionsTop`), and
 * the toast keeps its place. In the chrome's own px from the page's top.
 */
export function barToastTop(input: { head: Band | null; optionsTop: number }): number | null {
  if (input.head === null) return null;
  const top = input.head.bottom + EDGE;
  return input.optionsTop - top >= TOAST_MIN ? top : null;
}

/**
 * The toasts, of those that just showed, whose boxes meet a spanning bar's
 * header (`head`): each takes its place again under the header
 * (barToastTop, nextToastPlaces). Read from the boxes as drawn, since a
 * toast's height is known only then. Half a pixel of rounding never meets.
 */
export function toastsOverHead(boxes: readonly ({ id: number } & Band)[], head: Band | null): Set<number> {
  const over = new Set<number>();
  if (head === null) return over;
  for (const b of boxes) if (b.top < head.bottom - 0.5 && b.bottom > head.top + 0.5) over.add(b.id);
  return over;
}

/** The toasts' layer stack while it stands under a spanning bar's header (barToastTop): the top it was placed at, and its toasts. */
export type BarStack = { top: number; ids: readonly number[] };

/**
 * The layer's stack, of the toasts showing (`ids`), if the header of the
 * bar's opening that stands now (`opening`, spanToastSlot) placed it. A
 * stack belongs to the opening whose header placed it there last, so one
 * left by a bar that closed, or by another token's bar, stays where it is
 * when the next bar opens, rather than jump under a header that never
 * covered it, over that bar's body (review FU24-OPUS-1). The next bar's
 * header takes it over only by covering it as it opens. Null for a stack
 * placed anywhere else, by another opening, or none.
 */
export function barStack(state: ToastPlaces, ids: readonly number[], opening: number | null): BarStack | null {
  let top: number | null = null;
  const under: number[] = [];
  for (const id of ids) {
    const place = state.places.get(id);
    if (typeof place !== "object") continue;
    if (place.bar !== opening) return null;
    top ??= place.low;
    under.push(id);
  }
  return top === null ? null : { top, ids: under };
}

/**
 * The toasts that take their place again under a spanning bar's header,
 * as toasts that came now would (barToastTop, nextToastPlaces' `overBar`):
 * of `boxes`, as drawn, those that meet the header, and the whole stack
 * placed under the header before (`stack`) once the header's bottom has
 * moved below that stack's top, as an alert card or a pan that moves the
 * bar down makes it (review LP19-OPUS-3). So that stack goes down with the
 * header, and stays where it is as the header goes up. Half a pixel of
 * rounding never counts.
 */
export function toastsUnderHead(boxes: readonly ({ id: number } & Band)[], head: Band | null, stack: BarStack | null): Set<number> {
  const over = toastsOverHead(boxes, head);
  if (head !== null && stack !== null && head.bottom - 0.5 > stack.top) for (const id of stack.ids) over.add(id);
  return over;
}

/**
 * How long a spanning bar opens for, for the toasts, from when its header
 * shows: in that time it measures its content and Larger moves the map,
 * each of which can move its header. As long as a turn lasts for them
 * (Room.tsx TURN_MS).
 */
export const BAR_OPEN_MS = 600;

/** Whether a spanning bar whose header showed at `shownAt` is still opening (BAR_OPEN_MS). */
export function barOpening(shownAt: number | null, now: number): boolean {
  return shownAt !== null && now - shownAt < BAR_OPEN_MS;
}

/**
 * Whether a spanning bar's header that moved to `head` has the toasts look
 * again for those to place under it (spanToastSlot's `recheck`): while
 * the bar opens, so toasts already showing that cover the header move
 * under it, as new ones do (review LP19-Q1), and once the header's bottom
 * goes below the top of the stack this opening placed under it
 * (toastsUnderHead, reviews LP19-OPUS-3 and FU24-OPUS-1). Any other move
 * draws no toast. The stack is the one the toasts last published, read
 * against the opening now, since the toasts publish it only as they draw.
 */
export function headAsksToasts(slot: { shownAt: number | null; opening: number | null; stack: { top: number; opening: number } | null }, head: Band, now: number): boolean {
  if (barOpening(slot.shownAt, now)) return true;
  return slot.stack !== null && slot.stack.opening === slot.opening && head.bottom - 0.5 > slot.stack.top;
}

/**
 * Where a toast stands: at the top of the map's notices, in the toasts' own
 * layer under the column's first card (`low`, in the chrome's px, and
 * `column`), under a spanning token bar's header (across the map, `bar`
 * being the opening of the bar whose header placed it, spanToastSlot) or
 * where a map pane's header last stood (across the map), or under that
 * header while the pane stands ("pane"), or in the very short sheet.
 */
export type ToastPlace = "map" | "sheet" | "pane" | { low: number; column: boolean; bar?: number };

/**
 * The toasts' places by id, the pane header's last place, whether a pane
 * stood on the render before, the toasts a turn of the screen is placing
 * under the column's card, and the toasts at the notices' top that came
 * with no card measured to start under (`awaitCard`), which a card the
 * column measures while they are new still takes under it.
 */
export type ToastPlaces = { places: ReadonlyMap<number, ToastPlace>; paneLast: number | null; paneStood: boolean; turning: ReadonlySet<number>; awaitCard: ReadonlySet<number> };

export const NO_TOAST_PLACES: ToastPlaces = { places: new Map(), paneLast: null, paneStood: false, turning: new Set(), awaitCard: new Set() };

/** A place in the toasts' own layer, rather than in the notices' stack or the sheet. */
export function inToastLayer(place: ToastPlace | undefined): boolean {
  return place === "pane" || typeof place === "object";
}

/**
 * The toasts' places on this render (docs/design-v1-bar-dock.md 1.3),
 * from the last render's (`was`) and what stands now: the toasts showing
 * (`ids`, oldest first), toastTop's place (`low`), paneToastTop's
 * (`pane`), whether a map pane stands as a bottom sheet (`paneStands`),
 * the layer, the very short sheet's slot, and the toasts to place under
 * a spanning token bar's header with barToastTop's place there
 * (`overBar`).
 *
 * The layer keeps one stack. A new toast joins it, or starts one under
 * the column's first card or the pane's header. While a pane stands, the
 * whole stack goes under its header on any render that has the header's
 * place, and follows it: a column stack moves there once, as the pane
 * opens, and a stack a closed pane left joins the next pane's header. So
 * do the toasts at the top of the notices (review FU21B-OP-7), where a
 * pane that rises to the top bars would have them over its header and
 * Close. They move into the layer without being drawn anew (Room.tsx
 * Toasts), so none is announced again. When the pane goes away, the
 * stack freezes at the header's last place. A pane can stand for a render
 * with no header place (`pane` null), its first or one with too little
 * room, so the stack neither moves nor freezes on those. Just after the
 * screen turns (`turned`), a toast at the top of the notices that now
 * meets the column's first card, which a place under that card (`low`)
 * says, takes its place again as if it came now (review LP17-AW-1). It
 * goes on taking it while the turn lasts (`turning`), since the first
 * place after a turn may come from the card as it stood before, until
 * the column measures it again. So does a toast that comes under the
 * card while the turn lasts (review FU22B-ASTRA-03). A card that arrives
 * at another time moves no toast itself, so nothing jumps under a finger.
 * A toast that would start under the card while toasts at the notices'
 * top reach down past it (`mapFoot`, their foot as last drawn) joins them
 * there instead, so the two stacks never overlap (review LP18-TO-4). A
 * pane that stops standing as the screen turns leaves its toasts to be
 * placed anew (review LP18-TO-3).
 *
 * A trap's toast comes in the same render as its card, before the column
 * has measured the card, so it starts at the notices' top, over that card
 * (review LP18-TO-5). So a toast that starts there with no card to start
 * under, while it is still new (`recent`, the ids that came moments ago),
 * takes its place again, as if it came now, on the first render that has
 * a place under the card (`low`), as the turn's rule does. Once it is
 * placed anew, or no longer new, a card moves it no more.
 *
 * On an upright phone the toasts in `overBar` take their places again
 * under the spanning token bar's header, in the layer, as toasts that
 * came now would there, and the layer's one stack goes with them, since a
 * new toast would join it over the header again (review LP19-BS-2). Those
 * are the toasts that just showed over the header, those already showing
 * there as the bar opens (review LP19-Q1), and the stack placed under the
 * header once the header's bottom goes below its top, as an alert card
 * that moves the bar down makes it (review LP19-OPUS-3), as Room.tsx reads
 * them from the boxes drawn (toastsUnderHead). A pane's header, the very
 * short sheet and a page with no layer keep their own rules. As the
 * screen turns, a toast under the bar's header takes its place anew.
 *
 * An upright phone's resting strip keeps the toasts above the band over
 * it (docs/design-v1-bar-compact.md 3.5). As resting begins, and each time
 * the strip's top rises, the layer's stack whose drawn foot is lower than
 * the strip's top less 60 takes its place anew, as if it came then, a
 * stack a pane left included (`anew`, which Room.tsx reads from the stack
 * as drawn).
 *
 * A toast leaves the layer only when a pane stops standing as the screen
 * turns (review LP18-TO-3), as the screen turns under a bar's header, or
 * as a resting strip takes its stack anew, never leaves the sheet, and
 * leaves the notices only for a pane's header, an expanded bar's header
 * (`overBar`), a turned screen's card or a card that came with it.
 */
export function nextToastPlaces(
  was: ToastPlaces,
  now: {
    ids: readonly number[];
    pane: number | null;
    paneStands: boolean;
    low: number | null;
    layer: boolean;
    slot: boolean;
    turned?: boolean;
    mapFoot?: number | null;
    recent?: ReadonlySet<number>;
    /** The toasts to place under a spanning bar's header (toastsUnderHead), barToastTop's place under it, and the bar's opening, which then owns the stack (reviews LP19-BS-2, LP19-Q1, LP19-OPUS-3 and FU24-OPUS-1). */
    overBar?: { ids: ReadonlySet<number>; at: number | null; opening: number | null };
    /** The toasts that take their place anew for a resting strip, as toasts that came now would (docs/design-v1-bar-compact.md 3.5). */
    anew?: ReadonlySet<number>;
  },
): ToastPlaces {
  const freeze = was.paneStood && !now.paneStands;
  const paneLast = now.pane ?? was.paneLast;
  const places = new Map<number, ToastPlace>();
  const turned = now.turned === true;
  const turning = new Set(turned ? now.ids.filter((id) => was.turning.has(id)) : []);
  const underCard = turned && now.low !== null && now.layer && !now.slot && !now.paneStands;
  // A card can take a toast under it only in the layer, with no sheet's slot and no pane standing.
  const cardRoom = now.layer && !now.slot && !now.paneStands;
  const recent = now.recent ?? new Set<number>();
  const awaitCard = new Set(now.ids.filter((id) => was.awaitCard.has(id) && recent.has(id)));
  // A toast over a spanning bar's header takes its place again under it, in the layer, as one that came now would there. The layer's one stack goes with it, since a new toast would join it over the header again, and that bar's opening owns the stack from then on.
  const bar = cardRoom && now.overBar && now.overBar.at !== null && now.overBar.opening !== null ? { low: now.overBar.at, column: false, bar: now.overBar.opening } : null;
  const overBar = bar !== null ? (now.overBar?.ids ?? new Set<number>()) : new Set<number>();
  for (const id of now.ids) {
    const place = was.places.get(id);
    if (place === undefined) continue;
    if (overBar.has(id) && place !== "sheet" && place !== "pane") continue;
    if (now.anew?.has(id) && typeof place === "object") continue;
    if (bar !== null && overBar.size > 0 && typeof place === "object") {
      places.set(id, bar);
      continue;
    }
    // Its header's place was read on the screen before the turn, where the bar spanned: it takes its place anew, as a pane's toasts do (review LP18-TO-3).
    if (turned && typeof place === "object" && place.bar !== undefined) continue;
    // Left without a place, so the loop below places it as a new toast.
    if (underCard && (place === "map" || turning.has(id))) {
      turning.add(id);
      continue;
    }
    if (cardRoom && now.low !== null && place === "map" && awaitCard.has(id)) continue;
    // A pane that stops standing as the screen turns is a card now, or gone, and its header's last place was read on the screen before the turn, perhaps above this one: its toasts take their places anew (review LP18-TO-3).
    if (freeze && turned && place === "pane") continue;
    if (now.pane !== null && (inToastLayer(place) || (place === "map" && now.layer))) places.set(id, "pane");
    else if (freeze && place === "pane") places.set(id, paneLast !== null ? { low: paneLast, column: false } : "map");
    else places.set(id, place);
  }
  for (const id of now.ids) {
    if (places.has(id)) continue;
    // Toasts already at the notices' top that reach down past the card, as a trap's toast that came with its card does, would be covered by a stack started under the card, so the new toast joins them below instead (review LP18-TO-4).
    const mapReaches = now.low !== null && now.mapFoot != null && now.mapFoot + EDGE > now.low && [...places.values()].includes("map");
    const fresh: ToastPlace = now.slot
      ? "sheet"
      : !now.layer
        ? "map"
        : now.pane !== null
          ? "pane"
          : bar !== null && overBar.has(id)
            ? bar
            : now.low !== null && !mapReaches
              ? { low: now.low, column: true }
              : "map";
    const below = fresh === "sheet" || !now.layer ? undefined : [...places.values()].find(inToastLayer);
    const at = below !== undefined && (inToastLayer(fresh) || now.paneStands) ? below : fresh;
    places.set(id, at);
    // A toast that comes while the turn lasts takes the card's place as it reads now, which may be the card as it stood before, or joins a stack that does: it moves with that stack as the column measures again, rather than holding it there (review FU22B-ASTRA-03).
    if (underCard && typeof at === "object" && at.column) turning.add(id);
    if (at === "map" && now.low === null && cardRoom && recent.has(id)) awaitCard.add(id);
  }
  for (const id of awaitCard) if (places.get(id) !== "map") awaitCard.delete(id);
  return { places, paneLast: freeze ? null : paneLast, paneStood: now.paneStands, turning, awaitCard };
}

/**
 * Where the toasts' layer stack stands: its top, in the chrome's px from
 * the page's top, and its edges, null across the map. Null with none in
 * the layer. A stack under the column takes the column's edges as they
 * stand now (`column`, columnEdges), so a screen turned while it shows,
 * with a sideways sheet beside the column or without, keeps it under the
 * cards, where edges kept from its first toast could leave it no width
 * at all. Its top holds as it showed.
 */
export function toastLayerPlace(state: ToastPlaces, ids: readonly number[], column: ToastEdges): { top: number; edges: ToastEdges | null } | null {
  for (const id of ids) {
    const place = state.places.get(id);
    if (place === "pane") return state.paneLast === null ? null : { top: state.paneLast, edges: null };
    if (typeof place === "object") return { top: place.low, edges: place.column ? column : null };
  }
  return null;
}

/**
 * What a stack of toasts does when it runs past its room
 * (docs/design-v1-bar-dock.md 1.3, decided for review LP16-PT-2), the room
 * running from the stack's top down to the tool's highest control, which
 * stands over the screen's foot. First the oldest toasts whose words the
 * log keeps (`logged`, as a whisper's) and that have no button go, never
 * the newest, since stale ones would stand between a toast with a button
 * and its tap. A refusal or an error the log never sees stays, as does a
 * toast with a button (review FU22B-OP-4). If the rest still runs past,
 * the stack scrolls in its room, the newest in view. `stack` is the
 * toasts oldest first with their heights, and `gap` the space between
 * two, in the unit of `room`. Half a pixel of rounding still fits.
 */
export function fitToasts(stack: readonly { id: number; height: number; action: boolean; logged: boolean }[], gap: number, room: number): { drop: number[]; scrolls: boolean } {
  let total = stack.reduce((sum, t) => sum + t.height, 0) + gap * Math.max(0, stack.length - 1);
  const drop: number[] = [];
  for (const t of stack.slice(0, -1)) {
    if (total <= room + 0.5) break;
    if (t.action || !t.logged) continue;
    drop.push(t.id);
    total -= t.height + gap;
  }
  return { drop, scrolls: total > room + 0.5 };
}

/** The column's top: the lane's, or 8 px under the last lasting notice when the notices span over it. Toasts never move it. */
export function columnTop(laneTop: number, lastingBottom: number | null): number {
  return lastingBottom === null ? laneTop : Math.max(laneTop, lastingBottom + EDGE);
}

// ------------------------------------------------------------ the Room's slot

/*
 * What an upright phone's token bar and the toasts read of each other: the
 * box of the expanded bar's header (`head`), which a toast that shows over
 * it moves under (barToastTop, review LP19-BS-2), the resting strip
 * publishing none (docs/design-v1-bar-compact.md 3.5), when that header
 * last showed (`shownAt`, for barOpening) and which of the bar's openings
 * it is (`opening`, from a count, `openings`, that goes up each time a
 * header shows), the foot of the toasts over the map (`foot`), which the
 * clearing move leaves its token below (clearShift, review LP19-BS-3),
 * and the stack the toasts placed under that opening's header
 * (`stack`, its top and its opening, barStack). In the chrome's px from
 * the page's top, null while there is none. Each side reads the other as
 * it acts, not as it draws, so a toast that comes moves no bar. A pan that
 * moves the bar draws no toast but in two cases: while the bar opens, and
 * once its header goes down into the stack under it. Then the bar calls
 * `recheck`, which the toasts set, as headAsksToasts says (reviews LP19-Q1,
 * LP19-OPUS-3 and FU24-ASTRA-02). Per Room page, as the dock store is.
 */
export const spanToastSlot = scopeSlot(() => ({
  head: null as Band | null,
  shownAt: null as number | null,
  opening: null as number | null,
  openings: 0,
  foot: null as number | null,
  stack: null as { top: number; opening: number } | null,
  recheck: null as (() => void) | null,
}));

/**
 * The alerts' summary row while it stands in an upright phone's strip
 * header, where no spot is left for it over the band
 * (docs/design-v1-bar-compact.md 3.5): how many alerts wait, its words as
 * the button's name, and its own tap.
 */
export type HeaderSummary = { count: number; name: string; press(): void };

/**
 * The bar as it shows, for the column, the notices and the camera.
 * `freeRight` is the free area's right edge (barCover). `rests` marks an
 * upright phone's resting strip, whose band the toasts keep out of
 * (docs/design-v1-bar-compact.md 3.5).
 */
export type BarFacts = { box: Box; mode: BarMode; lane: Lane; laneLeft: number; freeRight: number; rests?: boolean };

type BarDockState = {
  /** Room's chrome, measured. Null until it is. */
  chrome: Chrome | null;
  /** The bar while it shows, unfolded. */
  bar: BarFacts | null;
  /** The column's measures while it has cards to measure. */
  column: ColumnFacts | null;
  /** The bottom of the lasting notices while they span the map, which the column starts below. */
  notices: number | null;
  /** The bottom of the lasting notices wherever they stand, which the token bar and the tool's options keep clear of. */
  lasting: number | null;
  /** A roll's card in the alerts column was asked for, by its chip or a summary (features/rolls/PlayerRolls.tsx). */
  columnRollAsked: boolean;
  /** This Room's spot. A "view as a player" preview reads the device's and keeps its own changes to itself. */
  spot: Spot;
  /** The default width this page measured (defaultBarWidth). */
  defaultWidth: number;
  /** This Room's stored window size, read with the spot, and kept to itself by a preview as the spot is. */
  size: BarSize;
  /** The device's main pointer is fine, read once with the page: the window resizes only here (docs/design-v1-token-window.md 5.1). */
  finePointer: boolean;
  /** The content height the bar last had, for where it will rest before it opens. */
  lastHeight: number;
  /** Set by Actions: the next bar to show takes focus on its frame. */
  focusFrame: boolean;
  /**
   * An upright phone's bar is expanded (docs/design-v1-bar-compact.md 5.3).
   * It lasts while the bar stays open, through another token tapped, a
   * drag, a fold and a turn of the screen, and is never stored.
   */
  expanded: boolean;
  /** The expanded bar's height (expandedRoom), frozen at Expand, for each new token and on a change of the map's frame. Null until worked out. */
  expandedHeight: number | null;
  /**
   * The token and the map's frame `expandedHeight` was worked out for, so
   * the bar a drag hid comes back at that height for the same token in the
   * same frame, the content a drop adds, such as Undo move, scrolling
   * (docs/design-v1-bar-compact.md 3.6, 5.1).
   */
  expandedFor: string | null;
  /**
   * A request that the bar clear its token once, by moving the map
   * (clearShift, 3.6): set by Stage for an opening that counts
   * (keepsOpening) and for a drop (`drop`), a new object each time, and
   * cleared as the frame consumes it or a cancel drops it.
   */
  clearRequest: { tokenId: string; drop?: true } | null;
  /**
   * The height of a roll card standing on a narrow screen's toolbar and options bar
   * (features/rolls/PlayerRolls.tsx), or 0: a docked or spanning bar keeps
   * above it. Measured while it shows and kept while it is folded, so
   * folding it never changes where the bar goes.
   */
  foot: number;
  /** That card is folded because the bar opened compact, too short a screen for both, and the column's summary row stands for it. */
  footYields: boolean;
  /** The room between the top bars and the tool's options is under one whole alert card, and the column's summary row stands for its cards. */
  columnCramped: boolean;
  /** The column draws a map pane's summary row in place of its cards (pages/fold.ts drawsPaneRow). */
  columnPaneRow: boolean;
  /** The column's alerts show over the screen (askedAlerts), so the top bars rise over the notices with them. */
  alertsOverlay: boolean;
  /** Asks for the alerts over the screen to close (closeAlertsOverlay), counted so each ask is heard, and the panel the ask opened, which then takes focus. */
  alertsClose: number;
  alertsClosePanel: string | null;
  /** A popover of the tool's options is open (pages/Room.tsx ToolOptions). It rises under a roll card at a narrow screen's foot, which folds while it is open. */
  toolPopover: boolean;
  /**
   * "span" once an upright phone's strip shows, kept through a drag, a
   * tap on another token and a fold until the selection is let go, the
   * screen turns or the interface size changes, so the strip never turns
   * compact by itself (docs/design-v1-bar-compact.md 2).
   */
  heldMode: HeldMode;
  /** Where a player's roll card stands on a narrow screen (CardAt), for the opening rule (openMode). */
  cardAt: CardAt;
  /** The alerts' summary row, handed to the strip's header (HeaderSummary). */
  headerSummary: HeaderSummary | null;
  /** The bar is open, shown or hidden for a drag: a token selected, its bar not put away, the Select tool (Stage.tsx). A roll card folds for a held strip only then (stripSqueezed). */
  barOpen: boolean;
};

/** Per Room page (state/scope.ts): a preview draws a second room with a bar and a column of its own. */
export const barDockSlot = scopeSlot(() =>
  createStore<BarDockState>(() => {
    forgetLarger();
    return { chrome: null, bar: null, column: null, notices: null, lasting: null, columnRollAsked: false, spot: readSpot(), defaultWidth: BAR_WIDTH, size: readSize(), finePointer: isFinePointer(), lastHeight: 200, focusFrame: false, expanded: false, expandedHeight: null, expandedFor: null, clearRequest: null, foot: 0, footYields: false, columnCramped: false, columnPaneRow: false, alertsOverlay: false, alertsClose: 0, alertsClosePanel: null, toolPopover: false, heldMode: null, cardAt: null, headerSummary: null, barOpen: false };
  }),
);

/**
 * Closes the alerts over the screen for an action on a card there that
 * opened `panel`, such as a trap's Save and damage or an ask's Open: the
 * alerts are modal, so the panel would stay out of reach behind them, and
 * it takes focus once they are gone (features/encounter/InitiativeStrip.tsx
 * FightAlerts). With the alerts where they are, it asks nothing.
 */
export function closeAlertsOverlay(scope: RoomScope, panel: string): void {
  const dock = scope.get(barDockSlot);
  if (dock.getState().alertsOverlay) dock.setState((s) => ({ alertsClose: s.alertsClose + 1, alertsClosePanel: panel }));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
