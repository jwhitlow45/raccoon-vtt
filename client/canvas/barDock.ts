import { createStore } from "zustand/vanilla";
import type { Point, Size } from "../lib/camera.ts";
import { isFinePointer } from "../lib/device.ts";
import { TAP_SLOP_PX } from "../lib/gestures.ts";
import { scopeSlot } from "../state/scope.ts";

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
 * The least height a docked or spanning bar needs: its 48 px header and
 * two 44 px rows of buttons with their gaps, or under the alerts summary
 * row the header and one row. Shorter than this, it opens compact.
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
  return layout.width < DOCK_MIN_WIDTH && layout.width <= layout.height ? "span" : "dock";
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
  if (spot.y === 0) return `Window at the ${v} edge, ${spot.x} px from the ${h}`;
  if (spot.x === 0) return `Window at the ${h} edge, ${spot.y} px from the ${v}`;
  return `Window ${spot.x} px from the ${h} and ${spot.y} px from the ${v}`;
}

/** What the status says once Reset brings the window home. */
export const RESET_WORDS = "Window back at bottom right";

/*
 * A docked window narrower than the default width happens only beside a
 * phone's open sideways sheet, and its header follows the width it gets
 * (docs/design-v1-token-window.md 7.1). Each band counts Reset and an
 * elevation badge whether they show or not, so pressing nothing and moving
 * the window never changes the band.
 */
/** One row: the grip, the name's 40 px floor, a badge up to "↑120 ft" (about 51 px), Reset and Close, four 4 px gaps and the frame's 26 px. */
export const HEADER_ROW_MIN = 44 + 40 + 51 + 44 + 44 + 4 * 4 + 26;
/** Stacked: the grip, Reset and Close at 44 px, two gaps and the frame's 26 px. Narrower, the window folds into the sheet's header. */
export const WINDOW_FOLD_BELOW = 3 * 44 + 2 * 4 + 26;

export function headerBand(width: number): "row" | "stacked" | "fold" {
  if (width >= HEADER_ROW_MIN) return "row";
  return width >= WINDOW_FOLD_BELOW ? "stacked" : "fold";
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

/** The shortest a resized window gets: its header and two rows of buttons, the least a docked bar needs. */
export const MIN_WINDOW_HEIGHT = MIN_BAR_HEIGHT;
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

/** The limits a resize meets, from the window's anchored edges (5.6): the default width and 148 px at least, the room and the content at most. */
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

/** What the status says after the handle's keys: "Window 316 by 400 px", and the limit a press met. */
export function sizeWords(box: Pick<Box, "width" | "height">, limit: ReturnType<typeof limitMet>): string {
  const words = `Window ${Math.round(box.width)} by ${Math.round(box.height)} px`;
  return limit ? `${words}, ${limit} it can be here` : words;
}

// ------------------------------------------------------------ the right lane

export type Lane = "none" | "stacked" | "beside" | "summary";

/**
 * The column's measures as it publishes them: its top, its content's height
 * and its first card's. `row` is where its summary row stands while it has
 * risen from the column's top (InitiativeStrip.tsx FightAlerts), over the
 * band or the top bar's row, so the bar under it may take the room it left.
 */
export type ColumnFacts = { top: number; content: number; first: number; row?: number };

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
  const firstBottom = Math.max(laneTop, column.top + column.first + EDGE + (input.floorGap ?? 0));
  if (laneTop + height - firstBottom >= Math.min(BAR_FLOOR, height) && height > 0) return { lane: "stacked", floor: firstBottom };
  if (input.besideRoom >= BESIDE_MIN) return { lane: "beside", floor: laneTop };
  return { lane: "summary", floor: Math.max(laneTop, (column.row ?? column.top) + SUMMARY_ROW + EDGE) };
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
export function barCover(viewport: Size, bars: Sides, bar: { box: Box; laneLeft: number; freeRight: number } | null): Sides {
  if (!bar) return NO_SIDES;
  const { box } = bar;
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
/** Room above the token's bottom edge for the token itself when the bar flips above it. */
const FLIP_CLEARANCE = 40;

/**
 * An upright phone's bar, the screen's width less the free area's margins:
 * below its token when it fits there, else above it, whichever has more
 * room. `top` is how high it may reach, the free area's top or under the
 * alerts column's first card. It never covers its token while the side it
 * takes leaves it its floor, `min(120, the room it has)`: a bar over the
 * creature it acts on is the very thing the dock exists to stop. Only on a
 * screen so short that neither side does, as at 320 x 480 at 130% under a
 * check, does it keep its floor over the token rather than shrink below
 * its header and buttons.
 */
function spanHang(anchor: Point, free: Box, height: number, top: number): Hang {
  const bottom = free.top + free.height;
  const ceiling = Math.max(free.top, top);
  const floor = Math.min(BAR_FLOOR, Math.max(0, bottom - ceiling));
  const topBelow = Math.max(ceiling, anchor.y + OFFSET_Y);
  const spaceBelow = bottom - topBelow;
  const bottomAbove = Math.min(bottom, anchor.y - OFFSET_Y - FLIP_CLEARANCE);
  const spaceAbove = bottomAbove - ceiling;
  if (height <= spaceBelow || spaceBelow >= spaceAbove) {
    const at = spaceBelow >= floor ? topBelow : bottom - floor;
    return { left: free.left, width: free.width, anchor: "top", at, room: Math.max(0, bottom - at) };
  }
  const at = spaceAbove >= floor ? bottomAbove : ceiling + floor;
  return { left: free.left, width: free.width, anchor: "bottom", at, room: Math.max(0, at - ceiling) };
}

/**
 * The least room a spanning bar gets on this screen, whichever token is
 * tapped: a token where the room below it and above it are equal, a little
 * under the free area's middle since a bar above its token also clears the
 * token itself. Each side there is about half the free area. Anywhere else
 * one side is larger, and the bar takes that one.
 */
export function spanRoomAtWorst(free: Box): number {
  return spanHang({ x: free.left + free.width / 2, y: free.top + (free.height + FLIP_CLEARANCE) / 2 }, free, Number.POSITIVE_INFINITY, free.top).room;
}

/**
 * Where the bar hangs, before a drag: by its token when it spans, at its
 * spot when it docks, and the overlay's place when compact, then shared
 * with the column when they meet across. The one rule for the bar drawn
 * (TokenActionBar.tsx) and for where a pan expects it (restingBar). Null
 * only where the bar would span and no token is given to hang it by.
 */
export function placeBar(input: {
  layout: Size;
  viewport: Size;
  chrome: Chrome;
  foot: number;
  /** Under the selected token, for a bar that spans. */
  anchor: Point | null;
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
}): { mode: BarMode; free: Box; hang: Hang; lane: Lane; resizable: boolean; room: Box } | null {
  const barWidth = input.width ?? BAR_WIDTH;
  const free = freeArea(input.viewport, input.chrome, input.foot);
  const mode = barMode(input.layout, free.height);
  if (mode === "span") {
    if (!input.anchor) return null;
    // An upright span crosses the whole map, so it always meets the column: it keeps below the first card, or moves beside the lane, and never covers its token either way.
    const { lane, floor } = laneChoice({ laneTop: free.top, laneHeight: free.height, column: input.column, besideRoom: free.width - LANE_WIDTH });
    const hang = spanHang(input.anchor, free, input.height, floor);
    if (lane !== "beside") return { mode, free, hang, lane, resizable: false, room: free };
    const width = Math.min(barWidth, free.width - LANE_WIDTH);
    return { mode, free, hang: { ...hang, left: laneLeft(free) - width, width }, lane, resizable: false, room: free };
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
 * Where a docked or compact bar rests before it exists, for a pan that
 * opens it: its spot and the height it last had, shared with the column
 * as the drawn bar will be (placeBar). Null where the bar spans, since a
 * spanning bar is placed by its token.
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
}): { box: Box; laneLeft: number; freeRight: number } | null {
  const placed = placeBar({ ...input, foot: input.foot ?? 0, anchor: null });
  if (!placed || placed.mode === "span") return null;
  return { box: hangBox(placed.hang, input.height), laneLeft: laneLeft(placed.free), freeRight: placed.free.left + placed.free.width };
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
export function columnFacts(prev: ColumnFacts | null, input: { top: number; measured: { content: number; first: number } | null; row?: number }): ColumnFacts | null {
  const { top, measured, row } = input;
  if (!measured) return prev && (prev.top !== top || prev.row !== row) ? withRow({ ...prev, top }, row) : prev;
  if (measured.first <= 0) return null;
  if (prev && prev.top === top && prev.content === measured.content && prev.first === measured.first && prev.row === row) return prev;
  return withRow({ top, content: measured.content, first: measured.first }, row);
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
export function columnCards(input: { mapWidth: number; sheet: number; safe: Pick<Sides, "left" | "right"> }): { card: number; shadowLeft: number } {
  const rightPad = EDGE + (input.sheet > 0 ? 0 : input.safe.right);
  const card = Math.min(CARD_MAX, input.mapWidth - input.sheet - 2 * EDGE - input.safe.left - (input.sheet > 0 ? 0 : input.safe.right));
  return { card, shadowLeft: Math.min(SHADOW_ROOM, input.mapWidth - card - rightPad) };
}

/** The column's top: the lane's, or 8 px under the last lasting notice when the notices span over it. Toasts never move it. */
export function columnTop(laneTop: number, lastingBottom: number | null): number {
  return lastingBottom === null ? laneTop : Math.max(laneTop, lastingBottom + EDGE);
}

// ------------------------------------------------------------ the Room's slot

/** The bar as it shows, for the column, the notices and the camera. `freeRight` is the free area's right edge (barCover). */
export type BarFacts = { box: Box; mode: BarMode; lane: Lane; laneLeft: number; freeRight: number };

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
  /** The column's alerts show over the screen (askedAlerts), so the top bars rise over the notices with them. */
  alertsOverlay: boolean;
};

/** Per Room page (state/scope.ts): a preview draws a second room with a bar and a column of its own. */
export const barDockSlot = scopeSlot(() =>
  createStore<BarDockState>(() => ({ chrome: null, bar: null, column: null, notices: null, lasting: null, columnRollAsked: false, spot: readSpot(), defaultWidth: BAR_WIDTH, size: readSize(), finePointer: isFinePointer(), lastHeight: 200, focusFrame: false, foot: 0, footYields: false, columnCramped: false, alertsOverlay: false })),
);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
